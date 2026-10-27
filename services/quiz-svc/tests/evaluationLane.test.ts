import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './database.js'

const version = 'v3-261012-d02-original300-v12'
const oldVersion = 'v3-261012-response-snapshot4-v11'
const originalLane = process.env.EVALUATION_WORKER_LANE
const frozen = {
  questionId: 'V3-261012-D02', questionVersion: 3, category: 'adversarial', role: 'defense',
  scenarioId: 'V3-261012-02', evaluationVersion: version,
  definition: { evaluation: {
    version, number: '02', role: 'defense', samples: 300, packageId: 'fixture', maxScore: 100,
    baselineMetric: 'qualificationMetric', baselineThreshold: 0.8, successMetric: 'successMetric', successThreshold: 0.5,
    parameters: { arenaPoolVersion: oldVersion },
  } },
}
const heavy = { ...frozen, configSnapshot: JSON.stringify(frozen) }

test('worker lanes accept only the exact restored D02 submission and reject unknown lane configuration', async () => {
  const lane = await import('../src/services/evaluationLane.js').catch(() => null)
  assert(lane, 'worker lane isolation is missing')
  assert.equal(lane.submissionEvaluationLane(heavy), 'd02-original300')
  for (const changed of [
    { questionId: 'V3-261012-A02' }, { scenarioId: 'other' }, { role: 'attack' },
    { evaluationVersion: oldVersion }, { category: 'basic' }, { configSnapshot: '{}' },
    { configSnapshot: JSON.stringify({ ...frozen, definition: { evaluation: { ...frozen.definition.evaluation, samples: 20 } } }) },
  ]) assert.equal(lane.submissionEvaluationLane({ ...heavy, ...changed }), 'ordinary')
  assert.equal(lane.evaluationWorkerLane(), 'ordinary')
  process.env.EVALUATION_WORKER_LANE = 'unknown'
  assert.throws(() => lane.evaluationWorkerLane(), /lane/)
  process.env.EVALUATION_WORKER_LANE = 'ordinary'
})

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let worker: typeof import('../src/services/evaluationWorker.js')
let arena: typeof import('../src/services/arenaScoring.js')
before(async () => {
  process.env.EVALUATION_WORKER_LANE = 'ordinary'
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  worker = await import('../src/services/evaluationWorker.js')
  arena = await import('../src/services/arenaScoring.js')
})
after(async () => {
  await arena?.drainArenaRecomputations()
  await prisma?.$disconnect()
  await database?.close()
  if (originalLane === undefined) delete process.env.EVALUATION_WORKER_LANE
  else process.env.EVALUATION_WORKER_LANE = originalLane
})

