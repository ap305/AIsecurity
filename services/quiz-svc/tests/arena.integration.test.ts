import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './database.js'
import type { ComposeEvaluationInput, ComposeEvaluationResult } from '../src/services/composeJudge.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let arena: typeof import('../src/services/arenaScoring.js')
let queries: typeof import('../src/services/arenaQueries.js')

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  arena = await import('../src/services/arenaScoring.js')
  queries = await import('../src/services/arenaQueries.js')
  await prisma.user.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({
      id: `u${i}`,
      username: `user${i}`,
      displayName: `学生${i}`,
      password: 'unused',
    })),
  })
})

after(async () => {
  await arena?.drainArenaRecomputations()
  await prisma?.$disconnect()
  await database?.close()
})

const calls: ComposeEvaluationInput[] = []
const completed = (data: Partial<ComposeEvaluationResult> = {}): ComposeEvaluationResult => ({
  status: 'completed',
  cleanupStatus: 'cleaned',
  ...data,
})
async function fixtureRunner(input: ComposeEvaluationInput): Promise<ComposeEvaluationResult> {
  calls.push(input)
  const code = JSON.parse(input.code) as {
    qualification?: number
    fail?: string
    wins?: string[]
    success?: boolean
  }
  if (code.fail && input.phase === code.fail) return { status: 'system_error', cleanupStatus: 'cleaned' }
  if (input.phase === 'baseline')
    return completed({ metrics: { qualificationMetric: code.qualification ?? 1 } })
  const success = code.wins ? code.wins.includes(input.opponent!.submissionId) : (code.success ?? true)
  return completed({ success, metrics: { successMetric: success ? 1 : 0 } })
}

async function settle() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await arena.drainArenaRecomputations()
    if ((await prisma.arenaEvaluation.count({ where: { status: { in: ['queued', 'running'] } } })) === 0)
      return
  }
  throw new Error('Arena queue did not settle')
}

test('adversarial code failures retain a safe failure category and do not trigger three worker retries', async () => {
  const s = await scene('student-code-failure')
  await s.submit('student-code-failure-a', 'u0', 'attack')
  const task = await prisma.evaluationTask.create({data:{submissionId:'student-code-failure-a'}})
  let runs=0
  arena.configureArenaRuntime({run:async()=>{runs++;return {status:'student_error',cleanupStatus:'cleaned',publicMessage:'PRIVATE_RAW_ERROR /hidden/data'} }})
  const worker=await import('../src/services/evaluationWorker.js')
  for(let i=0;i<3;i++) await worker.processEvaluationTask(task.id)
  const saved=await prisma.submission.findUniqueOrThrow({where:{id:'student-code-failure-a'}})
  const result=JSON.parse(saved.result!)
  assert.equal(result.evaluationStatus,'student_error')
  assert.equal(result.cleanupStatus,'cleaned')
  assert.equal(runs,1)
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({where:{id:task.id}})).attempts,1)
  assert.equal(JSON.stringify(result).includes('PRIVATE_RAW_ERROR'),false)
  assert.match(result.publicMessage,/代码|模型|接口/)
})

test('specific contract diagnostics survive worker processing and preserve the previous active score', async () => {
  const s = await scene('contract-diagnostics')
  await s.submit('contract-valid', 'u0', 'attack')
  await arena.processArenaSubmission('contract-valid')
  await settle()
  const before = await s.score('u0', 'attack')
  await s.submit('contract-invalid', 'u0', 'attack')
  const candidate = await prisma.submission.findUniqueOrThrow({where:{id:'contract-invalid'}})
  const template = 'def solve(x): raise NotImplementedError("TODO")'
  await prisma.submission.update({where:{id:candidate.id},data:{configSnapshot:JSON.stringify({...JSON.parse(candidate.configSnapshot),answerTemplate:template})}})
  const task = await prisma.evaluationTask.create({data:{submissionId:candidate.id}})
  let runs = 0
  arena.configureArenaRuntime({run:async(input)=>{
    runs++
    assert.equal(input.answerTemplate, template)
    return {status:'student_error',cleanupStatus:'cleaned',publicMessage:'防御检索接口不符合题目要求'}
  }})
  const worker = await import('../src/services/evaluationWorker.js')
  await worker.processEvaluationTask(task.id)
  await worker.processEvaluationTask(task.id)
  const failed = await prisma.submission.findUniqueOrThrow({where:{id:candidate.id}})
  assert.equal(failed.status,'failed')
  assert.equal(runs,1)
  assert.equal(JSON.parse(failed.result!).counted,false)
  assert.match(JSON.parse(failed.result!).publicMessage,/guard_retrieval.*列表/)
  const after = await s.score('u0','attack')
  for (const field of ['score','activeSubmissionId','scoreReachedAt','snapshotId','counted','qualified','updatedAt'] as const)
    assert.deepEqual(after![field],before![field])
  assert.equal(after!.latestSubmissionStatus,'failed')
})

