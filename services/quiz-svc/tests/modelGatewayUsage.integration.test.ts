import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let pool: typeof import('../src/services/apiPool.js')
let server: http.Server, upstream: http.Server, base: string, url: string, snapshotRoot: string
let studentToken: string, adminToken: string, actorId: string
let healthCalls = 0, healthStatus = 401, chatCalls = 0, chatStatus = 200
const privateText = 'fixture-secret-token-private-upstream-body'
const input = { messages: [{ role: 'user', content: 'private prompt' }] }
const result = { choices: [{ message: { role: 'assistant', content: 'safe synthetic answer' } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }
const tracking = { source: 'evaluation' as const, kind: 'llm' as const, actorId: 'fixture-actor', questionId: 'fixture-question' }
let binding: any

async function request(route: string, token = studentToken, body?: unknown) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, headers: response.headers, body: await response.json() as any }
}

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  pool = await import('../src/services/apiPool.js')
  upstream = http.createServer((req, res) => {
    req.resume()
    if (req.url === '/models') {
      healthCalls++
      res.writeHead(healthStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: privateText }))
    } else {
      chatCalls++
      res.writeHead(chatStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(chatStatus === 200 ? result : { error: privateText }))
    }
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => upstream.once('listening', resolve))
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const cfg = (await import('../src/lib/llmConfig.js')).getGatewayConfig()
  Object.assign(cfg, { baseUrl: url, apiKey: '', enabled: true, modelName: 'fixture-model' })
  binding = { poolId: 'fixture-pool', revision: 1, name: 'fixture', kind: 'llm', model: 'fixture-model', modelVersion: 'v1', baseUrl: url, credentialEnv: null, parameters: {} }
  snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-snapshot-'))
  process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = snapshotRoot
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  for (const role of ['student', 'admin']) {
    const username = `usage${role}`
    const registered = await request('/auth/register', '', { username, password: 'Test passphrase 123456', displayName: username })
    assert.equal(registered.status, 200, JSON.stringify(registered.body))
    if (role === 'admin') await prisma.user.update({ where: { username }, data: { role: 'admin' } })
    const login = await request('/auth/login', '', { username, password: 'Test passphrase 123456', role })
    assert.equal(login.status, 200)
    if (role === 'student') { studentToken = login.body.data.token; actorId = login.body.data.user.id }
    else adminToken = login.body.data.token
  }
})
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
  if (snapshotRoot) await fs.rm(snapshotRoot, { recursive: true, force: true })
})

test('anonymous health is rejected before contacting provider; authenticated checks are cached and sanitized', async () => {
  const count = healthCalls
  assert.equal((await request('/llm/health', '')).status, 401)
  assert.equal(healthCalls, count)
  const checks = await Promise.all(Array.from({ length: 5 }, () => request('/llm/health')))
  assert.equal(healthCalls, count + 1)
  for (const check of checks) {
    assert.equal(check.status, 200)
    assert.equal(check.body.data.status, 401)
    assert.ok(!JSON.stringify(check.body).includes(privateText))
    assert.match(check.headers.get('cache-control') || '', /no-store/)
  }
})

test('ordinary gateway records actual usage, while cached replies do not count tokens twice', async () => {
  const context = { ...tracking, actorId }
  const first = await pool.callPool(binding, input, false, false, undefined, context)
  assert.deepEqual(first, result)
  const rows = await prisma.modelUsageRecord.findMany({ where: { actorId, kind: 'llm' } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].totalTokens, 10)
  assert.equal(rows[0].outcome, 'success')
  assert.equal(rows[0].poolId, binding.poolId)
  const snapshot = { policy: 'first-valid-response-v1', scope: 'V3-261012-A09', evaluationVersion: 'v11', packageDigest: 'a'.repeat(64) }
  const before = chatCalls
  await pool.callPoolWithResponseSnapshot(binding, input, snapshot, async () => {}, context)
  await pool.callPoolWithResponseSnapshot(binding, input, snapshot, async () => {}, context)
  assert.equal(chatCalls, before + 1)
  const after = await prisma.modelUsageRecord.findMany({ where: { actorId, kind: 'llm' } })
  assert.equal(after.length, 3)
  assert.equal(after.filter(row => row.isSnapshot).length, 1)
  assert.equal(after.filter(row => row.isSnapshot)[0].totalTokens, null)
  assert.equal(after.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0), 20)
  assert.ok(!JSON.stringify(after).includes('private prompt'))
  assert.ok(!JSON.stringify(after).includes('safe synthetic answer'))
})

