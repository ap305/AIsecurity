import type { PrismaClient } from '@prisma/client'
import { isOriginalD02Evaluation } from '../lib/modelCallBudget.js'
import { D02_ORIGINAL_POOL_COMPATIBILITY } from './arenaRules.js'

export type EvaluationWorkerLane = 'ordinary' | 'd02-original300'
type LaneSubmission = {
  questionId: string; questionVersion: number; category: string; role: string | null; scenarioId: string | null
  evaluationVersion: string; configSnapshot: string
}
type LaneDatabase = Pick<PrismaClient, 'submission' | 'evaluationTask' | 'arenaEvaluation'>
const submissionSelect = {
  id: true, questionId: true, questionVersion: true, category: true, role: true, scenarioId: true,
  evaluationVersion: true, configSnapshot: true,
} as const
let dispatchStopped = false

export function evaluationWorkerLane(): EvaluationWorkerLane {
  const lane = process.env.EVALUATION_WORKER_LANE ?? 'ordinary'
  if (lane !== 'ordinary' && lane !== 'd02-original300') throw Error('Unknown evaluation worker lane')
  return lane
}
export function evaluationDispatchEnabled() { return !dispatchStopped }
export function stopEvaluationDispatch() { dispatchStopped = true }
export function resumeEvaluationDispatch() { dispatchStopped = false }

export function submissionEvaluationLane(row: LaneSubmission): EvaluationWorkerLane {
  const expected = D02_ORIGINAL_POOL_COMPATIBILITY
  if (row.questionId !== expected.questionId || row.scenarioId !== expected.scenarioId ||
      row.role !== 'defense' || row.category !== 'adversarial' || row.evaluationVersion !== expected.evaluationVersion)
    return 'ordinary'
  try {
    const snapshot = JSON.parse(row.configSnapshot)
    if (snapshot.questionId === row.questionId && snapshot.questionVersion === row.questionVersion &&
        snapshot.category === row.category && snapshot.role === row.role && snapshot.scenarioId === row.scenarioId &&
        snapshot.evaluationVersion === row.evaluationVersion && snapshot.definition?.evaluation &&
        isOriginalD02Evaluation(snapshot.definition.evaluation)) return 'd02-original300'
  } catch { /* Invalid frozen contracts stay in the ordinary bounded failure path. */ }
  return 'ordinary'
}

export async function taskIdsForEvaluationLane(
  db: LaneDatabase, tasks: Array<{ id: string; submissionId: string }>, lane = evaluationWorkerLane(),
) {
  const rows = await db.submission.findMany({
    where: { id: { in: [...new Set(tasks.map(t => t.submissionId))] } }, select: submissionSelect,
  })
  const byId = new Map(rows.map(row => [row.id, submissionEvaluationLane(row)]))
  return tasks.filter(task => (byId.get(task.submissionId) ?? 'ordinary') === lane).map(task => task.id)
}

/** Scan bounded pages so a long lane's queue head cannot block ordinary submissions. */
export async function nextEvaluationLaneTask(db: LaneDatabase, kind: 'submission' | 'arena', lane = evaluationWorkerLane()) {
  let cursor: string | undefined
  for (;;) {
    const page = { take: 100, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      select: { id: true, submissionId: true, attempts: true, createdAt: true },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }
    const tasks = kind === 'submission'
      ? await db.evaluationTask.findMany({ ...page, where: { state: 'queued' } })
      : await db.arenaEvaluation.findMany({ ...page, where: { status: 'queued' } })
    if (!tasks.length) return null
    const accepted = new Set(await taskIdsForEvaluationLane(db, tasks, lane))
    const task = tasks.find(task => accepted.has(task.id))
    if (task) return task
    if (tasks.length < page.take) return null
    cursor = tasks[tasks.length - 1].id
  }
}
