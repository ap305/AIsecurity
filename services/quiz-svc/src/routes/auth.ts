import { Router, type Request, type Response } from 'express'
import { prisma } from '../lib/db.js'
import { RequestError, validateOptionalProfile } from '../lib/prdContract.js'
import {
  registerStudent,
  loginUser,
  userByPayload,
  authPayload,
  requireAdminUser,
  listPublicUsers,
  adminResetPassword,
  adminDeleteUser,
  adminClearStudents,
  adminCreateTestAccount,
  adminSetTestAccountStatus,
  type PublicUser,
  logoutSession,
  logoutOtherSessions,
  changeOwnPassword,
  adminResetInitialPassword,
  listAuthEvents,
} from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { emailEnabled } from '../services/emailSender.js'

/**
 * 集中式账号接口
 *   POST /api/auth/register   学员注册
 *   POST /api/auth/login      登录（学员/管理员，返回 Token）
 *   GET  /api/auth/me         恢复会话（Bearer Token）
 *   GET    /api/admin/users                管理员：列出全部注册用户
 *   POST   /api/admin/users                管理员：创建测试学生账号
 *   PUT    /api/admin/users/:id/status     管理员：停用/启用测试学生账号
 *   PUT    /api/admin/users/:id/password   管理员：重置指定用户密码
 *   DELETE /api/admin/users/:id            管理员：删除用户
 *   DELETE /api/admin/users                管理员：清空全部学员
 */

const router = Router()

const publicValidationMessages = new Set([
  '展示名需要 1～64 个字符',
  '用户名仅限 3-32 位字母或数字',
  '请填写姓名',
  '密码至少需要 6 位',
  '用户名已存在',
  '用户名或密码错误',
  '请使用正确的登录入口',
  '用户不存在',
  '不能重置管理员密码',
  '不能删除管理员账号',
])

export function authPublicMessage(error: unknown, fallback: string): string {
  if (error instanceof RequestError) return error.message
  if (error instanceof Error && error.name === 'Error' && publicValidationMessages.has(error.message))
    return error.message
  return fallback
}

function authFailure(res: Response, error: unknown, fallback: string): void {
  const known =
    error instanceof RequestError ||
    (error instanceof Error && error.name === 'Error' && publicValidationMessages.has(error.message))
  const status = error instanceof RequestError ? error.status : known ? 400 : 503
  if (error instanceof AuthError && error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds))
  res
    .status(status)
    .json({ code: error instanceof AuthError ? error.code : status === 503 ? 50300 : status === 403 ? 40300 : 40001, message: authPublicMessage(error, fallback), data: error instanceof AuthError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : null })
}

router.get('/auth/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ code: 0, message: 'ok', data: { manualResetEnabled: true, emailEnabled: emailEnabled() } })
})

router.post('/auth/logout', async (req, res) => {
  try {
    await logoutSession(authPayload(req))
    res.json({ code: 0, message: 'ok', data: { ok: true } })
  } catch (error) { authFailure(res, error, '身份服务暂不可用，请稍后重试') }
})

router.post('/auth/logout-others', async (req, res) => {
  try {
    res.json({ code: 0, message: 'ok', data: await logoutOtherSessions(authPayload(req)) })
  } catch (error) { authFailure(res, error, '身份服务暂不可用，请稍后重试') }
})

router.post('/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {}
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') throw new RequestError('请填写当前密码和新密码')
    res.json({ code: 0, message: 'ok', data: await changeOwnPassword(authPayload(req), currentPassword, newPassword) })
  } catch (error) { authFailure(res, error, '身份服务暂不可用，请稍后重试') }
})

router.put('/auth/me', async (req, res) => {
  try {
    const current = await userByPayload(authPayload(req))
    if (!current) return res.status(401).json({ code: 40100, message: '请先登录', data: null })
    const profile = validateOptionalProfile({
      studentId: req.body.studentId ?? current.studentId,
      phone: req.body.phone ?? current.phone,
    })
    const displayName = String(req.body.displayName ?? current.displayName).trim()
    if (!displayName || displayName.length > 64) throw new Error('展示名需要 1～64 个字符')
    await prisma.user.update({
      where: { id: current.id },
      data: {
        ...profile,
        displayName,
        school: String(req.body.school ?? current.school)
          .trim()
          .slice(0, 200),
        ...(profile.phone !== current.phone ? { phoneVerified: false } : {}),
      },
    })
    res.json({ code: 0, message: 'ok', data: { user: await userByPayload(authPayload(req)) } })
  } catch (e) {
    authFailure(res, e, '资料更新暂不可用，请稍后重试')
  }
})