async function scene(id: string) {
  arena.configureArenaRuntime({ run: fixtureRunner, modelGateway: async () => undefined })
  const definition = {
    evaluation: {
      packageId: 'fixture-package',
      baselineMetric: 'qualificationMetric',
      baselineThreshold: 0.8,
      successMetric: 'successMetric',
      successThreshold: 0.5,
      repetitions: 1,
    },
  }
  for (const role of ['attack', 'defense'])
    await prisma.question.create({
      data: {
        id: `${id}-${role}`,
        moduleCode: 'T',
        number: 1,
        title: `${id} ${role}`,
        content: '题面',
        type: 'code',
        difficulty: 'L1',
        category: 'adversarial',
        scenarioId: id,
        role,
        evaluationVersion: 'v1',
        definition: JSON.stringify(definition),
      },
    })
  return {
    async submit(
      submissionId: string,
      userId: string,
      role: 'attack' | 'defense',
      code: Record<string, unknown> = {},
      createdAt?: Date,
    ) {
      return prisma.submission.create({
        data: {
          id: submissionId,
          userId,
          questionId: `${id}-${role}`,
          category: 'adversarial',
          questionVersion: 1,
          role,
          scenarioId: id,
          evaluationVersion: 'v1',
          code: JSON.stringify(code),
          status: 'queued',
          createdAt,
          configSnapshot: JSON.stringify({
            questionId: `${id}-${role}`,
            questionVersion: 1,
            category: 'adversarial',
            role,
            scenarioId: id,
            evaluationVersion: 'v1',
            definition,
          }),
        },
      })
    },
    async process(submissionId: string) {
      await arena.processArenaSubmission(submissionId)
      await settle()
    },
    async score(userId: string, role: 'attack' | 'defense') {
      return queries.arenaQuestionScore(`${id}-${role}`, userId)
    },
  }
}

test('AC-06/10: equality passes, empty pool is formal 100%, replay does not duplicate admission', async () => {
  const s = await scene('empty')
  await s.submit('empty-a', 'u0', 'attack', { qualification: 0.8 })
  await s.process('empty-a')
  const before = await s.score('u0', 'attack')
  assert.equal(before!.score, 100)
  assert.equal(before!.opponentCount, 0)
  assert.equal(before!.qualified, true)
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'empty' } }), 1)
  await s.process('empty-a')
  const after = await s.score('u0', 'attack')
  assert.equal(after!.scoreReachedAt, before!.scoreReachedAt)
  assert.equal(await prisma.arenaEvaluation.count({ where: { submissionId: 'empty-a' } }), 1)
  assert.equal(await prisma.userScore.count(), 0)
})

