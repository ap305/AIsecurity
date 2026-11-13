import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { NextFunction, Request, Response } from 'express'
import { prisma } from './db.js'
import { transaction } from './transaction.js'
import { invalidateArenaUserTx, drainArenaRecomputations } from '../services/arenaScoring.js'
import { RequestError, validateOptionalProfile } from './prdContract.js'
import type { Prisma } from '@prisma/client'
import { AuthError, hashPasswordAsync, verifyPasswordAsync, validateNewPassword } from './authPassword.js'
import { authEvent, digest, assertLoginAvailable, loginFailure, INITIAL_PASSWORD } from './authSecurity.js'
import { emailEnabled } from '../services/emailSender.js'
import { consumeRegistrationEmailTx } from '../services/authEmail.js'

/**
 * 集中式账号认证
 *
 * - 密码：scrypt + 随机盐，仅存哈希
 * - 会话：HMAC-SHA256 签名 Token（12 小时），密钥持久化于 auth-secret.json（容器挂载目录）
 * - 管理员：首次启动仅在显式配置 ADMIN_PASSWORD 后创建，已有账号不受配置缺失影响
 * - 保护后台接口：requireAdminMw（学生代码/客户端无法绕过）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SECRET_PATH = path.resolve(__dirname, '../../auth-secret.json')
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000

function loadOrCreateSecret(): string {
  try {
    if (fs.existsSync(SECRET_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf-8'))
      if (typeof raw?.secret === 'string' && raw.secret.length >= 32) return raw.secret
    }
  } catch {
    /* 重建 */
  }
  const secret = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true })
    fs.writeFileSync(SECRET_PATH, JSON.stringify({ secret }, null, 2), 'utf-8')
    fs.chmodSync(SECRET_PATH, 0o600)
  } catch (e) {
    console.error('[auth] 会话密钥持久化失败，重启后 Token 将失效:', e)
  }
  return secret
}

const SECRET = loadOrCreateSecret()

export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: string
  tier: string
  school: string
  studentId?: string | null
  phone?: string | null
  phoneVerified?: boolean
  isTestAccount: boolean
  accountStatus: string
  createdAt: string
  lastLoginAt?: string | null
  mustChangePassword?: boolean
}

type UserRow = {
  id: string
  username: string
  password: string
  displayName: string
  school: string
  studentId?: string | null
  phone?: string | null
  phoneVerified?: boolean
  role: string
  tier: string
  isTestAccount?: boolean
  accountStatus?: string
  sessionVersion?: number
  createdAt: Date
  updatedAt: Date
}

function toPublicUser(row: UserRow, security?: { lastLoginAt: Date | null; mustChangePassword: boolean } | null): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    tier: row.tier,
    school: row.school ?? '',
    studentId: row.studentId ?? null,
    phone: row.phone ?? null,
    phoneVerified: row.phoneVerified ?? false,
    isTestAccount: row.isTestAccount ?? false,
    accountStatus: row.accountStatus ?? 'active',
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: security?.lastLoginAt?.toISOString() ?? null,
    mustChangePassword: security?.mustChangePassword ?? false,
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = (stored || '').split(':')
  if (!salt || !hash) return false
  try {
    const calc = crypto.scryptSync(password, salt, 64)
    const expect = Buffer.from(hash, 'hex')
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect)
  } catch {
    return false
  }
}

export interface TokenPayload {
  uid: string
  u: string
  r: string
  exp: number
  sv?: number
  jti?: string
  tokenHash?: string
  limited?: boolean
}

