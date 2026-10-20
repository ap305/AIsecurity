import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AdmZip from 'adm-zip'
import { COURSE_PACK_IDS, importCoursePack, loadCoursePack, sha256, type CoursePackManifest } from '../scripts/importCoursePackV3.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import { decodeEvaluationArchive } from '../src/lib/evaluationPackage.js'

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'course-pack-import-'))
  const root = path.join(directory, 'input'), resourcesRoot = path.join(directory, 'runtime-resources')
  fs.mkdirSync(path.join(root, 'package', 'fixtures'), { recursive: true })
  const contents: Record<string, string> = {
    'manifest.json': JSON.stringify({ schemaVersion: 1, protocol: 'platform-rpc-v1', name: 'test-course', image: 'python:3.12-slim', entrypoint: 'grader.py', phases: ['basic', 'baseline', 'opponent'], network: 'none', resources: { cpus: 1, memoryMb: 128, pids: 16, timeoutMs: 1000, tmpMb: 16 }, materials: { requiresWeights: false, maxWeightBytes: 1048576, maxCodeBytes: 1048576 }, rpc: { maxRequestBytes: 1024, maxResponseBytes: 1024 } }),
    'compose.yaml': 'services:\n  grader:\n    image: python:3.12-slim\n',
    'grader.py': '# PRIVATE_GRADER_SENTINEL\n',
    'fixtures/model.json': '{"weight":1}',
  }
  for (const [filename, content] of Object.entries(contents)) fs.writeFileSync(path.join(root, 'package', filename), content)
  fs.writeFileSync(path.join(root, 'reference.py'), '# PRIVATE_REFERENCE_SENTINEL\ndef solve(): return 1\n')
  fs.writeFileSync(path.join(root, 'opponent.py'), '# PRIVATE_OPPONENT_SENTINEL\ndef solve(): return 0\n')
  fs.writeFileSync(path.join(root, 'guide.txt'), 'Public student instructions\n')
  const codeSha256 = sha256(fs.readFileSync(path.join(root, 'reference.py')))
  const opponentSha256 = sha256(fs.readFileSync(path.join(root, 'opponent.py')))
  const manifest: CoursePackManifest = {
    schemaVersion: 1, packId: 'V3-261012', sourceArchiveSha256: 'a'.repeat(64),
    packages: [{ key: 'shared', directory: 'package', files: Object.entries(contents).map(([filename, content]) => ({ path: filename, sha256: sha256(content) })) }],
    questions: COURSE_PACK_IDS.map((id) => {
      const basic = id.includes('-B'), attack = id.includes('-A')
      return { id, title: id, moduleCode: basic ? 'BASIC' : 'SECURITY', number: Number(id.slice(-2)), difficulty: 'L1', category: basic ? 'basic' : 'adversarial', ...(basic ? {} : { scenarioId: `V3-scene-${id.slice(-2)}`, role: attack ? 'attack' as const : 'defense' as const }), content: `# ${id}\nTask instructions`, answerTemplate: 'def solve():\n    pass\n', packageKey: 'shared', definition: normalizeDefinition({ evaluation: { version: 'v3-test', timeoutMs: 1000, baselineThreshold: 1, successThreshold: 0.5 } }), selfTest: { codePath: 'reference.py', codeSha256, ...(basic ? { minimumScore: 100 } : { opponent: { codePath: 'opponent.py', codeSha256: opponentSha256 } }) }, resources: [{ sourcePath: 'guide.txt', filename: 'guide.txt', sha256: sha256('Public student instructions\n') }] }
    }),
  }
  const manifestFile = path.join(root, 'manifest.json'), tokenFile = path.join(directory, 'token.txt'), stateFile = path.join(directory, 'state.json')
  fs.writeFileSync(tokenFile, 'PRIVATE_TOKEN_SENTINEL_0123456789')
  const write = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  write()
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(contents).sort(([a], [b]) => a.localeCompare(b))) zip.addFile(name, Buffer.from(content))
  const packageDigest = sha256(JSON.stringify(Object.fromEntries([...decodeEvaluationArchive(zip.toBuffer())].map(([name, bytes]) => [name, sha256(bytes)]))))
  return { directory, root, resourcesRoot, manifest, manifestFile, tokenFile, stateFile, packageDigest, write, clean: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

async function apiFixture(f: ReturnType<typeof fixture>) {
  const requests: Array<{ method: string; route: string; connection?: string }> = []
  const questions = new Map<string, any>(), tests = new Map<string, any>()
  let installed = false
  let packagePosts = 0, testPosts = 0, dropCreateResponse = false, dropTestResponse = false, invalidBaseline = false, failMessage = false
  const descriptor = { id: 'package-1', digest: f.packageDigest, valid: true }
  const server = http.createServer(async (req, res) => {
    const route = decodeURIComponent(new URL(req.url || '', 'http://localhost').pathname.slice(4))
    const method = req.method || 'GET'
    requests.push({ method, route, connection: req.headers.connection })
    const send = (data: any, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: status < 400 ? 0 : status, message: 'PRIVATE_SERVER_MESSAGE_SENTINEL', data }))
    }
    if (req.headers.authorization !== 'Bearer PRIVATE_TOKEN_SENTINEL_0123456789') return send(null, 401)
    if (failMessage) return send({ secret: 'PRIVATE_TOKEN_SENTINEL_0123456789' }, 500)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const body = String(req.headers['content-type']).includes('application/json') ? JSON.parse(raw.toString() || '{}') : null
    if (route === '/auth/me') return send({ user: { role: 'admin', id: 'PRIVATE_ACCOUNT_SENTINEL' } })
    if (route === '/admin/api-pool') return send([])
    if (route === '/admin/questions' && method === 'POST') {
      if (questions.has(body.id)) return send(null, 409)
      const q = { ...body, revision: 1, updatedAt: new Date().toISOString(), testConfig: JSON.stringify(body.testConfig) }
      questions.set(body.id, q)
      if (dropCreateResponse) { dropCreateResponse = false; req.socket.destroy(); return }
      return send(q, 201)
    }
    const adminQuestion = route.match(/^\/admin\/questions\/([^/]+)$/)
    if (adminQuestion) {
      const q = questions.get(adminQuestion[1])
      if (!q) return send(null, 404)
      if (method === 'PUT') {
        Object.assign(q, body, { testConfig: JSON.stringify(body.testConfig), updatedAt: new Date().toISOString() })
        if (body.status === 'published') q.definition.evaluation.packageDigest = descriptor.digest
      }
      return send(q)
    }
    if (route === '/admin/evaluation-packages') {
      if (method === 'POST') { packagePosts++; installed = true; return send(descriptor, 201) }
      return send(installed ? [descriptor] : [])
    }
    if (route === '/admin/evaluation-packages/package-1/validate') return send(descriptor)
    if (route === '/admin/evaluation-packages/package-1/self-tests' && method === 'POST') {
      testPosts++
      const id = `test-${testPosts}`
      const record = { id, packageId: descriptor.id, packageDigest: descriptor.digest, phase: body.phase, configurationKey: selfTestConfigurationKey(body.definition, body.role, body.category), status: 'completed', result: { status: 'completed', cleanupStatus: 'cleaned', score: 100, metrics: { qualificationMetric: invalidBaseline ? 0 : 1, successMetric: 0 }, privateDebug: 'PRIVATE_RESULT_SENTINEL' }, privateOriginal: body.code }
      tests.set(id, record)
      if (dropTestResponse) { dropTestResponse = false; req.socket.destroy(); return }
      return send(record, 202)
    }
    const selfTest = route.match(/^\/admin\/evaluation-packages\/package-1\/self-tests\/([^/]+)$/)
    if (selfTest) return send(tests.get(selfTest[1]) || null, tests.has(selfTest[1]) ? 200 : 404)
    const publicQuestion = route.match(/^\/questions\/([^/]+)$/)
    if (publicQuestion) return send(questions.get(publicQuestion[1]) || null, questions.has(publicQuestion[1]) ? 200 : 404)
    const resources = route.match(/^\/questions\/([^/]+)\/resources(?:\/(.+))?$/)
    if (resources) {
      const folder = path.join(f.resourcesRoot, resources[1])
      if (!resources[2]) return send(fs.existsSync(folder) ? fs.readdirSync(folder).map((filename) => ({ filename })) : [])
      const filename = path.join(folder, resources[2])
      if (!fs.existsSync(filename)) return send(null, 404)
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(fs.readFileSync(filename)); return
    }
    return send(null, 404)
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return { requests, questions, tests,
    options: { manifest: f.manifestFile, api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, tokenFile: f.tokenFile, stateFile: f.stateFile, resourcesRoot: f.resourcesRoot, pollMs: 0, log: (_event: Record<string, unknown>) => {} },
    count: () => ({ packagePosts, testPosts }),
    dropQuestion: () => { dropCreateResponse = true }, dropTest: () => { dropTestResponse = true }, lowBaseline: () => { invalidBaseline = true }, serverFailure: () => { failMessage = true },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('V3 dry-run validates all 77 explicit IDs and performs no HTTP or writes', async () => {
  const f = fixture()
  try {
    const result = await importCoursePack({ manifest: f.manifestFile, dryRun: true })
    assert.equal(result.status, 'validated')
    assert.equal(result.basicQuestions, 17); assert.equal(result.adversarialQuestions, 60)
    assert.equal('httpRequests' in result && result.httpRequests, 0)
    assert.equal(fs.existsSync(f.stateFile), false); assert.equal(fs.existsSync(f.resourcesRoot), false)
    assert.equal(COURSE_PACK_IDS.includes('V3-261012-A29'), false)
    await assert.rejects(importCoursePack({ manifest: f.manifestFile, dryRun: true, only: ['OLD-QUESTION'] }), /selected_scope_invalid/)
  } finally { f.clean() }
})

test('manifest rejects missing courses, traversal, undeclared package files and changed source bytes', () => {
  const f = fixture()
  try {
    f.manifest.questions.pop(); f.write()
    assert.throws(() => loadCoursePack(f.manifestFile), /manifest_requires_all_77_questions/)
  } finally { f.clean() }
  for (const mutation of ['path', 'extra', 'digest', 'fixture'] as const) {
    const g = fixture()
    try {
      if (mutation === 'path') g.manifest.questions[0].resources[0].filename = '../private.txt'
      if (mutation === 'extra') fs.writeFileSync(path.join(g.root, 'package', 'not-listed.txt'), 'hidden')
      if (mutation === 'digest') fs.appendFileSync(path.join(g.root, 'reference.py'), '# changed')
      if (mutation === 'fixture') g.manifest.questions[0].selfTest.weightFixture = 'grader.py'
      g.write()
      assert.throws(() => loadCoursePack(g.manifestFile), /unsafe_relative_path|package_files_not_exactly_allowlisted|input_digest_mismatch|weight_fixture_missing_or_not_private/)
    } finally { g.clean() }
  }
})

test('full HTTP lifecycle preserves original questions, reuses packages/tests and keeps evidence sanitized', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    const original = { id: 'OLD-QUESTION', status: 'published', code: 'ORIGINAL_PRIVATE_SOURCE' }
    api.questions.set(original.id, structuredClone(original))
    const only = ['V3-261012-B01', 'V3-261012-A01', 'V3-261012-D01']
    const result = await importCoursePack({ ...api.options, stage: 'all', only })
    assert.equal('published' in result && result.published, 3)
    assert.deepEqual(api.count(), { packagePosts: 1, testPosts: 5 })
    assert.deepEqual(api.questions.get(original.id), original)
    assert.equal(api.questions.size, 4)
    const evidence = fs.readFileSync(f.stateFile, 'utf8')
    for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_ACCOUNT', 'PRIVATE_REFERENCE', 'PRIVATE_OPPONENT', 'PRIVATE_RESULT', 'PRIVATE_SERVER_MESSAGE', f.directory]) assert.equal(evidence.includes(secret), false)
    // Both AD references qualify exactly at their baseline, then lose normally against the opponent.
    const state = JSON.parse(evidence)
    assert.equal(state.questions['V3-261012-A01'].tests.opponent.result.metric, 0)
    await importCoursePack({ ...api.options, stage: 'all', only })
    assert.deepEqual(api.count(), { packagePosts: 1, testPosts: 5 })
    const start = api.requests.length, before = fs.readFileSync(f.stateFile, 'utf8')
    await importCoursePack({ ...api.options, stage: 'verify', only })
    assert.ok(api.requests.slice(start).every((r) => r.method === 'GET'))
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before)
    assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    assert.ok(api.requests.every(r => r.connection === 'close'), 'package, self-test and resource requests must not reuse stale idle sockets')
  } finally { await api.close(); f.clean() }
})

