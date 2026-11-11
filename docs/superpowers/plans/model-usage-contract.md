# Model usage integration contract

All endpoints use `{ code: 0, message: 'ok', data: ... }`; errors use the existing envelope. Routes export the default Express router and require administrator sessions. Every response is `Cache-Control: private, no-store`.

```ts
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
  requestId?: string // optional stable server-generated id for begin idempotency
  traceId?: string | null // strict printable identifier, no arbitrary upstream body
  snapshot?: boolean // true on snapshot-only records: never temporarily counted as upstream
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
export function startModelUsage(context: ModelUsageContext): Promise<string | null>
export function finishModelUsage(id: string | null, result: ModelUsageFinish): Promise<void>
export function recordModelUsageSnapshot(context: ModelUsageContext): Promise<void>
```

Only pass server-derived metadata. No prompt/response/error/key arguments exist. Nonnegative integer numeric tokens only; absent/invalid numbers remain null. Snapshot and health always retain null token counts. Start and finish are best effort with fixed sanitized logs, no admission decisions. Each caller waits at most 200ms; a begin still pending at that point returns its preassigned record id, and finish coordinates with the bounded in-process begin map so a late successful commit still gets its completed usage. Confirmed begin failure returns null. Underlying transactions use maxWait 100ms, timeout 500ms, local lock timeout 100ms and statement timeout 400ms. Start with `snapshot: true` for cache reuse or use `recordModelUsageSnapshot`. Calling start repeatedly with the same server `requestId`, or finish repeatedly with the same record id, is idempotent.

GET `/admin/model-usage?days=7` accepts integer days 1..30 (default 7). Data shape:

```ts
interface UsageTotals {
  upstreamAttempts: number // kind=llm, excluding snapshots; includes pending
  successes: number // completed llm success
  failures: number // completed llm non-success, excluding snapshots
  pending: number // llm outcome=pending
  snapshotHits: number
  teacherRequests: number // kind=teacher, excluding snapshots
  healthChecks: number // kind=health
  knownUsageRequests: number // llm upstream with numeric totalTokens
  unknownUsageRequests: number // llm upstream minus knownUsageRequests
  inputTokens: number | null // sum of known numeric input; null if none
  outputTokens: number | null
  totalTokens: number | null
}
interface UsagePolicy {
  mode: 'observe'
  revision: number
  globalDaily: number // default 10000
  userDaily: number // default 4000
  globalTotal: number // default 100000
  userTotal: number // default 20000
  warnPercent: number // default 80; accepted integer 1..99
  updatedAt: string
}
interface UsageAlert {
  id: string
  type: 'threshold' | 'upstream'
  severity: 'warning' | 'critical'
  code: string // fixed allowlisted code
  message: string // fixed Chinese text
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
interface ModelUsageDashboard {
  mode: 'observe'
  timezone: 'Asia/Shanghai'
  days: number
  from: string // inclusive ISO time, start of first BJT date
  to: string // exclusive ISO time, start of tomorrow BJT
  coverage: { startedAt: string | null; historicalUsage: 'unknown'; currencyCost: 'unknown' }
  today: UsageTotals
  range: UsageTotals
  allTime: UsageTotals
  daily: Array<UsageTotals & { day: string }>
  byModel: Array<UsageTotals & { model: string | null }>
  byQuestion: Array<UsageTotals & { questionId: string | null; title: string | null }>
  byUser: Array<UsageTotals & { actorId: string | null; username: string | null; displayName: string | null; isTestAccount: boolean | null }>
  policy: UsagePolicy
  alerts: UsageAlert[] // most recent 100, active first; acknowledged history retained in DB
}
```

PUT `/admin/model-usage/policy` body: `{ revision, globalDaily, userDaily, globalTotal, userTotal, warnPercent }`. All fields required. Request may include `mode: 'observe'`; any other mode/unknown field rejected. Thresholds integers 1..1000000000. Response `data: UsagePolicy`; stale revision returns 409. No admission-blocking field exists.

POST `/admin/model-usage/alerts/:id/ack` accepts no payload (or `{}`); returns `data: UsageAlert`. Acknowledgement is idempotent; new qualifying events after acknowledgement reopen the existing deduplicated alert and advance occurrences. Invalid alert id 404.

New tables only: `ModelUsageRecord`, `ModelUsagePolicy`, `ModelUsageAlert`. No foreign keys into existing tables. Migration directory: `20261111000000_model_usage_observe`. Backend test: `tests/modelUsage.integration.test.ts`.
