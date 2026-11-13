import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { transaction } from '../lib/transaction.js'
import { hasValidSession, type TokenPayload } from '../lib/auth.js'
import {
  AuthError,
  hashPasswordAsync,
  validateNewPassword,
  verifyPasswordAsync,
} from '../lib/authPassword.js'
import { authEvent, digest } from '../lib/authSecurity.js'
import {
  assertEmailEnabled,
  emailEnabled,
  normalizeEmail,
  sendVerificationEmail,
  smtpSettings,
  verificationUrl,
  type EmailPurpose,
  type EmailSender,
} from './emailSender.js'

const invalid = () => new AuthError('验证链接无效或已过期，请重新申请', 400, 40016)
const unavailable = () => new AuthError('邮箱暂不可用于此操作，请核对后重试', 400, 40016)
let pendingDeliveries = 0,
  activeDeliveries = 0
const deliveries: Array<() => Promise<void>> = []
function drainDeliveries() {
  while (activeDeliveries < 2 && deliveries.length) {
    activeDeliveries++
    const work = deliveries.shift()!
    void work()
      .catch(() => {
        // Never expose transport credentials, recipient, verification URL or raw SMTP errors.
        console.error('[auth-email] delivery failure audit unavailable')
      })
      .finally(() => {
        activeDeliveries--
        pendingDeliveries--
        drainDeliveries()
      })
  }
}
async function currentUser(payload: TokenPayload | null, db: Prisma.TransactionClient = prisma) {
  const row = payload ? await db.user.findUnique({ where: { id: payload.uid } }) : null
  if (!(await hasValidSession(payload, row, db))) throw new AuthError('登录已过期，请重新登录', 401, 40100)
  return row!
}
async function throttle(tx: Prisma.TransactionClient, purpose: EmailPurpose, email: string) {
  const now = new Date(),
    hour = 3600000
  for (const [key, max, cooldown] of [
    [`${purpose}:${digest(email)}`, 5, 60000],
    ['global', 200, 0],
  ] as const) {
    const row = await tx.emailSendThrottle.findUnique({ where: { key } })
    const freshWindow = !row || now.getTime() - row.windowStartedAt.getTime() >= hour
    const remaining = row ? cooldown - (now.getTime() - row.lastSentAt.getTime()) : 0
    if (remaining > 0 || (!freshWindow && row!.count >= max)) {
      const seconds = Math.max(
        1,
        Math.ceil(
          (remaining > 0 ? remaining : hour - (now.getTime() - row!.windowStartedAt.getTime())) / 1000,
        ),
      )
      throw new AuthError('申请过于频繁，请稍后重试', 429, 42910, seconds)
    }
    await tx.emailSendThrottle.upsert({
      where: { key },
      create: { key, count: 1, windowStartedAt: now, lastSentAt: now },
      update: {
        count: freshWindow ? 1 : { increment: 1 },
        ...(freshWindow ? { windowStartedAt: now } : {}),
        lastSentAt: now,
      },
    })
  }
}