test('entire selected set is checked before writes and existing IDs cannot be adopted', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.questions.set('V3-261012-B02', { id: 'V3-261012-B02', status: 'draft', title: 'unrelated' })
    await assert.rejects(importCoursePack({ ...api.options, stage: 'prepare', only: ['V3-261012-B01', 'V3-261012-B02'] }), /owned_question_missing/)
    assert.ok(api.requests.every((r) => r.method === 'GET'))
    assert.equal(api.questions.has('V3-261012-B01'), false)
    assert.equal(fs.existsSync(f.resourcesRoot), false)
  } finally { await api.close(); f.clean() }
})

test('draft POST response loss resumes only using persisted import ownership marker', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.dropQuestion()
    const only = ['V3-261012-B01']
    await assert.rejects(importCoursePack({ ...api.options, stage: 'prepare', only }), /http_outcome_unknown/)
    assert.equal(api.questions.size, 1)
    await importCoursePack({ ...api.options, stage: 'prepare', only })
    assert.equal(api.requests.filter((r) => r.method === 'POST' && r.route === '/admin/questions').length, 1)
  } finally { await api.close(); f.clean() }
})

test('unknown self-test POST outcome does not silently create duplicate evaluation jobs', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    const only = ['V3-261012-B01']
    await importCoursePack({ ...api.options, stage: 'prepare', only })
    api.dropTest()
    await assert.rejects(importCoursePack({ ...api.options, stage: 'self-test', only }), /selected_self_tests_failed/)
    await assert.rejects(importCoursePack({ ...api.options, stage: 'self-test', only }), /selected_self_tests_failed/)
    assert.equal(api.count().testPosts, 1)
    await importCoursePack({ ...api.options, stage: 'self-test', only, recoverSelfTests: { 'V3-261012-B01': { basic: 'test-1' } } })
    await importCoursePack({ ...api.options, stage: 'publish', only })
    assert.equal(api.count().testPosts, 1)
  } finally { await api.close(); f.clean() }
})

