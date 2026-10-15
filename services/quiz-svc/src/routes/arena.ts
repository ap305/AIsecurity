import { Router, type Request, type Response } from 'express'
import { authPayload, requireUser, requireAdminMw } from '../lib/auth.js'
import { arenaTasks, arenaQuestionScore, arenaQuestionLeaderboard } from '../services/arenaQueries.js'
import { prisma } from '../lib/db.js'
import { RequestError, parseJson } from '../lib/prdContract.js'
import { retryArenaRecomputation } from '../services/arenaScoring.js'

const router = Router()

function failure(res: Response, error: unknown): void {
  if (error instanceof RequestError) {
    res.status(error.status).json({ code: error.status * 100, message: error.message, data: null })
    return
  }
  console.error('[arena] Query failed:', error instanceof Error ? error.name : 'unknown')
  res.status(500).json({ code: 50000, message: '攻防状态暂不可用，请稍后重试', data: null })
}

router.get('/arena/tasks', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  try {
    res.json({ code: 0, message: 'ok', data: await arenaTasks(user.id) })
  } catch (error) {
    failure(res, error)
  }
})

router.get('/admin/arena-evaluations', requireAdminMw, async (req: Request, res: Response) => {
  try {
    const filter = typeof req.query.status === 'string' ? req.query.status : undefined
    const tasks = await prisma.arenaEvaluation.findMany({
      where: filter ? { status: filter } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    res.json({
      code: 0,
      message: 'ok',
      data: tasks.map((task) => ({
        ...task,
        result: parseJson(task.result, null),
        opponentsSnapshot: parseJson(task.opponentsSnapshot, null),
      })),
    })
  } catch (error) {
    failure(res, error)
  }
})

router.post('/admin/arena-evaluations/:id/retry', requireAdminMw, async (req: Request, res: Response) => {
  try {
    await retryArenaRecomputation(req.params.id, authPayload(req)!.uid)
    res.json({ code: 0, message: 'ok', data: { queued: true } })
  } catch (error) {
    failure(res, error)
  }
})

router.get('/arena/questions/:id/score', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  try {
    const score = await arenaQuestionScore(req.params.id, user.id)
    if (!score) {
      res.status(404).json({ code: 40400, message: '攻防题不存在或未发布', data: null })
      return
    }
    res.json({ code: 0, message: 'ok', data: score })
  } catch (error) {
    failure(res, error)
  }
})

router.get('/arena/questions/:id/leaderboard', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  try {
    const leaderboard = await arenaQuestionLeaderboard(req.params.id, Number(req.query.limit) || 100)
    if (!leaderboard) {
      res.status(404).json({ code: 40400, message: '攻防题不存在或未发布', data: null })
      return
    }
    res.json({ code: 0, message: 'ok', data: leaderboard })
  } catch (error) {
    failure(res, error)
  }
})

export default router
