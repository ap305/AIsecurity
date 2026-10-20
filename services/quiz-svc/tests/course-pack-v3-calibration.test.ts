import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import AdmZip from 'adm-zip'
import { calibrate, thresholds } from '../scripts/calibrateCoursePackV3.js'
import { COURSE_PACK_IDS, importCoursePack, loadCoursePack, sha256, type CoursePackManifest } from '../scripts/importCoursePackV3.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'
import { selfTestConfigurationKey } from '../src/lib/selfTestContract.js'
import { decodeEvaluationArchive } from '../src/lib/evaluationPackage.js'

test('zero wins cannot turn normal failures into wins through greater-than-or-equal comparison', () => {
  assert.throws(() => thresholds(0, 0), /documented_positive_threshold/)
  assert.deepEqual(thresholds(0, 0, 1 / 48), { baselineThreshold: 0, successThreshold: 1 / 48 })
  assert.equal(0 >= thresholds(0, 0, 1 / 48).successThreshold, false)
})
test('nonzero continuous reference metrics retain their exact measured threshold', () => {
  assert.deepEqual(thresholds(0.031, 0.000031, 0.05), { baselineThreshold: 0.031, successThreshold: 0.000031 })
  assert.equal(0.031 >= thresholds(0.031, 0.000031).baselineThreshold, true)
})
test('failed hard qualification and nonfinite reference measurements prevent release', () => {
  for (const [baseline, success] of [[-1, 1], [NaN, 0.1], [1, Infinity], [1, -1], [1, 1.1]])
    assert.throws(() => thresholds(baseline, success), /reference_failed/)
})

