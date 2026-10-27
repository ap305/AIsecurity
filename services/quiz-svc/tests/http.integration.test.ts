import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'
let database: Awaited<ReturnType<typeof createTestDatabase>>,
  prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server,
  upstream: http.Server,
  base: string,
  upstreamUrl: string,
  token: string,
  otherToken: string
let id: string, lastModel: any, snapshotUpstreamCalls = 0, packageRoot: string
const definition = {
  kind: 'algorithm',
  weights: { enabled: false, required: false, extensions: ['.json'], maxBytes: 1000 },
  teacherApi: { enabled: true, poolId: 'teacher', maxCalls: 2 },
  llm: { enabled: false },
  evaluation: {
    packageId: 'test-package',
    version: 'v1',
    timeoutMs: 10000,
    maxScore: 100,
    baselineMetric: 'qualificationMetric',
    baselineThreshold: 0.5,
    successMetric: 'successMetric',
    successThreshold: 0.5,
    repetitions: 1,
  },
}
async function request(url: string, options: RequestInit = {}, auth = token) {
  const response = await fetch(`${base}${url}`, {
    ...options,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(options.headers || {}) },
  })
  return { status: response.status, json: (await response.json()) as any }
}
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
before(async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
  packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'http-evaluation-packages-'))
  process.env.EVALUATION_PACKAGE_ROOT = packageRoot
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  upstream = http
    .createServer((req, res) => {
      if (req.url === '/health' || req.url === '/models') {
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
        return
      }
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        lastModel = JSON.parse(data || '{}')
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/snapshot/chat/completions') {
          snapshotUpstreamCalls++
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'first response ' + snapshotUpstreamCalls } }] }))
          return
        }
        res.end(JSON.stringify({ ok: true, answer: 7 }))
      })
    })
    .listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => upstream.once('listening', resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  for (const username of ['student1', 'student2']) {
    const registered = await request(
      '/auth/register',
      post({
        username,
        password: 'test123456',
        displayName: username,
        studentId: username === 'student1' ? '001234' : '',
      }),
      '',
    )
    assert.equal(registered.status, 200)
    const logged = await request(
      '/auth/login',
      post({ username, password: 'test123456', role: 'student' }),
      '',
    )
    if (username === 'student1') {
      token = logged.json.data.token
      id = logged.json.data.user.id
    } else otherToken = logged.json.data.token
  }
  const binding = {
    poolId: 'teacher',
    revision: 1,
    name: 'teacher',
    kind: 'teacher',
    model: 'teacher',
    modelVersion: 'v1',
    baseUrl: upstreamUrl,
    credentialEnv: null,
    parameters: {},
  }
  await prisma.question.create({
    data: {
      id: 'algo',
      title: '算法题',
      content: '# 题面',
      moduleCode: 'T',
      number: 1,
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      definition: JSON.stringify(definition),
      answerTemplate: 'answer',
    },
  })
  await prisma.questionRevision.create({
    data: {
      questionId: 'algo',
      revision: 1,
      snapshot: JSON.stringify({
        questionId: 'algo',
        questionVersion: 1,
        category: 'basic',
        scenarioId: null,
        role: null,
        evaluationVersion: 'v1',
        definition,
        teacherBinding: binding,
      }),
    },
  })
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
  if (packageRoot) await (await import('node:fs/promises')).rm(packageRoot, { recursive: true, force: true })
})
test('authenticated hall exposes public configuration and optional registration fields', async () => {
  assert.equal((await request('/questions', {}, '')).status, 401)
  const list = await request('/questions?category=basic')
  assert.equal(list.json.data.length, 1)
  assert.equal(list.json.data[0].testConfig, undefined)
  assert.equal(list.json.data[0].solution, undefined)
  assert.equal((await request('/auth/me')).json.data.user.studentId, '001234')
  assert.equal((await request('/admin/questions')).status, 403)
})
test('AC-03/18: material rules and idempotent authenticated immutable submissions', async () => {
  const form = () => {
    const f = new FormData()
    f.set('questionId', 'algo')
    f.set('questionVersion', '1')
    f.set('code', 'answer')
    f.set('idempotencyKey', 'same-request-key')
    f.set('userId', 'forged')
    return f
  }
  const withFile = form()
  withFile.set('file', new Blob(['{}']), 'weights.json')
  assert.equal((await request('/submissions', { method: 'POST', body: withFile })).status, 400)
  const first = await request('/submissions', { method: 'POST', body: form() })
  assert.equal(first.status, 200)
  assert.equal(first.json.data.userId, id)
  assert.equal(first.json.data.status, 'queued')
  const duplicate = await request('/submissions', { method: 'POST', body: form() })
  assert.equal(duplicate.json.data.id, first.json.data.id)
  assert.equal(await prisma.evaluationTask.count(), 1)
  assert.equal((await request(`/submissions/${first.json.data.id}`, {}, otherToken)).status, 404)
  assert.equal((await request('/questions/algo/submissions', {}, otherToken)).json.data.length, 0)
  assert.equal(first.json.data.configSnapshot, undefined)
  assert.equal(first.json.data.filePath, undefined)
})
test('AC-01: worker persists completed score through unified API result', async () => {
  const { configureEvaluationRuntime, processEvaluationTask } =
    await import('../src/services/evaluationWorker.js')
  configureEvaluationRuntime({
    run: async () => ({ status: 'completed', score: 75, maxScore: 100, cleanupStatus: 'cleaned' }),
  })
  const task = await prisma.evaluationTask.findFirstOrThrow()
  await processEvaluationTask(task.id)
  await processEvaluationTask(task.id)
  const result = await request(`/submissions/${task.submissionId}`)
  assert.equal(result.json.data.score, 75)
  assert.equal(result.json.data.status, 'completed')
  assert.equal((await request('/leaderboard')).json.data[0].totalScore, 75)
})
test('AC-11/12/13: readiness starts two hours, refresh preserves expiry, renewal requires expiry, revoke immediately blocks', async () => {
  const started = await request('/questions/algo/teacher-lease/start', post({}))
  assert.equal(started.status, 200)
  const lease = started.json.data
  assert.equal(lease.state, 'active')
  assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.startsAt), 7200000)
  assert.equal(
    (await request('/questions/algo/teacher-lease/start', post({}))).json.data.expiresAt,
    lease.expiresAt,
  )
  assert.equal((await request('/questions/algo/teacher-lease/renew', post({}))).status, 400)
  assert.equal((await request(`/teacher/${lease.id}/query`, post({ x: 1 }), lease.token)).status, 200)
  await prisma.teacherLease.update({ where: { id: lease.id }, data: { expiresAt: new Date(Date.now() - 1) } })
  assert.equal((await request(`/teacher/${lease.id}/query`, post({ x: 1 }), lease.token)).status, 403)
  assert.equal((await request('/questions/algo/teacher-lease/start', post({}))).status, 400)
  const renewed = await request('/questions/algo/teacher-lease/renew', post({}))
  assert.equal(renewed.json.data.state, 'active')
  assert.notEqual(renewed.json.data.token, lease.token)
  await prisma.teacherLease.update({ where: { id: lease.id }, data: { state: 'revoked' } })
  assert.equal(
    (await request(`/teacher/${lease.id}/query`, post({ x: 1 }), renewed.json.data.token)).status,
    403,
  )
  assert.equal((await request('/questions/algo/teacher-lease/start', post({}))).status, 403)
})
test('legacy role/model entry points cannot bypass authentication or new scoring', async () => {
  assert.equal((await request('/matches/run', post({ userId: 'forged' }))).status, 410)
  assert.equal((await request('/v1/chat/completions', post({ model: 'other', messages: [] }))).status, 403)
})
test('AC-14/22: scoped model gateway pins the upstream model, counts concurrent calls and stops when the task ends', async () => {
  const { submissionGateway } = await import('../src/services/apiPool.js')
  const { normalizeDefinition } = await import('../src/lib/prdContract.js')
  const snapshot = {
    questionId: 'algo',
    questionVersion: 1,
    category: 'basic',
    role: null,
    scenarioId: null,
    evaluationVersion: 'v1',
    definition: normalizeDefinition(definition),
    modelBinding: {
      poolId: 'fixed',
      revision: 7,
      name: '固定模型',
      kind: 'llm',
      model: 'qwen3-8b',
      modelVersion: 'model-r7',
      baseUrl: upstreamUrl,
      credentialEnv: null,
      parameters: { maxCalls: 1, temperature: 0, max_tokens: 64 },
    },
  }
  await prisma.submission.create({
    data: {
      id: 'model-gateway-test',
      questionId: 'algo',
      userId: id,
      code: 'agent',
      status: 'judging',
      questionVersion: 1,
      configSnapshot: JSON.stringify(snapshot),
    },
  })
  const task = await prisma.evaluationTask.create({
    data: { submissionId: 'model-gateway-test', state: 'running' },
  })
  const gateway = submissionGateway(snapshot, 'model-gateway-test')!
  const route = '/evaluation-gateway/model-gateway-test/chat/completions'
  const body = {
    model: 'forged-model',
    temperature: 1,
    max_tokens: 1000000,
    apiKey: 'student-key',
    messages: [{ role: 'user', content: 'question' }],
  }
  assert.equal((await request(route, post(body), token)).status, 401)
  const responses = await Promise.all([
    request(route, post(body), gateway.token),
    request(route, post(body), gateway.token),
  ])
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429])
  assert.equal(lastModel.model, 'qwen3-8b')
  assert.equal(lastModel.temperature, 0)
  assert.equal(lastModel.max_tokens, 64)
  assert.equal(lastModel.apiKey, undefined)
  const nextPhase = submissionGateway(snapshot, 'model-gateway-test')!
  assert.equal((await request(route, post(body), nextPhase.token)).status, 200)
  await prisma.evaluationTask.update({ where: { id: task.id }, data: { state: 'completed' } })
  assert.equal((await request(route, post(body), nextPhase.token)).status, 403)
})

