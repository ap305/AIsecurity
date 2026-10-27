import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './database.js'
import type { ComposeEvaluationInput } from '../src/services/composeJudge.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let arena: typeof import('../src/services/arenaScoring.js')
let queries: typeof import('../src/services/arenaQueries.js')
let boards: typeof import('../src/services/leaderboard.js')
let basic: typeof import('../src/services/basicScores.js')
let adminScores: typeof import('../src/services/adminStudentScores.js')
const calls: ComposeEvaluationInput[] = []

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  arena = await import('../src/services/arenaScoring.js')
  queries = await import('../src/services/arenaQueries.js')
  boards = await import('../src/services/leaderboard.js')
  basic = await import('../src/services/basicScores.js')
  adminScores = await import('../src/services/adminStudentScores.js')
  for (const id of ['regularA', 'regularD', 'testA', 'testD']) {
    await prisma.user.create({
      data: { id, username: id, displayName: id, password: 'unused', isTestAccount: id.startsWith('test') },
    })
  }
  arena.configureArenaRuntime({
    modelGateway: async () => undefined,
    run: async (input) => {
      calls.push(input)
      return input.phase === 'baseline'
        ? { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 1 } }
        : { status: 'completed', cleanupStatus: 'cleaned', success: true, metrics: { successMetric: 1 } }
    },
  })
})

after(async () => {
  await arena?.drainArenaRecomputations()
  await prisma?.$disconnect()
  await database?.close()
})

async function settle() {
  await arena.drainArenaRecomputations()
  assert.equal(await prisma.arenaEvaluation.count({ where: { status: { in: ['queued', 'running'] } } }), 0)
}

async function question(id: string, role?: 'attack' | 'defense') {
  const definition = {
    evaluation: {
      packageId: 'fixture',
      baselineMetric: 'qualificationMetric',
      baselineThreshold: 0.5,
      successMetric: 'successMetric',
      successThreshold: 0.5,
      repetitions: 1,
    },
  }
  return prisma.question.create({
    data: {
      id,
      moduleCode: 'ISO',
      number: 1,
      title: id,
      content: 'fixture',
      type: 'code',
      difficulty: 'L1',
      category: role ? 'adversarial' : 'basic',
      role,
      scenarioId: role ? 'isolation' : undefined,
      definition: JSON.stringify(definition),
    },
  })
}

async function submit(id: string, userId: string, q: Awaited<ReturnType<typeof question>>) {
  return prisma.submission.create({
    data: {
      id,
      userId,
      questionId: q.id,
      code: 'fixture',
      status: 'queued',
      category: q.category,
      role: q.role,
      scenarioId: q.scenarioId,
      evaluationVersion: q.evaluationVersion,
      configSnapshot: JSON.stringify({
        questionId: q.id,
        questionVersion: q.revision,
        category: q.category,
        role: q.role,
        scenarioId: q.scenarioId,
        evaluationVersion: q.evaluationVersion,
        definition: JSON.parse(q.definition),
      }),
    },
  })
}

test('test basic scores remain visible individually without changing formal rank, limits, module ranks or student totals', async () => {
  const q = await question('iso-basic')
  await submit('normal-basic', 'regularA', q)
  await basic.recordBasicResult('normal-basic', 70, {})
  const before = await boards.getLeaderboard()
  const rankBefore = await boards.getMyRank('regularA')
  await submit('test-basic', 'testA', q)
  await basic.recordBasicResult('test-basic', 100, {})
  assert.deepEqual(await boards.getLeaderboard(), before)
  assert.deepEqual(
    (await boards.getLeaderboard(1)).map((r) => r.userId),
    ['regularA'],
  )
  assert.deepEqual(await boards.getMyRank('regularA'), rankBefore)
  assert.equal(await boards.getMyRank('testA'), null)
  assert.deepEqual(
    (await boards.getModuleLeaderboard('ISO', 1)).map((r) => r.userId),
    ['regularA'],
  )
  assert.equal((await boards.getUserStats('testA')).totalScore, 100)
  const summary = await adminScores.listAdminStudentScores({})
  assert.equal(summary.total, 2)
  assert.ok(summary.students.every((s) => !s.userId.startsWith('test')))
  const detail = await adminScores.getAdminStudentScores('testA')
  assert.equal(detail.questions.find((row) => row.questionId === q.id)?.score, 100)
})