test('AC-07/08: real persisted 6/8=75%, ninth opponent re-evaluates to 6/9; recompute does not recurse', async () => {
  const s = await scene('dynamic')
  const wins = Array.from({ length: 6 }, (_, i) => `dynamic-d${i}`)
  for (let i = 0; i < 8; i += 1) {
    await s.submit(`dynamic-d${i}`, `u${i + 1}`, 'defense')
    await s.process(`dynamic-d${i}`)
  }
  await s.submit('dynamic-a', 'u0', 'attack', { wins })
  await s.process('dynamic-a')
  const first = await s.score('u0', 'attack')
  assert.equal(first!.score, 75)
  assert.equal(first!.successCount, 6)
  assert.equal(first!.opponentCount, 8)
  await s.submit('dynamic-d8', 'u9', 'defense')
  await s.process('dynamic-d8')
  const second = await s.score('u0', 'attack')
  assert.equal(second!.score, 66.66666667)
  assert.equal(second!.successCount, 6)
  assert.equal(second!.opponentCount, 9)
  assert.notEqual(second!.snapshotId, first!.snapshotId)
  const count = await prisma.arenaEvaluation.count({ where: { scenarioId: 'dynamic' } })
  await settle()
  assert.equal(await prisma.arenaEvaluation.count({ where: { scenarioId: 'dynamic' } }), count)
  assert.equal(
    (
      await prisma.arenaPool.findUniqueOrThrow({
        where: { scenarioId_evaluationVersion: { scenarioId: 'dynamic', evaluationVersion: 'v1' } },
      })
    ).revision,
    10,
  )
})

test('AC-09/10: normal all-loss zero replaces old version; below-baseline and infrastructure errors preserve it', async () => {
  const s = await scene('replace')
  await s.submit('replace-d', 'u1', 'defense')
  await s.process('replace-d')
  await s.submit('replace-a1', 'u0', 'attack', { success: true })
  await s.process('replace-a1')
  await s.submit('replace-a2', 'u0', 'attack', { success: false })
  await s.process('replace-a2')
  const zero = await s.score('u0', 'attack')
  assert.equal(zero!.score, 0)
  assert.equal(zero!.activeSubmissionId, 'replace-a2')
  assert.equal(zero!.counted, true)
  await s.submit('replace-a3', 'u0', 'attack', { qualification: 0.79 })
  await s.process('replace-a3')
  assert.equal((await s.score('u0', 'attack'))!.activeSubmissionId, 'replace-a2')
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'replace-a3' } })).score, null)
  await s.submit('replace-a4', 'u0', 'attack', { fail: 'opponent' })
  await s.process('replace-a4')
  const preserved = await s.score('u0', 'attack')
  assert.equal(preserved!.activeSubmissionId, 'replace-a2')
  assert.equal(preserved!.scoreReachedAt, zero!.scoreReachedAt)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'replace-a4' } })).score, null)
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'replace', role: 'attack' } }), 1)
})

test('AC-09: same user opposite role is excluded, repeated opposite submissions replace one denominator entry', async () => {
  const s = await scene('dedupe')
  await s.submit('dedupe-own-d', 'u0', 'defense')
  await s.process('dedupe-own-d')
  await s.submit('dedupe-a', 'u0', 'attack')
  await s.process('dedupe-a')
  assert.equal((await s.score('u0', 'attack'))!.opponentCount, 0)
  await s.submit('dedupe-peer-v1', 'u1', 'defense')
  await s.process('dedupe-peer-v1')
  await s.submit('dedupe-peer-v2', 'u1', 'defense')
  await s.process('dedupe-peer-v2')
  assert.equal((await s.score('u0', 'attack'))!.opponentCount, 1)
  const active = await prisma.arenaSlot.findMany({ where: { scenarioId: 'dedupe', role: 'defense' } })
  assert.equal(active.length, 2)
  assert.equal((await queries.arenaQuestionLeaderboard('dedupe-defense'))!.length, 2)
})

test('late earlier candidate cannot replace a newer admitted submission', async () => {
  const s = await scene('ordering')
  await s.submit('ordering-old', 'u0', 'attack', {}, new Date('2026-10-14T01:00:00Z'))
  await s.submit('ordering-new', 'u0', 'attack', {}, new Date('2026-10-14T02:00:00Z'))
  await s.process('ordering-new')
  await s.process('ordering-old')
  assert.equal((await s.score('u0', 'attack'))!.activeSubmissionId, 'ordering-new')
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'ordering-old' } })).status, 'stale')
})