function signToken(user: { id: string; username: string; role: string; sessionVersion?: number }, limited = false): string {
  const payload: TokenPayload = {
    uid: user.id,
    u: user.username,
    r: user.role,
    exp: Date.now() + TOKEN_TTL_MS,
    jti: crypto.randomBytes(16).toString('hex'),
    limited,
    // Version zero also accepts pre-migration tokens, which have no sv field.
    ...(user.sessionVersion ? { sv: user.sessionVersion } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expect = crypto
    .createHmac('sha256', SECRET)
    .update(body || '')
    .digest('base64url')
  const a = Buffer.from(sig || '')
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as TokenPayload & {
      purpose?: unknown
    }
    if (
      typeof p?.uid !== 'string' ||
      !p.uid ||
      typeof p.u !== 'string' ||
      !p.u ||
      typeof p.r !== 'string' ||
      !p.r ||
      p.purpose !== undefined ||
      !Number.isFinite(p.exp) ||
      p.exp < Date.now()
    )
      return null
    return { ...p, tokenHash: digest(token) }
  } catch {
    return null
  }
}

export function bearerToken(req: Request): string | null {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  return auth.slice(7).trim() || null
}

/** 从请求中解析当前登录用户（仅校验 Token，不查库） */
export function authPayload(req: Request): TokenPayload | null {
  return verifyToken(bearerToken(req))
}

export function isAccountActive(user: { accountStatus?: string } | null | undefined): boolean {
  return !!user && (user.accountStatus ?? 'active') === 'active'
}

/** Called after loading the current identity, including immediately before a submission is committed. */
export function hasCurrentSession(
  payload: TokenPayload | null,
  user: { id: string; accountStatus?: string; sessionVersion?: number } | null | undefined,
): boolean {
  return (
    !!payload &&
    !!user &&
    payload.uid === user.id &&
    isAccountActive(user) &&
    Number.isSafeInteger(payload.sv ?? 0) &&
    (payload.sv ?? 0) === (user.sessionVersion ?? 0)
  )
}

type AuthClient = Pick<Prisma.TransactionClient, 'authRevocation' | 'userSecurity'>
/** Check persisted revocation as well as version; scoped capabilities never call this. */
export async function hasValidSession(
  payload: TokenPayload | null,
  user: Parameters<typeof hasCurrentSession>[1],
  client: AuthClient = prisma,
  allowPasswordChange = false,
): Promise<boolean> {
  if (!hasCurrentSession(payload, user) || !payload?.tokenHash || payload.exp <= Date.now()) return false
  let security
  try {
    if (await client.authRevocation.findUnique({ where: { tokenHash: payload.tokenHash } })) return false
    security = await client.userSecurity.findUnique({ where: { userId: payload.uid } })
  } catch { throw new AuthError('身份服务暂不可用，请稍后重试', 503, 50300) }
  if (security?.mustChangePassword) {
    if (security.temporaryPasswordExpiresAt && security.temporaryPasswordExpiresAt.getTime() <= Date.now()) return false
    if (!allowPasswordChange) throw new AuthError('请刷新页面并修改临时密码后继续', 428, 42801)
  }
  return true
}

export function authErrorResponse(res: Response, error: unknown): void {
  const failure = error instanceof AuthError ? error : new AuthError('身份服务暂不可用，请稍后重试', 503, 50300)
  res.status(failure.status).json({ code: failure.code, message: failure.message, data: null })
}

/** Limited web sessions may only recover/change their password or log out, including on public routes. */
export function passwordChangeOnlyMw(req: Request, res: Response, next: NextFunction): void {
  const route = req.path.replace(/\/+$/, '').toLowerCase()
  if ((req.method === 'GET' && ['/auth/me', '/auth/config'].includes(route)) ||
      (req.method === 'POST' && ['/auth/change-password', '/auth/logout'].includes(route))) {
    next()
    return
  }
  const payload = authPayload(req)
  // Only verified web tokens may take this fast path; old tokens have no marker and still consult persisted state.
  if (!payload || payload.limited === false) {
    next()
    return
  }
  void (async () => {
    const security = await prisma.userSecurity.findUnique({ where: { userId: payload.uid } })
    if (security?.mustChangePassword || payload.limited === true) {
      const row = await prisma.user.findUnique({ where: { id: payload.uid } })
      if (!(await hasValidSession(payload, row, prisma, true))) throw invalidSession()
      if (security?.mustChangePassword) throw new AuthError('请刷新页面并修改临时密码后继续', 428, 42801)
    }
    next()
  })().catch((error) => authErrorResponse(res, error))
}

/** 校验并返回 admin 用户行；非 admin 返回 null（同时向 res 写 403） */
export async function requireAdminUser(req: Request, res: Response): Promise<UserRow | null> {
  const row = await requireUser(req, res)
  if (!row) return null
  if (row.role !== 'admin' || authPayload(req)?.r !== 'admin') {
    res.status(403).json({ code: 40300, message: '需要管理员登录', data: null })
    return null
  }
  return row as UserRow
}

export function requireAdminMw(req: Request, res: Response, next: NextFunction): void {
  void requireAdminUser(req, res).then((row) => { if (row) next() }).catch((error) => authErrorResponse(res, error))
}

/** 启动引导：确保存在管理员账号 */
export async function ensureAdminUser(): Promise<void> {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim()
  const existing = await prisma.user.findUnique({ where: { username } })
  if (existing) return
  const password = process.env.ADMIN_PASSWORD
  if (!password || password.length < 6)
    throw new Error('首次初始化管理员需要显式设置 ADMIN_PASSWORD（至少 6 位）')
  await prisma.user.create({
    data: {
      username,
      password: await hashPasswordAsync(password),
      displayName: '管理员',
      role: 'admin',
      school: '',
    },
  })
  console.log(`[auth] 管理员账号 ${username} 已初始化`)
}

export async function registerStudent(input: {
  username: string
  password: string
  displayName: string
  school?: string
  studentId?: string
  phone?: string
  emailToken?: string
}): Promise<PublicUser> {
  const username = input.username.trim()
  const displayName = input.displayName.trim()
  if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
    throw new Error('用户名仅限 3-32 位字母或数字')
  }
  if (!displayName) throw new Error('请填写姓名')
  validateNewPassword(input.password)
  const exists = await prisma.user.findUnique({ where: { username } })
  if (exists) throw new Error('用户名已存在')
  const data = {
      username,
      password: await hashPasswordAsync(input.password),
      displayName,
      school: (input.school || '').trim(),
      ...validateOptionalProfile(input),
      role: 'student',
      tier: 'bronze',
  }
  const row = emailEnabled() ? await transaction(async tx => {
    const email = await consumeRegistrationEmailTx(tx, input.emailToken)
    if (await tx.user.findUnique({ where: { username } })) throw new RequestError('用户名已存在', 409)
    const created = await tx.user.create({ data })
    await tx.userEmail.create({ data: { userId: created.id, email, verifiedAt: new Date() } })
    await authEvent(tx, 'auth.email.registration', created.id)
    return created
  }) : await prisma.user.create({ data })
  return toPublicUser(row as UserRow)
}