test('failed qualification prevents publication of the whole selected batch', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    const only = ['V3-261012-B01', 'V3-261012-A01']
    api.lowBaseline()
    await assert.rejects(importCoursePack({ ...api.options, stage: 'all', only }), /selected_self_tests_failed/)
    assert.ok([...api.questions.values()].every((q) => q.status === 'draft'))
    await assert.rejects(importCoursePack({ ...api.options, stage: 'publish', only }), /baseline_self_test_below_threshold/)
    assert.ok([...api.questions.values()].every((q) => q.status === 'draft'))
  } finally { await api.close(); f.clean() }
})

test('changed manifest, frozen self-test or resource content blocks resume without overwriting', async () => {
  for (const mutation of ['manifest', 'proof', 'resource'] as const) {
    const f = fixture(), api = await apiFixture(f)
    try {
      const only = ['V3-261012-B01']
      await importCoursePack({ ...api.options, stage: 'all', only })
      if (mutation === 'manifest') { f.manifest.questions[0].content += '\nchanged'; f.write() }
      if (mutation === 'proof') api.tests.get('test-1').packageDigest = 'b'.repeat(64)
      if (mutation === 'resource') fs.writeFileSync(path.join(f.resourcesRoot, only[0], 'guide.txt'), 'unexpected modification')
      const before = api.requests.length
      await assert.rejects(importCoursePack({ ...api.options, stage: 'verify', only }), /state_frozen_inputs_changed|self_test_identity_mismatch|existing_resource_digest_conflict/)
      assert.ok(api.requests.slice(before).every((r) => r.method === 'GET'))
    } finally { await api.close(); f.clean() }
  }
})

