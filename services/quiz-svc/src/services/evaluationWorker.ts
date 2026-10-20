import crypto from 'node:crypto'
import { prisma } from '../lib/db.js'
import { parseJson, type SubmissionSnapshot } from '../lib/prdContract.js'
import { recordBasicResult } from './basicScores.js'
import { runComposeEvaluation } from './composeJudge.js'
import { processArenaSubmission, recoverArenaTasks, configureArenaRuntime } from './arenaScoring.js'
import { submissionGateway } from './apiPool.js'
import { transaction } from '../lib/transaction.js'

let running = false,
  enabled = false,
  timer: ReturnType<typeof setInterval> | undefined
const runtime = { run: runComposeEvaluation }
export function configureEvaluationRuntime(config: Partial<typeof runtime>) {
  Object.assign(runtime, config)
}

async function failAttempt(
  task: { id: string; attempts: number; submissionId: string },
  result: Record<string, unknown>,
  retryable: boolean,
  cleanupStatus?: string,
) {
  await transaction(async (tx) => {
    const current = await tx.evaluationTask.findUnique({ where: { id: task.id } })
    if (current?.state !== 'running' || current.attempts !== task.attempts) return
    const retry = retryable && task.attempts < 3
    await tx.submission.updateMany({
      where: { id: task.submissionId, status: { not: 'completed' } },
      data: {
        status: retry ? 'queued' : retryable ? 'error' : 'failed',
        score: null,
        result: JSON.stringify(result),
      },
    })
    await tx.evaluationTask.update({
      where: { id: task.id },
      data: {
        state: retry ? 'queued' : retryable ? 'error' : 'completed',
        lockedAt: null,
        error: String(result.publicMessage || '评测未完成'),
        ...(cleanupStatus ? { cleanupStatus } : {}),
      },
    })
    if (retry) {
      await tx.arenaEvaluation.updateMany({
        where: { submissionId: task.submissionId, kind: 'candidate', status: 'error' },
        data: { status: 'queued', error: null },
      })
      await tx.arenaAlgorithm.updateMany({
        where: { submissionId: task.submissionId, status: 'error' },
        data: { status: 'candidate' },
      })
    }
  })
}

