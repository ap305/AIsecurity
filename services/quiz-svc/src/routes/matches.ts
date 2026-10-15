import { Router, type Request, type Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireUser } from '../lib/auth.js'
import { prisma } from '../lib/db.js'

const router = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const historyPath = path.resolve(__dirname, '../../uploads/matches/history.json')

export interface UploadRecord {
  workDirId: string
  userId: string
  githubAccount: string
  displayName: string
  scenario: string
  role: string
  fileName: string
  size: number
  uploadedAt: string
  version: number
  archived: boolean
}

// Legacy judging mixed arena scores into the basic leaderboard and ran student
// Python in the service container. Keep old links explicit, never a bypass.
for (const endpoint of ['/matches/run', '/matches/upload', '/matches/submit-inline', '/matches/validate']) {
  router.post(endpoint, async (req: Request, res: Response) => {
    const user = await requireUser(req, res)
    if (!user) return
    res.status(410).json({
      code: 41000,
      message: '旧对战提交入口已迁移，请从对战大厅进入固定角色题目并使用统一提交入口',
      data: { submitPath: '/api/submissions', arenaPath: '/arena' },
    })
  })
}

router.get('/matches/judge-mode', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  res.json({ code: 0, message: 'ok', data: { mode: 'compose', migrationRequired: true } })
})

router.get('/matches/uploads', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  try {
    const raw = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : []
    const records: UploadRecord[] = Array.isArray(raw) ? raw : []
    const scenario = typeof req.query.scenario === 'string' ? req.query.scenario : ''
    const role = typeof req.query.role === 'string' ? req.query.role : ''
    const data = records
      .filter(
        (record) =>
          record.userId === user.id &&
          (!scenario || record.scenario === scenario) &&
          (!role || record.role === role),
      )
      .map(({ fileName, size, uploadedAt, version, archived, scenario: itemScenario, role: itemRole }) => ({
        fileName,
        size,
        uploadedAt,
        version,
        archived,
        scenario: itemScenario,
        role: itemRole,
      }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    res.json({ code: 0, message: 'ok', data })
  } catch {
    res.status(500).json({ code: 50000, message: '历史上传记录暂不可用', data: null })
  }
})

router.get('/matches/queue', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  try {
    const submissions = await prisma.submission.findMany({
      where: { userId: user.id, category: 'adversarial' },
      select: { id: true },
    })
    const tasks = await prisma.arenaEvaluation.findMany({
      where: { submissionId: { in: submissions.map((s) => s.id) }, status: { in: ['queued', 'running'] } },
      select: { id: true, submissionId: true, kind: true, status: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    res.json({ code: 0, message: 'ok', data: { tasks } })
  } catch {
    res.status(500).json({ code: 50000, message: '队列状态暂不可用', data: null })
  }
})

export default router