test('version change during baseline prevents admission and hides prior-version rankings', async () => {
  const s = await scene('versions')
  await s.submit('versions-old', 'u0', 'attack')
  await s.process('versions-old')
  await s.submit('versions-late', 'u1', 'attack')
  arena.configureArenaRuntime({
    run: async (input) => {
      if (input.submissionId === 'versions-late' && input.phase === 'baseline')
        await prisma.question.update({ where: { id: 'versions-attack' }, data: { revision: 2 } })
      return fixtureRunner(input)
    },
  })
  await s.process('versions-late')
  assert.equal((await s.score('u1', 'attack'))!.score, null)
  assert.equal((await s.score('u0', 'attack'))!.score, null)
  assert.deepEqual(await queries.arenaQuestionLeaderboard('versions-attack'), [])
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'versions', userId: 'u1' } }), 0)
  assert.equal(
    (await prisma.submission.findUniqueOrThrow({ where: { id: 'versions-late' } })).status,
    'stale',
  )
})

test('same score recompute preserves reached time and rank; active question invalidation enqueues opposite updates', async () => {
  const s = await scene('invalidate')
  await s.submit('invalidate-a', 'u0', 'attack')
  await s.process('invalidate-a')
  const original = await s.score('u0', 'attack')
  await s.submit('invalidate-d', 'u1', 'defense')
  await s.process('invalidate-d')
  assert.equal((await s.score('u0', 'attack'))!.scoreReachedAt, original!.scoreReachedAt)
  await prisma.question.update({ where: { id: 'invalidate-defense' }, data: { status: 'draft' } })
  await arena.invalidateArenaQuestion('invalidate-defense')
  await settle()
  assert.equal((await s.score('u0', 'attack'))!.opponentCount, 0)
  assert.equal((await s.score('u0', 'attack'))!.score, 100)
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'invalidate', role: 'defense' } }), 0)
})

test('opponent-pool mutation during candidate evaluation retries a fresh complete snapshot', async () => {
  const s = await scene('snapshot-race')
  await s.submit('snapshot-race-d1', 'u1', 'defense')
  await s.process('snapshot-race-d1')
  await s.submit('snapshot-race-a', 'u0', 'attack', { wins: ['snapshot-race-d1'] })
  let added = false
  arena.configureArenaRuntime({
    run: async (input) => {
      if (!added && input.submissionId === 'snapshot-race-a' && input.phase === 'opponent') {
        added = true
        await s.submit('snapshot-race-d2', 'u2', 'defense')
        await arena.processArenaSubmission('snapshot-race-d2')
        assert.equal((await s.score('u0', 'attack'))!.score, null)
      }
      return fixtureRunner(input)
    },
  })
  await s.process('snapshot-race-a')
  const score = await s.score('u0', 'attack')
  assert.equal(score!.opponentCount, 2)
  assert.equal(score!.score, 50)
  const task = await prisma.arenaEvaluation.findUniqueOrThrow({ where: { id: 'snapshot-race-a:candidate' } })
  assert.equal(task.status, 'completed')
  assert.equal(task.attempts, 2)
  assert.equal(JSON.parse(task.opponentsSnapshot!).length, 2)
})

test('concurrent duplicate candidate processing runs one baseline and admits one version', async () => {
  const s = await scene('duplicate-race')
  await s.submit('duplicate-race-a', 'u0', 'attack')
  let baselineCalls = 0
  arena.configureArenaRuntime({
    run: async (input) => {
      if (input.phase === 'baseline') {
        baselineCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return fixtureRunner(input)
    },
  })
  await Promise.all([
    arena.processArenaSubmission('duplicate-race-a'),
    arena.processArenaSubmission('duplicate-race-a'),
  ])
  await settle()
  assert.equal(baselineCalls, 1)
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'duplicate-race' } }), 1)
  assert.equal(await prisma.arenaEvaluation.count({ where: { submissionId: 'duplicate-race-a' } }), 1)
})

