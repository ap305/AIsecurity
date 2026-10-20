import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { runComposeEvaluation } from './composeJudge.js'
import type { ComposeEvaluationResult } from './composeJudge.js'
import { RequestError } from '../lib/prdContract.js'
import {
  aggregateArenaResults,
  arenaScoreReachedAt,
  baselineQualified,
  compareSubmissionOrder,
  isCurrentArenaSubmission,
  oppositeRole,
  opponentFingerprint,
  parseArenaSnapshot,
  pairwiseSucceeded,
  type ArenaPairResult,
  type ArenaSnapshot,
} from './arenaRules.js'

type ArenaDb = PrismaClient | Prisma.TransactionClient
type Gateway = { url: string; token: string } | undefined

interface ArenaRuntime {
  run: typeof runComposeEvaluation
  modelGateway: (snapshot: ArenaSnapshot, submissionId: string) => Promise<Gateway> | Gateway
}

const runtime: ArenaRuntime = { run: runComposeEvaluation, modelGateway: async () => undefined }

/** Gateway credentials are created by the trusted server, never submission JSON. */
export function configureArenaRuntime(config: Partial<ArenaRuntime>): void {
  Object.assign(runtime, config)
}

function safeError(error: unknown): string {
  console.error('[arena] Evaluation failed:', error instanceof Error ? error.name : 'unknown')
  return '攻防评测未正常完成，旧有效算法和成绩已保留，请查看任务状态或联系管理员'
}

class ArenaExecutionFailure extends Error {
  constructor(readonly output: ComposeEvaluationResult, readonly phase: 'baseline' | 'opponent') {
    super('Arena execution did not complete')
  }
}
function failureResult(error: unknown): Record<string, unknown> {
  if (!(error instanceof ArenaExecutionFailure)) return {counted:false, publicMessage:safeError(error)}
  const status=error.output.status
  const messages = {
    student_error:'代码或模型运行失败，请核对题目接口、依赖及模型结构后重新提交；本次不计分，原有效成绩保留',
    timeout:'评测超时，本次不计分，原有效成绩保留',
    system_error:'评测环境异常，本次不计分，原有效成绩保留；请联系管理员查看任务状态',
    completed:'评测结果无效，本次不计分，原有效成绩保留',
  }
  return {counted:false,evaluationStatus:status,failedPhase:error.phase,cleanupStatus:error.output.cleanupStatus,publicMessage:messages[status]}
}

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (attempt >= 4 || (code !== 'P2034' && code !== 'P2002')) throw error
    }
  }
}

function poolKey(snapshot: ArenaSnapshot) {
  return { scenarioId: snapshot.scenarioId, evaluationVersion: snapshot.evaluationVersion }
}

function slotKey(snapshot: ArenaSnapshot, userId: string) {
  return { userId, ...poolKey(snapshot), role: snapshot.role }
}

async function currentSubmission(db: ArenaDb, submissionId: string) {
  const submission = await db.submission.findUnique({ where: { id: submissionId } })
  if (!submission) throw new Error('提交不存在')
  const user = await db.user.findUnique({ where: { id: submission.userId }, select: { id: true } })
  if (!user) return null
  const question = await db.question.findUnique({ where: { id: submission.questionId } })
  if (!question || !isCurrentArenaSubmission(submission, question)) return null
  return submission
}

async function eligibleOpponents(db: ArenaDb, snapshot: ArenaSnapshot, userId: string) {
  const slots = await db.arenaSlot.findMany({
    where: { ...poolKey(snapshot), role: oppositeRole(snapshot.role), userId: { not: userId } },
    orderBy: { algorithmId: 'asc' },
  })
  const algorithms = await db.arenaAlgorithm.findMany({
    where: { id: { in: slots.map((s) => s.algorithmId) }, status: 'active' },
  })
  const submissions = await db.submission.findMany({
    where: { id: { in: algorithms.map((a) => a.submissionId) } },
  })
  const users = await db.user.findMany({
    where: { id: { in: algorithms.map((a) => a.userId) } },
    select: { id: true },
  })
  const existingUsers = new Set(users.map((u) => u.id))
  const questions = await db.question.findMany({
    where: { id: { in: submissions.map((s) => s.questionId) } },
  })
  const bySubmission = new Map(submissions.map((s) => [s.id, s]))
  const byQuestion = new Map(questions.map((q) => [q.id, q]))
  return algorithms
    .flatMap((algorithm) => {
      const submission = bySubmission.get(algorithm.submissionId)
      const question = submission && byQuestion.get(submission.questionId)
      return existingUsers.has(algorithm.userId) &&
        submission &&
        question &&
        isCurrentArenaSubmission(submission, question)
        ? [{ algorithm, submission }]
        : []
    })
    .sort((a, b) => a.algorithm.id.localeCompare(b.algorithm.id))
}