const image = 'quiz-runtime@sha256:' + '1'.repeat(64)
const attackId = 'V3-261012-A01'
const privateToken = 'PRIVATE_TOKEN_SENTINEL_0123456789'
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'course-calibration-'))
  const root = path.join(directory, 'input')
  fs.mkdirSync(path.join(root, 'package', 'fixtures'), { recursive: true })
  const contents: Record<string, string> = {
    'manifest.json': JSON.stringify({ schemaVersion: 1, protocol: 'platform-rpc-v1', name: 'calibration-test', image,
      entrypoint: 'grader.py', phases: ['basic', 'baseline', 'opponent'], network: 'none',
      resources: { cpus: 1, memoryMb: 128, pids: 16, timeoutMs: 1000, tmpMb: 16 },
      materials: { requiresWeights: false, maxWeightBytes: 1048576, maxCodeBytes: 1048576 }, rpc: { maxRequestBytes: 1024, maxResponseBytes: 1024 } }),
    'compose.yaml': `services:\n  grader:\n    image: ${image}\n`,
    'grader.py': '# PRIVATE_GRADER_SENTINEL\n', 'fixtures/model.json': '{"weight":1}',
  }
  for (const [name, value] of Object.entries(contents)) fs.writeFileSync(path.join(root, 'package', name), value)
  fs.writeFileSync(path.join(root, 'reference.py'), '# PRIVATE_REFERENCE_SENTINEL\ndef solve(): return 1\n')
  fs.writeFileSync(path.join(root, 'opponent.py'), '# PRIVATE_OPPONENT_SENTINEL\ndef solve(): return 0\n')
  fs.writeFileSync(path.join(root, 'guide.txt'), 'Student guide\n')
  const codeSha256 = sha256(fs.readFileSync(path.join(root, 'reference.py')))
  const opponentSha256 = sha256(fs.readFileSync(path.join(root, 'opponent.py')))
  const manifest: CoursePackManifest = {
    schemaVersion: 1, packId: 'V3-261012', sourceArchiveSha256: 'a'.repeat(64), requiresCalibration: true, deploymentReady: false,
    packages: [{ key: 'shared', directory: 'package', files: Object.entries(contents).map(([name, value]) => ({ path: name, sha256: sha256(value) })) }],
    questions: COURSE_PACK_IDS.map(id => {
      const basic = id.includes('-B'), attack = id.includes('-A')
      return { id, title: id, moduleCode: basic ? 'BASIC' : 'SECURITY', number: Number(id.slice(-2)), difficulty: 'L1',
        category: basic ? 'basic' : 'adversarial', ...(basic ? {} : { scenarioId: `V3-scene-${id.slice(-2)}`, role: attack ? 'attack' as const : 'defense' as const }),
        content: `# ${id}\nTask instructions`, answerTemplate: 'def solve():\n    pass\n', packageKey: 'shared', requiresCalibration: true, deploymentReady: false,
        definition: normalizeDefinition({ evaluation: { version: 'v3-test', timeoutMs: 1000, baselineThreshold: 0, successThreshold: 1, parameters: { calibrationMode: true } } }),
        selfTest: { codePath: 'reference.py', codeSha256, weightFixture: 'fixtures/model.json', ...(basic ? { minimumScore: 100 } : { opponent: { codePath: 'opponent.py', codeSha256: opponentSha256, weightFixture: 'fixtures/model.json' } }) },
        resources: [{ sourcePath: 'guide.txt', filename: 'guide.txt', sha256: sha256('Student guide\n') }] }
    }),
  }
  const evidence = { image, questions: COURSE_PACK_IDS.map(id => ({ sourceId: id.replace('V3-261012-', ''), minimumPositiveSuccessThreshold: 1 / 48 })) }
  const manifestFile = path.join(root, 'raw-manifest.json'), evidenceFile = path.join(root, 'build-evidence.json')
  const tokenFile = path.join(directory, 'token.txt'), stateFile = path.join(directory, 'state.json'), output = path.join(root, 'manifest.json')
  fs.writeFileSync(tokenFile, privateToken)
  const write = () => { fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.writeFileSync(evidenceFile, JSON.stringify(evidence)) }
  write()
  const zip = new AdmZip()
  for (const [name, value] of Object.entries(contents).sort(([a], [b]) => a.localeCompare(b))) zip.addFile(name, Buffer.from(value))
  const packageDigest = sha256(JSON.stringify(Object.fromEntries([...decodeEvaluationArchive(zip.toBuffer())].map(([name, bytes]) => [name, sha256(bytes)]))))
  return { directory, root, manifest, evidence, manifestFile, evidenceFile, tokenFile, stateFile, output, packageDigest, write,
    clean: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

async function apiFixture(f: ReturnType<typeof fixture>) {
  const requests: Array<{ method: string; route: string; body?: any; connection?: string }> = []
  const records = new Map<string, any>()
  const pools: any[] = []
  const descriptor = { id: 'package-1', digest: f.packageDigest, valid: true, manifest: { image } }
  const packages = new Map([[descriptor.id, descriptor]])
  const settings = { dropTestResponse: false, dropPackageResponse: false, testPosts: 0, packagePosts: 0,
    success: 0.2, calls: 2, installed: false, mutate: (_record: any, _read: number) => {}, mutatePackage: (_record: any) => {},
    create: (_record: any, _body: any) => {}, beforeRead: async (_record: any, _read: number) => {} }
  const reads = new Map<string, number>()
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url || '', 'http://localhost').pathname.slice(4), method = req.method || 'GET'
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const body = String(req.headers['content-type']).includes('application/json') ? JSON.parse(raw.toString() || '{}') : null
    requests.push({ method, route, body, connection: req.headers.connection })
    const send = (data: any, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: status < 400 ? 0 : status, message: 'PRIVATE_SERVER_MESSAGE_SENTINEL', data }))
    }
    if (req.headers.authorization !== `Bearer ${privateToken}`) return send(null, 401)
    if (route === '/admin/api-pool') return send(pools)
    if (route === '/admin/evaluation-packages') {
      if (method === 'GET') return send(settings.installed ? [...packages.values()] : [])
      settings.packagePosts++; settings.installed = true
      const archive = raw.subarray(raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])), raw.lastIndexOf(Buffer.from('\r\n--')))
      const files = decodeEvaluationArchive(archive)
      const digest = sha256(JSON.stringify(Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]))))
      let uploaded = [...packages.values()].find(p => p.digest === digest)
      if (!uploaded) {
        uploaded = { id: `package-${packages.size + 1}`, digest, valid: true, manifest: JSON.parse(files.get('manifest.json')!.toString()) }
        packages.set(uploaded.id, uploaded)
      }
      if (settings.dropPackageResponse) { settings.dropPackageResponse = false; req.socket.destroy(); return }
      const value = structuredClone(uploaded); settings.mutatePackage(value)
      return send(value, 201)
    }
    const packageId = route.match(/^\/admin\/evaluation-packages\/([^/]+)\//)?.[1]
    const currentPackage = packageId && packages.get(packageId)
    if (currentPackage && route.endsWith('/validate')) {
      const value = structuredClone(currentPackage); settings.mutatePackage(value); return send(value)
    }
    if (currentPackage && route.endsWith('/self-tests') && method === 'POST') {
      settings.testPosts++
      const id = randomUUID(), pool = body.definition.llm.enabled ? pools.find(p => p.id === body.definition.llm.poolId) : undefined
      const binding = pool ? { poolId: pool.id, revision: pool.revision, name: pool.name, kind: pool.kind, model: pool.model,
        modelVersion: pool.modelVersion, baseUrl: pool.baseUrl, credentialEnv: pool.credentialEnv, parameters: pool.parameters } : undefined
      const record = { id, packageId: currentPackage.id, packageDigest: currentPackage.digest, phase: body.phase,
        configurationKey: selfTestConfigurationKey(normalizeDefinition(body.definition), body.role ?? null, body.category, binding),
        status: 'completed', calls: settings.calls,
        result: { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 0.4, successMetric: settings.success },
          score: 100, maxScore: 100, message: 'PRIVATE_RESULT_SENTINEL' }, privateCode: body.code, privateWeights: 'PRIVATE_WEIGHTS_SENTINEL' }
      settings.create(record, body)
      records.set(id, record)
      if (settings.dropTestResponse) { settings.dropTestResponse = false; req.socket.destroy(); return }
      return send(record, 202)
    }
    const match = route.match(/^\/admin\/evaluation-packages\/[^/]+\/self-tests\/([^/]+)$/)
    if (match) {
      if (!records.has(match[1])) return send(null, 404)
      const count = (reads.get(match[1]) ?? 0) + 1; reads.set(match[1], count)
      const record = structuredClone(records.get(match[1])); await settings.beforeRead(record, count)
      settings.mutate(record, count); return send(record)
    }
    return send(null, 404)
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  return { requests, records, pools, settings, reads, packages,
    options: { manifest: f.manifestFile, evidence: f.evidenceFile, state: f.stateFile, output: f.output,
      api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, tokenFile: f.tokenFile, pollMs: 0, log: (_event: any) => {} },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('concurrency is bounded to integers 1 through 4 before HTTP or state locking', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    for (const concurrency of [0, -1, 5, 1.5, NaN, Infinity]) {
      await assert.rejects(calibrate({ ...api.options, concurrency }), /concurrency_must_be_integer_1_to_4/)
      assert.equal(api.requests.length, 0)
      assert.equal(fs.existsSync(f.stateFile), false)
      assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    }
  } finally { await api.close(); f.clean() }
})

