import { Router } from 'express'
import { bearerToken, readScopedToken, requireAdminMw } from '../lib/auth.js'
import { prisma } from '../lib/db.js'
import { parseJson, RequestError, type SubmissionSnapshot } from '../lib/prdContract.js'
import { callPoolWithResponseSnapshot, publicPool, savePool } from '../services/apiPool.js'
import { responseSnapshotContext } from '../services/modelResponseSnapshot.js'
import { transaction } from '../lib/transaction.js'

const router = Router()
router.use('/admin/api-pool', requireAdminMw)
const fail = (res: any, error: any) =>
  res
    .status(error instanceof RequestError ? error.status : 500)
    .json({ code: 40001, message: error instanceof RequestError ? error.message : '操作失败', data: null })
router.get('/admin/api-pool', async (_req, res) => {
  try {
    res.json({
      code: 0,
      message: 'ok',
      data: (await prisma.apiPool.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] })).map(
        publicPool,
      ),
    })
  } catch (e) {
    fail(res, e)
  }
})
router.post('/admin/api-pool', async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await savePool(null, req.body, readAdminId(req)) })
  } catch (e) {
    fail(res, e)
  }
})
router.put('/admin/api-pool/:id', async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await savePool(req.params.id, req.body, readAdminId(req)) })
  } catch (e) {
    fail(res, e)
  }
})
import { authPayload } from '../lib/auth.js'
function readAdminId(req: any) {
  return authPayload(req)!.uid
}

router.post('/evaluation-gateway/:id/chat/completions', async (req, res) => {
  try {
    const token = readScopedToken(bearerToken(req), 'evaluation')
    if (!token || token.submissionId !== req.params.id) throw new RequestError('无效的评测访问凭证', 401)
    const submission = await prisma.submission.findUnique({ where: { id: req.params.id } })
    if (!submission || submission.questionVersion !== token.questionVersion)
      throw new RequestError('评测版本不匹配', 403)
    const snapshot = parseJson<SubmissionSnapshot>(submission.configSnapshot, {} as SubmissionSnapshot)
    if (!snapshot.modelBinding) throw new RequestError('题目未配置固定模型', 403)
    const active =
      (await prisma.evaluationTask.count({ where: { submissionId: submission.id, state: 'running' } })) +
      (await prisma.arenaEvaluation.count({ where: { submissionId: submission.id, status: 'running' } }))
    if (!active) throw new RequestError('评测任务已结束', 403)
    const limit = Number(snapshot.modelBinding.parameters.maxCalls ?? 100)
    const targetId = `${submission.id}:${token.callId}`
    await transaction(async (tx) => {
      const used = await tx.auditEvent.count({ where: { action: 'model.call', targetId } })
      if (used >= limit) throw new RequestError('本次评测的模型调用预算已耗尽', 429)
      await tx.auditEvent.create({
        data: {
          actorId: submission.userId,
          action: 'model.call',
          targetId,
          detail: JSON.stringify({
            poolId: snapshot.modelBinding!.poolId,
            revision: snapshot.modelBinding!.revision,
          }),
        },
      })
    })
    const context = responseSnapshotContext(snapshot.definition, String(snapshot.definition.evaluation.packageDigest || ''))
    res.json(await callPoolWithResponseSnapshot(snapshot.modelBinding, req.body, context, async source => {
      const activeNow =
        (await prisma.evaluationTask.count({ where: { submissionId: submission.id, state: 'running' } })) +
        (await prisma.arenaEvaluation.count({ where: { submissionId: submission.id, status: 'running' } }))
      if (!activeNow) throw new RequestError('评测任务已结束', 403)
      await prisma.auditEvent.create({ data: {
        actorId: submission.userId,
        action: source === 'upstream' ? 'model.upstream.call' : 'model.snapshot.hit',
        targetId,
        detail: JSON.stringify({ poolId: snapshot.modelBinding!.poolId, revision: snapshot.modelBinding!.revision, policy: context!.policy }),
      } })
      res.setHeader('X-Model-Response-Source', source)
    }))
  } catch (e) {
    fail(res, e)
  }
})
export default router
