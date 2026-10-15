import crypto from 'node:crypto'

export type ArenaRole = 'attack' | 'defense'

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