test('HTTP calibration runs two independent questions together, preserves phase order and saves every proof', async () => {
  const f = fixture(), api = await apiFixture(f)
  const defenseId = 'V3-261012-D01', baselineReaders = new Set<string>()
  let release!: () => void, peakRunning = 0, barrierExpired = false, phaseOrderPreserved = true
  const bothRunning = new Promise<void>(resolve => { release = resolve })
  // A sequential implementation must fail the overlap assertion, not hang the suite.
  const timer = setTimeout(() => { barrierExpired = true; release() }, 2000)
  try {
    api.settings.create = (record, body) => {
      const questionId = body.role === 'attack' ? attackId : defenseId
      if (body.phase === 'opponent') {
        const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
        phaseOrderPreserved &&= saved.tests[questionId]?.baseline?.record?.result?.cleanupStatus === 'cleaned'
      }
      record.status = 'running'
    }
    api.settings.beforeRead = async (record, read) => {
      if (read !== 1) return
      if (record.phase === 'baseline') {
        baselineReaders.add(record.id)
        peakRunning = Math.max(peakRunning, [...api.records.values()].filter(r => r.status === 'running').length)
        if (baselineReaders.size === 2) release()
        await bothRunning
      }
      api.records.get(record.id).status = 'completed'
      record.status = 'completed'
    }
    const partial = await calibrate({ ...api.options, only: [attackId, defenseId], concurrency: 2 })
    clearTimeout(timer)
    assert.equal(barrierExpired, false, 'both questions must reach running before either baseline completes')
    assert.equal(peakRunning, 2)
    assert.equal(phaseOrderPreserved, true, 'opponent must start only after its own baseline proof was saved')
    assert.equal(partial.status, 'partial'); assert.equal(fs.existsSync(f.output), false)
    const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    assert.equal(Object.keys(saved.tests).length, 2)
    for (const id of [attackId, defenseId]) for (const phase of ['baseline', 'opponent']) {
      const proof = saved.tests[id][phase]
      assert.equal(proof.record.id, proof.id)
      assert.equal(proof.record.configurationKey, proof.configurationKey)
      assert.equal(proof.record.phase, phase)
      assert.equal(proof.record.result.cleanupStatus, 'cleaned')
    }
    assert.equal(api.settings.testPosts, 4)
    api.settings.create = () => {}; api.settings.beforeRead = async () => {}
    // Changing the worker count on resume must reuse saved proofs and still
    // pass the original full 77-question/137-phase final certification.
    assert.equal((await calibrate({ ...api.options, concurrency: 4 })).status, 'calibrated')
    assert.equal(api.settings.testPosts, 137)
    const finalState = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    const allProofs: any[] = Object.values(finalState.tests).flatMap((phases: any) => Object.values(phases))
    assert.equal(allProofs.length, 137)
    assert.ok(allProofs.every(proof => proof.record?.id === proof.id && proof.record?.result.cleanupStatus === 'cleaned'))
    assert.equal((await importCoursePack({ manifest: f.output, stage: 'all', dryRun: true })).status, 'validated')
  } finally { clearTimeout(timer); release(); await api.close(); f.clean() }
})