test('remote error details and credentials are never included in thrown errors or event evidence', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.serverFailure()
    await assert.rejects(importCoursePack({ ...api.options, stage: 'prepare', only: ['V3-261012-B01'] }), (error: any) => {
      assert.equal(error.message, 'http_500_operation_failed')
      assert.equal(error.message.includes('PRIVATE'), false)
      return true
    })
  } finally { await api.close(); f.clean() }
})

test('uncalibrated/readiness flags block all release stages before HTTP, even when another subset is selected', async () => {
  for (const flag of ['manifest-calibration', 'manifest-ready', 'question-calibration', 'question-ready', 'parameter-calibration'] as const) {
    const f = fixture(), api = await apiFixture(f)
    try {
      const other = f.manifest.questions.find((q) => q.id === 'V3-261012-A01')!
      if (flag === 'manifest-calibration') f.manifest.requiresCalibration = true
      if (flag === 'manifest-ready') f.manifest.deploymentReady = false
      if (flag === 'question-calibration') other.requiresCalibration = true
      if (flag === 'question-ready') other.deploymentReady = false
      if (flag === 'parameter-calibration') other.definition.evaluation.parameters = { calibrationMode: true }
      f.write()
      for (const stage of ['all', 'publish', 'verify'] as const) {
        await assert.rejects(importCoursePack({ ...api.options, stage, only: ['V3-261012-B01'] }), /course_pack_not_calibrated_or_deployment_ready/)
      }
      assert.deepEqual(api.requests, [])
      assert.equal(fs.existsSync(f.stateFile), false)
      assert.equal(fs.existsSync(f.resourcesRoot), false)
    } finally { await api.close(); f.clean() }
  }
})