test('approved snapshot gateway keeps per-attempt budgets, records hits separately, and rejects ended tasks', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-snapshot-'))
  const old = process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT
  process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = root
  t.after(async () => {
    if (old === undefined) delete process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT
    else process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = old
    await fs.rm(root, { recursive: true, force: true })
  })
  const { submissionGateway } = await import('../src/services/apiPool.js')
  const { normalizeDefinition } = await import('../src/lib/prdContract.js')
  const def = normalizeDefinition({ ...definition, llm: { enabled: true, poolId: 'snapshot-test' }, evaluation: {
    ...definition.evaluation, version: 'snapshot-v11', packageDigest: 'a'.repeat(64),
    parameters: { responseSnapshotPolicy: 'first-valid-response-v1', responseSnapshotScope: 'V3-261012-A09' },
  } })
  const snapshot = { questionId: 'algo', questionVersion: 1, category: 'basic' as const, role: null, scenarioId: null,
    evaluationVersion: 'snapshot-v11', definition: def, modelBinding: {
      poolId: 'snapshot-test', revision: 1, name: 'snapshot', kind: 'llm', model: 'Qwen/Qwen3-8B', modelVersion: 'fixed',
      baseUrl: upstreamUrl + '/snapshot', credentialEnv: null, parameters: { maxCalls: 1, temperature: 0 },
    } }
  const sid = 'snapshot-gateway-test'
  await prisma.submission.create({ data: { id: sid, questionId: 'algo', userId: id, code: 'synthetic', status: 'judging', questionVersion: 1, configSnapshot: JSON.stringify(snapshot) } })
  const task = await prisma.evaluationTask.create({ data: { submissionId: sid, state: 'running' } })
  const route = '/evaluation-gateway/' + sid + '/chat/completions'
  const body = { messages: [{ role: 'user', content: 'snapshot-fixed' }] }
  const first = submissionGateway(snapshot, sid)!
  const a = await request(route, post(body), first.token)
  assert.equal(a.status, 200)
  assert.equal((await request(route, post(body), first.token)).status, 429)
  const second = submissionGateway(snapshot, sid)!
  const b = await request(route, post({ ...body, model: 'forged', responseSnapshotScope: 'other' }), second.token)
  assert.equal(b.status, 200); assert.deepEqual(b.json, a.json); assert.equal(snapshotUpstreamCalls, 1)
  assert.equal(await prisma.auditEvent.count({ where: { action: 'model.upstream.call', targetId: { startsWith: sid + ':' } } }), 1)
  assert.equal(await prisma.auditEvent.count({ where: { action: 'model.snapshot.hit', targetId: { startsWith: sid + ':' } } }), 1)
  await prisma.evaluationTask.update({ where: { id: task.id }, data: { state: 'completed' } })
  assert.equal((await request(route, post(body), submissionGateway(snapshot, sid)!.token)).status, 403)
  assert.equal(snapshotUpstreamCalls, 1)
})