test('a parallel failure stops new questions, drains active phases under the lock and cannot write a final manifest', async () => {
  const f = fixture(), api = await apiFixture(f)
  const selected = f.manifest.questions.filter(q => q.category === 'adversarial').slice(0, 3).map(q => q.id)
  let release!: () => void, observed!: () => void, failedId: string | undefined, settled = false
  const held = new Promise<void>(resolve => { release = resolve })
  const otherRunning = new Promise<void>(resolve => { observed = resolve })
  const timer = setTimeout(() => { release(); observed() }, 3000)
  api.settings.create = record => {
    record.status = 'running'
    if (!failedId) failedId = record.id
  }
  api.settings.beforeRead = async (record, read) => {
    if (read !== 1) return
    if (record.id === failedId) {
      record.status = 'completed'; record.result.status = 'system_error'
      Object.assign(api.records.get(record.id), structuredClone(record))
    } else {
      if (record.phase === 'baseline') { observed(); await held }
      record.status = 'completed'; api.records.get(record.id).status = 'completed'
    }
  }
  const outcome = calibrate({ ...api.options, only: selected, concurrency: 2 }).then(
    result => { settled = true; return { result, error: undefined } },
    error => { settled = true; return { result: undefined, error } })
  try {
    await otherRunning
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(settled, false, 'the active second question must settle before the state lock is released')
    assert.equal(fs.existsSync(f.stateFile + '.lock'), true)
    assert.equal(fs.existsSync(f.output), false)
    assert.equal(api.settings.testPosts, 2)
    release()
    const stopped = await outcome
    assert.match(String(stopped.error), /reference_evaluation_failed_or_not_cleaned/)
    assert.equal(api.settings.testPosts, 3, 'the active question finishes opponent, but the third question is never started')
    assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    assert.equal(fs.existsSync(f.output), false)
    const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    assert.equal(Object.keys(saved.tests).length, 2)
    const completed = selected.find(id => saved.tests[id]?.opponent?.record)!
    assert.ok(completed)
    assert.equal(saved.tests[completed].baseline.record.result.cleanupStatus, 'cleaned')
    assert.equal(saved.tests[completed].opponent.record.result.cleanupStatus, 'cleaned')
    const completedProofIds = [saved.tests[completed].baseline.id, saved.tests[completed].opponent.id]
    api.settings.create = () => {}; api.settings.beforeRead = async () => {}
    // A failure does not silently become retriable; explicit retry preserves
    // the previous failure ID and completed sibling proofs across worker counts.
    const failedQuestion = selected.find(id => saved.tests[id]?.baseline?.id === failedId)!
    assert.ok(failedQuestion)
    await assert.rejects(calibrate({ ...api.options, only: [failedQuestion], concurrency: 1 }), /not_cleaned/)
    assert.equal(api.settings.testPosts, 3)
    assert.equal((await calibrate({ ...api.options, only: selected, concurrency: 4, retryFailed: true })).status, 'partial')
    const resumed = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    assert.deepEqual([resumed.tests[completed].baseline.id, resumed.tests[completed].opponent.id], completedProofIds)
    const retried = selected.find(id => resumed.tests[id].baseline.failed?.includes(failedId))
    assert.ok(retried)
    assert.equal(api.settings.testPosts, 7)
    assert.equal(fs.existsSync(f.output), false)
  } finally { clearTimeout(timer); release(); await outcome; await api.close(); f.clean() }
})

test('HTTP calibration resumes partial work, binds reference material and creates only a complete importable manifest', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.success = 0
    const partial = await calibrate({ ...api.options, only: [attackId] })
    assert.equal(partial.status, 'partial'); assert.equal(fs.existsSync(f.output), false)
    assert.equal(api.settings.testPosts, 2)
    const packageListReads=api.requests.filter(r=>r.method==='GET'&&r.route==='/admin/evaluation-packages').length
    const packageValidations=api.requests.filter(r=>r.method==='POST'&&r.route.endsWith('/validate')).length
    await calibrate({ ...api.options, only: [attackId] })
    assert.equal(api.requests.filter(r=>r.method==='GET'&&r.route==='/admin/evaluation-packages').length,packageListReads,'bound resume must not synchronously rescan every installed package')
    assert.equal(api.requests.filter(r=>r.method==='POST'&&r.route.endsWith('/validate')).length,packageValidations+1,'the selected bound package is still revalidated')
    assert.equal(api.settings.testPosts, 2); assert.equal(api.settings.packagePosts, 1)
    const first = api.requests.find(r => r.method === 'POST' && r.route.endsWith('/self-tests'))!.body
    const binding = sha256(JSON.stringify({ manifestDigest: loadCoursePack(f.manifestFile).manifestDigest, questionId: attackId,
      phase: 'baseline', code: f.manifest.questions.find(q => q.id === attackId)!.selfTest.codeSha256,
      weights: sha256('{"weight":1}'), opponentCode: null, opponentWeights: null }))
    assert.equal(first.definition.evaluation.parameters.calibrationReferenceBinding, binding)
    assert.equal(first.definition.evaluation.calibrationMode, true)
    const result = await calibrate(api.options)
    assert.equal(result.status, 'calibrated'); assert.equal(api.settings.testPosts, 137)
    const final = loadCoursePack(f.output).manifest
    assert.equal(final.requiresCalibration, false); assert.equal(final.deploymentReady, true)
    assert.equal(final.packages[0].directory, 'package')
    for (const q of final.questions) {
      assert.equal(q.requiresCalibration, false); assert.equal(q.deploymentReady, true)
      assert.equal(q.definition.evaluation.calibrationMode, undefined)
      assert.equal((q.definition.evaluation.parameters as any).calibrationMode, undefined)
      assert.equal((q.definition.evaluation.parameters as any).calibrationReferenceBinding, undefined)
      if (q.category !== 'basic') { assert.equal(q.definition.evaluation.baselineThreshold, 0.4); assert.equal(q.definition.evaluation.successThreshold, 1 / 48) }
    }
    assert.equal((await importCoursePack({ manifest: f.output, stage: 'all', dryRun: true })).status, 'validated')
    const state = fs.readFileSync(f.stateFile, 'utf8')
    for (const secret of ['PRIVATE_', f.directory]) assert.equal(state.includes(secret), false)
    assert.ok(api.requests.every(r => !r.route.includes('/questions') && !r.route.includes('/submissions')))
    assert.ok(api.requests.every(r => r.connection === 'close'), 'archive work must not leave a pooled socket for the next request')
    assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    const before = api.requests.length
    await assert.rejects(calibrate(api.options), /final_manifest_already_exists/)
    assert.equal(api.requests.length, before)
  } finally { await api.close(); f.clean() }
})

