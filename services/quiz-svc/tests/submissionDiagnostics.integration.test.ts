import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, base: string, ownerToken: string, otherToken: string, adminToken: string
let sequence = 0
const config = {
  packageId: 'private-package',
  baselineMetric: 'qualificationMetric',
  baselineThreshold: 0.5,
  successMetric: 'successMetric',
  successThreshold: 0.5,
  maxScore: 100,
  baselineCode: 'PRIVATE_REFERENCE_SOURCE',
  baselineModelFilePath: '/private/reference.pth',
}
async function request(route: string, token = ownerToken) {
  const response = await fetch(`${base}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return { status: response.status, body: (await response.json()) as any }
}
async function fixture(id: string, options: { category?: string; version?: number; status?: string } = {}) {
  const category = options.category ?? 'adversarial'
  const question = await prisma.question.create({
    data: {
      id,
      moduleCode: 'M4',
      number: ++sequence,
      title: id,
      content: '公开教学题面',
      type: 'C',
      difficulty: 'L1',
      category,
      revision: options.version ?? 1,
      status: options.status ?? 'published',
      role: category === 'adversarial' ? 'attack' : null,
      scenarioId: category === 'adversarial' ? id : null,
      evaluationVersion: 'frozen-v1',
      definition: JSON.stringify({ evaluation: config }),
    },
  })
  async function submit(suffix: string, overrides: Record<string, unknown> = {}) {
    return prisma.submission.create({
      data: {
        id: `${id}-${suffix}`,
        questionId: id,
        userId: 'diagnostic-owner',
        code: 'OWN_CODE',
        questionVersion: question.revision,
        category,
        role: question.role,
        scenarioId: question.scenarioId,
        evaluationVersion: question.evaluationVersion,
        status: 'queued',
        createdAt: new Date(1700000000000 + ++sequence * 1000),
        configSnapshot: JSON.stringify({
          questionId: id,
          questionVersion: question.revision,
          category,
          role: question.role,
          scenarioId: question.scenarioId,
          evaluationVersion: question.evaluationVersion,
          definition: { evaluation: config },
          modelBinding: { token: 'PRIVATE_GATEWAY_TOKEN' },
        }),
        ...overrides,
      },
    })
  }
  return { question, submit }
}
async function evidence(
  submission: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['submit']>>,
  values: number[],
  baselineValue = 0.5,
) {
  const algorithm = await prisma.arenaAlgorithm.create({
    data: {
      id: `${submission.id}-algorithm`,
      submissionId: submission.id,
      userId: submission.userId,
      questionId: submission.questionId,
      scenarioId: submission.scenarioId!,
      role: submission.role!,
      evaluationVersion: submission.evaluationVersion,
      status: 'active',
      baselineResult: JSON.stringify({
        qualified: baselineValue >= 0.5,
        metrics: {
          qualificationMetric: baselineValue,
          hiddenLabel: 1234567,
          internalPath: '/private/hidden-data',
        },
        secret: 'PRIVATE_BASELINE_DATA',
      }),
    },
  })
  const successCount = values.filter((value) => value >= 0.5).length
  const score = values.length ? Number(((100 * successCount) / values.length).toFixed(8)) : 100
  const id = `${submission.id}-published`
  const summary = {
    qualified: true,
    counted: true,
    score,
    successCount,
    opponentCount: values.length,
    emptyPool: values.length === 0,
    snapshotId: id,
  }
  const task = await prisma.arenaEvaluation.create({
    data: {
      id,
      submissionId: submission.id,
      algorithmId: algorithm.id,
      scenarioId: submission.scenarioId!,
      role: submission.role!,
      evaluationVersion: submission.evaluationVersion,
      kind: 'candidate',
      status: 'completed',
      snapshotRevision: 3,
      opponentsSnapshot: JSON.stringify(
        values.map((_, index) => ({
          algorithmId: `PRIVATE_OPPONENT_${index}`,
          submissionId: `PRIVATE_SUBMISSION_${index}`,
          questionVersion: 1,
        })),
      ),
      result: JSON.stringify({
        ...summary,
        rawLog: 'PRIVATE_GRADER_LOG',
        pairs: values.map((value, index) => ({
          opponentId: `PRIVATE_OPPONENT_${index}`,
          status: 'completed',
          success: value >= 0.5,
          metrics: { successMetric: value, hiddenLabel: 999999 },
          code: 'PRIVATE_OPPONENT_SOURCE',
        })),
      }),
      createdAt: new Date(1700100000000 + ++sequence * 1000),
    },
  })
  await prisma.submission.update({
    where: { id: submission.id },
    data: { status: 'completed', score, result: JSON.stringify(summary) },
  })
  return { algorithm, task, summary, score }
}

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  for (const [id, role] of [
    ['diagnostic-owner', 'student'],
    ['diagnostic-other', 'student'],
    ['diagnostic-admin', 'admin'],
  ]) {
    await prisma.user.create({
      data: { id, username: id, displayName: id, role, password: hashPassword('test-only-password') },
    })
  }
  ownerToken = (await loginUser('diagnostic-owner', 'test-only-password', 'student')).token
  otherToken = (await loginUser('diagnostic-other', 'test-only-password', 'student')).token
  adminToken = (await loginUser('diagnostic-admin', 'test-only-password', 'admin')).token
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
})

test('owner/admin diagnostics use frozen inclusive thresholds and anonymize opponents; other users cannot retrieve them', async () => {
  const f = await fixture('inclusive')
  const submission = await f.submit('answer')
  await evidence(submission, [0.5, 0.49])
  await prisma.question.update({
    where: { id: f.question.id },
    data: {
      revision: 2,
      definition: JSON.stringify({
        evaluation: { ...config, baselineThreshold: 0.9, successThreshold: 0.9 },
      }),
    },
  })
  const response = await request(`/submissions/${submission.id}`)
  assert.equal(response.status, 200)
  const d = response.body.data.diagnostics
  assert.deepEqual(d.baseline, {
    metric: 'qualificationMetric',
    value: 0.5,
    threshold: 0.5,
    comparator: '>=',
    passed: true,
  })
  assert.equal(d.historicalVersion, true)
  assert.equal(d.evaluation.counted, true)
  assert.equal(d.evaluation.successCount, 1)
  assert.equal(d.evaluation.opponentCount, 2)
  assert.deepEqual(
    d.evaluation.pairs.map((pair: any) => [pair.ordinal, pair.success, pair.value]),
    [
      [1, true, 0.5],
      [2, false, 0.49],
    ],
  )
  assert.doesNotMatch(
    JSON.stringify(d),
    /PRIVATE_|private|opponentId|submissionId|algorithmId|hiddenLabel|rawLog|code|token|filePath/,
  )
  assert.equal((await request(`/submissions/${submission.id}`, otherToken)).status, 404)
  assert.equal((await request(`/submissions/${submission.id}`, '')).status, 401)
  assert.equal((await request('/submissions/not-found')).status, 404)
  assert.deepEqual((await request(`/submissions/${submission.id}`, adminToken)).body.data.diagnostics, d)
  assert.deepEqual((await request(`/questions/${f.question.id}/submissions`)).body.data[0].diagnostics, d)
  assert.equal((await request(`/questions/${f.question.id}/submissions`, otherToken)).body.data.length, 0)
})

test('normal defeat remains zero while an empty completed pool is explicitly 100 percent', async () => {
  for (const [id, values, score] of [
    ['defeat', [0], 0],
    ['empty-pool', [], 100],
  ] as const) {
    const f = await fixture(id)
    const submission = await f.submit('answer')
    await evidence(submission, [...values])
    const record = (await request(`/submissions/${submission.id}`)).body.data
    assert.equal(record.score, score)
    assert.equal(record.diagnostics.evaluation.counted, true)
    assert.equal(record.diagnostics.evaluation.emptyPool, values.length === 0)
    assert.equal(record.diagnostics.evaluation.opponentCount, values.length)
  }
})

test('failed baseline, malformed legacy snapshots and foreign snapshot references do not manufacture evidence', async () => {
  const f = await fixture('no-evidence')
  const failed = await f.submit('failed')
  const proof = await evidence(failed, [0], 0.49)
  await prisma.submission.update({
    where: { id: failed.id },
    data: { status: 'baseline_failed', score: null, result: '{"qualified":false,"counted":false}' },
  })
  await prisma.arenaEvaluation.update({
    where: { id: proof.task.id },
    data: { status: 'failed', opponentsSnapshot: null, result: '{"qualified":false,"counted":false}' },
  })
  const d = (await request(`/submissions/${failed.id}`)).body.data.diagnostics
  assert.equal(d.baseline.passed, false)
  assert.equal(d.evaluation, null)
  const legacy = await f.submit('legacy', { configSnapshot: '{}' })
  assert.equal((await request(`/submissions/${legacy.id}`)).body.data.diagnostics, null)
  const mismatched = await f.submit('mismatch', {
    configSnapshot: JSON.stringify({
      questionId: 'different',
      questionVersion: 1,
      category: 'adversarial',
      evaluationVersion: 'frozen-v1',
      definition: { evaluation: config },
    }),
  })
  assert.equal((await request(`/submissions/${mismatched.id}`)).body.data.diagnostics, null)
  const other = await fixture('foreign')
  const otherSubmission = await other.submit('answer')
  const foreign = await evidence(otherSubmission, [1])
  await prisma.submission.update({
    where: { id: failed.id },
    data: { result: JSON.stringify({ ...foreign.summary }) },
  })
  assert.equal((await request(`/submissions/${failed.id}`)).body.data.diagnostics.evaluation, null)
})

test('partial/error recomputation is separate from the complete previously counted round', async () => {
  const f = await fixture('recompute')
  const submission = await f.submit('answer')
  const proof = await evidence(submission, [1, 0])
  await prisma.arenaEvaluation.create({
    data: {
      id: 'new-round',
      submissionId: submission.id,
      algorithmId: proof.algorithm.id,
      scenarioId: submission.scenarioId!,
      role: submission.role!,
      evaluationVersion: submission.evaluationVersion,
      kind: 'recompute',
      status: 'error',
      snapshotRevision: 4,
      opponentsSnapshot: JSON.stringify([
        { algorithmId: 'NEW_PRIVATE_A' },
        { algorithmId: 'NEW_PRIVATE_B' },
        { algorithmId: 'NEW_PRIVATE_C' },
      ]),
      result: JSON.stringify({
        pairs: [
          { opponentId: 'NEW_PRIVATE_A', status: 'completed', success: false, metrics: { successMetric: 0 } },
        ],
      }),
      error: '/private/failed SECRET_ERROR',
      createdAt: new Date(1700200000000),
    },
  })
  const d = (await request(`/submissions/${submission.id}`)).body.data.diagnostics
  assert.equal(d.evaluation.counted, true)
  assert.equal(d.evaluation.snapshotRevision, 3)
  assert.equal(d.evaluation.opponentCount, 2)
  assert.deepEqual(d.progress, { state: 'error', completedOpponents: 1, totalOpponents: 3 })
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE|SECRET_ERROR|\/private/)
})

test('partial candidates and invalid or duplicate opponent proof cannot appear as a completed score', async () => {
  const f = await fixture('partial')
  const submission = await f.submit('answer')
  const proof = await evidence(submission, [1, 0])
  await prisma.submission.update({
    where: { id: submission.id },
    data: { status: 'opponents', score: null, result: null },
  })
  await prisma.arenaEvaluation.update({
    where: { id: proof.task.id },
    data: {
      status: 'running',
      result: JSON.stringify({
        pairs: [
          {
            opponentId: 'PRIVATE_OPPONENT_0',
            status: 'completed',
            success: true,
            metrics: { successMetric: 1 },
          },
        ],
      }),
    },
  })
  let d = (await request(`/submissions/${submission.id}`)).body.data.diagnostics
  assert.equal(d.evaluation.counted, false)
  assert.equal(d.evaluation.successCount, null)
  assert.deepEqual(d.progress, { state: 'running', completedOpponents: 1, totalOpponents: 2 })
  const pair = {
    opponentId: 'PRIVATE_OPPONENT_0',
    status: 'completed',
    success: true,
    metrics: { successMetric: 1 },
  }
  await prisma.arenaEvaluation.update({
    where: { id: proof.task.id },
    data: { result: JSON.stringify({ pairs: [pair, pair] }) },
  })
  d = (await request(`/submissions/${submission.id}`)).body.data.diagnostics
  assert.equal(d.evaluation, null)
  assert.equal(d.progress.completedOpponents, 0)
})

test('basic diagnostics expose only known numeric aggregate metrics, never raw evaluator details', async () => {
  const f = await fixture('basic-metrics', { category: 'basic' })
  const submission = await f.submit('answer', {
    status: 'completed',
    score: 50,
    result: JSON.stringify({
      metrics: {
        correct: 1,
        total: 2,
        accuracy: 0.5,
        ratio: 'not-a-number',
        hiddenTestInput: 12345,
        expectedAnswer: 777,
      },
      rawLog: 'PRIVATE_LOG',
    }),
  })
  const d = (await request(`/submissions/${submission.id}`)).body.data.diagnostics
  assert.equal(d.phase, 'basic')
  assert.deepEqual(d.metrics, { correct: 1, total: 2, accuracy: 0.5 })
  assert.equal(d.baseline, null)
  assert.equal(d.evaluation, null)
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE|hiddenTest|expectedAnswer/)
})

test('hall distinguishes no attempt, current attempts, historical attempts and a valid zero, preserving the best score', async () => {
  const fresh = await fixture('hall-fresh', { category: 'basic' })
  const old = await fixture('hall-old', { category: 'basic', version: 2 })
  await old.submit('old', { questionVersion: 1, status: 'completed', score: 90 })
  await prisma.basicScore.create({
    data: {
      userId: 'diagnostic-owner',
      questionId: old.question.id,
      questionVersion: 1,
      submissionId: 'hall-old-old',
      score: 90,
    },
  })
  const best = await fixture('hall-best', { category: 'basic' })
  const good = await best.submit('good', { status: 'completed', score: 70 })
  await best.submit('new-error', { status: 'error', score: null })
  await prisma.basicScore.create({
    data: {
      userId: 'diagnostic-owner',
      questionId: best.question.id,
      questionVersion: 1,
      submissionId: good.id,
      score: 70,
    },
  })
  const zero = await fixture('hall-zero', { category: 'basic' })
  await zero.submit('zero', { status: 'completed', score: 0 })
  const pending = await fixture('hall-pending', { category: 'basic', status: 'pending' })
  const rows = (await request('/questions?category=basic')).body.data
  const byId = new Map<string, any>(rows.map((row: any) => [row.id, row]))
  assert.equal(byId.get(fresh.question.id).attempted, false)
  assert.equal(byId.get(fresh.question.id).latestSubmissionStatus, null)
  assert.equal(byId.get(fresh.question.id).myStatus, 'not_submitted')
  assert.equal(byId.get(old.question.id).attempted, false)
  assert.equal(byId.get(old.question.id).hasHistoricalAttempts, true)
  assert.equal(byId.get(old.question.id).myScore, null)
  assert.equal(byId.get(best.question.id).attempted, true)
  assert.equal(byId.get(best.question.id).latestSubmissionStatus, 'error')
  assert.equal(byId.get(best.question.id).myScore, 70)
  assert.deepEqual(byId.get(best.question.id).tags, ['LLM 安全'])
  assert.equal(byId.get(zero.question.id).myScore, 0)
  assert.equal(byId.has(pending.question.id), false)
  assert.equal((await request(`/questions/${pending.question.id}`)).status, 404)
  const otherRows = (await request('/questions?category=basic', otherToken)).body.data
  assert.equal(
    otherRows.every((row: any) => !row.attempted && row.myScore === null),
    true,
  )
})

test('hall adversarial score follows the active algorithm rather than a newer failed submission or basic ledger', async () => {
  const f = await fixture('hall-arena')
  const submission = await f.submit('good')
  const proof = await evidence(submission, [1, 0])
  await prisma.arenaSlot.create({
    data: {
      userId: submission.userId,
      scenarioId: submission.scenarioId!,
      role: submission.role!,
      evaluationVersion: submission.evaluationVersion,
      algorithmId: proof.algorithm.id,
    },
  })
  await prisma.arenaScore.create({
    data: {
      algorithmId: proof.algorithm.id,
      userId: submission.userId,
      questionId: submission.questionId,
      scenarioId: submission.scenarioId!,
      role: submission.role!,
      evaluationVersion: submission.evaluationVersion,
      score: proof.score,
      successCount: 1,
      opponentCount: 2,
      snapshotId: proof.task.id,
      snapshotRevision: 3,
      achievedAt: new Date(),
    },
  })
  await f.submit('failed', { status: 'baseline_failed', result: '{"qualified":false,"counted":false}' })
  await prisma.basicScore.create({
    data: {
      userId: submission.userId,
      questionId: submission.questionId,
      questionVersion: 1,
      submissionId: submission.id,
      score: 99,
    },
  })
  const row = (await request('/questions?category=adversarial')).body.data.find(
    (item: any) => item.id === f.question.id,
  )
  assert.equal(row.attempted, true)
  assert.equal(row.latestSubmissionStatus, 'baseline_failed')
  assert.equal(row.myScore, 50)
  assert.equal(row.dynamicScore.counted, true)
})