// ── POST /api/auth/register ──────────────────────────────────────────────
router.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { username, password, displayName, school, studentId, phone, emailToken } = (req.body ?? {}) as Record<
      string,
      unknown
    >
    const user = await registerStudent({
      username: String(username ?? ''),
      password: String(password ?? ''),
      displayName: String(displayName ?? ''),
      school: String(school ?? ''),
      studentId: String(studentId ?? ''),
      phone: String(phone ?? ''),
      emailToken: typeof emailToken === 'string' ? emailToken : undefined,
    })
    res.json({ code: 0, message: 'ok', data: { user } })
  } catch (err) {
    authFailure(res, err, '注册服务暂不可用，请稍后重试')
  }
})

// ── POST /api/auth/login ─────────────────────────────────────────────────
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password, role } = (req.body ?? {}) as Record<string, unknown>
    // No trust-proxy chain is configured; forwarded headers are not a source identity.
    const result = await loginUser(String(username ?? ''), String(password ?? ''), String(role ?? 'student'), req.socket.remoteAddress)
    res.json({ code: 0, message: 'ok', data: result })
  } catch (err) {
    authFailure(res, err, '登录服务暂不可用，请稍后重试')
  }
})

// ── GET /api/auth/me ────────────────────────────────────────────────────
router.get('/auth/me', async (req: Request, res: Response) => {
  try {
    const user = await userByPayload(authPayload(req), true)
    if (!user) {
      res.status(401).json({ code: 40100, message: '登录已过期', data: null })
      return
    }
    res.json({ code: 0, message: 'ok', data: { user } })
  } catch (err) {
    authFailure(res, err, '身份服务暂不可用，请稍后重试')
  }
})

// ── 管理员：用户列表 / 重置密码 / 删除 / 清空 ─────────────────────────────
router.get('/admin/users', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const users: PublicUser[] = await listPublicUsers()
    res.json({ code: 0, message: 'ok', data: users })
  } catch (err) {
    console.error('[auth] list users failed:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

router.post('/admin/users', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const user = await adminCreateTestAccount(req.body, admin.id)
    res.json({ code: 0, message: 'ok', data: { user } })
  } catch (error) {
    authFailure(res, error, '测试账号创建暂不可用，请稍后重试')
  }
})

router.put('/admin/users/:id/status', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const user = await adminSetTestAccountStatus(req.params.id, req.body?.status, admin.id)
    res.json({ code: 0, message: 'ok', data: { user } })
  } catch (error) {
    authFailure(res, error, '测试账号状态更新暂不可用，请稍后重试')
  }
})

router.put('/admin/users/:id/password', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    await adminResetPassword(req.params.id, String((req.body ?? {}).password ?? ''), admin.id)
    res.json({ code: 0, message: 'ok', data: { ok: true } })
  } catch (err) {
    authFailure(res, err, '密码重置暂不可用，请稍后重试')
  }
})

router.post('/admin/users/:id/password-reset', async (req, res) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const result = await adminResetInitialPassword(req.params.id, req.body?.identityVerified, admin.id)
    res.json({ code: 0, message: 'ok', data: result })
  } catch (error) { authFailure(res, error, '密码重置暂不可用，请稍后重试') }
})

router.get('/admin/auth-events', async (req, res) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const data = await listAuthEvents(typeof req.query.userId === 'string' ? req.query.userId : undefined, Number(req.query.limit ?? 50))
    res.json({ code: 0, message: 'ok', data })
  } catch (error) { authFailure(res, error, '安全事件查询暂不可用，请稍后重试') }
})

router.delete('/admin/users/:id', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    await adminDeleteUser(req.params.id, admin.id)
    res.json({ code: 0, message: 'ok', data: { ok: true } })
  } catch (err) {
    authFailure(res, err, '用户删除暂不可用，请稍后重试')
  }
})

router.delete('/admin/users', async (req: Request, res: Response) => {
  try {
    const admin = await requireAdminUser(req, res)
    if (!admin) return
    const count = await adminClearStudents()
    res.json({ code: 0, message: 'ok', data: { deleted: count } })
  } catch (err) {
    console.error('[auth] clear users failed:', err)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

export default router