test('test adversarial candidates see formal opponents but never become opponents, advance formal pool or enqueue peer recomputations', async () => {
  const attack = await question('iso-attack', 'attack')
  const defense = await question('iso-defense', 'defense')
  await submit('formal-defense', 'regularD', defense)
  await arena.processArenaSubmission('formal-defense')
  await settle()
  const regularScoreBefore = await queries.arenaQuestionScore(defense.id, 'regularD')
  const poolBefore = await prisma.arenaPool.findMany()
  const jobsBefore = await prisma.arenaEvaluation.findMany({ where: { submissionId: 'formal-defense' } })
  await submit('test-attack', 'testA', attack)
  await arena.processArenaSubmission('test-attack')
  await settle()
  assert.equal((await queries.arenaQuestionScore(attack.id, 'testA'))?.score, 100)
  assert.deepEqual(await prisma.arenaPool.findMany(), poolBefore)
  assert.deepEqual(await queries.arenaQuestionScore(defense.id, 'regularD'), regularScoreBefore)
  assert.deepEqual(
    await prisma.arenaEvaluation.findMany({ where: { submissionId: 'formal-defense' } }),
    jobsBefore,
  )
  assert.equal(calls.filter((c) => c.submissionId === 'test-attack' && c.phase === 'opponent').length, 1)
  assert.deepEqual(await queries.arenaQuestionLeaderboard(attack.id, 1), [])
  await submit('formal-attack', 'regularA', attack)
  await arena.processArenaSubmission('formal-attack')
  await settle()
  await submit('test-defense', 'testD', defense)
  const beforeTestDefense = await prisma.arenaScore.findMany({
    where: { userId: { in: ['regularA', 'regularD'] } },
    orderBy: { id: 'asc' },
  })
  await arena.processArenaSubmission('test-defense')
  await settle()
  assert.deepEqual(
    await prisma.arenaScore.findMany({
      where: { userId: { in: ['regularA', 'regularD'] } },
      orderBy: { id: 'asc' },
    }),
    beforeTestDefense,
  )
  assert.equal((await queries.arenaQuestionScore(defense.id, 'regularD'))?.opponentCount, 1)
  assert.deepEqual(
    (await queries.arenaQuestionLeaderboard(defense.id, 1))!.map((r) => r.userId),
    ['regularD'],
  )
  assert.ok(
    calls
      .filter((c) => c.phase === 'opponent' && !c.submissionId.startsWith('test-'))
      .every((c) => !c.opponent?.submissionId.startsWith('test-')),
  )
})

test('archiving a question with only test algorithms removes their slots without changing the formal pool or peer grades', async () => {
  const a = await question('test-only-attack', 'attack')
  const d = await question('test-only-defense', 'defense')
  const attack = await prisma.question.update({ where: { id: a.id }, data: { scenarioId: 'test-only' } })
  const defense = await prisma.question.update({ where: { id: d.id }, data: { scenarioId: 'test-only' } })
  await submit('only-formal-defense', 'regularD', defense)
  await arena.processArenaSubmission('only-formal-defense')
  await settle()
  await submit('only-test-attack', 'testA', attack)
  await arena.processArenaSubmission('only-test-attack')
  await settle()
  const before = {
    pool: await prisma.arenaPool.findUnique({
      where: { scenarioId_evaluationVersion: { scenarioId: 'test-only', evaluationVersion: 'v1' } },
    }),
    score: await queries.arenaQuestionScore(defense.id, 'regularD'),
    tasks: await prisma.arenaEvaluation.findMany({ where: { submissionId: 'only-formal-defense' } }),
  }
  await prisma.question.update({ where: { id: attack.id }, data: { status: 'archived' } })
  await arena.invalidateArenaQuestion(attack.id)
  await settle()
  assert.equal(await prisma.arenaSlot.count({ where: { scenarioId: 'test-only', role: 'attack' } }), 0)
  assert.deepEqual(
    await prisma.arenaPool.findUnique({
      where: { scenarioId_evaluationVersion: { scenarioId: 'test-only', evaluationVersion: 'v1' } },
    }),
    before.pool,
  )
  assert.deepEqual(await queries.arenaQuestionScore(defense.id, 'regularD'), before.score)
  assert.deepEqual(
    await prisma.arenaEvaluation.findMany({ where: { submissionId: 'only-formal-defense' } }),
    before.tasks,
  )
})
