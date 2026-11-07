import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: Server
let base: string, adminToken: string, studentToken: string
const route = '/admin/questions/target/evaluation-runs'
const newest = new Date('2026-10-10T00:00:00.000Z')
const oldest = new Date('2026-09-01T00:00:00.000Z')

async function request(path = route, token = adminToken) {
  const response = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const body = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text()
  return { status: response.status, body, cacheControl: response.headers.get('cache-control') }
}

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  const password = 'test-only-password'
  for (const [id, role, isTestAccount] of [
    ['run-admin', 'admin', false],
    ['run-student', 'student', false],
    ['run-test', 'student', true],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        displayName: `Display ${id}`,
        role,
        isTestAccount,
        password: hashPassword(password),
      },
    })
  }
  adminToken = (await loginUser('run-admin', password, 'admin')).token
  studentToken = (await loginUser('run-student', password, 'student')).token

  const question = {
    moduleCode: 'M4',
    number: 1,
    content: 'PRIVATE_QUESTION_BODY',
    type: 'C',
    difficulty: 'L1',
    category: 'adversarial',
    definition: '{"model":"PRIVATE_MODEL_CONFIG"}',
  }
  await prisma.question.createMany({
    data: [
      { ...question, id: 'target', title: '指定题目', revision: 3, status: 'archived' },
      { ...question, id: 'unrelated', title: '其他题目', number: 2 },
      { ...question, id: 'empty', title: '空题目', number: 3 },
    ],
  })
  const submission = {
    questionId: 'target',
    userId: 'run-student',
    questionVersion: 3,
    evaluationVersion: 'v3',
    status: 'completed',
    createdAt: newest,
    updatedAt: newest,
    code: 'PRIVATE_STUDENT_CODE',
    filePath: '/private/model.pth',
    configSnapshot: '{"token":"PRIVATE_GATEWAY_TOKEN"}',
  }
  await prisma.submission.createMany({
    data: [
      {
        ...submission,
        id: 'current-z',
        score: 0,
        result: JSON.stringify({
          qualified: true,
          counted: true,
          successCount: 0,
          opponentCount: 3,
          publicMessage: '本次完整对抗评测已完成',
          rawLog: 'PRIVATE_GRADER_LOG',
        }),
      },
      {
        ...submission,
        id: 'current-a',
        userId: 'run-test',
        status: 'failed',
        score: null,
        result: JSON.stringify({
          evaluationStatus: 'student_error',
          failedPhase: 'baseline',
          publicMessage: '防御检索接口不符合题目要求',
          counted: false,
          successCount: '0',
        }),
      },
      {
        ...submission,
        id: 'old-without-user',
        userId: 'removed-account',
        questionVersion: 1,
        evaluationVersion: 'v1',
        createdAt: oldest,
        score: 71,
        result: JSON.stringify({
          publicMessage: 'PRIVATE_MESSAGE /private/path.py',
          evaluationStatus: 'PRIVATE_STATUS',
          failedPhase: 'PRIVATE_PHASE',
          qualified: { value: true },
          successCount: -1,
          opponentCount: 1.5,
        }),
      },
      {
        ...submission,
        id: 'old-malformed-json',
        questionVersion: 2,
        evaluationVersion: 'v2',
        createdAt: oldest,
        result: '{malformed PRIVATE_RESULT',
      },
      { ...submission, id: 'other-question-run', questionId: 'unrelated', createdAt: new Date('2026-11-01') },
    ],
  })
  await prisma.evaluationTask.create({
    data: {
      submissionId: 'current-z',
      state: 'completed',
      attempts: 2,
      cleanupStatus: 'cleaned',
      updatedAt: newest,
      error: 'PRIVATE_TASK_ERROR',
    },
  })
  const arenaRun = {
    algorithmId: 'PRIVATE_ALGORITHM_ID',
    scenarioId: 'PRIVATE_SCENARIO',
    role: 'attack',
    evaluationVersion: 'v3',
    kind: 'recompute',
    status: 'completed',
    attempts: 1,
    snapshotRevision: 3,
    createdAt: newest,
    updatedAt: newest,
    opponentsSnapshot: '{"code":"PRIVATE_OPPONENT"}',
    result: '{"secret":"PRIVATE_ARENA_RESULT"}',
    error: 'PRIVATE_ARENA_ERROR',
  }
  await prisma.arenaEvaluation.createMany({
    data: [
      ...Array.from({ length: 12 }, (_, index) => ({
        ...arenaRun,
        id: `arena-${String(index + 1).padStart(2, '0')}`,
        submissionId: 'current-z',
        ...(index === 11
          ? {
              result: JSON.stringify({
                score: 0,
                qualified: true,
                counted: true,
                successCount: 0,
                opponentCount: 3,
                evaluationStatus: 'completed',
                failedPhase: 'PRIVATE_PHASE',
                publicMessage: 'PRIVATE_ARENA_MESSAGE',
                pairs: ['PRIVATE_OPPONENT'],
                rawLog: 'PRIVATE_ARENA_LOG',
              }),
            }
          : {}),
        ...(index === 10
          ? { result: '{"evaluationStatus":"timeout","failedPhase":"opponent","counted":false}' }
          : {}),
      })),
      { ...arenaRun, id: 'arena-other-question', submissionId: 'other-question-run' },
    ],
  })

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