test('ordinary dispatch skips heavy claims and queue heads, and neither lane recovers the other lane leases', async () => {
  await prisma.user.create({ data: { id: 'lane-student', username: 'lane-student', displayName: 'fixture', password: 'unused' } })
  await prisma.question.create({ data: {
    id: frozen.questionId, moduleCode: 'T', number: 2, title: 'D02', content: 'fixture', type: 'code', difficulty: 'L1',
    status: 'published', revision: 3, category: frozen.category, role: frozen.role, scenarioId: frozen.scenarioId,
    evaluationVersion: version, definition: JSON.stringify(frozen.definition),
  } })
  await prisma.question.create({ data: {
    id: 'lane-basic', moduleCode: 'T', number: 1, title: 'basic', content: 'fixture', type: 'code', difficulty: 'L1',
    status: 'published', category: 'basic', evaluationVersion: 'v1',
  } })
  async function basic(id: string) {
    const s = { questionId: 'lane-basic', questionVersion: 1, category: 'basic', evaluationVersion: 'v1',
      definition: { evaluation: { packageId: 'fixture', maxScore: 100 } } }
    await prisma.submission.create({ data: { id, userId: 'lane-student', code: 'fixture', status: 'queued',
      ...s, definition: undefined, configSnapshot: JSON.stringify(s) } as any })
    return prisma.evaluationTask.create({ data: { id: id + '-task', submissionId: id } })
  }
  await prisma.submission.create({ data: {
    id: 'heavy-submission', userId: 'lane-student', questionId: frozen.questionId, questionVersion: 3, category: 'adversarial',
    role: 'defense', scenarioId: frozen.scenarioId, evaluationVersion: version, code: 'fixture', status: 'queued', configSnapshot: JSON.stringify(frozen),
  } })
  const heavyTask = await prisma.evaluationTask.create({ data: { id: 'heavy-task', submissionId: 'heavy-submission' } })
  let release: () => void = () => {}
  let began: () => void = () => {}
  const started = new Promise<void>(resolve => { began = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let blockHeavy = false
  arena.configureArenaRuntime({ modelGateway: () => undefined, run: async () => {
    if (blockHeavy) { began(); await blocked }
    return { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 1 } }
  } })
  worker.configureEvaluationRuntime({ run: async () => ({ status: 'completed', cleanupStatus: 'cleaned', score: 100, maxScore: 100 }) })
  await worker.processEvaluationTask(heavyTask.id)
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: heavyTask.id } })).attempts, 0)
  const backlog = Array.from({ length: 101 }, (_, n) => 'heavy-backlog-' + n)
  await prisma.submission.createMany({ data: backlog.map(id => ({
    id, userId: 'lane-student', questionId: frozen.questionId, questionVersion: 3, category: 'adversarial',
    role: 'defense', scenarioId: frozen.scenarioId, evaluationVersion: version, code: 'fixture',
    status: 'queued', configSnapshot: JSON.stringify(frozen),
  })) })
  await prisma.evaluationTask.createMany({ data: backlog.map(submissionId => ({
    id: submissionId + '-task', submissionId, createdAt: new Date(0),
  })) })
  const first = await basic('ordinary-after-heavy')
  await worker.drainEvaluationQueue()
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: first.id } })).state, 'completed')
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: heavyTask.id } })).state, 'queued')
  assert.equal(await prisma.evaluationTask.count({ where: { submissionId: { in: backlog }, state: 'queued', attempts: 0 } }), 101)
  await prisma.evaluationTask.updateMany({ where: { submissionId: { in: backlog } }, data: { state: 'error' } })

  process.env.EVALUATION_WORKER_LANE = 'd02-original300'
  blockHeavy = true
  const processing = worker.processEvaluationTask(heavyTask.id)
  await started
  await prisma.evaluationTask.update({ where: { id: heavyTask.id }, data: { lockedAt: new Date(0) } })
  const heavyArena = await prisma.arenaEvaluation.findFirstOrThrow({ where: { submissionId: 'heavy-submission' } })
  await prisma.arenaEvaluation.update({ where: { id: heavyArena.id }, data: { updatedAt: new Date(0) } })
  process.env.EVALUATION_WORKER_LANE = 'ordinary'
  const second = await basic('ordinary-during-heavy')
  await worker.drainEvaluationQueue()
  await arena.recoverArenaTasks()
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: second.id } })).state, 'completed')
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: heavyTask.id } })).state, 'running')
  assert.equal((await prisma.arenaEvaluation.findUniqueOrThrow({ where: { id: heavyArena.id } })).status, 'running')
  process.env.EVALUATION_WORKER_LANE = 'd02-original300'
  release()
  await processing
  const stale = await basic('ordinary-stale')
  await prisma.evaluationTask.update({ where: { id: stale.id }, data: { state: 'running', attempts: 1, lockedAt: new Date(0) } })
  await worker.drainEvaluationQueue()
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: stale.id } })).state, 'running')
  process.env.EVALUATION_WORKER_LANE = 'ordinary'
  await worker.drainEvaluationQueue()
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: stale.id } })).state, 'completed')
})

test('a stopping heavy worker waits for its current attempt and leaves its next accepted submission queued', async () => {
  process.env.EVALUATION_WORKER_LANE = 'd02-original300'
  for (const id of ['heavy-shutdown-current', 'heavy-shutdown-next']) {
    await prisma.submission.create({ data: {
      id, userId: 'lane-student', questionId: frozen.questionId, questionVersion: 3, category: 'adversarial',
      role: 'defense', scenarioId: frozen.scenarioId, evaluationVersion: version, code: 'fixture',
      status: 'queued', configSnapshot: JSON.stringify(frozen),
    } })
    await prisma.evaluationTask.create({ data: { id: id + '-task', submissionId: id } })
  }
  let release: () => void = () => {}, began: () => void = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { began = resolve })
  arena.configureArenaRuntime({ modelGateway: () => undefined, run: async () => {
    began(); await blocked
    return { status: 'completed', cleanupStatus: 'cleaned', metrics: { qualificationMetric: 1 } }
  } })
  const dispatch = worker.drainEvaluationQueue()
  await started
  worker.stopEvaluationWorker()
  let finished = false
  const idle = worker.waitForEvaluationWorkerIdle().then(() => { finished = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(finished, false)
    assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: 'heavy-shutdown-current-task' } })).state, 'running')
    assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: 'heavy-shutdown-next-task' } })).attempts, 0)
  } finally { release(); await Promise.all([dispatch, idle]) }
  assert.equal(finished, true)
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: 'heavy-shutdown-current-task' } })).state, 'completed')
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: 'heavy-shutdown-next-task' } })).state, 'queued')
})
