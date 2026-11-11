import { randomUUID } from 'node:crypto'
import { Prisma, type ModelUsageAlert, type ModelUsagePolicy, type ModelUsageRecord } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { RequestError } from '../lib/prdContract.js'

export type ModelUsageSource = 'evaluation' | 'selftest' | 'teacher' | 'admin_test' | 'legacy' | 'health'
export type ModelUsageKind = 'llm' | 'teacher' | 'health'
export type ModelUsageOutcome = 'success' | 'http_error' | 'timeout' | 'transport' | 'invalid_json' | 'snapshot'
export interface ModelUsageContext {
  actorId?: string | null
  questionId?: string | null
  submissionId?: string | null
  poolId?: string | null
  model?: string | null
  source: ModelUsageSource
  kind: ModelUsageKind
  requestId?: string
  traceId?: string | null
  snapshot?: boolean
}
export interface ModelUsageFinish {
  outcome: ModelUsageOutcome
  elapsedMs?: number | null
  httpStatus?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
  traceId?: string | null
}
export interface UsageTotals {
  upstreamAttempts: number
  successes: number
  failures: number
  pending: number
  snapshotHits: number
  teacherRequests: number
  healthChecks: number
  knownUsageRequests: number
  unknownUsageRequests: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}
export interface UsagePolicy {
  mode: 'observe'
  revision: number
  globalDaily: number
  userDaily: number
  globalTotal: number
  userTotal: number
  warnPercent: number
  updatedAt: string
}
export interface UsageAlert {
  id: string
  type: 'threshold' | 'upstream'
  severity: 'warning' | 'critical'
  code: string
  message: string
  scope: 'global' | 'user' | 'pool' | 'source'
  scopeId: string | null
  period: 'daily' | 'total' | 'rolling'
  value: number
  threshold: number
  firstSeenAt: string
  lastSeenAt: string
  occurrences: number
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}
export interface ModelUsageDashboard {
  mode: 'observe'
  timezone: 'Asia/Shanghai'
  days: number
  from: string
  to: string
  coverage: { startedAt: string | null; historicalUsage: 'unknown'; currencyCost: 'unknown' }
  today: UsageTotals
  range: UsageTotals
  allTime: UsageTotals
  daily: Array<UsageTotals & { day: string }>
  byModel: Array<UsageTotals & { model: string | null }>
  byQuestion: Array<UsageTotals & { questionId: string | null; title: string | null }>
  byUser: Array<UsageTotals & { actorId: string | null; username: string | null; displayName: string | null; isTestAccount: boolean | null }>
  policy: UsagePolicy
  alerts: UsageAlert[]
}