test('pending calibration permits numeric draft preparation/self-tests but never publication with a zero threshold', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    const q = f.manifest.questions.find((row) => row.id === 'V3-261012-A01')!
    q.requiresCalibration = true
    q.definition.evaluation.baselineThreshold = 0
    q.definition.evaluation.parameters = { calibrationMode: true }
    f.write()
    const only = [q.id]
    await importCoursePack({ ...api.options, stage: 'prepare', only })
    await importCoursePack({ ...api.options, stage: 'self-test', only })
    assert.equal(api.tests.size, 2)
    const before = api.requests.length
    await assert.rejects(importCoursePack({ ...api.options, stage: 'publish', only }), /course_pack_not_calibrated_or_deployment_ready/)
    assert.equal(api.requests.length, before)
    assert.equal(api.questions.get(q.id).status, 'draft')
  } finally { await api.close(); f.clean() }
})

test('unset or null thresholds cannot silently normalize into publishable zero thresholds', () => {
  for (const value of [null, undefined, '0']) {
    const f = fixture()
    try {
      ;(f.manifest.questions[0].definition.evaluation as any).baselineThreshold = value
      f.write()
      assert.throws(() => loadCoursePack(f.manifestFile), /thresholds_must_be_explicit_finite_numbers/)
    } finally { f.clean() }
  }
})

test('top-level production calibrationMode is rejected before every importer stage', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    f.manifest.questions[0].definition.evaluation.calibrationMode = true
    f.write()
    for (const stage of ['prepare', 'self-test', 'publish', 'verify', 'all'] as const)
      await assert.rejects(importCoursePack({ ...api.options, stage }), /definition_must_not_bind_package_or_calibration/)
    assert.equal(api.requests.length, 0)
    assert.equal(fs.existsSync(f.stateFile), false)
  } finally { await api.close(); f.clean() }
})

test('explicit ready-basic publication releases exactly 17 tested basics while all 60 adversarial rows stay unready', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    f.manifest.requiresCalibration = true; f.manifest.deploymentReady = false
    for (const q of f.manifest.questions) {
      q.requiresCalibration = q.category !== 'basic'; q.deploymentReady = q.category === 'basic'
      if (q.category !== 'basic') q.definition.evaluation.parameters = {calibrationMode:true}
    }
    f.write()
    const only = COURSE_PACK_IDS.filter(id => id.includes('-B'))
    const report = await importCoursePack({...api.options, only, publishReadyBasics:true, stage:'all'})
    assert.equal(report.published,17); assert.equal(report.selfTests,17)
    assert.equal(api.questions.size,17); assert.equal(api.tests.size,17)
    assert.ok([...api.questions.values()].every(q => q.category === 'basic' && q.status === 'published'))
    const n = api.requests.length
    await importCoursePack({...api.options, only, publishReadyBasics:true, stage:'verify'})
    assert.ok(api.requests.slice(n).every(r => r.method === 'GET'))
  } finally { await api.close(); f.clean() }
})

test('ready-basic override refuses incomplete, widened, unready, or model-calling selections before any HTTP', async () => {
  for (const failure of ['missing','attack','unready','model'] as const) {
    const f=fixture(),api=await apiFixture(f)
    try {
      for (const q of f.manifest.questions) {q.requiresCalibration=false;q.deploymentReady=true}
      const only=COURSE_PACK_IDS.filter(id=>id.includes('-B'))
      if(failure==='missing')only.pop()
      if(failure==='attack')only.push('V3-261012-A01')
      if(failure==='unready')f.manifest.questions[0].deploymentReady=false
      if(failure==='model'){f.manifest.questions[0].definition.llm.enabled=true;f.manifest.questions[0].definition.llm.poolId='pool-1'}
      f.write()
      await assert.rejects(importCoursePack({...api.options,only,publishReadyBasics:true,stage:'prepare'}),/ready_basics_requires_exact_explicit_17|selected_basics_not_calibrated_or_ready/)
      assert.equal(api.requests.length,0); assert.equal(fs.existsSync(f.stateFile),false)
    } finally {await api.close();f.clean()}
  }
})