export async function requireUser(req: Request, res: Response) {
  try {
    const payload = authPayload(req)
    const user = payload ? await prisma.user.findUnique({ where: { id: payload.uid } }) : null
    if (!(await hasValidSession(payload, user))) {
      res.status(401).json({ code: 40100, message: '账号不可用或登录已过期，请重新登录', data: null })
      return null
    }
    return user
  } catch (error) {
    // Express 4 does not forward rejected async handlers automatically. Keep auth outages bounded for every route.
    authErrorResponse(res, error)
    return null
  }
}

export function signScopedToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

export function readScopedToken(token: string | null, purpose: string): Record<string, any> | null {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra) return null
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return payload.purpose === purpose && Number.isFinite(payload.exp) && payload.exp > Date.now()
      ? payload
      : null
  } catch {
    return null
  }
}

export async function loginUser(
  username: string,
  password: string,
  role: string,
  source?: string,
): Promise<{ token: string; user: PublicUser }> {
  const exactUsername = (username || '').trim()
  const accountKey = digest(exactUsername)
  await assertLoginAvailable(accountKey)
  const row = await prisma.user.findUnique({ where: { username: exactUsername } })
  const validPassword = await verifyPasswordAsync(password || '', row?.password)
  if (!row || !validPassword || (role && row.role !== role)) {
    await loginFailure(accountKey, row?.id, source)
    throw new Error('用户名或密码错误')
  }
  if (!isAccountActive(row)) throw new RequestError('账号已停用或删除，请联系管理员', 403)
  return transaction(async (tx) => {
    const fresh = await tx.user.findUnique({ where: { id: row.id } })
    if (!fresh || !isAccountActive(fresh) || fresh.password !== row.password || fresh.sessionVersion !== row.sessionVersion)
      throw new AuthError('账号或密码已更新，请重新登录', 401, 40100)
    const oldSecurity = await tx.userSecurity.findUnique({ where: { userId: row.id } })
    if (oldSecurity?.mustChangePassword && oldSecurity.temporaryPasswordExpiresAt && oldSecurity.temporaryPasswordExpiresAt.getTime() <= Date.now())
      throw new AuthError('临时密码已过期，请联系管理员', 401, 40100)
    const security = await tx.userSecurity.upsert({ where: { userId: row.id }, create: { userId: row.id, lastLoginAt: new Date() }, update: { lastLoginAt: new Date() } })
    await tx.authLoginThrottle.deleteMany({ where: { accountKey } })
    await tx.authRevocation.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    await authEvent(tx, 'auth.login.success', row.id)
    return { token: signToken(fresh, security.mustChangePassword), user: toPublicUser(fresh, security) }
  })
}