test('provider failure is tracked without retaining its body or changing the existing non-scoring error', async () => {
  chatStatus = 402
  try {
    await assert.rejects(pool.callPool(binding, input, false, false, undefined, tracking), (error: any) => error.status === 502)
    const row = await prisma.modelUsageRecord.findFirstOrThrow({ where: { actorId: tracking.actorId } })
    assert.equal(row.outcome, 'http_error')
    assert.equal(row.httpStatus, 402)
    assert.equal(row.totalTokens, null)
    assert.ok(!JSON.stringify(row).includes(privateText))
  } finally { chatStatus = 200 }
})

test('telemetry database errors cannot replace a successful model response', async t => {
  t.mock.method(prisma, '$transaction', async () => { throw new Error(privateText) })
  const log = t.mock.method(console, 'warn', () => {})
  assert.deepEqual(await pool.callPool(binding, input, false, false, undefined, tracking), result)
  assert.ok(!JSON.stringify(log.mock.calls.map(call => call.arguments)).includes(privateText))
})

test('connection tests require admin and return only sanitized upstream errors', async () => {
  assert.equal((await request('/llm/test-connection', studentToken, { baseUrl: url })).status, 403)
  chatStatus = 401
  try {
    const response = await request('/llm/test-connection', adminToken, { baseUrl: url, model: 'fixture-model' })
    assert.equal(response.status, 200)
    assert.equal(response.body.data.ok, false)
    assert.equal(response.body.data.status, 401)
    assert.ok(!JSON.stringify(response.body).includes(privateText))
    assert.equal(await prisma.modelUsageRecord.count({ where: { source: 'admin_test', kind: 'llm', httpStatus: 401 } }), 1)
  } finally { chatStatus = 200 }
})

test('API pool rejects nested credentials server-side before persisting configuration', async () => {
  for (const parameters of [{ apiKey: privateText }, { headers: { Authorization: privateText } }, { rows: [{ secret: privateText }] }]) {
    await assert.rejects(pool.savePool(null, { name: 'safe', kind: 'llm', model: 'fixture-model', modelVersion: 'v1', baseUrl: url, parameters }, 'admin'), /凭证/)
  }
  assert.equal(await prisma.apiPool.count(), 0)
  const parameters = { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { token: { type: 'string' }, secret_code: { type: 'string' } } } } }] }
  const saved = await pool.savePool(null, { name: 'schema', kind: 'llm', model: 'fixture-model', modelVersion: 'v1', baseUrl: url, parameters }, 'admin')
  assert.deepEqual(saved.parameters, parameters)
})

test('teacher service health calls are observed without becoming model inference attempts', async () => {
  assert.equal(await pool.poolHealthy(binding, { source: 'teacher', kind: 'health', actorId }), false)
  const row = await prisma.modelUsageRecord.findFirstOrThrow({ where: { source: 'teacher', kind: 'health' } })
  assert.equal(row.httpStatus, 401)
  assert.equal(row.totalTokens, null)
  const before = await prisma.modelUsageRecord.count()
  const requests = healthCalls
  assert.equal(await pool.poolHealthy({ ...binding, credentialEnv: 'FIXTURE_MISSING_PROVIDER_SECRET' }, { source: 'teacher', kind: 'health', actorId }), false)
  assert.equal(await prisma.modelUsageRecord.count(), before)
  assert.equal(healthCalls, requests)
})
