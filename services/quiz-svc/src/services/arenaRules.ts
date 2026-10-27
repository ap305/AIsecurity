import crypto from 'node:crypto'

export type ArenaRole = 'attack' | 'defense'

export const D02_ORIGINAL_POOL_COMPATIBILITY = {
  questionId: 'V3-261012-D02', scenarioId: 'V3-261012-02', role: 'defense', samples: 300,
  evaluationVersion: 'v3-261012-d02-original300-v12',
  poolVersion: 'v3-261012-response-snapshot4-v11',
} as const

/** Only the audited D02 restoration shares its existing A02 opponents; evidence keeps its actual version. */
export function arenaPoolKey(identity: {
  questionId: string; scenarioId: string; role: string | null; evaluationVersion: string; definition?: unknown
}) {
  const definition = typeof identity.definition === 'string' ? JSON.parse(identity.definition) : identity.definition
  const evaluation = (definition as { evaluation?: Record<string, unknown> & { parameters?: Record<string, unknown> } } | undefined)?.evaluation
  const { parameters: nested, ...topLevel } = evaluation ?? {}
  const parameters = { ...nested, ...topLevel }
  const override = parameters?.arenaPoolVersion
  if (override === undefined) return { scenarioId: identity.scenarioId, evaluationVersion: identity.evaluationVersion }
  const expected = D02_ORIGINAL_POOL_COMPATIBILITY
  if (identity.questionId !== expected.questionId || identity.scenarioId !== expected.scenarioId ||
      identity.role !== expected.role || identity.evaluationVersion !== expected.evaluationVersion ||
      evaluation?.version !== expected.evaluationVersion || parameters?.samples !== expected.samples || override !== expected.poolVersion)
    throw new Error('对手池兼容配置不属于已审计的 D02 原题恢复版本')
  return { scenarioId: identity.scenarioId, evaluationVersion: expected.poolVersion }
}

export interface ArenaEvaluationConfig {
  packageId: string
  version?: string
  timeoutMs?: number
  baselineMetric: string
  baselineThreshold: number
  successMetric: string
  successThreshold: number
  repetitions?: number
  [key: string]: unknown
}

export interface ArenaSnapshot {
  answerTemplate?: string | null
  questionId: string
  questionVersion: number
  category: 'adversarial'
  role: ArenaRole
  scenarioId: string
  evaluationVersion: string
  definition: { evaluation: ArenaEvaluationConfig; [key: string]: unknown }
  modelBinding?: Record<string, unknown>
}

export function parseArenaSnapshot(raw: string): ArenaSnapshot {
  const value = JSON.parse(raw) as Partial<ArenaSnapshot>
  const config = value.definition?.evaluation
  if (
    value.category !== 'adversarial' ||
    !value.questionId ||
    !Number.isInteger(value.questionVersion) ||
    Number(value.questionVersion) < 1 ||
    !value.scenarioId ||
    !value.evaluationVersion ||
    (value.role !== 'attack' && value.role !== 'defense') ||
    !config?.packageId ||
    typeof config.baselineMetric !== 'string' ||
    !config.baselineMetric.trim() ||
    typeof config.baselineThreshold !== 'number' ||
    !Number.isFinite(config.baselineThreshold)
  ) {
    throw new Error('攻防题缺少固定角色、版本、环境包或基线指标配置')
  }
  return value as ArenaSnapshot
}

export function pairwiseSucceeded(
  metrics: Record<string, unknown> | undefined,
  config: ArenaEvaluationConfig,
): boolean {
  const metric = metrics?.[config.successMetric]
  if (
    !config.successMetric ||
    typeof config.successThreshold !== 'number' ||
    !Number.isFinite(config.successThreshold) ||
    typeof metric !== 'number' ||
    !Number.isFinite(metric)
  ) {
    throw new Error('评测未返回声明的对手成功指标或阈值无效')
  }
  return metric >= config.successThreshold
}

export function oppositeRole(role: ArenaRole): ArenaRole {
  return role === 'attack' ? 'defense' : 'attack'
}

export function baselineQualified(
  metrics: Record<string, unknown> | undefined,
  config: ArenaEvaluationConfig,
): boolean {
  const metric = metrics?.[config.baselineMetric]
  if (typeof metric !== 'number' || !Number.isFinite(metric)) {
    throw new Error('评测未返回声明的基线指标')
  }
  // All qualification metrics are normalized by the publisher: equality passes.
  return metric >= config.baselineThreshold
}

export interface ArenaPairResult {
  opponentId: string
  status: string
  success?: boolean
  reportedSuccess?: boolean
  metrics?: Record<string, number>
}

export interface ArenaAggregate {
  score: number
  successCount: number
  opponentCount: number
  emptyPool: boolean
}

export function aggregateArenaResults(
  opponentIds: readonly string[],
  results: readonly ArenaPairResult[],
): ArenaAggregate {
  if (new Set(opponentIds).size !== opponentIds.length || results.length !== opponentIds.length) {
    throw new Error('对手快照或评测数量不一致')
  }
  const byId = new Map(results.map((r) => [r.opponentId, r]))
  if (byId.size !== opponentIds.length) throw new Error('对手评测结果重复')
  let successCount = 0
  for (const id of opponentIds) {
    const result = byId.get(id)
    if (!result || result.status !== 'completed' || typeof result.success !== 'boolean') {
      // Errors are neither wins nor normal losses and cannot silently shrink the denominator.
      throw new Error('对手评测尚未正常完成，不发布本次成绩')
    }
    if (result.success) successCount += 1
  }
  return {
    score: opponentIds.length === 0 ? 100 : Number(((100 * successCount) / opponentIds.length).toFixed(8)),
    successCount,
    opponentCount: opponentIds.length,
    emptyPool: opponentIds.length === 0,
  }
}

export function arenaScoreReachedAt(
  previous: { score: number; achievedAt: Date } | null,
  score: number,
  now: Date,
): Date {
  return previous && previous.score === score ? previous.achievedAt : now
}

export function opponentFingerprint(ids: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([...ids].sort()))
    .digest('hex')
}

export function compareSubmissionOrder(
  a: { id: string; createdAt: Date },
  b: { id: string; createdAt: Date },
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
}

export function isCurrentArenaSubmission(
  submission: {
    questionVersion: number
    evaluationVersion: string | null
    role: string | null
    scenarioId: string | null
  },
  question: {
    revision: number
    evaluationVersion: string | null
    role: string | null
    scenarioId: string | null
    category: string
    status: string
  },
): boolean {
  return (
    question.status === 'published' &&
    question.category === 'adversarial' &&
    question.revision === submission.questionVersion &&
    question.evaluationVersion === submission.evaluationVersion &&
    question.role === submission.role &&
    question.scenarioId === submission.scenarioId
  )
}
