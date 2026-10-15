import type { Prisma } from '@prisma/client'
import { transaction } from '../lib/transaction.js'
import { normalizeCategory } from '../lib/prdContract.js'

export async function recordBasicResult(
  submissionId: string,
  score: number,
  result: Record<string, unknown>,
  at = new Date(),
  lease?: { taskId: string; attempt: number },
) {
  if (!Number.isFinite(score) || score < 0) throw new Error('Invalid basic score')
  return transaction(async (tx) => {
    if (lease) {
      const task = await tx.evaluationTask.findUnique({ where: { id: lease.taskId } })
      if (task?.state !== 'running' || task.attempts !== lease.attempt || task.submissionId !== submissionId)
        return false
    }
    const submission = await tx.submission.findUniqueOrThrow({ where: { id: submissionId } })
    if (['passed', 'failed', 'completed'].includes(submission.status) && submission.score !== null)
      return false
    const question = await tx.question.findUniqueOrThrow({ where: { id: submission.questionId } })
    await tx.submission.update({
      where: { id: submissionId },
      data: { status: 'completed', score, result: JSON.stringify(result) },
    })
    if (normalizeCategory(question.category) !== 'basic' || question.revision !== submission.questionVersion)
      return false
    const previous = await tx.basicScore.findUnique({
      where: { userId_questionId: { userId: submission.userId, questionId: question.id } },
    })
    const oldScore = previous?.questionVersion === question.revision ? previous.score : 0
    const delta = score - oldScore
    if (delta <= 0) return false
    await tx.basicScore.upsert({
      where: { userId_questionId: { userId: submission.userId, questionId: question.id } },
      create: {
        userId: submission.userId,
        questionId: question.id,
        questionVersion: question.revision,
        score,
        submissionId,
        scoreReachedAt: at,
      },
      update: { score, submissionId, questionVersion: question.revision, scoreReachedAt: at },
    })
    await tx.basicTotal.upsert({
      where: { userId: submission.userId },
      create: { userId: submission.userId, totalScore: score, tasksCompleted: 1, scoreReachedAt: at },
      update: {
        totalScore: { increment: delta },
        tasksCompleted: { increment: oldScore > 0 ? 0 : 1 },
        scoreReachedAt: at,
      },
    })
    return true
  })
}

// Must share the question publication transaction: a late result observes either old or new revision atomically.
export async function resetQuestionScores(tx: Prisma.TransactionClient, questionId: string, at = new Date()) {
  const scores = await tx.basicScore.findMany({ where: { questionId } })
  for (const row of scores) {
    if (row.score <= 0) continue
    await tx.basicTotal.updateMany({
      where: { userId: row.userId },
      data: { totalScore: { decrement: row.score }, tasksCompleted: { decrement: 1 }, scoreReachedAt: at },
    })
  }
  await tx.basicScore.deleteMany({ where: { questionId } })
}