async function enqueueRecompute(db: ArenaDb, algorithmId: string, revision: number): Promise<void> {
  const algorithm = await db.arenaAlgorithm.findUnique({ where: { id: algorithmId } })
  if (!algorithm || algorithm.status !== 'active') return
  const id = `${algorithm.id}:recompute:${revision}`
  await db.arenaEvaluation.upsert({
    where: { id },
    update: {},
    create: {
      id,
      submissionId: algorithm.submissionId,
      algorithmId: algorithm.id,
      scenarioId: algorithm.scenarioId,
      role: algorithm.role,
      evaluationVersion: algorithm.evaluationVersion,
      kind: 'recompute',
      status: 'queued',
    },
  })
}

/** Idempotent entry point called by the durable submission worker. */
export async function processArenaSubmission(submissionId: string): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } })
  if (!submission) throw new Error('提交不存在')
  const snapshot = parseArenaSnapshot(submission.configSnapshot)
  if (
    snapshot.questionId !== submission.questionId ||
    snapshot.questionVersion !== submission.questionVersion ||
    snapshot.role !== submission.role ||
    snapshot.scenarioId !== submission.scenarioId ||
    snapshot.evaluationVersion !== submission.evaluationVersion
  ) {
    throw new Error('攻防提交与冻结题目配置不一致')
  }
  const jobId = await serializable(async (tx) => {
    const algorithm = await tx.arenaAlgorithm.upsert({
      where: { submissionId },
      update: {},
      create: {
        submissionId,
        userId: submission.userId,
        questionId: submission.questionId,
        ...poolKey(snapshot),
        role: snapshot.role,
      },
    })
    const id = `${submissionId}:candidate`
    await tx.arenaEvaluation.upsert({
      where: { id },
      update: {},
      create: {
        id,
        submissionId,
        algorithmId: algorithm.id,
        ...poolKey(snapshot),
        role: snapshot.role,
        kind: 'candidate',
        status: 'queued',
      },
    })
    return id
  })
  await processArenaEvaluation(jobId)
  void drainArenaRecomputations()
}

async function finishWithoutScore(
  jobId: string,
  attempt: number,
  status: 'failed' | 'error' | 'stale',
  result: Record<string, unknown>,
): Promise<void> {
  await serializable(async (tx) => {
    const task = await tx.arenaEvaluation.findUnique({ where: { id: jobId } })
    if (!task || task.status !== 'running' || task.attempts !== attempt) return
    await tx.arenaEvaluation.update({
      where: { id: jobId },
      data: {
        status,
        result: JSON.stringify(result),
        error: status === 'error' ? String(result.publicMessage ?? '') : null,
      },
    })
    if (task.kind === 'candidate') {
      await tx.arenaAlgorithm.updateMany({
        where: { id: task.algorithmId, status: 'candidate' },
        data: { status },
      })
      await tx.submission.update({
        where: { id: task.submissionId },
        data: {
          status: status === 'failed' ? 'baseline_failed' : status,
          score: null,
          result: JSON.stringify(result),
        },
      })
    }
  })
}