test('uncertain package upload is reconciled by immutable digest without duplicate uploads', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.dropPackageResponse = true
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /http_outcome_unknown/)
    assert.equal(api.settings.packagePosts, 1); assert.equal(api.settings.testPosts, 0)
    await calibrate({ ...api.options, only: [attackId] })
    assert.equal(api.settings.packagePosts, 1); assert.equal(api.settings.testPosts, 2)
  } finally { await api.close(); f.clean() }
})

test('uncertain self-test requires an explicit matching recovery ID and never automatically repeats work', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.dropTestResponse = true
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /http_outcome_unknown/)
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /unknown_self_test_outcome_requires_recovery/)
    assert.equal(api.settings.testPosts, 1)
    const id = [...api.records.keys()][0], recover = path.join(f.directory, 'recover.json')
    fs.writeFileSync(recover, JSON.stringify({ [attackId]: { baseline: id } }))
    const record = api.records.get(id); record.configurationKey = 'wrong-reference-binding'
    await assert.rejects(calibrate({ ...api.options, only: [attackId], recover }), /self_test_binding_mismatch/)
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).tests[attackId].baseline.id, undefined)
    const body = api.requests.find(r => r.method === 'POST' && r.route.endsWith('/self-tests'))!.body
    record.configurationKey = selfTestConfigurationKey(normalizeDefinition(body.definition), body.role, body.category)
    await calibrate({ ...api.options, only: [attackId], recover })
    assert.equal(api.settings.testPosts, 2); assert.equal(fs.existsSync(f.output), false)
  } finally { await api.close(); f.clean() }
})

test('only explicitly retried, finished and cleaned failures may create replacement self-tests', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.mutate = record => { record.result.status = 'timeout'; record.result.cleanupStatus = 'dirty' }
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /not_cleaned/)
    await assert.rejects(calibrate({ ...api.options, only: [attackId], retryFailed: true }), /not_cleaned/)
    assert.equal(api.settings.testPosts, 1)
    api.settings.mutate = () => {}
    const failed = [...api.records.keys()][0]
    api.records.get(failed).result.status = 'timeout'
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /not_cleaned/)
    assert.equal(api.settings.testPosts, 1)
    await calibrate({ ...api.options, only: [attackId], retryFailed: true })
    assert.equal(api.settings.testPosts, 3)
    const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    assert.deepEqual(state.tests[attackId].baseline.failed, [failed])
    assert.notEqual(state.tests[attackId].baseline.id, failed)
  } finally { await api.close(); f.clean() }
})

test('failed, dirty, malformed, misbound or indefinitely running reference results cannot become proofs', async () => {
  const cases: Array<[string, (record: any) => void, RegExp]> = [
    ['dirty', r => { r.result.cleanupStatus = 'dirty' }, /not_cleaned/],
    ['failed', r => { r.result.status = 'system_error' }, /not_cleaned/],
    ['package', r => { r.packageId = 'different-package' }, /binding_mismatch/],
    ['digest', r => { r.packageDigest = '0'.repeat(64) }, /binding_mismatch/],
    ['metrics', r => { r.result.metrics.claim = true }, /metrics_invalid/],
    ['missing metric', r => { delete r.result.metrics.qualificationMetric }, /metric_missing/],
    ['status', r => { r.status = 'failed' }, /status_invalid/],
    ['running', r => { r.status = 'running' }, /deadline_exceeded/],
  ]
  for (const [label, mutate, expected] of cases) {
    const f = fixture(), api = await apiFixture(f)
    try {
      api.settings.mutate = mutate
      await assert.rejects(calibrate({ ...api.options, only: [attackId], selfTestTimeoutMs: 0 }), expected, label)
      const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
      assert.equal(state.tests[attackId].baseline.record, undefined, label)
      assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    } finally { await api.close(); f.clean() }
  }
})

test('final verification rereads all real proofs and rejects a stale package binding', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.mutate = (record, read) => { if (read > 1) record.packageId = 'stale-package' }
    await assert.rejects(calibrate(api.options), /binding_mismatch/)
    assert.equal(api.settings.testPosts, 137); assert.equal(fs.existsSync(f.output), false)
  } finally { await api.close(); f.clean() }
})

test('a measured zero without a documented positive success threshold cannot produce a release', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    f.evidence.questions.forEach(q => { delete (q as any).minimumPositiveSuccessThreshold }); f.write()
    api.settings.success = 0
    await assert.rejects(calibrate(api.options), /zero_reference_requires_documented_positive_threshold/)
    assert.equal(api.settings.testPosts, 137); assert.equal(fs.existsSync(f.output), false)
  } finally { await api.close(); f.clean() }
})

test('real LLM calls and a frozen model pool are required for API reference proofs', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    f.manifest.questions.find(q => q.id === attackId)!.definition.llm = { enabled: true, poolId: 'pool-1' }; f.write()
    api.pools.push({ id: 'pool-1', name: 'Frozen model', kind: 'llm', enabled: true, revision: 1, model: 'qwen3-8b',
      modelVersion: '20261016', baseUrl: 'http://gateway.local/v1', credentialEnv: 'PRIVATE_CREDENTIAL_NAME', parameters: { temperature: 0 } })
    api.settings.calls = 0
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /real_model_calls_required/)
    api.records.forEach(record => { record.calls = 2 }); api.settings.calls = 2
    await calibrate({ ...api.options, only: [attackId] })
    api.pools[0].revision = 2
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /frozen_model_pool_changed/)
    assert.equal(api.settings.testPosts, 2)
    assert.equal(fs.readFileSync(f.stateFile, 'utf8').includes('PRIVATE_'), false)
  } finally { await api.close(); f.clean() }
})