const sources = new Set(['evaluation', 'selftest', 'teacher', 'admin_test', 'legacy', 'health'])
const kinds = new Set(['llm', 'teacher', 'health'])
const outcomes = new Set(['success', 'http_error', 'timeout', 'transport', 'invalid_json', 'snapshot'])
const dayMs = 86400000, beijingOffset = 8 * 3600000
const observationFailure = () => console.warn('[model-usage] observation unavailable')
async function bestEffort<T>(work: () => Promise<T>, fallback: T, started?: (operation: Promise<T>) => void, timeoutValue = fallback): Promise<T> {
  let timer: NodeJS.Timeout | undefined, reported = false
  const fail = () => { if (!reported) { reported = true; observationFailure() }; return fallback }
  // Keep a rejection handler on the operation after the caller has stopped waiting.
  const operation = Promise.resolve().then(work).catch(fail)
  started?.(operation)
  try {
    return await Promise.race([operation, new Promise<T>(resolve => { timer = setTimeout(() => { fail(); resolve(timeoutValue) }, 200) })])
  } finally { clearTimeout(timer) }
}
const pendingBegins = new Map<string, Promise<string | null>>()
const emptyTotals = (): UsageTotals => ({ upstreamAttempts: 0, successes: 0, failures: 0, pending: 0, snapshotHits: 0, teacherRequests: 0, healthChecks: 0, knownUsageRequests: 0, unknownUsageRequests: 0, inputTokens: null, outputTokens: null, totalTokens: null })
const dayStart = (now: Date) => new Date(Math.floor((now.getTime() + beijingOffset) / dayMs) * dayMs - beijingOffset)
const dayLabel = (at: Date) => new Date(at.getTime() + beijingOffset).toISOString().slice(0, 10)
function identifier(value: unknown, max = 128): string | null {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) && !/^(?:sk-|bearer|api[_-]?key|access[_-]?token)/i.test(value) ? value : null
}
const numeric = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : null
const trace = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? identifier(value) : null
function policyDto(row: ModelUsagePolicy): UsagePolicy {
  return { mode: 'observe', revision: row.revision, globalDaily: row.globalDaily, userDaily: row.userDaily, globalTotal: row.globalTotal, userTotal: row.userTotal, warnPercent: row.warnPercent, updatedAt: row.updatedAt.toISOString() }
}
const messages: Record<string, string> = {
  global_daily_warning: '平台今日模型请求量达到预警比例。仅提示，不限制调用。',
  global_daily_exceeded: '平台今日模型请求量达到告警阈值。仅提示，不限制调用。',
  global_total_warning: '平台累计模型请求量达到预警比例。仅提示，不限制调用。',
  global_total_exceeded: '平台累计模型请求量达到告警阈值。仅提示，不限制调用。',
  user_daily_warning: '账号今日模型请求量达到预警比例。仅提示，不限制调用。',
  user_daily_exceeded: '账号今日模型请求量达到告警阈值。仅提示，不限制调用。',
  user_total_warning: '账号累计模型请求量达到预警比例。仅提示，不限制调用。',
  user_total_exceeded: '账号累计模型请求量达到告警阈值。仅提示，不限制调用。',
  upstream_401: '上游接口返回认证失败，请检查服务端凭据配置。',
  upstream_402: '上游接口返回付费或额度错误，请检查服务商账户。',
  upstream_transient: '同一上游在十分钟内连续出现至少三次限流、超时或连接失败。',
}
function alertDto(row: ModelUsageAlert): UsageAlert {
  return { id: row.id, type: row.type as UsageAlert['type'], severity: row.severity as UsageAlert['severity'], code: row.code, message: messages[row.code] ?? '模型调用监控告警。', scope: row.scope as UsageAlert['scope'], scopeId: row.scopeId, period: row.period as UsageAlert['period'], value: row.value, threshold: row.threshold, firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(), occurrences: row.occurrences, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, acknowledgedBy: row.acknowledgedBy }
}
async function ensurePolicy(tx: Prisma.TransactionClient) {
  return tx.modelUsagePolicy.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} })
}
// A lock on our own singleton serializes event/ack changes without locking score or account rows.
async function observationTransaction<T>(work: (tx: Prisma.TransactionClient, policy: ModelUsagePolicy) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'")
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '400ms'")
    await ensurePolicy(tx)
    await tx.$queryRaw`SELECT "id" FROM "ModelUsagePolicy" WHERE "id" = 'default' FOR UPDATE`
    const policy = await tx.modelUsagePolicy.findUniqueOrThrow({ where: { id: 'default' } })
    return work(tx, policy)
  }, { maxWait: 100, timeout: 500 })
}
async function raiseAlert(tx: Prisma.TransactionClient, data: {
  type: UsageAlert['type']; severity: UsageAlert['severity']; code: string; scope: UsageAlert['scope']; scopeId: string | null; period: UsageAlert['period']; value: number; threshold: number; periodKey: string
}, at: Date) {
  const { periodKey, ...fields } = data
  const dedupeKey = JSON.stringify([fields.code, fields.scope, fields.scopeId, periodKey])
  await tx.modelUsageAlert.upsert({
    where: { dedupeKey },
    create: { ...fields, dedupeKey, firstSeenAt: at, lastSeenAt: at },
    update: { value: fields.value, threshold: fields.threshold, lastSeenAt: at, occurrences: { increment: 1 }, acknowledgedAt: null, acknowledgedBy: null },
  })
}
async function thresholdAlerts(tx: Prisma.TransactionClient, row: ModelUsageRecord, policy: ModelUsagePolicy) {
  if (row.kind !== 'llm' || row.isSnapshot) return
  const start = dayStart(row.createdAt), end = new Date(start.getTime() + dayMs)
  const base = { kind: 'llm', isSnapshot: false }
  for (const scope of ['global', 'user'] as const) {
    if (scope === 'user' && !row.actorId) continue
    const actor = scope === 'user' ? { actorId: row.actorId } : {}
    for (const period of ['daily', 'total'] as const) {
      const value = await tx.modelUsageRecord.count({ where: { ...base, ...actor, ...(period === 'daily' ? { createdAt: { gte: start, lt: end } } : {}) } })
      const limit = scope === 'global' ? (period === 'daily' ? policy.globalDaily : policy.globalTotal) : (period === 'daily' ? policy.userDaily : policy.userTotal)
      for (const level of ['warning', 'exceeded'] as const) {
        const threshold = level === 'warning' ? Math.ceil(limit * policy.warnPercent / 100) : limit
        if (value < threshold) continue
        await raiseAlert(tx, { type: 'threshold', severity: level === 'warning' ? 'warning' : 'critical', code: `${scope}_${period}_${level}`, scope, scopeId: scope === 'user' ? row.actorId : null, period, value, threshold, periodKey: period === 'daily' ? dayLabel(start) : 'total' }, row.createdAt)
      }
    }
  }
}
async function errorAlerts(tx: Prisma.TransactionClient, row: ModelUsageRecord) {
  if (row.isSnapshot || !row.finishedAt) return
  const scope = row.poolId ? 'pool' : 'source', scopeId = row.poolId ?? row.source
  let code: string | null = null, value = 1, threshold = 1
  if (row.outcome === 'http_error' && [401, 402].includes(row.httpStatus ?? 0)) code = `upstream_${row.httpStatus}`
  else if (['timeout', 'transport'].includes(row.outcome) || (row.outcome === 'http_error' && row.httpStatus === 429)) {
    const recent = await tx.modelUsageRecord.findMany({
      where: { ...(row.poolId ? { poolId: row.poolId } : { poolId: null, source: row.source }), isSnapshot: false, finishedAt: { gte: new Date(row.finishedAt.getTime() - 600000), lte: row.finishedAt } },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], take: 3,
      select: { outcome: true, httpStatus: true },
    })
    if (recent.length === 3 && recent.every(r => ['timeout', 'transport'].includes(r.outcome) || (r.outcome === 'http_error' && r.httpStatus === 429))) {
      code = 'upstream_transient'; value = threshold = 3
    }
  }
  if (code) await raiseAlert(tx, { type: 'upstream', severity: code === 'upstream_transient' ? 'warning' : 'critical', code, scope, scopeId, period: 'rolling', value, threshold, periodKey: 'rolling' }, row.finishedAt)
}