export async function processEvaluationTask(id: string) {
  const task = await transaction(async (tx) => {
    const claimed = await tx.evaluationTask.updateMany({
      where: { id, state: 'queued' },
      data: { state: 'running', lockedAt: new Date(), attempts: { increment: 1 }, error: null },
    })
    if (!claimed.count) return null
    const task = await tx.evaluationTask.findUniqueOrThrow({ where: { id } })
    const submission = await tx.submission.findUniqueOrThrow({ where: { id: task.submissionId } })
    if (submission.status === 'completed' && submission.score !== null) {
      await tx.evaluationTask.update({ where: { id }, data: { state: 'completed' } })
      return null
    }
    await tx.submission.update({ where: { id: submission.id }, data: { status: 'judging' } })
    return task
  })
  if (!task) return
  const heartbeat = setInterval(() => {
    void prisma.evaluationTask
      .updateMany({
        where: { id, state: 'running', attempts: task.attempts },
        data: { lockedAt: new Date() },
      })
      .catch(() => {})
  }, 20000)
  heartbeat.unref()
  try {
    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: task.submissionId } })
    const snapshot = parseJson<SubmissionSnapshot>(submission.configSnapshot, {} as SubmissionSnapshot)
    if (snapshot.category === 'adversarial') {
      await processArenaSubmission(submission.id)
      const latest = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })
      if (latest.status === 'error') {
        const result = parseJson<Record<string, unknown>>(latest.result, {})
        const status = result.evaluationStatus
        const known = ['student_error', 'timeout', 'system_error'].includes(String(status))
        // The arena publishes fixed messages; never relay an untrusted raw evaluator message.
        const messages = {
          student_error:'代码或模型运行失败，请核对题目接口、依赖及模型结构后重新提交；本次不计分，原有效成绩保留',
          timeout:'评测超时，本次不计分，原有效成绩保留',
          system_error:'评测环境异常，本次不计分，原有效成绩保留；请联系管理员查看任务状态',
        }
        await failAttempt(task, {
          counted:false,
          ...(known ? {evaluationStatus:status} : {}),
          publicMessage:known ? messages[status as keyof typeof messages] : '攻防评测未完成，已按有限重试规则处理；原有效成绩保留',
          ...(['cleaned','cleanup_failed','not_started'].includes(String(result.cleanupStatus)) ? {cleanupStatus:result.cleanupStatus} : {}),
        }, status !== 'student_error', typeof result.cleanupStatus === 'string' ? result.cleanupStatus : undefined)
      }
      else
        await prisma.evaluationTask.updateMany({
          where: { id, state: 'running', attempts: task.attempts },
          data: { state: 'completed' },
        })
      return
    }
    const output = await runtime.run({
      submissionId: submission.id,
      attemptId: crypto.randomUUID(),
      questionVersion: submission.questionVersion,
      evaluationVersion: submission.evaluationVersion,
      packageId: snapshot.definition.evaluation.packageId!,
      code: submission.code,
      filePath: submission.filePath,
      phase: 'basic',
      timeoutMs: snapshot.definition.evaluation.timeoutMs,
      modelGateway: submissionGateway(snapshot, submission.id),
      parameters: snapshot.definition.evaluation,
    })
    const result = {
      publicMessage: output.publicMessage,
      maxScore: output.maxScore,
      metrics: output.metrics,
      cleanupStatus: output.cleanupStatus,
    }
    if (
      output.status === 'completed' &&
      output.score !== undefined &&
      Number.isFinite(output.score) &&
      output.score >= 0 &&
      output.score <= snapshot.definition.evaluation.maxScore
    ) {
      await recordBasicResult(submission.id, output.score, result, new Date(), {
        taskId: id,
        attempt: task.attempts,
      })
      await prisma.evaluationTask.updateMany({
        where: { id, state: 'running', attempts: task.attempts },
        data: { state: 'completed', cleanupStatus: output.cleanupStatus },
      })
    } else {
      await failAttempt(task, result, output.status !== 'student_error', output.cleanupStatus)
    }
  } catch {
    await failAttempt(task, { publicMessage: '评测服务异常，本次未计分，将按有限重试规则处理' }, true)
  } finally {
    clearInterval(heartbeat)
  }
}

export async function drainEvaluationQueue() {
  if (running) return
  running = true
  try {
    // A heartbeat protects tasks still owned by another process; crashed jobs become retryable after two minutes.
    await prisma.evaluationTask.updateMany({
      where: { state: 'running', lockedAt: { lt: new Date(Date.now() - 120000) } },
      data: { state: 'queued', error: '执行中断后恢复' },
    })
    for (;;) {
      const task = await prisma.evaluationTask.findFirst({
        where: { state: 'queued' },
        orderBy: { createdAt: 'asc' },
      })
      if (!task) break
      if (task.attempts >= 3) {
        await prisma.evaluationTask.update({
          where: { id: task.id },
          data: { state: 'error', error: '已达到三次尝试上限' },
        })
        continue
      }
      await processEvaluationTask(task.id)
    }
  } finally {
    running = false
  }
}
export function wakeEvaluationWorker() {
  if (enabled) void drainEvaluationQueue().catch(() => console.error('[worker] queue unavailable'))
}
export async function startEvaluationWorker() {
  configureArenaRuntime({
    modelGateway: async (snapshot, id) => submissionGateway(snapshot as unknown as SubmissionSnapshot, id),
  })
  await recoverArenaTasks()
  enabled = true
  timer = setInterval(() => {
    wakeEvaluationWorker()
    void recoverArenaTasks().catch(() => console.error('[worker] arena recovery unavailable'))
  }, 3000)
  timer.unref()
  wakeEvaluationWorker()
}
export function stopEvaluationWorker() {
  enabled = false
  if (timer) clearInterval(timer)
}
