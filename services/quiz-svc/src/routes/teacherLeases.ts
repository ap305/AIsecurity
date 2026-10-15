import { Router } from 'express'
import { requireUser, requireAdminMw, authPayload, bearerToken, readScopedToken } from '../lib/auth.js'
import { prisma } from '../lib/db.js'
import { RequestError } from '../lib/prdContract.js'
import { callPool } from '../services/apiPool.js'
import { consumeTeacherCall, leaseState, leaseView, startTeacherLease } from '../services/teacherLeases.js'

const router = Router()
const fail = (res: any, e: any) =>
  res
    .status(e instanceof RequestError ? e.status : 500)
    .json({ code: 40001, message: e instanceof RequestError ? e.message : '租约操作失败', data: null })
router.get('/questions/:id/teacher-lease', async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    const row = await prisma.teacherLease.findUnique({
      where: { userId_questionId: { userId: user.id, questionId: req.params.id } },
    })
    res.json({
      code: 0,
      message: 'ok',
      data: row
        ? leaseView(row)
        : { state: 'not_started', scope: 'user_question', serverTime: new Date().toISOString() },
    })
  } catch (e) {
    fail(res, e)
  }
})
for (const action of ['start', 'renew'])
  router.post(`/questions/:id/teacher-lease/${action}`, async (req, res) => {
    try {
      const user = await requireUser(req, res)
      if (!user) return
      res.json({
        code: 0,
        message: 'ok',
        data: await startTeacherLease(user.id, req.params.id, action === 'renew'),
      })
    } catch (e) {
      fail(res, e)
    }
  })
router.post('/teacher/:id/query', async (req, res) => {
  try {
    const token = readScopedToken(bearerToken(req), 'teacher')
    if (!token || token.leaseId !== req.params.id) throw new RequestError('教师凭证无效或已到期', 401)
    if (Buffer.byteLength(JSON.stringify(req.body)) > 1024 * 1024)
      throw new RequestError('教师请求不能超过 1 MB', 413)
    const { binding, leaseId } = await consumeTeacherCall(token)
    const output = await callPool(binding, req.body, true)
    const current = await prisma.teacherLease.findUniqueOrThrow({ where: { id: leaseId } })
    if (leaseState(current) !== 'active' || current.nonce !== token.nonce)
      throw new RequestError('租约已到期或撤销', 403)
    res.json(output)
  } catch (e) {
    fail(res, e)
  }
})
router.use('/admin/teacher-leases', requireAdminMw)
router.get('/admin/teacher-leases', async (req, res) => {
  try {
    const rows = await prisma.teacherLease.findMany({
      where: req.query.questionId ? { questionId: String(req.query.questionId) } : {},
      orderBy: { updatedAt: 'desc' },
    })
    const data = rows
      .map((r) => leaseView(r, false))
      .filter((r) => !req.query.state || r.state === req.query.state)
    res.json({ code: 0, message: 'ok', data })
  } catch (e) {
    fail(res, e)
  }
})
router.post('/admin/teacher-leases/:id/revoke', async (req, res) => {
  try {
    const reason = String(req.body.reason || '管理员已撤销访问').slice(0, 500)
    const row = await prisma.teacherLease.update({
      where: { id: req.params.id },
      data: { state: 'revoked', reason },
    })
    await prisma.auditEvent.create({
      data: {
        actorId: authPayload(req)!.uid,
        action: 'teacher.revoke',
        targetId: row.id,
        detail: JSON.stringify({ reason }),
      },
    })
    res.json({ code: 0, message: 'ok', data: leaseView(row, false) })
  } catch (e) {
    fail(res, e)
  }
})
export default router