/** Context is supplied by trusted server callers; arbitrary payload fields are never persisted. */
export async function startModelUsage(context: ModelUsageContext): Promise<string | null> {
  let id: string
  try {
    if (!sources.has(context.source) || !kinds.has(context.kind)) throw new Error('invalid_context')
    const candidate = context.requestId === undefined ? randomUUID() : identifier(context.requestId)
    if (!candidate) throw new Error('invalid_request_id')
    id = candidate
  } catch { observationFailure(); return null }
  const pending = pendingBegins.get(id)
  if (pending) return bestEffort(() => pending, null, undefined, id)
  if (pendingBegins.size >= 1024) { observationFailure(); return null }
  return bestEffort(async () => {
    return await observationTransaction(async (tx, policy) => {
      const inserted = await tx.modelUsageRecord.createMany({ data: [{ id, actorId: identifier(context.actorId), questionId: identifier(context.questionId), submissionId: identifier(context.submissionId), poolId: identifier(context.poolId), model: identifier(context.model), source: context.source, kind: context.kind, traceId: trace(context.traceId), isSnapshot: context.snapshot === true }], skipDuplicates: true })
      if (inserted.count) await thresholdAlerts(tx, await tx.modelUsageRecord.findUniqueOrThrow({ where: { id } }), policy)
      return id
    })
  }, null, operation => {
    pendingBegins.set(id, operation)
    void operation.then(() => { if (pendingBegins.get(id) === operation) pendingBegins.delete(id) })
  }, id)
}

