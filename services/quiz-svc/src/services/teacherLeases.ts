import crypto from 'node:crypto'
import { prisma } from '../lib/db.js'
import { signScopedToken, isAccountActive, hasCurrentSession } from '../lib/auth.js'
import { parseJson, RequestError, type PoolBinding, type SubmissionSnapshot } from '../lib/prdContract.js'
import { poolHealthy } from './apiPool.js'
import { transaction } from '../lib/transaction.js'

export const LEASE_MS = 2 * 60 * 60 * 1000
export const CREATION_RECOVERY_MS = 30_000
export function leaseState(row: { state: string; expiresAt: Date | null }, now = new Date()) {
  return row.state === 'active' && (!row.expiresAt || row.expiresAt <= now) ? 'expired' : row.state
}
export function leaseView(row: any, includeToken = true) {
  const state = leaseState(row),
    token =
      state === 'active' && includeToken
        ? signScopedToken({
            purpose: 'teacher',
            leaseId: row.id,
            uid: row.userId,
            nonce: row.nonce,
            exp: row.expiresAt.getTime(),
          })
        : undefined
  return {
    id: row.id,
    userId: row.userId,
    questionId: row.questionId,
    questionVersion: row.questionVersion,
    scope: 'user_question',
    state,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    serverTime: new Date().toISOString(),
    endpoint: `/api/teacher/${row.id}/query`,
    token,
    calls: row.calls,
    maxCalls: row.maxCalls,
    reason: row.reason,
  }
}

export async function startTeacherLease(
  userId: string,
  questionId: string,
  renew: boolean,
  sessionPayload?: Parameters<typeof hasCurrentSession>[0],
) {
  const question = await prisma.question.findUnique({ where: { id: questionId } })
  if (!question || question.status !== 'published') throw new RequestError('题目当前不可使用', 404)
  const version = await prisma.questionRevision.findUnique({
    where: { questionId_revision: { questionId, revision: question.revision } },
  })
  const snapshot = parseJson<SubmissionSnapshot>(version?.snapshot, {} as SubmissionSnapshot)
  if (!snapshot.definition?.teacherApi.enabled || !snapshot.teacherBinding)
    throw new RequestError('题目未启用教师 API')
  const prepared = await transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (sessionPayload !== undefined && !hasCurrentSession(sessionPayload, user))
      throw new RequestError('账号不可用或登录已过期，请重新登录', 401)
    if (!isAccountActive(user)) throw new RequestError('账号已停用或删除，请联系管理员', 403)
    const freshQuestion = await tx.question.findUnique({ where: { id: questionId } })
    if (
      !freshQuestion ||
      freshQuestion.status !== 'published' ||
      freshQuestion.revision !== question.revision
    )
      throw new RequestError('题目版本已变化，请刷新后重试', 409)
    const current = await tx.teacherLease.findUnique({ where: { userId_questionId: { userId, questionId } } })
    if (current && current.questionVersion === question.revision) {
      const state = leaseState(current)
      if (state === 'revoked') throw new RequestError('管理员已撤销访问资格', 403)
      if (
        state === 'active' ||
        (state === 'creating' && current.updatedAt.getTime() > Date.now() - CREATION_RECOVERY_MS)
      ) {
        if (renew && state === 'active') throw new RequestError('租约尚未到期，不能提前续期')
        return { row: current, check: false }
      }
      if (state === 'expired' && !renew) throw new RequestError('租约已到期，请手动续期')
    } else if (renew) throw new RequestError('尚无本题版本租约，请先开启')
    const data = {
      userId,
      questionId,
      questionVersion: question.revision,
      poolSnapshot: JSON.stringify(snapshot.teacherBinding),
      state: 'creating',
      startsAt: null,
      expiresAt: null,
      nonce: crypto.randomBytes(24).toString('hex'),
      calls: 0,
      maxCalls: snapshot.definition.teacherApi.maxCalls ?? 1000,
      reason: null,
    }
    const row = await tx.teacherLease.upsert({
      where: { userId_questionId: { userId, questionId } },
      create: data,
      update: data,
    })
    return { row, check: true }
  })
  if (!prepared.check) return leaseView(prepared.row)
  const ready = await poolHealthy(snapshot.teacherBinding)
  const started = new Date()
  const row = await transaction(async (tx) => {
    const freshQuestion = await tx.question.findUnique({ where: { id: questionId } })
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (sessionPayload !== undefined && !hasCurrentSession(sessionPayload, user))
      throw new RequestError('账号不可用或登录已过期，请重新登录', 401)
    const owned = await tx.teacherLease.findFirst({
      where: { id: prepared.row.id, nonce: prepared.row.nonce },
    })
    if (!owned) throw new RequestError('教师租约准备已被更新，请刷新后重试', 409)
    const current =
      freshQuestion?.status === 'published' &&
      freshQuestion.revision === question.revision &&
      isAccountActive(user)
    await tx.teacherLease.updateMany({
      where: { id: prepared.row.id, nonce: prepared.row.nonce, state: 'creating' },
      data: !current
        ? { state: 'revoked', reason: '账号或题目版本已失效' }
        : ready
          ? { state: 'active', startsAt: started, expiresAt: new Date(started.getTime() + LEASE_MS) }
          : { state: 'error', reason: '教师服务暂不可用，可稍后重试' },
    })
    // Bind the returned credentials to this preparation in the same transaction.
    // Another session may have replaced this lease while its health check was pending.
    const result = await tx.teacherLease.findFirst({
      where: { id: prepared.row.id, nonce: prepared.row.nonce },
    })
    if (!result) throw new RequestError('教师租约准备已被更新，请刷新后重试', 409)
    return result
  })
  await prisma.auditEvent.create({
    data: {
      actorId: userId,
      action: renew ? 'teacher.renew' : 'teacher.start',
      targetId: row.id,
      detail: JSON.stringify({ state: row.state, questionVersion: question.revision }),
    },
  })
  return leaseView(row)
}

