import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let usage: typeof import('../src/services/modelUsage.js') | null
let server: http.Server | undefined, base: string, adminToken: string, studentToken: string
const context = { actorId: 'student', questionId: 'question', submissionId: 'submission', poolId: 'pool', model: 'model-1', source: 'evaluation' as const, kind: 'llm' as const }
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  usage = await import('../src/services/modelUsage.js').catch(() => null)
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  for (const [id, role] of [['admin', 'admin'], ['student', 'student']]) {
    await prisma.user.create({ data: { id, username: id, displayName: `姓名 ${id}`, role, isTestAccount: id === 'student', password: hashPassword('fixture-password'), phone: 'PRIVATE_PHONE' } })
  }
  adminToken = (await loginUser('admin', 'fixture-password', 'admin')).token
  studentToken = (await loginUser('student', 'fixture-password', 'student')).token
  await prisma.question.create({ data: { id: 'question', moduleCode: 'TEST', number: 1, title: '观察测试题', content: 'PRIVATE_QUESTION', type: 'code', difficulty: 'L1', category: 'basic' } })
  await prisma.submission.create({ data: { id: 'submission', userId: 'student', questionId: 'question', code: 'PRIVATE_CODE', score: 83, status: 'completed', result: 'PRIVATE_RESULT' } })
  await prisma.basicScore.create({ data: { userId: 'student', questionId: 'question', questionVersion: 1, score: 83, submissionId: 'submission' } })
  const router = await import('../src/routes/modelUsage.js').catch(() => null)
  if (router) {
    const app = express().use(express.json()).use(router.default)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server!.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
})
beforeEach(async () => {
  await prisma.modelUsageAlert.deleteMany()
  await prisma.modelUsageRecord.deleteMany()
  await prisma.modelUsagePolicy.deleteMany()
})
after(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  await prisma?.$disconnect()
  await database?.close()
})

async function request(route = '/admin/model-usage', method = 'GET', body?: unknown, token = adminToken) {
  assert.ok(server, 'administrator observation router must exist')
  const response = await fetch(`${base}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, cache: response.headers.get('cache-control'), json: await response.json() as any }
}
async function record(outcome: string, extra: Record<string, unknown> = {}, ctx = context) {
  assert.ok(usage, 'observation service must exist')
  const id = await usage.startModelUsage(ctx)
  assert.ok(id)
  await usage.finishModelUsage(id, { outcome, ...extra } as any)
  return id
}

test('migration creates only independent observation tables without foreign keys into student data', async () => {
  const { rows } = await database.db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ModelUsage%' ORDER BY table_name`,
  )
  assert.deepEqual(rows.map(row => row.table_name), ['ModelUsageAlert', 'ModelUsagePolicy', 'ModelUsageRecord'])
  const keys = await database.db.query(`SELECT 1 FROM information_schema.table_constraints WHERE table_name LIKE 'ModelUsage%' AND constraint_type = 'FOREIGN KEY'`)
  assert.equal(keys.rows.length, 0)
})

test('concurrent repeated begin and finish record one attempt and preserve the first completed outcome', async () => {
  assert.ok(usage, 'observation service must exist')
  const ids = await Promise.all(Array.from({ length: 6 }, () => usage!.startModelUsage({ ...context, requestId: 'stable-attempt' })))
  assert.equal(new Set(ids).size, 1)
  assert.equal(ids[0], 'stable-attempt')
  await Promise.all(ids.map(id => usage!.finishModelUsage(id, { outcome: 'success', inputTokens: 8, outputTokens: 2, totalTokens: 10 })))
  await usage.finishModelUsage(ids[0], { outcome: 'timeout', totalTokens: 999 })
  const dashboard = await usage.getModelUsageDashboard()
  assert.equal(dashboard.allTime.upstreamAttempts, 1)
  assert.equal(dashboard.allTime.successes, 1)
  assert.equal(dashboard.allTime.failures, 0)
  assert.equal(dashboard.allTime.totalTokens, 10)
  assert.equal(await prisma.modelUsageRecord.count(), 1)
})

