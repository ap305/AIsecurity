import { prisma } from '../lib/db.js'
import { arenaPoolKey, isCurrentArenaSubmission } from './arenaRules.js'

export async function arenaQuestionScore(questionId: string, userId: string) {
  const question = await prisma.question.findUnique({ where: { id: questionId } })
  if (
    !question ||
    question.status !== 'published' ||
    question.category !== 'adversarial' ||
    !question.scenarioId ||
    !question.role
  )
    return null
  const slot = await prisma.arenaSlot.findUnique({
    where: {
      userId_scenarioId_role_evaluationVersion: {
        userId,
        ...arenaPoolKey({ ...question, questionId: question.id, scenarioId: question.scenarioId }),
        role: question.role,
      },
    },
  })
  const algorithm = slot && (await prisma.arenaAlgorithm.findUnique({ where: { id: slot.algorithmId } }))
  const activeSubmission =
    algorithm && (await prisma.submission.findUnique({ where: { id: algorithm.submissionId } }))
  const eligible =
    algorithm?.status === 'active' &&
    activeSubmission?.questionId === questionId &&
    isCurrentArenaSubmission(activeSubmission, question)
  const score =
    eligible && algorithm
      ? await prisma.arenaScore.findUnique({ where: { algorithmId: algorithm.id } })
      : null
  const latest = await prisma.submission.findFirst({
    where: { userId, questionId, questionVersion: question.revision, category: 'adversarial' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const recomputation =
    eligible && algorithm
      ? await prisma.arenaEvaluation.findFirst({
          where: { algorithmId: algorithm.id, kind: 'recompute' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : null
  const pending =
    recomputation && ['queued', 'running', 'error'].includes(recomputation.status) ? recomputation : null
  const latestResult = latest?.result
    ? (JSON.parse(latest.result) as { qualified?: boolean; publicMessage?: string })
    : null
  const latestIsRunning =
    !!latest && ['queued', 'pending', 'judging', 'baseline', 'opponents'].includes(latest.status)
  return {
    questionId,
    scenarioId: question.scenarioId,
    role: question.role,
    evaluationVersion: question.evaluationVersion,
    questionVersion: question.revision,
    score: score ? score.score : null,
    qualified: score ? true : (latestResult?.qualified ?? null),
    counted: !!score,
    successCount: score ? score.successCount : null,
    opponentCount: score ? score.opponentCount : null,
    emptyPool: score ? score.opponentCount === 0 : false,
    snapshotId: score ? score.snapshotId : null,
    snapshotRevision: score ? score.snapshotRevision : null,
    scoreReachedAt: score ? score.achievedAt.toISOString() : null,
    updatedAt: score ? score.updatedAt.toISOString() : null,
    status: latestIsRunning
      ? latest!.status
      : pending
        ? pending.status === 'error'
          ? 'update_error'
          : 'updating'
        : score
          ? 'completed'
          : (latest?.status ?? 'not_submitted'),
    updating: latestIsRunning || !!pending,
    activeSubmissionId: score && algorithm ? algorithm.submissionId : null,
    latestSubmissionId: latest?.id ?? null,
    latestSubmissionStatus: latest?.status ?? null,
    publicMessage:
      pending?.status === 'error'
        ? '成绩更新暂未完成，保留上次有效成绩'
        : (latestResult?.publicMessage ?? (score?.opponentCount === 0 ? '暂无有效对手，按规则计100%' : null)),
  }
}

export async function arenaTasks(userId: string) {
  const questions = await prisma.question.findMany({
    where: {
      category: 'adversarial',
      status: 'published',
      role: { in: ['attack', 'defense'] },
      scenarioId: { not: null },
    },
    select: {
      id: true,
      title: true,
      difficulty: true,
      moduleCode: true,
      category: true,
      role: true,
      scenarioId: true,
      revision: true,
      evaluationVersion: true,
    },
    orderBy: [{ scenarioId: 'asc' }, { role: 'asc' }, { id: 'asc' }],
  })
  return Promise.all(
    questions.map(async (question) => ({
      ...question,
      myScore: await arenaQuestionScore(question.id, userId),
    })),
  )
}

export async function arenaQuestionLeaderboard(questionId: string, limit = 100) {
  const question = await prisma.question.findUnique({ where: { id: questionId } })
  if (
    !question ||
    question.status !== 'published' ||
    question.category !== 'adversarial' ||
    !question.scenarioId ||
    !question.role
  )
    return null
  const slots = await prisma.arenaSlot.findMany({
    where: {
      ...arenaPoolKey({ ...question, questionId: question.id, scenarioId: question.scenarioId }),
      role: question.role,
    },
  })
  const algorithms = await prisma.arenaAlgorithm.findMany({
    where: { id: { in: slots.map((slot) => slot.algorithmId) }, questionId, status: 'active' },
  })
  const submissions = await prisma.submission.findMany({
    where: { id: { in: algorithms.map((a) => a.submissionId) }, questionVersion: question.revision },
  })
  const validSubmissionIds = new Set(
    submissions.filter((s) => isCurrentArenaSubmission(s, question)).map((s) => s.id),
  )
  const ids = algorithms.filter((a) => validSubmissionIds.has(a.submissionId)).map((a) => a.id)
  // Filter before the score limit so test results cannot displace real students.
  const users = await prisma.user.findMany({
    where: { id: { in: algorithms.map((a) => a.userId) }, isTestAccount: false },
    select: { id: true, displayName: true },
  })
  const scores = await prisma.arenaScore.findMany({
    where: { algorithmId: { in: ids }, questionId, userId: { in: users.map((u) => u.id) } },
    orderBy: [{ score: 'desc' }, { achievedAt: 'asc' }, { userId: 'asc' }],
    take: Math.max(1, Math.min(500, limit)),
  })
  const byUser = new Map(users.map((u) => [u.id, u.displayName]))
  return scores
    .filter((s) => byUser.has(s.userId))
    .map((s, index) => ({
      rank: index + 1,
      userId: s.userId,
      displayName: byUser.get(s.userId),
      score: s.score,
      successCount: s.successCount,
      opponentCount: s.opponentCount,
      emptyPool: s.opponentCount === 0,
      scoreReachedAt: s.achievedAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }))
}
