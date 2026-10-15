import { Router, type Response } from 'express'
import { requireAdminMw } from '../lib/auth.js'
import { RequestError } from '../lib/prdContract.js'
import { getAdminStudentScores, listAdminStudentScores } from '../services/adminStudentScores.js'

const router = Router()
router.use('/admin/student-scores', requireAdminMw)
function fail(res: Response, error: unknown) {
  const status = error instanceof RequestError ? error.status : 500
  res
    .status(status)
    .json({
      code: status * 100,
      message: error instanceof RequestError ? error.message : '学生成绩暂不可用，请稍后重试',
      data: null,
    })
}
router.get('/admin/student-scores', async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await listAdminStudentScores(req.query) })
  } catch (error) {
    fail(res, error)
  }
})
router.get('/admin/student-scores/:userId', async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await getAdminStudentScores(req.params.userId) })
  } catch (error) {
    fail(res, error)
  }
})
export default router