export async function userByPayload(payload: TokenPayload | null, allowPasswordChange = false): Promise<PublicUser | null> {
  if (!payload) return null
  const row = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!(await hasValidSession(payload, row, prisma, allowPasswordChange))) return null
  const security = await prisma.userSecurity.findUnique({ where: { userId: payload.uid } })
  return toPublicUser(row as UserRow, security)
}

export async function listPublicUsers(): Promise<PublicUser[]> {
  const rows = await prisma.user.findMany({ where: { accountStatus: { not: 'deleted' } }, orderBy: { createdAt: 'asc' } })
  const security = new Map((await prisma.userSecurity.findMany({ where: { userId: { in: rows.map((row) => row.id) } } })).map((row) => [row.userId, row]))
  return rows.map((row) => toPublicUser(row, security.get(row.id)))
}

function invalidSession(): AuthError {
  return new AuthError('账号不可用或登录已过期，请重新登录', 401, 40100)
}

export async function logoutSession(payload: TokenPayload | null): Promise<void> {
  if (!payload?.tokenHash) throw invalidSession()
  await transaction(async (tx) => {
    // Repeated logout is safe even when the account version has since advanced.
    await tx.authRevocation.upsert({ where: { tokenHash: payload.tokenHash! }, create: { tokenHash: payload.tokenHash!, userId: payload.uid, expiresAt: new Date(payload.exp) }, update: {} })
    await authEvent(tx, 'auth.logout', payload.uid)
  })
}

async function revokeTeacherLeases(tx: Prisma.TransactionClient, userId: string) {
  await tx.teacherLease.updateMany({ where: { userId, state: { in: ['creating', 'active'] } }, data: { state: 'revoked', reason: '账号安全凭据已更新', nonce: crypto.randomBytes(24).toString('hex') } })
}

export async function logoutOtherSessions(payload: TokenPayload | null): Promise<{ token: string; user: PublicUser }> {
  if (!payload) throw invalidSession()
  return transaction(async (tx) => {
    const row = await tx.user.findUnique({ where: { id: payload.uid } })
    if (!(await hasValidSession(payload, row, tx))) throw invalidSession()
    const changed = await tx.user.updateMany({ where: { id: row!.id, sessionVersion: payload.sv ?? 0, accountStatus: 'active' }, data: { sessionVersion: { increment: 1 } } })
    if (changed.count !== 1) throw invalidSession()
    const fresh = await tx.user.findUniqueOrThrow({ where: { id: row!.id } })
    await authEvent(tx, 'auth.logout-others', fresh.id)
    return { token: signToken(fresh), user: toPublicUser(fresh, await tx.userSecurity.findUnique({ where: { userId: fresh.id } })) }
  })
}

