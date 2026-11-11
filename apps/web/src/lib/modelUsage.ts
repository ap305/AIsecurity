import { apiGet, apiPost, apiPut } from './api'

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
  byUser: Array<
    UsageTotals & {
      actorId: string | null
      username: string | null
      displayName: string | null
      isTestAccount: boolean | null
    }
  >
  policy: UsagePolicy
  alerts: UsageAlert[]
}

export const USAGE_POLICY_FIELDS = [
  ['globalDaily', '平台每日次数阈值'],
  ['globalTotal', '平台累计次数阈值'],
  ['userDaily', '单账号每日次数阈值'],
  ['userTotal', '单账号累计次数阈值'],
  ['warnPercent', '预警百分比'],
] as const
type PolicyKey = (typeof USAGE_POLICY_FIELDS)[number][0]
export type UsagePolicyDraft = Record<PolicyKey, string>
export type UsagePolicyUpdate = Pick<UsagePolicy, PolicyKey | 'revision'>

export function usagePolicyDraft(policy: UsagePolicy): UsagePolicyDraft {
  return {
    globalDaily: String(policy.globalDaily),
    globalTotal: String(policy.globalTotal),
    userDaily: String(policy.userDaily),
    userTotal: String(policy.userTotal),
    warnPercent: String(policy.warnPercent),
  }
}

export function parseUsagePolicyDraft(draft: UsagePolicyDraft, revision: number): UsagePolicyUpdate {
  const parsed = {} as Record<PolicyKey, number>
  for (const [key] of USAGE_POLICY_FIELDS) {
    const value = draft[key].trim()
    const max = key === 'warnPercent' ? 99 : 1000000000
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > max
    )
      throw new Error(
        key === 'warnPercent' ? '预警百分比须为 1～99 的整数。' : '次数阈值须为 1～1,000,000,000 的整数。',
      )
    parsed[key] = Number(value)
  }
  return { revision, ...parsed }
}

const REQUEST_TIMEOUT_MS = 30000
export const modelUsageApi = {
  async get(days: number): Promise<ModelUsageDashboard> {
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('统计天数须为 1～30 的整数。')
    return apiGet<ModelUsageDashboard>(`/admin/model-usage?days=${days}`, REQUEST_TIMEOUT_MS)
  },
  savePolicy(input: UsagePolicyUpdate): Promise<UsagePolicy> {
    const { revision, globalDaily, globalTotal, userDaily, userTotal, warnPercent } = input
    return apiPut<UsagePolicy>(
      '/admin/model-usage/policy',
      {
        revision,
        globalDaily,
        globalTotal,
        userDaily,
        userTotal,
        warnPercent,
      },
      REQUEST_TIMEOUT_MS,
    )
  },
  acknowledge(id: string): Promise<UsageAlert> {
    return apiPost<UsageAlert>(
      `/admin/model-usage/alerts/${encodeURIComponent(id)}/ack`,
      {},
      REQUEST_TIMEOUT_MS,
    )
  },
}