/** Recover only preparations whose ten-second health request owner has stopped. */
export async function recoverTeacherLeases(): Promise<void> {
  const stale = await prisma.teacherLease.findMany({
    where: { state: 'creating', updatedAt: { lte: new Date(Date.now() - CREATION_RECOVERY_MS) } },
    select: { userId: true, questionId: true },
  })
  for (const lease of stale) {
    try {
      await startTeacherLease(lease.userId, lease.questionId, false)
    } catch {
      /* Invalid/revoked leases remain unusable. */
    }
  }
}

export async function consumeTeacherCall(
  token: Record<string, any>,
  now = new Date(),
): Promise<{ binding: PoolBinding; leaseId: string }> {
  return transaction(async (tx) => {
    const lease = await tx.teacherLease.findUnique({ where: { id: token.leaseId } })
    if (!lease || lease.nonce !== token.nonce || lease.userId !== token.uid)
      throw new RequestError('无效的教师访问凭证', 401)
    const user = await tx.user.findUnique({ where: { id: lease.userId } })
    const question = await tx.question.findUnique({ where: { id: lease.questionId } })
    if (
      !isAccountActive(user) ||
      !question ||
      question.status !== 'published' ||
      question.revision !== lease.questionVersion
    )
      throw new RequestError('账号或题目版本已失效', 403)
    if (leaseState(lease, now) !== 'active') throw new RequestError('租约已到期或撤销，请检查租约状态', 403)
    if (lease.calls >= lease.maxCalls) throw new RequestError('教师查询额度已耗尽', 429)
    await tx.teacherLease.update({ where: { id: lease.id }, data: { calls: { increment: 1 } } })
    return { binding: parseJson<PoolBinding>(lease.poolSnapshot, {} as PoolBinding), leaseId: lease.id }
  })
}
