import { requireAdminMw } from '../lib/auth.js'
import { Router } from 'express'
import {
  getLeaderboard,
  getUserStats,
  getModuleLeaderboard,
  getMyRank,
  clearLeaderboard,
} from '../services/leaderboard.js'

const router = Router()
router.use('/admin', requireAdminMw)

// GET /api/leaderboard?limit=50
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const data = await getLeaderboard(limit)
    res.json({ code: 0, message: 'ok', data })
  } catch (err) {
    console.error('Failed to fetch leaderboard:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// GET /api/leaderboard/module/:moduleCode?limit=50
router.get('/leaderboard/module/:moduleCode', async (req, res) => {
  try {
    const moduleCode = req.params.moduleCode
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const data = await getModuleLeaderboard(moduleCode, limit)
    res.json({ code: 0, message: 'ok', data })
  } catch (err) {
    console.error('Failed to fetch module leaderboard:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// GET /api/leaderboard/my-rank?userId=xxx
router.get('/leaderboard/my-rank', async (req, res) => {
  try {
    const userId = String(req.query.userId ?? '')
    if (!userId) {
      return res.status(400).json({ code: 40001, message: 'userId is required', data: null })
    }
    const data = await getMyRank(userId)
    res.json({ code: 0, message: 'ok', data })
  } catch (err) {
    console.error('Failed to fetch my rank:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// GET /api/users/:userId/stats
router.get('/users/:userId/stats', async (req, res) => {
  try {
    const data = await getUserStats(req.params.userId)
    res.json({ code: 0, message: 'ok', data })
  } catch (err) {
    console.error('Failed to fetch user stats:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// DELETE /api/admin/leaderboard - 清空排行榜（UserScore + Submission）
router.delete('/admin/leaderboard', async (_req, res) => {
  res
    .status(409)
    .json({
      code: 40900,
      message: '请通过题目版本发布或迁移差异报告处理成绩；历史提交不可直接删除',
      data: null,
    })
})

export default router