async function processArenaEvaluation(jobId: string): Promise<void> {
  const claim = await prisma.arenaEvaluation.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'running', attempts: { increment: 1 } },
  })
  if (claim.count !== 1) return
  const task = await prisma.arenaEvaluation.findUnique({ where: { id: jobId } })
  if (!task) return
  const heartbeat = setInterval(() => {
    void prisma.arenaEvaluation
      .updateMany({
        where: { id: jobId, status: 'running', attempts: task.attempts },
        data: { updatedAt: new Date() },
      })
      .catch(() => {
        console.error('[arena] Job heartbeat failed')
      })
  }, 20_000)
  heartbeat.unref()
  try {
    const submission = await currentSubmission(prisma, task.submissionId)
    if (!submission) {
      await finishWithoutScore(jobId, task.attempts, 'stale', {
        publicMessage: '题目版本已变更，本次提交不再计分',
      })
      return
    }
    const snapshot = parseArenaSnapshot(submission.configSnapshot)
    const config = snapshot.definition.evaluation
    const baseInput = {
      submissionId: submission.id,
      questionVersion: submission.questionVersion,
      evaluationVersion: snapshot.evaluationVersion,
      packageId: config.packageId,
      code: submission.code,
      filePath: submission.filePath,
      role: snapshot.role,
      timeoutMs: config.timeoutMs,
      parameters: config,
    }
    if (task.kind === 'candidate') {
      await prisma.submission.update({ where: { id: submission.id }, data: { status: 'baseline' } })
      const baseline = await runtime.run({
        ...baseInput,
        attemptId: `${jobId}:baseline:${task.attempts}`,
        phase: 'baseline',
        modelGateway: await runtime.modelGateway(snapshot, submission.id),
        baseline: {
          code: typeof config.baselineCode === 'string' ? config.baselineCode : undefined,
          fixture: typeof config.baselineFixture === 'string' ? config.baselineFixture : undefined,
          filePath: typeof config.baselineModelFilePath === 'string' ? config.baselineModelFilePath : null,
          weightFixture:
            typeof config.baselineWeightFixture === 'string' ? config.baselineWeightFixture : undefined,
        },
      })
      if (baseline.status !== 'completed') throw new ArenaExecutionFailure(baseline, 'baseline')
      const qualified = baselineQualified(baseline.metrics, config)
      await prisma.arenaAlgorithm.updateMany({
        where: { id: task.algorithmId, status: 'candidate' },
        data: { baselineResult: JSON.stringify({ qualified, metrics: baseline.metrics }) },
      })
      if (!qualified) {
        await finishWithoutScore(jobId, task.attempts, 'failed', {
          qualified: false,
          counted: false,
          publicMessage: '基线资格未通过，本次不入池不计分',
        })
        return
      }
      await prisma.submission.update({ where: { id: submission.id }, data: { status: 'opponents' } })
    } else {
      const slot = await prisma.arenaSlot.findUnique({
        where: { userId_scenarioId_role_evaluationVersion: slotKey(snapshot, submission.userId) },
      })
      if (slot?.algorithmId !== task.algorithmId) {
        await finishWithoutScore(jobId, task.attempts, 'stale', {
          publicMessage: '算法已被替换，不再更新旧版本成绩',
        })
        return
      }
    }

    const frozen = await serializable(async (tx) => {
      const owned = await tx.arenaEvaluation.findUnique({ where: { id: jobId } })
      if (owned?.status !== 'running' || owned.attempts !== task.attempts) return null
      const pool = await tx.arenaPool.upsert({
        where: { scenarioId_evaluationVersion: poolKey(snapshot) },
        update: {},
        create: poolKey(snapshot),
      })
      const opponents = await eligibleOpponents(tx, snapshot, submission.userId)
      await tx.arenaEvaluation.update({
        where: { id: jobId },
        data: {
          snapshotRevision: pool.revision,
          opponentsSnapshot: JSON.stringify(
            opponents.map(({ algorithm, submission: peer }) => ({
              algorithmId: algorithm.id,
              submissionId: peer.id,
              questionVersion: peer.questionVersion,
            })),
          ),
        },
      })
      return { revision: pool.revision, opponents }
    })
    if (!frozen) return
    const pairResults: ArenaPairResult[] = []
    for (const opponent of frozen.opponents) {
      const owned = await prisma.arenaEvaluation.updateMany({
        where: { id: jobId, status: 'running', attempts: task.attempts },
        data: { updatedAt: new Date() },
      })
      if (owned.count !== 1) return
      const result = await runtime.run({
        ...baseInput,
        attemptId: `${jobId}:peer:${opponent.algorithm.id}:${task.attempts}`,
        phase: 'opponent',
        modelGateway: await runtime.modelGateway(snapshot, submission.id),
        opponent: {
          submissionId: opponent.submission.id,
          code: opponent.submission.code,
          filePath: opponent.submission.filePath,
        },
      })
      if (result.status !== 'completed' || typeof result.success !== 'boolean')
        throw new ArenaExecutionFailure(result, 'opponent')
      pairResults.push({
        opponentId: opponent.algorithm.id,
        status: result.status,
        success: pairwiseSucceeded(result.metrics, config),
        reportedSuccess: result.success,
        metrics: result.metrics,
      })
      // Save each result as it arrives for audit and crash diagnosis.
      await prisma.arenaEvaluation.updateMany({
        where: { id: jobId, status: 'running', attempts: task.attempts },
        data: { result: JSON.stringify({ qualified: true, pairs: pairResults }) },
      })
    }
    const aggregate = aggregateArenaResults(
      frozen.opponents.map((p) => p.algorithm.id),
      pairResults,
    )
    const outcome = await serializable(async (tx) => {
      const current = await currentSubmission(tx, task.submissionId)
      const pool = await tx.arenaPool.findUnique({
        where: { scenarioId_evaluationVersion: poolKey(snapshot) },
      })
      const taskNow = await tx.arenaEvaluation.findUnique({ where: { id: jobId } })
      if (!current || taskNow?.status !== 'running' || taskNow.attempts !== task.attempts)
        return 'stale' as const
      const currentOpponents = await eligibleOpponents(tx, snapshot, current.userId)
      if (
        pool?.revision !== frozen.revision ||
        opponentFingerprint(currentOpponents.map((p) => p.algorithm.id)) !==
          opponentFingerprint(frozen.opponents.map((p) => p.algorithm.id))
      ) {
        await tx.arenaEvaluation.update({
          where: { id: jobId },
          data: {
            status: 'queued',
            result: JSON.stringify({ ...aggregate, counted: false, reason: 'snapshot_changed' }),
          },
        })
        return 'retry' as const
      }
      const slot = await tx.arenaSlot.findUnique({
        where: { userId_scenarioId_role_evaluationVersion: slotKey(snapshot, current.userId) },
      })
      const previousAlgorithm =
        slot && (await tx.arenaAlgorithm.findUnique({ where: { id: slot.algorithmId } }))
      const previousSubmission =
        previousAlgorithm &&
        (await tx.submission.findUnique({ where: { id: previousAlgorithm.submissionId } }))
      if (
        task.kind === 'candidate' &&
        previousSubmission &&
        compareSubmissionOrder(previousSubmission, current) > 0
      )
        return 'stale' as const
      if (task.kind === 'recompute' && slot?.algorithmId !== task.algorithmId) return 'stale' as const
      const previous = slot && (await tx.arenaScore.findUnique({ where: { algorithmId: slot.algorithmId } }))
      const now = new Date()
      const achievedAt = arenaScoreReachedAt(previous || null, aggregate.score, now)
      const scoreData = {
        userId: current.userId,
        questionId: current.questionId,
        ...poolKey(snapshot),
        role: snapshot.role,
        score: aggregate.score,
        successCount: aggregate.successCount,
        opponentCount: aggregate.opponentCount,
        snapshotRevision: frozen.revision,
        snapshotId: task.id,
        achievedAt,
      }
      await tx.arenaScore.upsert({
        where: { algorithmId: task.algorithmId },
        create: { algorithmId: task.algorithmId, ...scoreData },
        update: scoreData,
      })
      const publishedResult = {
        qualified: true,
        counted: true,
        ...aggregate,
        snapshotId: task.id,
        snapshotRevision: frozen.revision,
        scoreReachedAt: achievedAt.toISOString(),
        publicMessage: aggregate.emptyPool ? '暂无有效对手，按规则计100%' : '本次完整对抗评测已完成',
      }
      await tx.arenaEvaluation.update({
        where: { id: jobId },
        data: { status: 'completed', result: JSON.stringify({ ...publishedResult, pairs: pairResults }) },
      })
      await tx.submission.update({
        where: { id: current.id },
        data: { status: 'completed', score: aggregate.score, result: JSON.stringify(publishedResult) },
      })
      if (task.kind === 'candidate' && slot?.algorithmId !== task.algorithmId) {
        if (slot)
          await tx.arenaAlgorithm.update({ where: { id: slot.algorithmId }, data: { status: 'superseded' } })
        await tx.arenaAlgorithm.update({ where: { id: task.algorithmId }, data: { status: 'active' } })
        await tx.arenaSlot.upsert({
          where: { userId_scenarioId_role_evaluationVersion: slotKey(snapshot, current.userId) },
          create: { ...slotKey(snapshot, current.userId), algorithmId: task.algorithmId },
          update: { algorithmId: task.algorithmId },
        })
        const nextPool = await tx.arenaPool.update({
          where: { scenarioId_evaluationVersion: poolKey(snapshot) },
          data: { revision: { increment: 1 } },
        })
        for (const peer of currentOpponents) await enqueueRecompute(tx, peer.algorithm.id, nextPool.revision)
      }
      // Recomputations publish scores only. They never re-admit an algorithm or enqueue peers.
      return 'completed' as const
    })
    if (outcome === 'stale')
      await finishWithoutScore(jobId, task.attempts, 'stale', {
        publicMessage: '已有更新版本，本次旧结果不覆盖有效成绩',
      })
    if (outcome === 'retry') void drainArenaRecomputations()
  } catch (error) {
    const failure = failureResult(error)
    await finishWithoutScore(jobId, task.attempts, 'error', failure)
    if (task.kind === 'recompute' && task.attempts < 3 && failure.evaluationStatus !== 'student_error') {
      await prisma.arenaEvaluation.updateMany({
        where: { id: jobId, status: 'error', attempts: task.attempts },
        data: { status: 'queued' },
      })
    }
  } finally {
    clearInterval(heartbeat)
  }
}

