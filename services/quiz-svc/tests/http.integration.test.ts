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
let id: string, lastModel: any
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
