import { Router } from 'express'
import { requireAdminMw, authPayload, requireUser } from '../lib/auth.js'
import { prisma } from '../lib/db.js'
import { RequestError } from '../lib/prdContract.js'
import { questionView, saveQuestion } from '../services/questions.js'
import { PackageValidationError } from '../lib/evaluationPackage.js'
import { arenaQuestionScore } from '../services/arenaQueries.js'
const router = Router()
const ok = (res: any, data: any) => res.json({ code: 0, message: 'ok', data })
const fail = (res: any, error: any) =>
  res
    .status(
      error instanceof RequestError ? error.status : error instanceof PackageValidationError ? 400 : 500,
    )
    .json({
      code: 40001,
      message:
        error instanceof RequestError || error instanceof PackageValidationError
          ? error.message
          : '题目操作失败',
      data: null,
    })
// Existing course module names, also used by the original teaching navigation.
const moduleTags: Record<string, string> = {
  M1: '对抗攻击与规避',
  M2: '数据投毒与后门',
  M3: '模型窃取与隐私',
  M4: 'LLM 安全',
  M5: '公平性与审计',
}
router.use('/admin', requireAdminMw)
router.get('/questions', async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    const category = String(req.query.category || '')
    const rows = await prisma.question.findMany({
      where: {
        status: 'published',
        ...(category
          ? { category: { in: category === 'adversarial' ? ['adversarial', 'security'] : ['basic'] } }
          : {}),
      },
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
    })
    const [scores, submissions] = await Promise.all([
      prisma.basicScore.findMany({
        where: { userId: user.id, questionId: { in: rows.map((row) => row.id) } },
      }),
      prisma.submission.findMany({
        where: { userId: user.id, questionId: { in: rows.map((row) => row.id) } },
        select: {
          id: true,
          questionId: true,
          questionVersion: true,
          evaluationVersion: true,
          category: true,
          status: true,
          score: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ])
    const byScore = new Map(scores.map((score) => [score.questionId, score]))
    ok(
      res,
      await Promise.all(
        rows.map(async (row) => {
          const attempts = submissions.filter((submission) => submission.questionId === row.id)
          const current = attempts.filter(
            (submission) =>
              submission.questionVersion === row.revision &&
              submission.evaluationVersion === row.evaluationVersion,
          )
          const latest = current[0]
          const score = byScore.get(row.id)
          const dynamic = row.category === 'adversarial' ? await arenaQuestionScore(row.id, user.id) : null
          const completedZero = current.some(
            (submission) =>
              submission.category === 'basic' && submission.status === 'completed' && submission.score === 0,
          )
          return {
            ...questionView(row),
            myScore:
              row.category === 'adversarial'
                ? (dynamic?.score ?? null)
                : score?.questionVersion === row.revision
                  ? score.score
                  : completedZero
                    ? 0
                    : null,
            attempted: current.length > 0,
            hasHistoricalAttempts: attempts.length > current.length,
            latestSubmissionStatus: latest?.status ?? null,
            myStatus: dynamic?.status ?? latest?.status ?? 'not_submitted',
            tags: moduleTags[row.moduleCode] ? [moduleTags[row.moduleCode]] : [],
            ...(row.category === 'adversarial' ? { dynamicScore: dynamic } : {}),
          }
        }),
      ),
    )
  } catch (e) {
    fail(res, e)
  }
})
router.get('/modules/:moduleCode/questions', async (req, res) => {
  try {
    ok(
      res,
      (
        await prisma.question.findMany({
          where: { moduleCode: req.params.moduleCode.toUpperCase(), status: 'published' },
          orderBy: { number: 'asc' },
        })
      ).map((r) => questionView(r)),
    )
  } catch (e) {
    fail(res, e)
  }
})
router.get('/questions/:id', async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    const question = await prisma.question.findUnique({ where: { id: req.params.id } })
    if (!question || (question.status !== 'published' && user.role !== 'admin'))
      throw new RequestError('题目不存在或未发布', 404)
    ok(res, questionView(question, user.role === 'admin'))
  } catch (e) {
    fail(res, e)
  }
})
router.get('/admin/questions', async (req, res) => {
  try {
    ok(
      res,
      (
        await prisma.question.findMany({
          where: {
            ...(req.query.moduleCode ? { moduleCode: String(req.query.moduleCode) } : {}),
            ...(req.query.status ? { status: String(req.query.status) } : {}),
          },
          orderBy: [{ moduleCode: 'asc' }, { number: 'asc' }],
        })
      ).map((r) => questionView(r, true)),
    )
  } catch (e) {
    fail(res, e)
  }
})
router.get('/admin/questions/:id', async (req, res) => {
  try {
    const row = await prisma.question.findUnique({ where: { id: req.params.id } })
    if (!row) throw new RequestError('题目不存在', 404)
    ok(res, questionView(row, true))
  } catch (e) {
    fail(res, e)
  }
})
router.post('/admin/questions', async (req, res) => {
  try {
    ok(res, await saveQuestion(String(req.body.id || ''), req.body, authPayload(req)!.uid, true))
  } catch (e) {
    fail(res, e)
  }
})
router.put('/admin/questions/:id', async (req, res) => {
  try {
    ok(res, await saveQuestion(req.params.id, req.body, authPayload(req)!.uid))
  } catch (e) {
    fail(res, e)
  }
})
router.post('/admin/questions/batch-status', async (req, res) => {
  try {
    if (!Array.isArray(req.body.ids) || !req.body.ids.length) throw new RequestError('ids 不能为空')
    for (const id of req.body.ids)
      await saveQuestion(String(id), { status: req.body.status }, authPayload(req)!.uid)
    ok(res, { updated: req.body.ids.length })
  } catch (e) {
    fail(res, e)
  }
})
router.delete('/admin/questions/:id', async (req, res) => {
  try {
    ok(res, await saveQuestion(req.params.id, { status: 'archived' }, authPayload(req)!.uid))
  } catch (e) {
    fail(res, e)
  }
})
router.get('/admin/stats', async (_req, res) => {
  try {
    const rows = await prisma.question.findMany({ select: { status: true, moduleCode: true } })
    ok(res, {
      totalQuestions: rows.length,
      published: rows.filter((r) => r.status === 'published').length,
      draft: rows.filter((r) => r.status === 'draft').length,
      review: rows.filter((r) => r.status === 'review').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      submissions: await prisma.submission.count(),
      passedSubmissions: await prisma.submission.count({
        where: { status: { in: ['passed', 'completed'] } },
      }),
      userScores: await prisma.basicTotal.count(),
      modules: [...new Set(rows.map((r) => r.moduleCode))].map((moduleCode) => ({
        moduleCode,
        count: rows.filter((r) => r.moduleCode === moduleCode).length,
      })),
    })
  } catch (e) {
    fail(res, e)
  }
})
export default router