test('the question evaluation history requires an administrator and returns 404 for a missing question', async () => {
  assert.equal((await request(route, '')).status, 401)
  assert.equal((await request(route, studentToken)).status, 403)
  const missing = await request('/admin/questions/missing/evaluation-runs')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.data, null)
})

test('paginates one question across revisions with deterministic order, counts and nullable users', async () => {
  const first = await request(`${route}?page=1&pageSize=2`)
  assert.equal(first.status, 200)
  assert.equal(first.cacheControl, 'private, no-store')
  assert.equal(first.body.code, 0)
  const { question, page, pageSize, total, rows } = first.body.data
  assert.deepEqual(
    { question, page, pageSize, total },
    {
      question: { id: 'target', title: '指定题目', revision: 3 },
      page: 1,
      pageSize: 2,
      total: 4,
    },
  )
  assert.deepEqual(
    rows.map((row: any) => [row.id, row.username, row.displayName, row.isTestAccount, row.score]),
    [
      ['current-z', 'run-student', 'Display run-student', false, 0],
      ['current-a', 'run-test', 'Display run-test', true, null],
    ],
  )
  const second = await request(`${route}?page=2&pageSize=2`)
  assert.equal(second.status, 200)
  assert.deepEqual(
    second.body.data.rows.map((row: any) => [row.id, row.questionVersion, row.evaluationVersion]),
    [
      ['old-without-user', 1, 'v1'],
      ['old-malformed-json', 2, 'v2'],
    ],
  )
  assert.deepEqual(second.body.data.rows[0], {
    id: 'old-without-user',
    userId: 'removed-account',
    username: null,
    displayName: null,
    isTestAccount: null,
    questionVersion: 1,
    evaluationVersion: 'v1',
    status: 'completed',
    score: 71,
    createdAt: oldest.toISOString(),
    updatedAt: newest.toISOString(),
    task: null,
    arenaRuns: [],
    arenaRunCount: 0,
    result: null,
  })
  assert.equal(second.body.data.rows[1].result, null)
  assert.equal(second.body.data.total, 4)
  assert.deepEqual((await request(`${route}?page=3&pageSize=2`)).body.data.rows, [])
  assert.deepEqual((await request('/admin/questions/empty/evaluation-runs')).body.data, {
    question: { id: 'empty', title: '空题目', revision: 1 },
    page: 1,
    pageSize: 20,
    total: 0,
    rows: [],
  })
})

test('validates pagination and caps the page size', async () => {
  for (const query of ['page=0', 'page=1.5', 'page=1&page=2', 'pageSize=-2', 'page=9007199254740992']) {
    const response = await request(`${route}?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(response.body.code, 40001)
  }
  const response = await request(`${route}?pageSize=500`)
  assert.equal(response.status, 200)
  assert.equal(response.body.data.pageSize, 50)
})

test('returns only safe typed results and the ten latest arena runs, retaining the actual count', async () => {
  const response = await request()
  assert.equal(response.status, 200)
  const [run, failure] = response.body.data.rows
  assert.deepEqual(run.task, {
    state: 'completed',
    attempts: 2,
    cleanupStatus: 'cleaned',
    updatedAt: newest.toISOString(),
  })
  assert.equal(failure.task, null)
  assert.deepEqual(run.result, {
    publicMessage: '本次完整对抗评测已完成',
    qualified: true,
    counted: true,
    successCount: 0,
    opponentCount: 3,
  })
  assert.equal(failure.result.evaluationStatus, 'student_error')
  assert.equal(failure.result.failedPhase, 'baseline')
  assert.equal(failure.result.counted, false)
  assert.match(failure.result.publicMessage, /guard_retrieval/)
  assert.equal(failure.result.successCount, undefined)
  assert.equal(run.arenaRunCount, 12)
  assert.deepEqual(
    run.arenaRuns.map((row: any) => row.id),
    Array.from({ length: 10 }, (_, index) => `arena-${String(12 - index).padStart(2, '0')}`),
  )
  assert.deepEqual(run.arenaRuns[0], {
    id: 'arena-12',
    kind: 'recompute',
    status: 'completed',
    attempts: 1,
    snapshotRevision: 3,
    createdAt: newest.toISOString(),
    updatedAt: newest.toISOString(),
    result: {
      score: 0,
      qualified: true,
      counted: true,
      successCount: 0,
      opponentCount: 3,
      evaluationStatus: 'completed',
    },
  })
  assert.deepEqual(run.arenaRuns[1].result, {
    evaluationStatus: 'timeout',
    failedPhase: 'opponent',
    counted: false,
  })
  assert.equal(run.arenaRuns[2].result, null)
  assert.doesNotMatch(JSON.stringify(response.body.data), /PRIVATE_|\/private\/|other-question-run/)
})