test('snapshot calibration rejects missing accounting and preserves upstream/hit evidence across resume', async () => {
  const f = fixture(), api = await apiFixture(f), qid = 'V3-261012-A02'
  try {
    const q = f.manifest.questions.find(q => q.id === qid)!
    q.definition.llm = { enabled: true, poolId: 'pool-1' }
    q.definition.evaluation.parameters = { responseSnapshotPolicy: 'first-valid-response-v1', responseSnapshotScope: qid }
    f.write()
    api.pools.push({ id: 'pool-1', name: 'Frozen model', kind: 'llm', enabled: true, revision: 1, model: 'qwen3-8b', modelVersion: '20261018', baseUrl: 'http://gateway.local/v1', credentialEnv: null, parameters: {} })
    await assert.rejects(calibrate({ ...api.options, only: [qid] }), /snapshot_call_evidence_invalid/)
    api.records.forEach(r => { r.upstreamCalls = 1; r.responseSnapshotHits = 1 })
    api.settings.create = r => { r.upstreamCalls = 1; r.responseSnapshotHits = 1 }
    await calibrate({ ...api.options, only: [qid] })
    const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    for (const phase of ['baseline', 'opponent']) {
      assert.equal(saved.tests[qid][phase].record.upstreamCalls, 1)
      assert.equal(saved.tests[qid][phase].record.responseSnapshotHits, 1)
      assert.equal(saved.tests[qid][phase].record.calls, 2)
    }
    assert.equal(api.settings.testPosts, 2)
  } finally { await api.close(); f.clean() }
})

test('local output paths, frozen inputs, exclusive locks and immutable package content are enforced', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    await assert.rejects(calibrate({ ...api.options, output: path.join(f.directory, 'elsewhere.json') }), /share_input_root/)
    fs.writeFileSync(f.stateFile + '.lock', 'other writer')
    await assert.rejects(calibrate(api.options), /state_locked/)
    assert.equal(api.requests.length, 0)
    fs.unlinkSync(f.stateFile + '.lock')
    api.settings.mutatePackage = p => { p.digest = 'f'.repeat(64) }
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /package_or_image_mismatch/)
    assert.equal(api.settings.testPosts, 0)
    api.settings.mutatePackage = () => {}
    await calibrate({ ...api.options, only: [attackId] })
    f.evidence.questions[0].minimumPositiveSuccessThreshold = 0.25; f.write()
    await assert.rejects(calibrate({ ...api.options, only: [attackId] }), /calibration_input_changed/)
    assert.equal(fs.existsSync(f.output), false)
  } finally { await api.close(); f.clean() }
})

test('reference and threshold-evidence changes during long-running calibration prevent certification', async () => {
  for (const kind of ['code', 'evidence']) {
    const f = fixture(), api = await apiFixture(f)
    try {
      let changed = false
      api.settings.mutate = () => {
        if (changed) return
        changed = true
        if (kind === 'code') fs.appendFileSync(path.join(f.root, 'reference.py'), '# changed while running\n')
        else fs.appendFileSync(f.evidenceFile, '\n')
      }
      await assert.rejects(calibrate({ ...api.options, ...(kind === 'code' ? { only: [attackId] } : {}) }),
        kind === 'code' ? /reference_code_changed/ : /calibration_input_changed/)
      assert.equal(fs.existsSync(f.output), false)
      if (kind === 'code') assert.equal(api.settings.testPosts, 1)
    } finally { await api.close(); f.clean() }
  }
})

function refreshFixture(f: ReturnType<typeof fixture>, api: Awaited<ReturnType<typeof apiFixture>>) {
  const root = path.join(f.directory, 'refreshed-input')
  fs.cpSync(f.root, root, { recursive: true })
  const manifest = structuredClone(f.manifest), evidence = structuredClone(f.evidence)
  const options = { ...api.options, manifest: path.join(root, 'raw-manifest.json'), evidence: path.join(root, 'build-evidence.json'),
    output: path.join(root, 'calibrated-v2.json'), state: path.join(f.directory, 'state-v2.json'),
    refreshFrom: f.stateFile, refreshManifest: f.manifestFile, refreshEvidence: f.evidenceFile }
  const write = () => { fs.writeFileSync(options.manifest, JSON.stringify(manifest)); fs.writeFileSync(options.evidence, JSON.stringify(evidence)) }
  return { root, manifest, evidence, options, write }
}

