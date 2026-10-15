import { prisma } from '../lib/db.js'
import { normalizeCategory } from '../lib/prdContract.js'
import { transaction } from '../lib/transaction.js'
import type { Prisma, PrismaClient } from '@prisma/client'

export async function buildMigrationReport(db: PrismaClient | Prisma.TransactionClient = prisma) {
  const questions = await db.question.findMany()
  const revisions = new Map(questions.map((q) => [q.id, q]))
  const submissions = await db.submission.findMany({ orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] })
  const users = await db.user.findMany({ select: { id: true } })
  const existingScores = await db.basicScore.findMany()
  const existingTotals = await db.basicTotal.findMany()
  const scoreByIdentity = new Map(existingScores.map((s) => [JSON.stringify([s.userId, s.questionId]), s]))
  const totalByUser = new Map(existingTotals.map((s) => [s.userId, s]))
  const known = new Set(users.map((u) => u.id))
  const best = new Map<
    string,
    {
      userId: string
      questionId: string
      questionVersion: number
      score: number
      submissionId: string
      scoreReachedAt: Date
    }
  >()
  const excluded: { id: string; reason: string }[] = []
  const timestampWarnings: { userId: string; questionId: string; reason: string }[] = []
  for (const s of submissions) {
    const q = revisions.get(s.questionId)
    if (!q || normalizeCategory(q.category) !== 'basic') {
      excluded.push({ id: s.id, reason: 'adversarial_or_missing_question' })
      continue
    }
    if (s.questionVersion !== q.revision) {
      excluded.push({ id: s.id, reason: 'obsolete_question_version' })
      continue
    }
    if (!known.has(s.userId)) {
      excluded.push({ id: s.id, reason: 'unknown_user_identity' })
      continue
    }
    if (
      !['passed', 'completed'].includes(s.status) ||
      s.score === null ||
      !Number.isFinite(s.score) ||
      s.score <= 0
    )
      continue
    const key = JSON.stringify([s.userId, s.questionId])
    if (s.score > (best.get(key)?.score ?? 0))
      best.set(key, {
        userId: s.userId,
        questionId: s.questionId,
        questionVersion: q.revision,
        score: s.score,
        submissionId: s.id,
        scoreReachedAt: s.updatedAt,
      })
  }
  for (const [key, row] of best) {
    const existing = scoreByIdentity.get(key)
    if (existing?.questionVersion === row.questionVersion && existing.score === row.score)
      row.scoreReachedAt = existing.scoreReachedAt
    else
      timestampWarnings.push({
        userId: row.userId,
        questionId: row.questionId,
        reason: 'legacy_updated_at_is_only_available_score_time_estimate',
      })
  }
  const totals = new Map<
    string,
    { userId: string; totalScore: number; tasksCompleted: number; scoreReachedAt: Date }
  >()
  for (const row of best.values()) {
    const current = totals.get(row.userId) || {
      userId: row.userId,
      totalScore: 0,
      tasksCompleted: 0,
      scoreReachedAt: new Date(0),
    }
    current.totalScore += row.score
    current.tasksCompleted++
    if (row.scoreReachedAt > current.scoreReachedAt) current.scoreReachedAt = row.scoreReachedAt
    totals.set(row.userId, current)
  }
  for (const [userId, total] of totals) {
    const existing = totalByUser.get(userId)
    if (existing?.totalScore === total.totalScore) total.scoreReachedAt = existing.scoreReachedAt
  }
  for (const existing of existingTotals) {
    if (known.has(existing.userId) && existing.totalScore === 0 && !totals.has(existing.userId)) {
      totals.set(existing.userId, {
        userId: existing.userId,
        totalScore: 0,
        tasksCompleted: 0,
        scoreReachedAt: existing.scoreReachedAt,
      })
    }
  }
  return {
    createdAt: new Date().toISOString(),
    scores: [...best.values()],
    totals: [...totals.values()],
    excluded,
    timestampWarnings,
    legacyMixedScores: await db.userScore.count(),
    questionsNeedingPackages: questions
      .filter((q) => q.definition === '{}')
      .map((q) => ({
        id: q.id,
        category: normalizeCategory(q.category),
        judgeMode: q.judgeMode,
        reason: 'requires_package_and_self_test',
      })),
    historicalArenaAction: '保留历史记录；重新提交材料并在当前规则下完成基线与完整对手评测后才生效',
  }
}

export async function applyBasicMigration(actorId: string) {
  return transaction(async (tx) => {
    const pending = await tx.evaluationTask.count({ where: { state: { in: ['queued', 'running'] } } })
    if (pending) throw new Error('迁移前须暂停提交并等待任务完成')
    // Build the report from the same serializable snapshot as its writes. A
    // concurrent publication cannot reset a score and then have migration revive it.
    const report = await buildMigrationReport(tx)
    await tx.basicScore.deleteMany()
    await tx.basicTotal.deleteMany()
    if (report.scores.length) await tx.basicScore.createMany({ data: report.scores })
    if (report.totals.length) await tx.basicTotal.createMany({ data: report.totals })
    await tx.auditEvent.create({
      data: {
        actorId,
        action: 'migration.basic_scores',
        targetId: 'prd-v1.1',
        detail: JSON.stringify({
          scoreRows: report.scores.length,
          totals: report.totals.length,
          excluded: report.excluded,
          timestampWarnings: report.timestampWarnings,
        }),
      },
    })
    return report
  })
}