test('snapshot and health tokens are never counted, missing or invalid tokens remain unknown, and zero is known', async () => {
  assert.ok(usage, 'observation service must exist')
  await record('success', { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  await record('success', { inputTokens: '30', outputTokens: -4, totalTokens: Number.NaN })
  await record('http_error', { httpStatus: 503 })
  await usage.startModelUsage(context)
  await usage.recordModelUsageSnapshot(context)
  const cacheId = await usage.startModelUsage({ ...context, snapshot: true })
  await usage.finishModelUsage(cacheId, { outcome: 'snapshot', totalTokens: 900, inputTokens: 800, outputTokens: 100 })
  await record('success', { totalTokens: 500 }, { ...context, source: 'health', kind: 'health' } as any)
  await record('success', {}, { ...context, source: 'teacher', kind: 'teacher' } as any)
  const totals = (await usage.getModelUsageDashboard()).allTime
  assert.deepEqual(totals, { upstreamAttempts: 4, successes: 2, failures: 1, pending: 1, snapshotHits: 2, teacherRequests: 1, healthChecks: 1, knownUsageRequests: 1, unknownUsageRequests: 3, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  const filtered = await prisma.modelUsageRecord.findMany({ where: { OR: [{ isSnapshot: true }, { kind: 'health' }] } })
  assert.ok(filtered.every(row => row.totalTokens === null && row.inputTokens === null && row.outputTokens === null))
  await prisma.modelUsageRecord.deleteMany({ where: { totalTokens: 0 } })
  assert.equal((await usage.getModelUsageDashboard()).allTime.totalTokens, null)
})

test('daily statistics use Beijing midnight, fill empty days, and preserve incomplete calls across reads', async () => {
  assert.ok(usage, 'observation service must exist')
  for (const [id, createdAt] of [['old', '2026-11-09T15:59:59.999Z'], ['yesterday', '2026-11-09T16:00:00.000Z'], ['today', '2026-11-10T16:00:00.000Z']]) {
    await prisma.modelUsageRecord.create({ data: { id, ...context, createdAt: new Date(createdAt) } })
  }
  const d = await usage.getModelUsageDashboard(2, new Date('2026-11-11T01:00:00.000Z'))
  assert.equal(d.from, '2026-11-09T16:00:00.000Z')
  assert.equal(d.to, '2026-11-11T16:00:00.000Z')
  assert.equal(d.today.upstreamAttempts, 1)
  assert.equal(d.range.upstreamAttempts, 2)
  assert.equal(d.allTime.upstreamAttempts, 3)
  assert.equal(d.range.pending, 2)
  assert.deepEqual(d.daily.map(row => [row.day, row.upstreamAttempts]), [['2026-11-10', 1], ['2026-11-11', 1]])
  assert.equal((await usage.getModelUsageDashboard(7, new Date('2026-11-11T01:00:00Z'))).daily.length, 7)
  assert.equal(d.coverage.startedAt, '2026-11-09T15:59:59.999Z')
  assert.equal(d.coverage.historicalUsage, 'unknown')
})

test('admin summaries expose only account and question labels and never mutate existing scores', async () => {
  assert.ok(usage, 'observation service must exist')
  const before = JSON.stringify(await Promise.all([prisma.submission.findMany(), prisma.basicScore.findMany(), prisma.user.findMany(), prisma.question.findMany()]))
  await record('success', { totalTokens: 20, error: 'sk-PRIVATE_ERROR', body: 'PRIVATE_RESPONSE' })
  const d = await usage.getModelUsageDashboard()
  assert.equal(d.byUser[0].username, 'student')
  assert.equal(d.byUser[0].displayName, '姓名 student')
  assert.equal(d.byUser[0].isTestAccount, true)
  assert.equal(d.byQuestion[0].title, '观察测试题')
  assert.equal(d.byModel[0].model, 'model-1')
  assert.ok(!JSON.stringify(d).includes('PRIVATE_'))
  assert.ok(!JSON.stringify(await prisma.modelUsageRecord.findMany()).includes('PRIVATE_'))
  assert.equal(JSON.stringify(await Promise.all([prisma.submission.findMany(), prisma.basicScore.findMany(), prisma.user.findMany(), prisma.question.findMany()])), before)
})

test('80 and 100 percent warnings are deduplicated, acknowledging preserves history and new events reopen', async () => {
  assert.ok(usage, 'observation service must exist')
  await prisma.modelUsagePolicy.create({ data: { id: 'default', globalDaily: 5, userDaily: 5, globalTotal: 5, userTotal: 5 } })
  for (let i = 0; i < 3; i++) await usage.startModelUsage(context)
  assert.equal(await prisma.modelUsageAlert.count(), 0)
  await usage.startModelUsage(context)
  const warned = await prisma.modelUsageAlert.findMany()
  assert.equal(warned.length, 4)
  assert.ok(warned.every(row => row.severity === 'warning'))
  await usage.startModelUsage(context)
  assert.equal(await prisma.modelUsageAlert.count(), 8)
  const alert = (await prisma.modelUsageAlert.findFirst({ where: { severity: 'critical', scope: 'global', period: 'daily' } }))!
  await usage.acknowledgeModelUsageAlert(alert.id, 'admin')
  await usage.acknowledgeModelUsageAlert(alert.id, 'admin')
  await usage.getModelUsageDashboard()
  assert.ok((await prisma.modelUsageAlert.findUniqueOrThrow({ where: { id: alert.id } })).acknowledgedAt)
  await usage.startModelUsage(context)
  const reopened = await prisma.modelUsageAlert.findUniqueOrThrow({ where: { id: alert.id } })
  assert.equal(reopened.acknowledgedAt, null)
  assert.equal(reopened.occurrences, 2)
  assert.equal(JSON.parse(reopened.acknowledgementHistory).length, 1)
  assert.equal(await prisma.modelUsageAlert.count(), 8)
  assert.equal((await usage.getModelUsageDashboard()).mode, 'observe')
})

test('401 and 402 alert immediately, transient errors require a consecutive three-event ten-minute streak per pool', async () => {
  assert.ok(usage, 'observation service must exist')
  await record('http_error', { httpStatus: 401 })
  await record('http_error', { httpStatus: 402 })
  assert.equal(await prisma.modelUsageAlert.count({ where: { type: 'upstream' } }), 2)
  await record('http_error', { httpStatus: 429 })
  await record('timeout')
  assert.equal(await prisma.modelUsageAlert.count({ where: { code: 'upstream_transient' } }), 0)
  await record('success')
  await record('transport')
  await record('timeout')
  assert.equal(await prisma.modelUsageAlert.count({ where: { code: 'upstream_transient' } }), 0)
  await record('http_error', { httpStatus: 429 }, { ...context, poolId: 'other-pool' })
  assert.equal(await prisma.modelUsageAlert.count({ where: { code: 'upstream_transient' } }), 0)
  await record('http_error', { httpStatus: 429 })
  assert.equal(await prisma.modelUsageAlert.count({ where: { code: 'upstream_transient' } }), 1)
  const a = (await prisma.modelUsageAlert.findFirst({ where: { code: 'upstream_transient' } }))!
  await usage.acknowledgeModelUsageAlert(a.id, 'admin')
  await record('timeout')
  assert.equal((await prisma.modelUsageAlert.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt, null)
  await prisma.modelUsageRecord.updateMany({ data: { finishedAt: new Date(Date.now() - 11 * 60 * 1000) } })
  await usage.acknowledgeModelUsageAlert(a.id, 'admin')
  await record('timeout')
  assert.ok((await prisma.modelUsageAlert.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt)
})

test('tracking rejects arbitrary trace strings and only logs a fixed message when the ledger is unavailable', async () => {
  assert.ok(usage, 'observation service must exist')
  const id = await usage.startModelUsage({ ...context, traceId: 'Bearer sk-PRIVATE_CREDENTIAL' })
  await usage.finishModelUsage(id, { outcome: 'success', traceId: 'sk-PRIVATE_CREDENTIAL', totalTokens: Infinity })
  const row = await prisma.modelUsageRecord.findUniqueOrThrow({ where: { id: id! } })
  assert.equal(row.traceId, null)
  assert.equal(row.totalTokens, null)
  const logs: unknown[][] = [], original = console.warn
  console.warn = (...args: unknown[]) => { logs.push(args) }
  await prisma.$executeRawUnsafe('ALTER TABLE "ModelUsageRecord" RENAME TO "OfflineUsageFixture"')
  try {
    assert.equal(await usage.startModelUsage(context), null)
    await assert.doesNotReject(usage.finishModelUsage(id, { outcome: 'timeout' }))
    await assert.doesNotReject(usage.finishModelUsage(null, { outcome: 'timeout' }))
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "OfflineUsageFixture" RENAME TO "ModelUsageRecord"')
    console.warn = original
  }
  assert.equal(logs.length, 2)
  assert.ok(logs.every(log => log.length === 1 && log[0] === '[model-usage] observation unavailable'))
})

test('administrator routes require a current admin session, bound day filters, and return no-store on every status', async () => {
  for (const [token, status] of [['', 401], [studentToken, 403], [adminToken, 200]] as const) {
    for (const [route, method, body] of [['/admin/model-usage', 'GET', undefined], ['/admin/model-usage/policy', 'PUT', {}], ['/admin/model-usage/alerts/absent/ack', 'POST', {}]] as const) {
      const r = await request(route, method, body, token)
      assert.equal(r.status, status === 200 ? (method === 'GET' ? 200 : method === 'PUT' ? 400 : 404) : status)
      assert.ok(r.cache?.includes('no-store'))
    }
  }
  for (const days of ['0', '31', '1.5', 'abc', '7&days=8']) assert.equal((await request(`/admin/model-usage?days=${days}`)).status, 400)
  for (const days of ['1', '30']) assert.equal((await request(`/admin/model-usage?days=${days}`)).status, 200)
})

test('warning policy validates all fields, rejects hard limits and stale revisions, and survives later reads', async () => {
  const first = await request()
  const policy = first.json.data.policy
  assert.equal(policy.mode, 'observe')
  assert.deepEqual([policy.globalDaily, policy.userDaily, policy.globalTotal, policy.userTotal, policy.warnPercent], [10000, 4000, 100000, 20000, 80])
  const body = { revision: policy.revision, globalDaily: 5000, userDaily: 2000, globalTotal: 50000, userTotal: 10000, warnPercent: 75 }
  for (const invalid of [{ ...body, mode: 'block' }, { ...body, hardLimit: true }, { ...body, globalDaily: 0 }, { ...body, userTotal: '1000' }, { ...body, warnPercent: 100 }, { ...body, revision: 0 }]) {
    assert.equal((await request('/admin/model-usage/policy', 'PUT', invalid)).status, 400)
  }
  const raced = await Promise.all([request('/admin/model-usage/policy', 'PUT', body), request('/admin/model-usage/policy', 'PUT', body)])
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409])
  const latest = (await request()).json.data.policy
  assert.equal(latest.revision, 2)
  assert.equal(latest.globalDaily, 5000)
  assert.equal(latest.mode, 'observe')
})

test('a hung observation transaction releases start and finish within 500ms and delayed rejection is handled', async t => {
  assert.ok(usage, 'observation service must exist')
  const logs: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args) })
  const dbMock = t.mock.method(prisma, '$transaction', () => new Promise(() => {}))
  const expired = Symbol('expired')
  let timer: NodeJS.Timeout | undefined
  const at = performance.now()
  const result = await Promise.race([
    Promise.all([usage.startModelUsage(context), usage.finishModelUsage('any-id', { outcome: 'success' })]),
    new Promise<typeof expired>(resolve => { timer = setTimeout(() => resolve(expired), 500) }),
  ])
  clearTimeout(timer)
  assert.notEqual(result, expired, 'monitoring must release callers even if its database promise never resolves')
  assert.ok(Array.isArray(result) && typeof result[0] === 'string' && result[1] === undefined)
  assert.ok(performance.now() - at < 500)
  assert.equal(logs.length, 2)
  dbMock.mock.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('PRIVATE_LATE_DB_ERROR')), 300)))
  assert.equal(typeof await usage.startModelUsage(context), 'string')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(logs.length, 3, 'late rejection must be handled without a duplicate or raw error log')
})

