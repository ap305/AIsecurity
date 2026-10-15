import type { ArenaAlgorithm, ArenaEvaluation, Submission } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { parseJson } from '../lib/prdContract.js'

export interface SubmissionDiagnostics {
  questionVersion: number
  evaluationVersion: string
  historicalVersion: boolean
  phase: 'basic' | 'baseline' | 'opponents'
  state: string
  metrics: Record<string, number>
  baseline: {
    metric: string
    value: number | null
    threshold: number
    comparator: '>='
    passed: boolean | null
  } | null
  evaluation: {
    state: string
    snapshotRevision: number | null
    counted: boolean
    successCount: number | null
    opponentCount: number | null
    emptyPool: boolean
    pairs: {
      ordinal: number
      state: string
      success: boolean | null
      metric: string
      value: number | null
      threshold: number
    }[]
  } | null
  progress: {
    state: string
    completedOpponents: number
    totalOpponents: number | null
  } | null
}

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}
const decode = (value: string | null) => object(parseJson<unknown>(value, null))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const metricName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
const states = new Set([
  'queued',
  'pending',
  'judging',
  'baseline',
  'opponents',
  'running',
  'completed',
  'passed',
  'failed',
  'baseline_failed',
  'error',
  'stale',
])
const publicState = (value: string) => (states.has(value) ? value : 'unavailable')
// These are aggregate counts/quality values used by the basic protocol, never per-case inputs.
const basicMetricNames = ['correct', 'total', 'testsPassed', 'testsTotal', 'accuracy', 'ratio']
function publicMetrics(raw: unknown, allowed: string[]) {
  const values = object(raw)
  return Object.fromEntries(
    allowed.flatMap((name) => (finite(values?.[name]) ? [[name, values![name]]] : [])),
  ) as Record<string, number>
}

function frozenConfiguration(row: Submission) {
  const snapshot = decode(row.configSnapshot)
  const definition = object(snapshot?.definition)
  const evaluation = object(definition?.evaluation)
  if (
    !snapshot ||
    !evaluation ||
    typeof evaluation.packageId !== 'string' ||
    !evaluation.packageId ||
    snapshot.questionId !== row.questionId ||
    snapshot.questionVersion !== row.questionVersion ||
    snapshot.category !== row.category ||
    snapshot.evaluationVersion !== row.evaluationVersion ||
    !['basic', 'adversarial'].includes(row.category)
  )
    return null
  if (
    row.category === 'adversarial' &&
    (snapshot.role !== row.role ||
      snapshot.scenarioId !== row.scenarioId ||
      !['attack', 'defense'].includes(row.role || '') ||
      !row.scenarioId ||
      !metricName(evaluation.baselineMetric) ||
      !finite(evaluation.baselineThreshold) ||
      !metricName(evaluation.successMetric) ||
      !finite(evaluation.successThreshold))
  )
    return null
  return evaluation
}

function boundAlgorithm(row: Submission, algorithm: ArenaAlgorithm | undefined) {
  return algorithm &&
    algorithm.submissionId === row.id &&
    algorithm.userId === row.userId &&
    algorithm.questionId === row.questionId &&
    algorithm.scenarioId === row.scenarioId &&
    algorithm.role === row.role &&
    algorithm.evaluationVersion === row.evaluationVersion
    ? algorithm
    : null
}
function boundTask(row: Submission, algorithm: ArenaAlgorithm, task: ArenaEvaluation | undefined) {
  return task &&
    task.submissionId === row.id &&
    task.algorithmId === algorithm.id &&
    task.scenarioId === row.scenarioId &&
    task.role === row.role &&
    task.evaluationVersion === row.evaluationVersion &&
    ['candidate', 'recompute'].includes(task.kind)
    ? task
    : null
}

function pairEvidence(task: ArenaEvaluation, config: JsonObject) {
  const opponents = parseJson<unknown>(task.opponentsSnapshot, null)
  if (!Array.isArray(opponents)) return null
  const ids = opponents.map((item) => object(item)?.algorithmId)
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return null
  const raw = decode(task.result)
  const values = raw?.pairs ?? (task.status !== 'completed' ? [] : null)
  if (!Array.isArray(values)) return null
  const byId = new Map<string, JsonObject>()
  for (const item of values) {
    const pair = object(item)
    if (
      !pair ||
      typeof pair.opponentId !== 'string' ||
      !ids.includes(pair.opponentId) ||
      byId.has(pair.opponentId)
    )
      return null
    byId.set(pair.opponentId, pair)
  }
  const pairs: NonNullable<SubmissionDiagnostics['evaluation']>['pairs'] = []
  for (const [index, id] of ids.entries()) {
    const pair = byId.get(id as string)
    if (!pair) continue
    const metric = config.successMetric as string
    const threshold = config.successThreshold as number
    const value = object(pair.metrics)?.[metric]
    if (
      pair.status !== 'completed' ||
      !finite(value) ||
      typeof pair.success !== 'boolean' ||
      pair.success !== value >= threshold
    )
      return null
    pairs.push({ ordinal: index + 1, state: 'completed', success: pair.success, metric, value, threshold })
  }
  return {
    pairs,
    complete: pairs.length === ids.length,
    total: ids.length,
    successCount: pairs.filter((pair) => pair.success).length,
  }
}