export async function finishModelUsage(id: string | null, result: ModelUsageFinish): Promise<void> {
  if (!id) return
  return bestEffort(async () => {
    if (!outcomes.has(result.outcome)) throw new Error('invalid_outcome')
    // A begin may commit after its caller's wait budget; keep completion ordered without blocking inference.
    const pending = pendingBegins.get(id)
    if (pending && await pending === null) return
    await observationTransaction(async tx => {
      const row = await tx.modelUsageRecord.findUnique({ where: { id } })
      if (!row || row.outcome !== 'pending') return
      const isSnapshot = row.isSnapshot || result.outcome === 'snapshot'
      const hasTokens = row.kind === 'llm' && !isSnapshot
      const status = numeric(result.httpStatus)
      await tx.modelUsageRecord.update({ where: { id }, data: {
        outcome: isSnapshot ? 'snapshot' : result.outcome, isSnapshot,
        finishedAt: new Date(), elapsedMs: numeric(result.elapsedMs),
        httpStatus: status !== null && status >= 100 && status <= 599 ? status : null,
        inputTokens: hasTokens ? numeric(result.inputTokens) : null,
        outputTokens: hasTokens ? numeric(result.outputTokens) : null,
        totalTokens: hasTokens ? numeric(result.totalTokens) : null,
        traceId: trace(result.traceId) ?? row.traceId,
      } })
      await errorAlerts(tx, await tx.modelUsageRecord.findUniqueOrThrow({ where: { id } }))
    })
  }, undefined)
}
export async function recordModelUsageSnapshot(context: ModelUsageContext): Promise<void> {
  const id = await startModelUsage({ ...context, snapshot: true })
  await finishModelUsage(id, { outcome: 'snapshot' })
}

function validDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 30) throw new RequestError('统计天数必须为 1 到 30 的整数', 400)
  return value as number
}
type AggregateRow = UsageTotals & { key?: string | null }
async function aggregate(tx: Prisma.TransactionClient, where: Prisma.Sql, group?: Prisma.Sql): Promise<AggregateRow[]> {
  const rows = await tx.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT ${group ? Prisma.sql`${group} AS "key",` : Prisma.empty}
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot")::float8 AS "upstreamAttempts",
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot" AND "outcome" = 'success')::float8 AS "successes",
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot" AND "outcome" NOT IN ('pending', 'success', 'snapshot'))::float8 AS "failures",
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot" AND "outcome" = 'pending')::float8 AS "pending",
      COUNT(*) FILTER (WHERE "isSnapshot")::float8 AS "snapshotHits",
      COUNT(*) FILTER (WHERE "kind" = 'teacher' AND NOT "isSnapshot")::float8 AS "teacherRequests",
      COUNT(*) FILTER (WHERE "kind" = 'health')::float8 AS "healthChecks",
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot" AND "totalTokens" IS NOT NULL)::float8 AS "knownUsageRequests",
      COUNT(*) FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot" AND "totalTokens" IS NULL)::float8 AS "unknownUsageRequests",
      SUM("inputTokens") FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot")::float8 AS "inputTokens",
      SUM("outputTokens") FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot")::float8 AS "outputTokens",
      SUM("totalTokens") FILTER (WHERE "kind" = 'llm' AND NOT "isSnapshot")::float8 AS "totalTokens"
    FROM "ModelUsageRecord" WHERE ${where}
    ${group ? Prisma.sql`GROUP BY ${group} ORDER BY "upstreamAttempts" DESC, "key" ASC NULLS LAST` : Prisma.empty}
  `)
  return rows
}

export async function getModelUsageDashboard(days = 7, now = new Date()): Promise<ModelUsageDashboard> {
  validDays(days)
  const today = dayStart(now), from = new Date(today.getTime() - (days - 1) * dayMs), to = new Date(today.getTime() + dayMs)
  return prisma.$transaction(async tx => {
    const policy = await ensurePolicy(tx)
    // Prisma timestamps are stored as UTC without a zone; avoid session-timezone coercion of bound Dates.
    const rangeWhere = Prisma.sql`"createdAt" >= ${from.toISOString()}::timestamp AND "createdAt" < ${to.toISOString()}::timestamp`
    const allTime = (await aggregate(tx, Prisma.sql`TRUE`))[0]
    const todayTotals = (await aggregate(tx, Prisma.sql`"createdAt" >= ${today.toISOString()}::timestamp AND "createdAt" < ${to.toISOString()}::timestamp`))[0]
    const range = (await aggregate(tx, rangeWhere))[0]
    const byDay = await aggregate(tx, rangeWhere, Prisma.sql`to_char("createdAt" + interval '8 hours', 'YYYY-MM-DD')`)
    const dailyMap = new Map(byDay.map(({ key, ...totals }) => [key, totals]))
    const byModel = (await aggregate(tx, rangeWhere, Prisma.sql`"model"`)).map(({ key, ...totals }) => ({ model: key ?? null, ...totals }))
    const questionTotals = await aggregate(tx, rangeWhere, Prisma.sql`"questionId"`)
    const userTotals = await aggregate(tx, rangeWhere, Prisma.sql`"actorId"`)
    const questionIds = questionTotals.flatMap(row => row.key ? [row.key] : [])
    const userIds = userTotals.flatMap(row => row.key ? [row.key] : [])
    const questions = new Map((await tx.question.findMany({ where: { id: { in: questionIds } }, select: { id: true, title: true } })).map(row => [row.id, row.title]))
    const users = new Map((await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true, isTestAccount: true } })).map(({ id, ...row }) => [id, row]))
    const coverage = await tx.modelUsageRecord.aggregate({ _min: { createdAt: true } })
    const alertOrder = [{ lastSeenAt: 'desc' as const }, { id: 'asc' as const }]
    const alerts = await tx.modelUsageAlert.findMany({ where: { acknowledgedAt: null }, orderBy: alertOrder, take: 100 })
    if (alerts.length < 100) alerts.push(...await tx.modelUsageAlert.findMany({ where: { acknowledgedAt: { not: null } }, orderBy: alertOrder, take: 100 - alerts.length }))
    return {
      mode: 'observe', timezone: 'Asia/Shanghai', days, from: from.toISOString(), to: to.toISOString(),
      coverage: { startedAt: coverage._min.createdAt?.toISOString() ?? null, historicalUsage: 'unknown', currencyCost: 'unknown' },
      today: todayTotals, allTime, range,
      daily: Array.from({ length: days }, (_, index) => { const day = dayLabel(new Date(from.getTime() + index * dayMs)); return { day, ...(dailyMap.get(day) ?? emptyTotals()) } }),
      byModel,
      byQuestion: questionTotals.map(({ key, ...totals }) => ({ questionId: key ?? null, title: key ? questions.get(key) ?? null : null, ...totals })),
      byUser: userTotals.map(({ key, ...totals }) => ({ actorId: key ?? null, ...(key && users.get(key) || { username: null, displayName: null, isTestAccount: null }), ...totals })),
      policy: policyDto(policy), alerts: alerts.map(alertDto),
    }
  }, { isolationLevel: 'RepeatableRead', maxWait: 3000, timeout: 10000 })
}

export async function updateModelUsagePolicy(input: unknown): Promise<UsagePolicy> {
  const keys = ['revision', 'globalDaily', 'userDaily', 'globalTotal', 'userTotal', 'warnPercent'] as const
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('告警策略参数无效', 400)
  const body = input as Record<string, unknown>
  if (Object.keys(body).some(key => ![...keys, 'mode'].includes(key)) || (body.mode !== undefined && body.mode !== 'observe')) throw new RequestError('仅支持统计与告警模式', 400)
  for (const key of keys) {
    const max = key === 'warnPercent' ? 99 : key === 'revision' ? 2147483646 : 1000000000
    if (!Number.isInteger(body[key]) || (body[key] as number) < 1 || (body[key] as number) > max) throw new RequestError('告警策略参数无效', 400)
  }
  return observationTransaction(async (tx, current) => {
    if (current.revision !== body.revision) throw new RequestError('告警策略已更新，请刷新后重试', 409)
    const values = Object.fromEntries(keys.filter(key => key !== 'revision').map(key => [key, body[key]])) as Pick<ModelUsagePolicy, 'globalDaily' | 'userDaily' | 'globalTotal' | 'userTotal' | 'warnPercent'>
    return policyDto(await tx.modelUsagePolicy.update({ where: { id: 'default' }, data: { ...values, mode: 'observe', revision: { increment: 1 } } }))
  })
}
export async function acknowledgeModelUsageAlert(id: string, actorId: string): Promise<UsageAlert> {
  return observationTransaction(async tx => {
    const row = await tx.modelUsageAlert.findUnique({ where: { id } })
    if (!row) throw new RequestError('告警不存在', 404)
    if (row.acknowledgedAt) return alertDto(row)
    const at = new Date()
    const history = JSON.parse(row.acknowledgementHistory) as Array<{ at: string; actorId: string; occurrences: number }>
    history.push({ at: at.toISOString(), actorId, occurrences: row.occurrences })
    return alertDto(await tx.modelUsageAlert.update({ where: { id }, data: { acknowledgedAt: at, acknowledgedBy: actorId, acknowledgementHistory: JSON.stringify(history) } }))
  })
}