test('explicit refresh rechecks unchanged real proofs, resumes a running ID and rebuilds only changed scene 03', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    assert.equal((await calibrate(api.options)).status, 'calibrated')
    const oldState = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'))
    const runningId = oldState.tests[attackId].baseline.id
    delete oldState.tests[attackId].baseline.record
    delete oldState.tests[attackId].baseline.intent
    fs.writeFileSync(f.stateFile, JSON.stringify(oldState, null, 2))
    const original = fs.readFileSync(f.stateFile), oldRecords = structuredClone([...api.records.values()])
    const next = refreshFixture(f, api)
    fs.cpSync(path.join(next.root, 'package'), path.join(next.root, 'scene03'), { recursive: true })
    fs.appendFileSync(path.join(next.root, 'scene03', 'grader.py'), '# corrected reference calibration\n')
    const pkg = structuredClone(next.manifest.packages[0]); pkg.key = 'scene03'; pkg.directory = 'scene03'
    pkg.files.find(file => file.path === 'grader.py')!.sha256 = sha256(fs.readFileSync(path.join(next.root, 'scene03', 'grader.py')))
    next.manifest.packages.push(pkg)
    fs.writeFileSync(path.join(next.root, 'reference03.py'), '# corrected official defaults\ndef solve(): return 3\n')
    const changed = ['V3-261012-A03', 'V3-261012-D03']
    for (const q of next.manifest.questions.filter(q => changed.includes(q.id))) {
      q.packageKey = 'scene03'; q.selfTest.codePath = 'reference03.py'
      q.selfTest.codeSha256 = sha256(fs.readFileSync(path.join(next.root, 'reference03.py')))
    }
    next.write()
    api.records.get(runningId).status = 'running'
    api.settings.beforeRead = async record => {
      if (record.id === runningId) { record.status = 'completed'; api.records.get(runningId).status = 'completed' }
    }
    const requestStart = api.requests.length
    assert.equal((await calibrate({ ...next.options, concurrency: 4 })).status, 'calibrated')
    const state = JSON.parse(fs.readFileSync(next.options.state, 'utf8'))
    assert.equal(api.settings.testPosts, 141, 'only the two changed questions create four new phases')
    assert.equal(api.settings.packagePosts, 2)
    assert.deepEqual(fs.readFileSync(f.stateFile), original)
    assert.deepEqual(state.refreshFrom, { stateDigest: sha256(original), manifestDigest: oldState.manifestDigest, evidenceDigest: oldState.evidenceDigest })
    assert.equal(Object.keys(state.references).length, 75)
    for (const q of next.manifest.questions) for (const phase of q.category === 'basic' ? ['basic'] : ['baseline', 'opponent']) {
      const proof = state.tests[q.id][phase]
      if (changed.includes(q.id)) {
        assert.notEqual(proof.id, oldState.tests[q.id][phase].id)
        assert.equal(state.references[q.id], undefined)
        assert.equal(proof.record.packageId, 'package-2')
      } else {
        assert.equal(proof.id, oldState.tests[q.id][phase].id)
        assert.equal(proof.configurationKey, oldState.tests[q.id][phase].configurationKey)
        assert.equal(state.references[q.id].referenceManifestDigest, oldState.manifestDigest)
        assert.ok(api.requests.slice(requestStart).some(r => r.method === 'GET' && r.route.endsWith('/self-tests/' + proof.id)))
      }
    }
    assert.ok(oldRecords.every(record => api.records.get(record.id).configurationKey === record.configurationKey), 'old server records are never rewritten')
    assert.equal((await importCoursePack({ manifest: next.options.output, stage: 'all', dryRun: true })).status, 'validated')
    assert.equal(fs.existsSync(f.stateFile + '.lock'), false)
    assert.equal(fs.existsSync(next.options.state + '.lock'), false)
  } finally { await api.close(); f.clean() }
})

test('refresh compares complete question JSON and source package files, not only grading keys', async () => {
  for (const change of ['title', 'resources', 'package']) {
    const f = fixture(), api = await apiFixture(f)
    try {
      await calibrate({ ...api.options, only: [attackId] })
      const original = fs.readFileSync(f.stateFile), oldId = JSON.parse(original.toString()).tests[attackId].baseline.id
      const next = refreshFixture(f, api), q = next.manifest.questions.find(q => q.id === attackId)!
      if (change === 'title') q.title += ' clarified'
      if (change === 'resources') q.resources[0].filename = 'renamed-guide.txt'
      if (change === 'package') {
        fs.appendFileSync(path.join(next.root, 'package', 'grader.py'), '# changed\n')
        next.manifest.packages[0].files.find(file => file.path === 'grader.py')!.sha256 = sha256(fs.readFileSync(path.join(next.root, 'package', 'grader.py')))
      }
      next.write()
      await calibrate({ ...next.options, only: [attackId] })
      const state = JSON.parse(fs.readFileSync(next.options.state, 'utf8'))
      assert.equal(state.references[attackId], undefined, change)
      assert.notEqual(state.tests[attackId].baseline.id, oldId, change)
      assert.equal(api.settings.testPosts, 4, change)
      assert.equal(api.settings.packagePosts, change === 'package' ? 2 : 1, change)
      assert.deepEqual(fs.readFileSync(f.stateFile), original)
    } finally { await api.close(); f.clean() }
  }
})

