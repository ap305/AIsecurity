import { Router, type Request, type Response } from 'express'
import { authPayload } from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { RequestError } from '../lib/prdContract.js'
import {
  listClassrooms,
  createClassroom,
  joinClassroom,
  getClassroom,
  updateClassroom,
  rotateClassroomInvite,
  leaveClassroom,
  removeClassMember,
  getTeachingGrant,
  setTeachingGrant,
  exportClassrooms,
} from '../services/classrooms.js'

const router = Router()
function fail(res: Response, error: unknown) {
  const status = error instanceof RequestError ? error.status : 500
  res
    .status(status)
    .json({
      code: error instanceof AuthError ? error.code : status * 100,
      message: error instanceof RequestError ? error.message : '班级服务暂不可用，请稍后重试',
      data: null,
    })
}
function json(work: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json({ code: 0, message: 'ok', data: await work(req) })
    } catch (error) {
      fail(res, error)
    }
  }
}
router.get(
  '/classrooms',
  json((req) => listClassrooms(authPayload(req))),
)
router.post(
  '/classrooms',
  json((req) => createClassroom(authPayload(req), req.body)),
)
router.post(
  '/classrooms/join',
  json((req) => joinClassroom(authPayload(req), req.body?.inviteCode)),
)
router.post('/classrooms/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const file = await exportClassrooms(authPayload(req), req.body?.classroomIds)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.data)
  } catch (error) {
    fail(res, error)
  }
})
router.get(
  '/classrooms/:id',
  json((req) => getClassroom(authPayload(req), req.params.id)),
)
router.put(
  '/classrooms/:id',
  json((req) => updateClassroom(authPayload(req), req.params.id, req.body)),
)
router.post(
  '/classrooms/:id/invite',
  json((req) => rotateClassroomInvite(authPayload(req), req.params.id)),
)
router.delete(
  '/classrooms/:id/membership',
  json((req) => leaveClassroom(authPayload(req), req.params.id)),
)
router.delete(
  '/classrooms/:id/members/:userId',
  json((req) => removeClassMember(authPayload(req), req.params.id, req.params.userId)),
)
router.get(
  '/admin/users/:id/teaching',
  json((req) => getTeachingGrant(authPayload(req), req.params.id)),
)
router.put(
  '/admin/users/:id/teaching',
  json((req) => setTeachingGrant(authPayload(req), req.params.id, req.body?.enabled)),
)
export default router