test('recovery reclaims stopped attempts but leaves current running leases untouched', async () => {
  const s = await scene('recover')
  for (const [id, age] of [
    ['recover-abandoned', new Date(0)],
    ['recover-live', new Date()],
  ] as const) {
    const submission = await s.submit(id, id === 'recover-live' ? 'u1' : 'u0', 'attack')
    const algorithm = await prisma.arenaAlgorithm.create({
      data: {
        submissionId: id,
        userId: submission.userId,
        questionId: submission.questionId,
        scenarioId: 'recover',
        role: 'attack',
        evaluationVersion: 'v1',
      },
    })
    await prisma.arenaEvaluation.create({
      data: {
        id: `${id}:candidate`,
        submissionId: id,
        algorithmId: algorithm.id,
        scenarioId: 'recover',
        role: 'attack',
        evaluationVersion: 'v1',
        kind: 'candidate',
        status: 'running',
        attempts: 1,
        updatedAt: age,
      },
    })
  }
  await arena.recoverArenaTasks()
  assert.equal(
    (await prisma.arenaEvaluation.findUniqueOrThrow({ where: { id: 'recover-abandoned:candidate' } })).status,
    'completed',
  )
  assert.equal(
    (await prisma.arenaEvaluation.findUniqueOrThrow({ where: { id: 'recover-live:candidate' } })).status,
    'running',
  )
  assert.equal((await s.score('u0', 'attack'))!.score, 100)
  await prisma.arenaEvaluation.update({ where: { id: 'recover-live:candidate' }, data: { status: 'stale' } })
})

test('publication cleanup only invalidates outdated algorithms, never a newly admitted revision', async () => {
  const s = await scene('cleanup-race')
  await s.submit('cleanup-race-old', 'u0', 'attack')
  await s.process('cleanup-race-old')
  await prisma.question.update({ where: { id: 'cleanup-race-attack' }, data: { revision: 2 } })
  const submission = await s.submit('cleanup-race-new', 'u0', 'attack')
  const snapshot = JSON.parse(submission.configSnapshot)
  snapshot.questionVersion = 2
  await prisma.submission.update({
    where: { id: submission.id },
    data: { questionVersion: 2, configSnapshot: JSON.stringify(snapshot) },
  })
  await s.process(submission.id)
  await arena.invalidateArenaQuestion('cleanup-race-attack')
  await settle()
  assert.equal((await s.score('u0', 'attack'))!.activeSubmissionId, 'cleanup-race-new')
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'cleanup-race' } }), 1)
})

test('deleted users leave the opponent denominator and trigger a complete new score', async () => {
  const s = await scene('deleted-user')
  await prisma.user.create({
    data: { id: 'delete-me', username: 'deleteme', displayName: '删除测试', password: 'unused' },
  })
  await s.submit('deleted-user-d', 'delete-me', 'defense')
  await s.process('deleted-user-d')
  await s.submit('deleted-user-a', 'u0', 'attack', { success: false })
  await s.process('deleted-user-a')
  assert.equal((await s.score('u0', 'attack'))!.score, 0)
  const { adminDeleteUser } = await import('../src/lib/auth.js')
  await adminDeleteUser('delete-me')
  await settle()
  const current = await s.score('u0', 'attack')
  assert.equal(current!.opponentCount, 0)
  assert.equal(current!.score, 100)
  assert.equal(await prisma.arenaSlot.count({ where: { userId: 'delete-me' } }), 0)
})

test('every baseline and peer execution gets a fresh attempt-scoped model gateway token', async () => {
  const s = await scene('gateway-attempt')
  await s.submit('gateway-attempt-d1', 'u1', 'defense')
  await s.process('gateway-attempt-d1')
  await s.submit('gateway-attempt-d2', 'u2', 'defense')
  await s.process('gateway-attempt-d2')
  let counter = 0
  const tokens: string[] = []
  arena.configureArenaRuntime({
    modelGateway: async (_snapshot, submissionId) => ({
      url: `http://gateway/${submissionId}`,
      token: `fixture-token-${counter++}`,
    }),
    run: async (input) => {
      if (input.submissionId === 'gateway-attempt-a') tokens.push(input.modelGateway!.token)
      return fixtureRunner(input)
    },
  })
  await s.submit('gateway-attempt-a', 'u0', 'attack')
  await s.process('gateway-attempt-a')
  assert.equal(tokens.length, 3)
  assert.equal(new Set(tokens).size, 3)
})

