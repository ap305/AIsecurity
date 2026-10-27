import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as rules from '../src/services/arenaRules.js'
import { createTestDatabase } from './database.js'
import type { ComposeEvaluationInput } from '../src/services/composeJudge.js'

const oldVersion = 'v3-261012-response-snapshot4-v11'
const newVersion = 'v3-261012-d02-original300-v12'
const scenarioId = 'V3-261012-02'
const originalLane = process.env.EVALUATION_WORKER_LANE
const identity = {
  questionId: 'V3-261012-D02', scenarioId, role: 'defense', evaluationVersion: newVersion,
  definition: { evaluation: { version: newVersion, parameters: { samples: 300, arenaPoolVersion: oldVersion } } },
}

test('only the original-300 D02 contract may join the existing 02 opponent pool', () => {
  const key = (rules as any).arenaPoolKey
  assert.equal(typeof key, 'function', 'the explicit, restricted pool-version mapping is missing')
  assert.deepEqual(key(identity), { scenarioId, evaluationVersion: oldVersion })
  assert.deepEqual(key({ ...identity, definition: JSON.stringify(identity.definition) }), key(identity))
  assert.deepEqual(key({ ...identity, definition: {} }), { scenarioId, evaluationVersion: newVersion })
  for (const invalid of [
    { ...identity, questionId: 'V3-261012-A02' },
    { ...identity, questionId: 'V3-261012-D09' },
    { ...identity, scenarioId: 'another-scene' },
    { ...identity, role: 'attack' },
    { ...identity, evaluationVersion: oldVersion },
    { ...identity, definition: { evaluation: { version: newVersion, parameters: { samples: 20, arenaPoolVersion: oldVersion } } } },
    { ...identity, definition: { evaluation: { version: oldVersion, parameters: { samples: 300, arenaPoolVersion: oldVersion } } } },
    { ...identity, definition: { evaluation: { version: newVersion, parameters: { samples: 300, arenaPoolVersion: 'arbitrary' } } } },
    { ...identity, definition: { evaluation: { version: newVersion, parameters: { samples: 300, arenaPoolVersion: null } } } },
  ]) assert.throws(() => key(invalid), /对手池/)
  for (const role of ['A', 'D']) for (let number = 1; number <= 31; number++) {
    const unchanged = { ...identity, questionId: `V3-261012-${role}${String(number).padStart(2, '0')}`,
      evaluationVersion: oldVersion, definition: { evaluation: { parameters: { samples: 20 } } } }
    assert.deepEqual(key(unchanged), { scenarioId, evaluationVersion: oldVersion })
  }
})

test('the actual candidate top-level frozen fields override older nested fields', () => {
  const key = rules.arenaPoolKey
  const actual = { ...identity, definition: { evaluation: {
    version: newVersion, number: '02', role: 'defense', samples: 300,
    parameters: { responseSnapshotPolicy: 'first-valid-response-v1', responseSnapshotScope: identity.questionId, arenaPoolVersion: oldVersion },
  } } }
  assert.deepEqual(key(actual), { scenarioId, evaluationVersion: oldVersion })
  assert.deepEqual(key({ ...actual, definition: { evaluation: {
    ...actual.definition.evaluation, parameters: { ...actual.definition.evaluation.parameters, samples: 20 },
  } } }), key(actual))
  assert.throws(() => key({ ...actual, definition: { evaluation: {
    ...actual.definition.evaluation, samples: 20,
    parameters: { ...actual.definition.evaluation.parameters, samples: 300 },
  } } }), /对手池/)
  assert.throws(() => key({ ...actual, definition: { evaluation: {
    ...actual.definition.evaluation, arenaPoolVersion: 'arbitrary',
  } } }), /对手池/)
})

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let arena: typeof import('../src/services/arenaScoring.js')
let queries: typeof import('../src/services/arenaQueries.js')
const calls: ComposeEvaluationInput[] = []

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  arena = await import('../src/services/arenaScoring.js')
  queries = await import('../src/services/arenaQueries.js')
})
after(async () => {
  await arena?.drainArenaRecomputations()
  await prisma?.$disconnect()
  await database?.close()
  if (originalLane === undefined) delete process.env.EVALUATION_WORKER_LANE
  else process.env.EVALUATION_WORKER_LANE = originalLane
})

