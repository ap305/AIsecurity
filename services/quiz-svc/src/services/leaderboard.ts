import { prisma } from '../lib/db.js'
export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum'
export function calculateTier(score: number): Tier {
  return score >= 6000 ? 'platinum' : score >= 3000 ? 'gold' : score >= 1000 ? 'silver' : 'bronze'
}
export async function getLeaderboard(limit?: number) {
  const users = await prisma.user.findMany({ select: { id: true, displayName: true } })
  const rows = await prisma.basicTotal.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    orderBy: [{ totalScore: 'desc' }, { scoreReachedAt: 'asc' }, { userId: 'asc' }],
    ...(limit ? { take: Math.max(1, Math.floor(limit)) } : {}),
  })
  const names = new Map(users.map((u) => [u.id, u.displayName]))
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    displayName: names.get(r.userId) || '历史用户',
    totalScore: r.totalScore,
    tasksCompleted: r.tasksCompleted,
    scoreReachedAt: r.scoreReachedAt.toISOString(),
    tier: calculateTier(r.totalScore),
    matchWins: 0,
    uploadCount: 0,
    uploadTasks: 0,
    latestUploadAt: null,
  }))
}
export async function getUserStats(userId: string) {
  const [row, user] = await Promise.all([
    prisma.basicTotal.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } }),
  ])
  return {
    displayName: user?.displayName || '历史用户',
    totalScore: row?.totalScore ?? 0,
    tier: calculateTier(row?.totalScore ?? 0),
    tasksCompleted: row?.tasksCompleted ?? 0,
    matchWins: 0,
  }
}
export async function getMyRank(userId: string) {
  const users = await prisma.user.findMany({ select: { id: true } })
  if (!users.some((user) => user.id === userId)) return null
  const row = await prisma.basicTotal.findUnique({ where: { userId } })
  if (!row) return null
  const higher = await prisma.basicTotal.count({
    where: {
      userId: { in: users.map((user) => user.id) },
      OR: [
        { totalScore: { gt: row.totalScore } },
        { totalScore: row.totalScore, scoreReachedAt: { lt: row.scoreReachedAt } },
        { totalScore: row.totalScore, scoreReachedAt: row.scoreReachedAt, userId: { lt: row.userId } },
      ],
    },
  })
  return {
    rank: higher + 1,
    totalScore: row.totalScore,
    tier: calculateTier(row.totalScore),
    scoreReachedAt: row.scoreReachedAt.toISOString(),
  }
}
export async function getModuleLeaderboard(moduleCode: string, limit = 50) {
  const users = await prisma.user.findMany({ select: { id: true } })
  const existingUsers = new Set(users.map((user) => user.id))
  const questions = await prisma.question.findMany({
    where: { moduleCode, category: 'basic' },
    select: { id: true, revision: true },
  })
  const scores = await prisma.basicScore.findMany({
    where: { questionId: { in: questions.map((q) => q.id) } },
  })
  const totals = new Map<string, { score: number; count: number; at: Date }>()
  for (const row of scores) {
    if (!existingUsers.has(row.userId)) continue
    if (questions.find((q) => q.id === row.questionId)?.revision !== row.questionVersion) continue
    const total = totals.get(row.userId) || { score: 0, count: 0, at: new Date(0) }
    total.score += row.score
    total.count++
    if (row.scoreReachedAt > total.at) total.at = row.scoreReachedAt
    totals.set(row.userId, total)
  }
  const global = await getLeaderboard()
  return [...totals.entries()]
    .sort(
      (a, b) => b[1].score - a[1].score || a[1].at.getTime() - b[1].at.getTime() || a[0].localeCompare(b[0]),
    )
    .slice(0, limit)
    .map(([userId, r], i) => ({
      rank: i + 1,
      userId,
      displayName: global.find((x) => x.userId === userId)?.displayName || '历史用户',
      moduleScore: r.score,
      tasksCompleted: r.count,
      tier: calculateTier(r.score),
    }))
}
export async function clearLeaderboard(): Promise<never> {
  throw new Error('成绩清空已停用；请通过题目版本发布或带差异报告的迁移处理，历史提交必须保留')
}