test('self-test snapshot gateway preserves logical budgets and separate actual-call evidence', async t => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'selftest-response-snapshot-'))
  process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = root
  t.after(async () => { delete process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT; await fs.rm(root, { recursive: true, force: true }) })
  const packages = await import('../src/lib/evaluationPackage.js')
  const pkg = await packages.importEvaluationDirectory(path.join(packages.EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'))
  const { randomUUID } = await import('node:crypto')
  const { signScopedToken } = await import('../src/lib/auth.js')
  const testId = randomUUID(), dir = path.join(packages.packageDirectory(pkg.id), '_self-tests')
  await fs.mkdir(dir)
  const poolBinding = { poolId: 'selftest-snapshot', revision: 1, name: 'fixture', kind: 'llm', model: 'Qwen/Qwen3-8B', modelVersion: 'fixture', baseUrl: upstreamUrl + '/snapshot', credentialEnv: null, parameters: { maxCalls: 2 } }
  const file = path.join(dir, testId + '.json')
  const record = { id: testId, packageId: pkg.id, packageDigest: pkg.digest, phase: 'baseline', configurationKey: 'fixture', status: 'running', calls: 0, poolBinding,
    responseSnapshot: { policy: 'first-valid-response-v1', scope: 'V3-261012-A09', evaluationVersion: 'v11', packageDigest: pkg.digest } }
  await fs.writeFile(file, JSON.stringify(record))
  const auth = signScopedToken({ purpose: 'selftest', testId, packageId: pkg.id, packageDigest: pkg.digest, poolBinding, exp: Date.now() + 60000 })
  const route = '/evaluation-self-test-gateway/' + testId + '/chat/completions'
  const body = { messages: [{ role: 'user', content: 'synthetic self-test' }] }
  const beforeCalls = snapshotUpstreamCalls
  assert.equal((await request(route, post(body), token)).status, 403)
  const a = await request(route, post(body), auth), b = await request(route, post(body), auth)
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.deepEqual(a.json, b.json)
  assert.equal(snapshotUpstreamCalls - beforeCalls, 1)
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(saved.calls, 2); assert.equal(saved.upstreamCalls, 1); assert.equal(saved.responseSnapshotHits, 1)
  assert.equal((await request(route, post(body), auth)).status, 400)
  await fs.writeFile(file, JSON.stringify({ ...saved, status: 'completed' }))
  assert.equal((await request(route, post(body), auth)).status, 400)
  assert.equal(snapshotUpstreamCalls - beforeCalls, 1)
})