export async function changeOwnPassword(payload: TokenPayload | null, currentPassword: string, newPassword: string): Promise<{ token: string; user: PublicUser }> {
  if (!payload) throw invalidSession()
  validateNewPassword(newPassword)
  if (newPassword === currentPassword) throw new RequestError('新密码不能与当前密码相同')
  const row = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!(await hasValidSession(payload, row, prisma, true))) throw invalidSession()
  if (!(await verifyPasswordAsync(currentPassword, row!.password))) throw new RequestError('当前密码错误')
  const password = await hashPasswordAsync(newPassword)
  return transaction(async (tx) => {
    const fresh = await tx.user.findUnique({ where: { id: row!.id } })
    if (!(await hasValidSession(payload, fresh, tx, true))) throw invalidSession()
    const changed = await tx.user.updateMany({ where: { id: row!.id, password: row!.password, sessionVersion: payload.sv ?? 0, accountStatus: 'active' }, data: { password, sessionVersion: { increment: 1 } } })
    if (changed.count !== 1) throw new AuthError('密码或登录状态已更新，请重新登录', 409, 40100)
    const security = await tx.userSecurity.upsert({ where: { userId: row!.id }, create: { userId: row!.id }, update: { mustChangePassword: false, temporaryPasswordExpiresAt: null } })
    await revokeTeacherLeases(tx, row!.id)
    await authEvent(tx, 'auth.password.change', row!.id)
    const updated = await tx.user.findUniqueOrThrow({ where: { id: row!.id } })
    return { token: signToken(updated), user: toPublicUser(updated, security) }
  })
}

async function resetPassword(userId: string, newPassword: string, actorId: string, initial = false): Promise<Date> {
  if (!initial) validateNewPassword(newPassword)
  const password = await hashPasswordAsync(newPassword)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
  await transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } })
    if (!target) throw new RequestError('用户不存在', 404)
    if (target.role === 'admin') throw new RequestError('不能重置管理员密码', 403)
    await tx.user.update({ where: { id: userId }, data: { password, sessionVersion: { increment: 1 } } })
    await tx.userSecurity.upsert({ where: { userId }, create: { userId, mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt }, update: { mustChangePassword: true, temporaryPasswordExpiresAt: expiresAt } })
    await revokeTeacherLeases(tx, userId)
    await authEvent(tx, 'auth.password.reset', userId, actorId, { initialPassword: initial, requiresChange: true })
  })
  return expiresAt
}

export async function adminResetPassword(userId: string, newPassword: string, actorId = 'system'): Promise<void> {
  await resetPassword(userId, newPassword, actorId)
}

export async function adminResetInitialPassword(userId: string, identityVerified: unknown, actorId: string) {
  if (identityVerified !== true) throw new RequestError('请先确认已线下核验账号本人身份')
  const expiresAt = await resetPassword(userId, INITIAL_PASSWORD, actorId, true)
  return { ok: true, temporaryPassword: INITIAL_PASSWORD, expiresAt: expiresAt.toISOString() }
}

export async function listAuthEvents(userId: string | undefined, limit: number) {
  const rows = await prisma.auditEvent.findMany({ where: { action: { startsWith: 'auth.' }, ...(userId ? { targetId: userId } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50)) })
  return rows.map((event) => ({ id: event.id, type: event.action, action: event.action, createdAt: event.createdAt, userId: event.targetId, actorId: event.actorId, success: event.action !== 'auth.login.failure' }))
}

const TEST_ACCOUNT_DISABLED_REASON = '测试账号已停用'

export async function adminCreateTestAccount(input: unknown, actorId: string): Promise<PublicUser> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RequestError('请填写测试账号信息')
  const form = input as Record<string, unknown>
  const allowed = new Set(['username', 'password', 'displayName', 'school'])
  if (Object.keys(form).some((key) => !allowed.has(key)))
    throw new RequestError('测试账号不接受角色、状态或其他额外字段')
  if (typeof form.username !== 'string' || !/^[A-Za-z0-9]{3,32}$/.test(form.username.trim()))
    throw new RequestError('用户名仅限 3-32 位字母或数字')
  if (
    typeof form.password !== 'string' ||
    !form.password.trim() ||
    form.password.length < 6 ||
    form.password.length > 128
  )
    throw new RequestError('密码需要 6～128 位')
  if (typeof form.displayName !== 'string' || !form.displayName.trim() || form.displayName.trim().length > 64)
    throw new RequestError('展示名需要 1～64 个字符')
  if (form.school !== undefined && (typeof form.school !== 'string' || form.school.trim().length > 200))
    throw new RequestError('学校名称不能超过 200 个字符')
  const data = {
    username: form.username.trim(),
    password: await hashPasswordAsync(form.password),
    displayName: form.displayName.trim(),
    school: typeof form.school === 'string' ? form.school.trim() : '',
    role: 'student',
    tier: 'bronze',
    isTestAccount: true,
    accountStatus: 'active',
    sessionVersion: 0,
  }
  try {
    return await transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { username: data.username } }))
        throw new RequestError('用户名已存在', 409)
      const row = await tx.user.create({ data })
      await tx.auditEvent.create({
        data: {
          actorId,
          action: 'user.test.create',
          targetId: row.id,
          detail: JSON.stringify({
            username: row.username,
            role: row.role,
            accountStatus: row.accountStatus,
          }),
        },
      })
      return toPublicUser(row)
    })
  } catch (error: any) {
    if (error?.code === 'P2002') throw new RequestError('用户名已存在', 409)
    throw error
  }
}

