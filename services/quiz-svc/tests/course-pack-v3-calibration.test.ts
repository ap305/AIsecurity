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
  const requests: Array<{ method: string; route: string; body?: any }> = []
  const records = new Map<string, any>()
  const pools: any[] = []
  const descriptor = { id: 'package-1', digest: f.packageDigest, valid: true, manifest: { image } }
  const settings = { dropTestResponse: false, dropPackageResponse: false, testPosts: 0, packagePosts: 0,
    success: 0.2, calls: 2, installed: false, mutate: (_record: any, _read: number) => {}, mutatePackage: (_record: any) => {} }
  const reads = new Map<string, number>()
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url || '', 'http://localhost').pathname.slice(4), method = req.method || 'GET'
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks)
    const body = String(req.headers['content-type']).includes('application/json') ? JSON.parse(raw.toString() || '{}') : null
    requests.push({ method, route, body })
    const send = (data: any, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: status < 400 ? 0 : status, message: 'PRIVATE_SERVER_MESSAGE_SENTINEL', data }))
    }
    if (req.headers.authorization !== `Bearer ${privateToken}`) return send(null, 401)
    if (route === '/admin/api-pool') return send(pools)
    if (route === '/admin/evaluation-packages') {
      if (method === 'GET') return send(settings.installed ? [descriptor] : [])
      settings.packagePosts++; settings.installed = true
      if (settings.dropPackageResponse) { settings.dropPackageResponse = false; req.socket.destroy(); return }
      const value = structuredClone(descriptor); settings.mutatePackage(value)
      return send(value, 201)
    }
    if (route === '/admin/evaluation-packages/package-1/validate') {
      const value = structuredClone(descriptor); settings.mutatePackage(value); return send(value)
    }
    if (route === '/admin/evaluation-packages/package-1/self-tests' && method === 'POST') {
      settings.testPosts++
      const id = randomUUID(), pool = body.definition.llm.enabled ? pools.find(p => p.id === body.definition.llm.poolId) : undefined
      const binding = pool ? { poolId: pool.id, revision: pool.revision, name: pool.name, kind: pool.kind, model: pool.model,
        modelVersion: pool.modelVersion, baseUrl: pool.baseUrl, credentialEnv: pool.credentialEnv, parameters: pool.parameters } : undefined
      const record = { id, packageId: descriptor.id, packageDigest: descriptor.digest, phase: body.phase,
        configurationKey: selfTestConfigurationKey(normalizeDefinition(body.definition), body.role ?? null, body.category, binding),
        status: 'completed', calls: settings.calls,
        result: { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 0.4, successMetric: settings.success },
          score: 100, maxScore: 100, message: 'PRIVATE_RESULT_SENTINEL' }, privateCode: body.code, privateWeights: 'PRIVATE_WEIGHTS_SENTINEL' }
      records.set(id, record)
      if (settings.dropTestResponse) { settings.dropTestResponse = false; req.socket.destroy(); return }
      return send(record, 202)
    }
    const match = route.match(/^\/admin\/evaluation-packages\/package-1\/self-tests\/([^/]+)$/)
    if (match) {
      if (!records.has(match[1])) return send(null, 404)
      const count = (reads.get(match[1]) ?? 0) + 1; reads.set(match[1], count)
      const record = structuredClone(records.get(match[1])); settings.mutate(record, count); return send(record)
    }
    return send(null, 404)
  }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  return { requests, records, pools, settings,
    options: { manifest: f.manifestFile, evidence: f.evidenceFile, state: f.stateFile, output: f.output,
      api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, tokenFile: f.tokenFile, pollMs: 0, log: (_event: any) => {} },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('HTTP calibration resumes partial work, binds reference material and creates only a complete importable manifest', async () => {
  const f = fixture(), api = await apiFixture(f)
  try {
    api.settings.success = 0
    const partial = await calibrate({ ...api.options, only: [attackId] })
    assert.equal(partial.status, 'partial'); assert.equal(fs.existsSync(f.output), false)
    assert.equal(api.settings.testPosts, 2)
    await calibrate({ ...api.options, only: [attackId] })
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