test('original D02 self-test allows its expanded calls while respecting the frozen pool limit', async () => {
  const fs = await import('node:fs/promises'), path = await import('node:path')
  const packages = await import('../src/lib/evaluationPackage.js')
  const { evaluationModelCallLimit } = await import('../src/lib/modelCallBudget.js')
  const { randomUUID } = await import('node:crypto')
  const { signScopedToken } = await import('../src/lib/auth.js')
  const pkg = await packages.importEvaluationDirectory(path.join(packages.EVALUATION_EXAMPLE_ROOT, 'basic-algorithm'))
  const directory = path.join(packages.packageDirectory(pkg.id), '_self-tests')
  await fs.mkdir(directory, { recursive: true })
  const expanded = evaluationModelCallLimit({ version: 'v3-261012-d02-original300-v12', maxModelCalls: 3600,
    parameters: { number: '02', role: 'defense', samples: 300 } }, 'defense')
  for (const [poolLimit, modelCallLimit, accepted] of [[3600, expanded, 3600], [1200, expanded, 1200], [3600, undefined, 1000]]) {
    const testId = randomUUID(), file = path.join(directory, testId + '.json')
    const poolBinding = { poolId: 'original-d02-isolated', revision: 1, name: 'fixture', kind: 'llm', model: 'Qwen/Qwen3-8B',
      modelVersion: 'fixture', baseUrl: upstreamUrl, credentialEnv: null, parameters: { maxCalls: poolLimit } }
    await fs.writeFile(file, JSON.stringify({ id: testId, packageId: pkg.id, packageDigest: pkg.digest, phase: 'baseline',
      configurationKey: 'fixture', status: 'running', calls: accepted! - 1, poolBinding, modelCallLimit }))
    const auth = signScopedToken({ purpose: 'selftest', testId, packageId: pkg.id, packageDigest: pkg.digest, poolBinding, exp: Date.now() + 60000 })
    const route = '/evaluation-self-test-gateway/' + testId + '/chat/completions'
    const body = { messages: [{ role: 'user', content: 'local budget fixture' }] }
    assert.equal((await request(route, post(body), auth)).status, 200)
    assert.equal((await request(route, post(body), auth)).status, 400)
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).calls, accepted)
  }
})