test('refresh is explicit, one-time, source-locked and retains strict resume inputs', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    await calibrate({ ...api.options, only: [attackId] })
    const original = fs.readFileSync(f.stateFile), next = refreshFixture(f, api)
    await assert.rejects(calibrate({ ...next.options, refreshEvidence: undefined }), /requires_all_source_inputs/)
    fs.writeFileSync(f.stateFile + '.lock', 'active original controller')
    await assert.rejects(calibrate(next.options), /refresh_source_state_locked/)
    assert.equal(fs.readFileSync(f.stateFile + '.lock', 'utf8'), 'active original controller')
    fs.unlinkSync(f.stateFile + '.lock')
    await calibrate({ ...next.options, only: [attackId] })
    await assert.rejects(calibrate(next.options), /refresh_target_state_already_exists/)
    const { refreshFrom, refreshManifest, refreshEvidence, ...resume } = next.options
    await calibrate({ ...resume, only: [attackId] })
    assert.equal(api.settings.testPosts, 2)
    next.manifest.questions[0].title += ' changed'; next.write()
    await assert.rejects(calibrate({ ...resume, only: [attackId] }), /calibration_input_changed/)
    assert.deepEqual(fs.readFileSync(f.stateFile), original)
  } finally { await api.close(); f.clean() }
})

test('refresh rejects corrupt source state, unknown scopes and mismatched frozen source identity before saving a target', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    await calibrate({ ...api.options, only: [attackId] })
    const original = fs.readFileSync(f.stateFile), next = refreshFixture(f, api)
    const cases: Array<[string, (state: any) => void, RegExp]> = [
      ['api', s => { s.api += '/different' }, /refresh_source_input_changed/],
      ['manifest', s => { s.manifestDigest = '0'.repeat(64) }, /refresh_source_input_changed/],
      ['evidence', s => { s.evidenceDigest = '0'.repeat(64) }, /refresh_source_input_changed/],
      ['question scope', s => { s.tests.other = {} }, /source_state_invalid/],
      ['package scope', s => { s.packages.other = s.packages.shared }, /source_state_invalid/],
      ['pool scope', s => { s.pools[attackId] = { id: 'wrong' } }, /source_state_invalid/],
      ['phase scope', s => { s.tests[attackId].basic = s.tests[attackId].baseline }, /source_state_invalid/],
      ['borrowed proof', s => { s.tests['V3-261012-D01'] = structuredClone(s.tests[attackId]) }, /source_state_invalid/],
      ['package digest', s => { s.packages.shared.digest = '0'.repeat(64) }, /source_state_invalid/],
      ['configuration', s => { delete s.tests[attackId].baseline.record; s.tests[attackId].baseline.configurationKey = '0'.repeat(64) }, /proof_binding_mismatch/],
      ['cached result metric', s => { delete s.tests[attackId].baseline.record.result.metrics.qualificationMetric }, /metric_missing/],
    ]
    for (const [label, corrupt, expected] of cases) {
      const state = JSON.parse(original.toString()); corrupt(state)
      fs.writeFileSync(f.stateFile, JSON.stringify(state))
      await assert.rejects(calibrate({ ...next.options, only: [attackId] }), expected, label)
      assert.equal(fs.existsSync(next.options.state), false, label)
      assert.equal(fs.existsSync(f.stateFile + '.lock'), false, label)
    }
    fs.writeFileSync(f.stateFile, original)
    next.manifest.sourceArchiveSha256 = 'b'.repeat(64); next.write()
    await assert.rejects(calibrate(next.options), /refresh_source_identity_changed/)
    next.manifest.sourceArchiveSha256 = f.manifest.sourceArchiveSha256; next.write()
    next.evidence.questions[0].sourceId = 'unknown'; next.write()
    await assert.rejects(calibrate(next.options), /refresh_evidence_scope_invalid/)
    next.evidence.questions[0].sourceId = f.evidence.questions[0].sourceId; next.write()
    fs.appendFileSync(path.join(f.root, 'reference.py'), '# invalid old source\n')
    await assert.rejects(calibrate(next.options), /input_digest_mismatch/)
    assert.equal(fs.existsSync(next.options.state), false)
  } finally { await api.close(); f.clean() }
})

test('migrated cached records never bypass live API package, configuration, model or result verification', async () => {
  for (const failure of ['package', 'configuration', 'result', 'model']) {
    const f = fixture(), api = await apiFixture(f)
    try {
      f.manifest.questions.find(q => q.id === attackId)!.definition.llm = { enabled: true, poolId: 'pool-1' }; f.write()
      api.pools.push({ id: 'pool-1', name: 'Frozen model', kind: 'llm', enabled: true, revision: 1, model: 'qwen3-8b',
        modelVersion: '20261016', baseUrl: 'http://gateway.local/v1', credentialEnv: 'PRIVATE_CREDENTIAL_NAME', parameters: { temperature: 0 } })
      await calibrate({ ...api.options, only: [attackId] })
      const original = fs.readFileSync(f.stateFile), next = refreshFixture(f, api)
      if (failure === 'package') api.settings.mutatePackage = record => { record.digest = 'f'.repeat(64) }
      if (failure === 'configuration') api.settings.mutate = record => { record.configurationKey = '0'.repeat(64) }
      if (failure === 'result') api.settings.mutate = record => { record.result.status = 'system_error' }
      if (failure === 'model') api.pools[0].revision++
      await assert.rejects(calibrate({ ...next.options, only: [attackId] }),
        failure === 'package' ? /installed_package_changed/ : failure === 'configuration' ? /binding_mismatch/ : failure === 'result' ? /not_cleaned/ : /source_model_pool_changed/)
      assert.equal(api.settings.testPosts, 2)
      assert.equal(fs.existsSync(next.options.output), false)
      assert.deepEqual(fs.readFileSync(f.stateFile), original)
    } finally { await api.close(); f.clean() }
  }
})