async function settle() {
  const previousLane = process.env.EVALUATION_WORKER_LANE
  try {
    for (let n = 0; n < 10; n++) {
      for (const lane of ['ordinary', 'd02-original300']) {
        process.env.EVALUATION_WORKER_LANE = lane
        await arena.drainArenaRecomputations()
      }
      if (await prisma.arenaEvaluation.count({ where: { status: { in: ['queued', 'running'] } } }) === 0) return
    }
  } finally {
    if (previousLane === undefined) delete process.env.EVALUATION_WORKER_LANE
    else process.env.EVALUATION_WORKER_LANE = previousLane
  }
  throw Error('fixture arena did not settle')
}

test('new D02 and old A02 pair in both directions without relabelling evaluation evidence or historical submissions', async () => {
  await prisma.user.createMany({ data: ['attacker', 'defender', 'tester'].map(id => ({
    id, username: id, displayName: id, password: 'unused', isTestAccount: id === 'tester',
  })) })
  for (const role of ['attack', 'defense'] as const) {
    const questionId = role === 'attack' ? 'V3-261012-A02' : identity.questionId
    const evaluationVersion = role === 'attack' ? oldVersion : newVersion
    const definition = { evaluation: {
      version: evaluationVersion, packageId: 'fixture-' + role, baselineMetric: 'qualificationMetric', baselineThreshold: 0.8,
      successMetric: 'successMetric', successThreshold: 0.5,
      number: '02', role, samples: role === 'defense' ? 300 : 20,
      parameters: role === 'defense' ? { arenaPoolVersion: oldVersion } : {},
    } }
    const revision = role === 'attack' ? 2 : 3
    await prisma.question.create({ data: {
      id: questionId, moduleCode: 'T', number: 2, title: role, content: 'fixture', type: 'code', difficulty: 'L1', category: 'adversarial', status: 'published',
      scenarioId, role, revision, evaluationVersion, definition: JSON.stringify(definition),
    } })
    await prisma.questionRevision.create({ data: { questionId, revision, snapshot: JSON.stringify({
      questionId, questionVersion: revision, category: 'adversarial', role, scenarioId, evaluationVersion, definition,
    }) } })
  }
  for (let n = 0; n < 5; n++) await prisma.submission.create({ data: {
    id: 'historical-' + n, userId: 'defender', questionId: identity.questionId, category: 'adversarial', role: 'defense',
    scenarioId, questionVersion: 2, evaluationVersion: oldVersion, code: 'old source',
    configSnapshot: '{"historical":"unchanged"}', status: n < 3 ? 'baseline_failed' : 'failed', result: '{"counted":false}',
  } })
  const historical = await prisma.submission.findMany({ where: { id: { startsWith: 'historical-' } }, orderBy: { id: 'asc' } })
  arena.configureArenaRuntime({ modelGateway: async () => undefined, run: async input => {
    calls.push(input)
    return input.phase === 'baseline'
      ? { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 1 } }
      : { status: 'completed', cleanupStatus: 'cleaned', success: false, metrics: { successMetric: 0 } }
  } })
  async function submit(id: string, userId: string, role: 'attack' | 'defense') {
    const q = await prisma.question.findUniqueOrThrow({ where: { id: role === 'attack' ? 'V3-261012-A02' : identity.questionId } })
    await prisma.submission.create({ data: {
      id, userId, questionId: q.id, questionVersion: q.revision, category: 'adversarial', role, scenarioId,
      evaluationVersion: q.evaluationVersion, code: 'fixture', status: 'queued', configSnapshot: JSON.stringify({
        questionId: q.id, questionVersion: q.revision, category: 'adversarial', role, scenarioId,
        evaluationVersion: q.evaluationVersion, definition: JSON.parse(q.definition),
      }),
    } })
    const previousLane = process.env.EVALUATION_WORKER_LANE
    process.env.EVALUATION_WORKER_LANE = role === 'defense' ? 'd02-original300' : 'ordinary'
    try { await arena.processArenaSubmission(id) }
    finally {
      if (previousLane === undefined) delete process.env.EVALUATION_WORKER_LANE
      else process.env.EVALUATION_WORKER_LANE = previousLane
    }
    await settle()
  }
  await submit('old-attack', 'attacker', 'attack')
  const beforeDefense = await queries.arenaQuestionScore('V3-261012-A02', 'attacker')
  assert.equal(beforeDefense?.score, 100)
  await submit('new-defense', 'defender', 'defense')
  assert.equal((await queries.arenaQuestionScore(identity.questionId, 'defender'))?.opponentCount, 1)
  assert.equal((await queries.arenaQuestionScore(identity.questionId, 'defender'))?.score, 0)
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.opponentCount, 1)
  assert(calls.some(c => c.submissionId === 'new-defense' && c.opponent?.submissionId === 'old-attack' && c.evaluationVersion === newVersion))
  assert(calls.some(c => c.submissionId === 'old-attack' && c.opponent?.submissionId === 'new-defense' && c.evaluationVersion === oldVersion))
  assert(calls.filter(c => c.submissionId === 'new-defense').every(c => c.parameters?.samples === 300))
  for (const table of [prisma.arenaAlgorithm, prisma.arenaEvaluation, prisma.arenaScore]) {
    const records = await (table as any).findMany({ where: { role: 'defense' } })
    assert(records.length > 0)
    assert(records.every((r: any) => r.evaluationVersion === newVersion))
  }
  assert.equal(await prisma.arenaPool.count({ where: { scenarioId, evaluationVersion: newVersion } }), 0)
  assert((await prisma.arenaSlot.findMany({ where: { scenarioId } })).every(s => s.evaluationVersion === oldVersion))
  assert.equal((await queries.arenaQuestionLeaderboard(identity.questionId))?.[0].userId, 'defender')
  const admin = await import('../src/services/adminStudentScores.js')
  assert.equal((await admin.getAdminStudentScores('defender')).questions.find(q => q.questionId === identity.questionId)?.score, 0)
  const diagnostics = await import('../src/services/submissionDiagnostics.js')
  const current = await prisma.submission.findUniqueOrThrow({ where: { id: 'new-defense' } })
  assert.equal((await diagnostics.submissionDiagnostics([current])).get(current.id)?.evaluation?.opponentCount, 1)

  const formalPoolBefore = await prisma.arenaPool.findFirstOrThrow({ where: { scenarioId } })
  const formalAttackBefore = await prisma.arenaScore.findFirstOrThrow({ where: { questionId: 'V3-261012-A02' } })
  await submit('test-defense', 'tester', 'defense')
  assert.deepEqual(await prisma.arenaPool.findFirstOrThrow({ where: { scenarioId } }), formalPoolBefore)
  assert.deepEqual(await prisma.arenaScore.findFirstOrThrow({ where: { questionId: 'V3-261012-A02' } }), formalAttackBefore)
  assert.equal((await queries.arenaQuestionScore(identity.questionId, 'tester'))?.opponentCount, 1)
  assert.equal((await queries.arenaQuestionLeaderboard(identity.questionId))?.length, 1)

  await prisma.question.update({ where: { id: identity.questionId }, data: { status: 'draft' } })
  await arena.invalidateArenaQuestion(identity.questionId)
  await settle()
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.opponentCount, 0)
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.score, 100)
  assert.equal((await prisma.arenaPool.findFirstOrThrow({ where: { scenarioId } })).revision, formalPoolBefore.revision + 1)
  await prisma.question.update({ where: { id: identity.questionId }, data: { status: 'published' } })
  await submit('new-defense-again', 'defender', 'defense')
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.opponentCount, 1)
  await prisma.$transaction(tx => arena.invalidateArenaUserTx(tx, 'defender'))
  await settle()
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.opponentCount, 0)
  assert.equal((await queries.arenaQuestionScore('V3-261012-A02', 'attacker'))?.score, 100)
  assert.equal(await prisma.arenaPool.count({ where: { scenarioId, evaluationVersion: newVersion } }), 0)
  assert.deepEqual(await prisma.submission.findMany({ where: { id: { startsWith: 'historical-' } }, orderBy: { id: 'asc' } }), historical)
})