test('failed background recomputation retries finitely, preserves old score, and supports audited admin retry', async () => {
  const s = await scene('recompute-retry')
  await s.submit('recompute-retry-a', 'u0', 'attack', { success: false })
  await s.process('recompute-retry-a')
  arena.configureArenaRuntime({
    run: async (input) =>
      input.submissionId === 'recompute-retry-a' && input.phase === 'opponent'
        ? { status: 'system_error', cleanupStatus: 'cleaned' }
        : fixtureRunner(input),
  })
  await s.submit('recompute-retry-d', 'u1', 'defense')
  await s.process('recompute-retry-d')
  const failed = await prisma.arenaEvaluation.findFirstOrThrow({
    where: { submissionId: 'recompute-retry-a', kind: 'recompute' },
    orderBy: { createdAt: 'desc' },
  })
  assert.equal(failed.status, 'error')
  assert.equal(failed.attempts, 3)
  assert.equal((await s.score('u0', 'attack'))!.score, 100)
  assert.equal((await s.score('u0', 'attack'))!.status, 'update_error')
  arena.configureArenaRuntime({ run: fixtureRunner })
  await arena.retryArenaRecomputation(failed.id, 'u10')
  await settle()
  assert.equal((await s.score('u0', 'attack'))!.score, 0)
  assert.equal((await s.score('u0', 'attack'))!.updating, false)
  assert.equal(
    await prisma.auditEvent.count({ where: { action: 'arena.recompute.retry', targetId: failed.id } }),
    1,
  )
})

test('deleting a candidate account during evaluation prevents late admission', async () => {
  const s = await scene('deleted-candidate')
  await prisma.user.create({
    data: {
      id: 'delete-candidate',
      username: 'deletecandidate',
      displayName: 'candidate',
      password: 'unused',
    },
  })
  await s.submit('deleted-candidate-a', 'delete-candidate', 'attack')
  arena.configureArenaRuntime({
    run: async (input) => {
      if (input.phase === 'baseline') await prisma.user.delete({ where: { id: 'delete-candidate' } })
      return fixtureRunner(input)
    },
  })
  await s.process('deleted-candidate-a')
  assert.equal(await prisma.arenaSlot.count({ where: { userId: 'delete-candidate' } }), 0)
  assert.equal(
    (await prisma.submission.findUniqueOrThrow({ where: { id: 'deleted-candidate-a' } })).status,
    'stale',
  )
})

test('published successMetric and threshold control scores, including equality, despite contradictory legacy boolean', async () => {
  const s = await scene('metric-authority')
  await s.submit('metric-authority-d', 'u1', 'defense')
  await s.process('metric-authority-d')
  await s.submit('metric-authority-a', 'u0', 'attack')
  const row = await prisma.submission.findUniqueOrThrow({ where: { id: 'metric-authority-a' } })
  const snapshot = JSON.parse(row.configSnapshot)
  snapshot.definition.evaluation.successMetric = 'configuredMetric'
  snapshot.definition.evaluation.successThreshold = 0.75
  await prisma.submission.update({
    where: { id: row.id },
    data: { configSnapshot: JSON.stringify(snapshot) },
  })
  arena.configureArenaRuntime({
    run: async (input) =>
      input.submissionId === row.id && input.phase === 'opponent'
        ? completed({ success: false, metrics: { configuredMetric: 0.75, successMetric: 0 } })
        : fixtureRunner(input),
  })
  await s.process(row.id)
  assert.equal((await s.score('u0', 'attack'))!.score, 100)
  const task = await prisma.arenaEvaluation.findUniqueOrThrow({ where: { id: `${row.id}:candidate` } })
  const audit = JSON.parse(task.result!)
  assert.equal(audit.pairs[0].metrics.configuredMetric, 0.75)
  assert.equal(audit.pairs[0].reportedSuccess, false)
  assert.equal(audit.pairs[0].success, true)
})