export async function requestEmail(
  input: { purpose?: unknown; email?: unknown; currentPassword?: unknown },
  payload: TokenPayload | null,
  sender: EmailSender = sendVerificationEmail,
) {
  assertEmailEnabled()
  if (!['registration', 'bind', 'reset'].includes(String(input.purpose)))
    throw new AuthError('请选择有效的邮箱操作', 400, 40016)
  const purpose = input.purpose as EmailPurpose,
    email = normalizeEmail(input.email)
  if (sender === sendVerificationEmail) smtpSettings()
  else if (process.env.NODE_ENV !== 'test') throw new AuthError('邮箱服务配置不可用', 503, 50310)
  const user = purpose === 'bind' ? await currentUser(payload) : null
  if (
    user &&
    (typeof input.currentPassword !== 'string' ||
      input.currentPassword.length > 256 ||
      !(await verifyPasswordAsync(input.currentPassword, user.password)))
  )
    throw new AuthError('当前密码错误', 400, 40016)
  const token = crypto.randomBytes(32).toString('base64url')
  const url = verificationUrl(token, purpose)
  // Overflow has the same acceptance and throttle accounting; queue occupancy must not be an email oracle.
  const reserved = pendingDeliveries < 16
  if (reserved) pendingDeliveries++
  let issued
  try {
    issued = await transaction(async (tx) => {
      if (user) {
        const fresh = await currentUser(payload, tx)
        if (fresh.password !== user.password) throw invalid()
      }
      await throttle(tx, purpose, email)
      if (!reserved) {
        await authEvent(tx, 'auth.email.capacity', 'delivery-queue', 'system')
        return null
      }
      const bound = await tx.userEmail.findUnique({ where: { email } })
      const owner = bound ? await tx.user.findUnique({ where: { id: bound.userId } }) : null
      if (purpose === 'reset' && (!owner || owner.accountStatus !== 'active' || owner.role === 'admin'))
        return null
      if (purpose !== 'reset' && bound && bound.userId !== user?.id) return null
      const target = purpose === 'reset' ? owner : user
      // Resending revokes earlier links for this same destination and purpose.
      await tx.emailChallenge.updateMany({
        where: { purpose, email, consumedAt: null },
        data: { consumedAt: new Date() },
      })
      return tx.emailChallenge.create({
        data: {
          purpose,
          email,
          userId: target?.id,
          sessionVersion: target?.sessionVersion,
          tokenHash: digest(token),
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
      })
    })
  } catch (error) {
    if (reserved) pendingDeliveries--
    throw error
  }
  if (issued) {
    const challengeId = issued.id
    deliveries.push(async () => {
      try {
        await sender({ to: email, purpose, url })
      } catch {
        await prisma.emailChallenge.updateMany({
          where: { id: challengeId, consumedAt: null },
          data: { consumedAt: new Date() },
        })
        await authEvent(prisma, 'auth.email.send-failure', challengeId, 'system')
      }
    })
    drainDeliveries()
  } else if (reserved) pendingDeliveries--
  return { accepted: true }
}

async function consume(tx: Prisma.TransactionClient, token: unknown, purpose: EmailPurpose) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid()
  const challenge = await tx.emailChallenge.findUnique({ where: { tokenHash: digest(token) } })
  if (
    !challenge ||
    challenge.purpose !== purpose ||
    challenge.consumedAt ||
    challenge.expiresAt.getTime() <= Date.now()
  )
    throw invalid()
  const result = await tx.emailChallenge.updateMany({
    where: { id: challenge.id, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  })
  if (result.count !== 1) throw invalid()
  return challenge
}
export async function consumeRegistrationEmailTx(
  tx: Prisma.TransactionClient,
  token: unknown,
): Promise<string> {
  assertEmailEnabled()
  const challenge = await consume(tx, token, 'registration')
  if (await tx.userEmail.findUnique({ where: { email: challenge.email } })) throw unavailable()
  return challenge.email
}
async function revokeLeases(tx: Prisma.TransactionClient, userId: string) {
  await tx.teacherLease.updateMany({
    where: { userId, state: { in: ['creating', 'active'] } },
    data: { state: 'revoked', reason: '账号安全凭据已更新', nonce: crypto.randomBytes(24).toString('hex') },
  })
}
export async function bindEmail(payload: TokenPayload | null, token: unknown, currentPassword: unknown) {
  assertEmailEnabled()
  const user = await currentUser(payload)
  if (
    typeof currentPassword !== 'string' ||
    currentPassword.length > 256 ||
    !(await verifyPasswordAsync(currentPassword, user.password))
  )
    throw new AuthError('当前密码错误', 400, 40016)
  return transaction(async (tx) => {
    const fresh = await currentUser(payload, tx)
    const challenge = await consume(tx, token, 'bind')
    if (
      challenge.userId !== user.id ||
      challenge.sessionVersion !== fresh.sessionVersion ||
      fresh.password !== user.password
    )
      throw invalid()
    const occupied = await tx.userEmail.findUnique({ where: { email: challenge.email } })
    if (occupied && occupied.userId !== user.id) throw unavailable()
    const changed = await tx.user.updateMany({
      where: {
        id: user.id,
        sessionVersion: fresh.sessionVersion,
        accountStatus: 'active',
        password: user.password,
      },
      data: { sessionVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw invalid()
    await tx.userEmail.upsert({
      where: { userId: user.id },
      create: { userId: user.id, email: challenge.email, verifiedAt: new Date() },
      update: { email: challenge.email, verifiedAt: new Date() },
    })
    await revokeLeases(tx, user.id)
    await authEvent(tx, 'auth.email.bind', user.id)
    return { ok: true, relogin: true }
  })
}
export async function recoverPassword(token: unknown, newPassword: unknown) {
  assertEmailEnabled()
  if (typeof newPassword !== 'string') throw new AuthError('请填写新密码', 400, 40016)
  validateNewPassword(newPassword)
  // Validate the unguessable capability before starting the bounded expensive hash work.
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid()
  const candidate = await prisma.emailChallenge.findUnique({ where: { tokenHash: digest(token) } })
  if (
    !candidate ||
    candidate.purpose !== 'reset' ||
    candidate.consumedAt ||
    candidate.expiresAt.getTime() <= Date.now()
  )
    throw invalid()
  const password = await hashPasswordAsync(newPassword)
  return transaction(async (tx) => {
    const challenge = await consume(tx, token, 'reset')
    const user = challenge.userId ? await tx.user.findUnique({ where: { id: challenge.userId } }) : null
    const bound = user ? await tx.userEmail.findUnique({ where: { userId: user.id } }) : null
    if (
      !user ||
      user.accountStatus !== 'active' ||
      user.role === 'admin' ||
      challenge.sessionVersion !== user.sessionVersion ||
      bound?.email !== challenge.email
    )
      throw invalid()
    const changed = await tx.user.updateMany({
      where: {
        id: user.id,
        sessionVersion: challenge.sessionVersion!,
        accountStatus: 'active',
        role: { not: 'admin' },
      },
      data: { password, sessionVersion: { increment: 1 } },
    })
    if (changed.count !== 1) throw invalid()
    await tx.userSecurity.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: { mustChangePassword: false, temporaryPasswordExpiresAt: null },
    })
    await revokeLeases(tx, user.id)
    await authEvent(tx, 'auth.password.recover', user.id)
    return { ok: true, relogin: true }
  })
}
export async function ownEmail(payload: TokenPayload | null) {
  const user = await currentUser(payload)
  const bound = await prisma.userEmail.findUnique({ where: { userId: user.id } })
  return {
    emailEnabled: emailEnabled(),
    email: bound?.email ?? null,
    verifiedAt: bound?.verifiedAt.toISOString() ?? null,
  }
}