export async function adminSetTestAccountStatus(
  userId: string,
  status: unknown,
  actorId: string,
): Promise<PublicUser> {
  if (status !== 'active' && status !== 'disabled')
    throw new RequestError('账号状态仅支持 active 或 disabled')
  return transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } })
    if (!target) throw new RequestError('用户不存在', 404)
    if (!target.isTestAccount || target.role !== 'student')
      throw new RequestError('仅测试学生账号可停用或启用', 403)
    if (target.accountStatus === 'deleted') throw new RequestError('测试账号已删除，不能重新启用', 409)
    if (target.accountStatus === status) return toPublicUser(target)
    const row = await tx.user.update({
      where: { id: userId },
      data: {
        accountStatus: status,
        ...(status === 'disabled' ? { sessionVersion: { increment: 1 } } : {}),
      },
    })
    if (status === 'disabled') {
      await tx.teacherLease.updateMany({
        where: { userId, state: { in: ['creating', 'active'] } },
        data: {
          state: 'revoked',
          reason: TEST_ACCOUNT_DISABLED_REASON,
          nonce: crypto.randomBytes(24).toString('hex'),
        },
      })
    } else {
      // Only lifecycle revocations are recoverable; administrator-revoked leases stay revoked.
      await tx.teacherLease.updateMany({
        where: { userId, state: 'revoked', reason: TEST_ACCOUNT_DISABLED_REASON },
        data: { state: 'error', reason: '账号已重新启用，请重新开启教师租约' },
      })
    }
    await tx.auditEvent.create({
      data: {
        actorId,
        action: 'user.test.status',
        targetId: userId,
        detail: JSON.stringify({ from: target.accountStatus, to: status }),
      },
    })
    return toPublicUser(row)
  })
}

export async function adminDeleteUser(userId: string, actorId?: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target) throw new Error('用户不存在')
  if (target.role === 'admin') throw new Error('不能删除管理员账号')
  if (target.isTestAccount) {
    await transaction(async (tx) => {
      const fresh = await tx.user.findUnique({ where: { id: userId } })
      if (!fresh) throw new RequestError('用户不存在', 404)
      if (!fresh.isTestAccount || fresh.role !== 'student')
        throw new RequestError('仅测试学生账号可逻辑删除', 403)
      if (fresh.accountStatus === 'deleted') return
      await tx.user.update({
        where: { id: userId },
        data: { accountStatus: 'deleted', sessionVersion: { increment: 1 } },
      })
      await tx.teacherLease.updateMany({
        where: { userId },
        data: { state: 'revoked', reason: '测试账号已删除', nonce: crypto.randomBytes(24).toString('hex') },
      })
      await tx.auditEvent.create({
        data: {
          actorId: actorId ?? 'system',
          action: 'user.test.delete',
          targetId: userId,
          detail: JSON.stringify({ from: fresh.accountStatus, to: 'deleted' }),
        },
      })
    })
    return
  }
  await transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } })
    await invalidateArenaUserTx(tx, userId)
  })
  void drainArenaRecomputations()
}

export async function adminClearStudents(): Promise<number> {
  const count = await transaction(async (tx) => {
    const where = { role: 'student', isTestAccount: false }
    const users = await tx.user.findMany({ where, select: { id: true } })
    const result = await tx.user.deleteMany({ where })
    for (const user of users) await invalidateArenaUserTx(tx, user.id)
    return result.count
  })
  void drainArenaRecomputations()
  return count
}