let drain: Promise<void> | null = null

/** A bounded, persistent queue. A second process still needs the row claim. */
export function drainArenaRecomputations(): Promise<void> {
  if (drain) return drain
  drain = (async () => {
    for (let count = 0; count < 100; count += 1) {
      const task = await prisma.arenaEvaluation.findFirst({
        where: { status: 'queued' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (!task) break
      await processArenaEvaluation(task.id)
    }
  })()
    .catch((error) => {
      safeError(error)
    })
    .finally(() => {
      drain = null
    })
  return drain
}

/** Resume queued jobs and reclaim abandoned attempts, without touching live workers. */
export async function recoverArenaTasks(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)
  await prisma.arenaEvaluation.updateMany({
    where: { status: 'running', updatedAt: { lt: cutoff } },
    data: { status: 'queued', error: '执行实例未继续更新，已恢复排队' },
  })
  await drainArenaRecomputations()
}

/** Call when a question is unpublished or its published configuration changes. */
export async function invalidateArenaQuestionTx(
  tx: Prisma.TransactionClient,
  questionId: string,
): Promise<void> {
  const question = await tx.question.findUnique({ where: { id: questionId } })
  const algorithms = await tx.arenaAlgorithm.findMany({ where: { questionId, status: 'active' } })
  const affectedPools = new Map<
    string,
    { scenarioId: string; evaluationVersion: string; roles: Set<'attack' | 'defense'> }
  >()
  for (const algorithm of algorithms) {
    const submission = await tx.submission.findUnique({ where: { id: algorithm.submissionId } })
    // Post-publication cleanup must not retire a candidate already admitted on
    // the new revision between publication and this cleanup transaction.
    if (question && submission && isCurrentArenaSubmission(submission, question)) continue
    await tx.arenaSlot.deleteMany({ where: { algorithmId: algorithm.id } })
    await tx.arenaAlgorithm.update({ where: { id: algorithm.id }, data: { status: 'invalidated' } })
    const key = { scenarioId: algorithm.scenarioId, evaluationVersion: algorithm.evaluationVersion }
    const identity = JSON.stringify(key)
    const group = affectedPools.get(identity) ?? { ...key, roles: new Set<'attack' | 'defense'>() }
    group.roles.add(algorithm.role as 'attack' | 'defense')
    affectedPools.set(identity, group)
  }
  for (const group of affectedPools.values()) {
    const key = { scenarioId: group.scenarioId, evaluationVersion: group.evaluationVersion }
    const pool = await tx.arenaPool.upsert({
      where: { scenarioId_evaluationVersion: key },
      create: { ...key, revision: 1 },
      update: { revision: { increment: 1 } },
    })
    const peers = await tx.arenaSlot.findMany({
      where: { ...key, role: { in: [...group.roles].map(oppositeRole) } },
    })
    for (const peer of peers) await enqueueRecompute(tx, peer.algorithmId, pool.revision)
  }
}

export async function invalidateArenaQuestion(questionId: string): Promise<void> {
  await serializable((tx) => invalidateArenaQuestionTx(tx, questionId))
  void drainArenaRecomputations()
}

export async function invalidateArenaUserTx(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const algorithms = await tx.arenaAlgorithm.findMany({ where: { userId, status: 'active' } })
  const groups = new Map<
    string,
    { scenarioId: string; evaluationVersion: string; roles: Set<'attack' | 'defense'> }
  >()
  for (const algorithm of algorithms) {
    await tx.arenaSlot.deleteMany({ where: { algorithmId: algorithm.id } })
    await tx.arenaAlgorithm.update({ where: { id: algorithm.id }, data: { status: 'invalidated' } })
    const identity = JSON.stringify([algorithm.scenarioId, algorithm.evaluationVersion])
    const group = groups.get(identity) ?? {
      scenarioId: algorithm.scenarioId,
      evaluationVersion: algorithm.evaluationVersion,
      roles: new Set<'attack' | 'defense'>(),
    }
    group.roles.add(algorithm.role as 'attack' | 'defense')
    groups.set(identity, group)
  }
  for (const group of groups.values()) {
    const key = { scenarioId: group.scenarioId, evaluationVersion: group.evaluationVersion }
    const pool = await tx.arenaPool.upsert({
      where: { scenarioId_evaluationVersion: key },
      create: { ...key, revision: 1 },
      update: { revision: { increment: 1 } },
    })
    const peers = await tx.arenaSlot.findMany({
      where: { ...key, role: { in: [...group.roles].map(oppositeRole) } },
    })
    for (const peer of peers) await enqueueRecompute(tx, peer.algorithmId, pool.revision)
  }
}

export async function retryArenaRecomputation(jobId: string, actorId: string): Promise<void> {
  await serializable(async (tx) => {
    const task = await tx.arenaEvaluation.findUnique({ where: { id: jobId } })
    if (!task || task.kind !== 'recompute' || task.status !== 'error')
      throw new RequestError('仅异常重评任务可从此入口重试', 409)
    const submission = await currentSubmission(tx, task.submissionId)
    const algorithm = await tx.arenaAlgorithm.findUnique({ where: { id: task.algorithmId } })
    if (!submission || algorithm?.status !== 'active')
      throw new RequestError('题目或算法已失效，不能重试旧版本', 409)
    const snapshot = parseArenaSnapshot(submission.configSnapshot)
    const slot = await tx.arenaSlot.findUnique({
      where: { userId_scenarioId_role_evaluationVersion: slotKey(snapshot, submission.userId) },
    })
    if (slot?.algorithmId !== algorithm.id) throw new RequestError('算法已替换，不能重试旧版本', 409)
    await tx.arenaEvaluation.update({
      where: { id: task.id },
      data: { status: 'queued', attempts: 0, error: null },
    })
    await tx.auditEvent.create({
      data: {
        actorId,
        action: 'arena.recompute.retry',
        targetId: task.id,
        detail: JSON.stringify({ previousAttempts: task.attempts }),
      },
    })
  })
  void drainArenaRecomputations()
}
