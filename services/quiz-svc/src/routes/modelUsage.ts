import { Router, type Response } from 'express'
import { authPayload, requireAdminMw } from '../lib/auth.js'
import { RequestError } from '../lib/prdContract.js'
import { acknowledgeModelUsageAlert, getModelUsageDashboard, updateModelUsagePolicy } from '../services/modelUsage.js'

const router = Router()
router.use('/admin/model-usage', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() }, requireAdminMw)
function fail(res: Response, error: unknown) {
  const status = error instanceof RequestError ? error.status : 500
  res.status(status).json({ code: status * 100, message: error instanceof RequestError ? error.message : '模型用量监控暂不可用，请稍后重试', data: null })
}
router.get('/admin/model-usage', async (req, res) => {
  try {
    const days = req.query.days === undefined ? 7 : typeof req.query.days === 'string' && /^\d{1,2}$/.test(req.query.days) ? Number(req.query.days) : NaN
    res.json({ code: 0, message: 'ok', data: await getModelUsageDashboard(days) })
  } catch (error) { fail(res, error) }
})
router.put('/admin/model-usage/policy', async (req, res) => {
  try { res.json({ code: 0, message: 'ok', data: await updateModelUsagePolicy(req.body) }) }
  catch (error) { fail(res, error) }
})
router.post('/admin/model-usage/alerts/:id/ack', async (req, res) => {
  try {
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw new RequestError('确认告警参数无效', 400)
    res.json({ code: 0, message: 'ok', data: await acknowledgeModelUsageAlert(req.params.id, authPayload(req)!.uid) })
  } catch (error) { fail(res, error) }
})
export default router