test('late successful begin retains its id so an earlier finish waits and records actual successful usage', async t => {
  assert.ok(usage, 'observation service must exist')
  const original = prisma.$transaction.bind(prisma)
  let first = true
  t.mock.method(console, 'warn', () => {})
  t.mock.method(prisma, '$transaction', (...args: any[]) => {
    if (!first) return (original as any)(...args)
    first = false
    return new Promise(resolve => setTimeout(resolve, 300)).then(() => (original as any)(...args))
  })
  const startAt = performance.now()
  const id = await usage.startModelUsage({ ...context, requestId: 'late-start' })
  assert.equal(id, 'late-start')
  assert.ok(performance.now() - startAt < 500)
  assert.equal(await prisma.modelUsageRecord.count({ where: { id: 'late-start' } }), 0)
  await usage.finishModelUsage(id, { outcome: 'success', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  const row = await prisma.modelUsageRecord.findUniqueOrThrow({ where: { id: 'late-start' } })
  assert.equal(row.outcome, 'success')
  assert.equal(row.totalTokens, 15)
  assert.equal((await usage.getModelUsageDashboard()).allTime.unknownUsageRequests, 0)
})

test('alert display includes the newest acknowledged history after active alerts even beyond 100 rows', async () => {
  assert.ok(usage, 'observation service must exist')
  await prisma.modelUsageAlert.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
    id: `history-${index}`, dedupeKey: `history-${index}`, type: 'upstream', severity: 'critical', code: 'upstream_401', scope: 'pool', scopeId: 'pool', period: 'rolling', value: 1, threshold: 1,
    acknowledgedAt: new Date(1700000000000 + index * 1000), acknowledgedBy: 'admin', lastSeenAt: new Date(1700000000000 + index * 1000),
  })) })
  await prisma.modelUsageAlert.create({ data: { id: 'active', dedupeKey: 'active', type: 'upstream', severity: 'critical', code: 'upstream_402', scope: 'pool', scopeId: 'pool', period: 'rolling', value: 1, threshold: 1, lastSeenAt: new Date(1600000000000) } })
  const alerts = (await usage.getModelUsageDashboard()).alerts
  assert.equal(alerts.length, 100)
  assert.equal(alerts[0].id, 'active')
  assert.equal(alerts[1].id, 'history-104')
  assert.equal(alerts.some(row => row.id === 'history-0'), false)
})
