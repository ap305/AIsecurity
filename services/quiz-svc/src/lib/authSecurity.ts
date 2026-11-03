import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { transaction } from './transaction.js'
import { AuthError } from './authPassword.js'

export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const WINDOW_MS = 15 * 60 * 1000

export async function authEvent(tx: Prisma.TransactionClient, action: string, userId: string, actorId = userId, detail: Record<string, unknown> = {}) {
  await tx.auditEvent.create({ data: { actorId, action, targetId: userId, detail: JSON.stringify(detail) } })
}

export async function assertLoginAvailable(accountKey: string) {
  const state = await prisma.authLoginThrottle.findUnique({ where: { accountKey } })
  if (state?.blockedUntil && state.blockedUntil.getTime() > Date.now())
    throw new AuthError('登录尝试过多，请稍后重试', 429, 42900, Math.ceil((state.blockedUntil.getTime() - Date.now()) / 1000))
}

export async function loginFailure(accountKey: string, userId?: string, source?: string) {
  await transaction(async (tx) => {
    const now = new Date()
    const previous = await tx.authLoginThrottle.upsert({ where: { accountKey }, create: { accountKey }, update: { failures: { increment: 0 } } })
    const failures = previous.windowStartedAt.getTime() < now.getTime() - WINDOW_MS ? 1 : previous.failures + 1
    await tx.authLoginThrottle.update({ where: { accountKey }, data: {
      failures,
      ...(failures === 1 ? { windowStartedAt: now } : {}),
      blockedUntil: failures >= 5 ? new Date(now.getTime() + Math.min(300000, 30000 * 2 ** Math.min(failures - 5, 4))) : null,
    } })
    await authEvent(tx, 'auth.login.failure', userId ?? `unknown:${accountKey}`, 'anonymous', source ? { sourceHash: digest(source) } : {})
    await tx.authLoginThrottle.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } })
  })
}

// Existing platform initial password, used only after administrator identity verification.
// Public demo value only; the production value is maintained by private deployment.
export const INITIAL_PASSWORD = 'PublicDemoInit42!'