/** Called only after the route has authorized the owner/admin or selected the owner's history. */
export async function submissionDiagnostics(
  rows: Submission[],
): Promise<Map<string, SubmissionDiagnostics | null>> {
  const output = new Map<string, SubmissionDiagnostics | null>(rows.map((row) => [row.id, null]))
  const valid = rows.flatMap((row) => {
    const config = frozenConfiguration(row)
    return config ? [{ row, config }] : []
  })
  if (!valid.length) return output
  const arenaIds = valid.filter(({ row }) => row.category === 'adversarial').map(({ row }) => row.id)
  const [questions, algorithms] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: valid.map(({ row }) => row.questionId) } },
      select: { id: true, revision: true, evaluationVersion: true },
    }),
    arenaIds.length ? prisma.arenaAlgorithm.findMany({ where: { submissionId: { in: arenaIds } } }) : [],
  ])
  const byQuestion = new Map(questions.map((question) => [question.id, question]))
  const bySubmission = new Map(algorithms.map((algorithm) => [algorithm.submissionId, algorithm]))
  const snapshotIds = valid.flatMap(({ row }) => {
    const id = decode(row.result)?.snapshotId
    return typeof id === 'string' ? [id] : []
  })
  const [published, latest] = await Promise.all([
    snapshotIds.length ? prisma.arenaEvaluation.findMany({ where: { id: { in: snapshotIds } } }) : [],
    Promise.all(
      algorithms.map((algorithm) =>
        prisma.arenaEvaluation.findFirst({
          where: { algorithmId: algorithm.id, submissionId: algorithm.submissionId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      ),
    ),
  ])
  const byTask = new Map(published.map((task) => [task.id, task]))
  const byLatest = new Map(
    latest.filter((task): task is ArenaEvaluation => task !== null).map((task) => [task.algorithmId, task]),
  )
  for (const { row, config } of valid) {
    const current = byQuestion.get(row.questionId)
    const result = decode(row.result)
    const diagnostic: SubmissionDiagnostics = {
      questionVersion: row.questionVersion,
      evaluationVersion: row.evaluationVersion,
      historicalVersion:
        !current ||
        current.revision !== row.questionVersion ||
        current.evaluationVersion !== row.evaluationVersion,
      phase:
        row.category === 'basic'
          ? 'basic'
          : row.status === 'opponents' || row.status === 'completed'
            ? 'opponents'
            : 'baseline',
      state: publicState(row.status),
      metrics: row.category === 'basic' ? publicMetrics(result?.metrics, basicMetricNames) : {},
      baseline: null,
      evaluation: null,
      progress: null,
    }
    if (row.category === 'basic') {
      output.set(row.id, diagnostic)
      continue
    }
    const metric = config.baselineMetric as string
    const threshold = config.baselineThreshold as number
    const algorithm = boundAlgorithm(row, bySubmission.get(row.id))
    const baseline = algorithm && decode(algorithm.baselineResult)
    const measured = object(baseline?.metrics)?.[metric]
    const value = finite(measured) ? measured : null
    diagnostic.baseline = {
      metric,
      value,
      threshold,
      comparator: '>=',
      passed: value === null ? null : value >= threshold,
    }
    if (value !== null && value >= threshold) diagnostic.phase = 'opponents'
    if (!algorithm) {
      output.set(row.id, diagnostic)
      continue
    }
    const latestTask = boundTask(row, algorithm, byLatest.get(algorithm.id))
    const publishedTask =
      typeof result?.snapshotId === 'string' ? boundTask(row, algorithm, byTask.get(result.snapshotId)) : null
    const selected = publishedTask?.status === 'completed' ? publishedTask : latestTask
    if (selected) {
      const evidence = pairEvidence(selected, config)
      const saved = decode(selected.result)
      const expectedScore = evidence
        ? evidence.total === 0
          ? 100
          : (100 * evidence.successCount) / evidence.total
        : null
      const final =
        selected === publishedTask &&
        selected.status === 'completed' &&
        result?.counted === true &&
        diagnostic.baseline.passed === true &&
        result.qualified === true &&
        saved?.qualified === true &&
        evidence?.complete === true &&
        saved?.counted === true &&
        saved.successCount === evidence.successCount &&
        saved.opponentCount === evidence.total &&
        result.successCount === evidence.successCount &&
        result.opponentCount === evidence.total &&
        finite(row.score) &&
        expectedScore !== null &&
        Math.abs(row.score - expectedScore) < 1e-8
      if (evidence)
        diagnostic.evaluation = {
          state: publicState(selected.status),
          snapshotRevision: selected.snapshotRevision,
          counted: final,
          successCount: final ? evidence.successCount : null,
          opponentCount: final ? evidence.total : null,
          emptyPool: final && evidence.total === 0,
          pairs: evidence.pairs,
        }
    }
    if (latestTask && ['queued', 'running', 'error'].includes(latestTask.status)) {
      const evidence = pairEvidence(latestTask, config)
      diagnostic.progress = {
        state: publicState(latestTask.status),
        completedOpponents: evidence?.pairs.length ?? 0,
        totalOpponents: evidence?.total ?? null,
      }
    }
    output.set(row.id, diagnostic)
  }
  return output
}
