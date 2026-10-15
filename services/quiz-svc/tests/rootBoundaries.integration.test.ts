import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let worker: typeof import('../src/services/evaluationWorker.js')
let scores: typeof import('../src/services/basicScores.js')
let migrations: typeof import('../src/services/prdMigration.js')
let pools: typeof import('../src/services/apiPool.js')
let leases: typeof import('../src/services/teacherLeases.js')
let server: http.Server,
  upstream: http.Server,
  base: string,
  upstreamUrl: string,
  token: string,
  adminToken: string
let healthHook: (() => Promise<void>) | undefined

const definition = {
  kind: 'algorithm',
  weights: { enabled: true, required: true, extensions: ['.json'], maxBytes: 1000 },
  teacherApi: { enabled: true, poolId: 'teacher', maxCalls: 3 },
  llm: { enabled: false },
  evaluation: {
    packageId: 'fixture-package',
    version: 'v1',
    timeoutMs: 10000,
    maxScore: 100,
    baselineMetric: 'qualificationMetric',
    baselineThreshold: 0.5,
    successMetric: 'successMetric',
    successThreshold: 0.5,
    repetitions: 1,
  },
}

async function request(url: string, body?: unknown, auth = token) {
  const response = await fetch(`${base}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  })
  return { status: response.status, json: (await response.json()) as any }
}

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  worker = await import('../src/services/evaluationWorker.js')
  scores = await import('../src/services/basicScores.js')
  migrations = await import('../src/services/prdMigration.js')
  pools = await import('../src/services/apiPool.js')
  leases = await import('../src/services/teacherLeases.js')
  upstream = http
    .createServer(async (_req, res) => {
      if (healthHook) {
        const hook = healthHook
        healthHook = undefined
        await hook()
      }
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
    })
    .listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => upstream.once('listening', resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const auth = await import('../src/lib/auth.js')
  for (const role of ['student', 'admin'])
    await prisma.user.create({
      data: {
        id: role,
        username: `fixture${role}`,
        displayName: role,
        password: auth.hashPassword('fixture-password'),
        role,
      },
    })
  token = (
    await request(
      '/auth/login',
      { username: 'fixturestudent', password: 'fixture-password', role: 'student' },
      '',
    )
  ).json.data.token
  adminToken = (
    await request(
      '/auth/login',
      { username: 'fixtureadmin', password: 'fixture-password', role: 'admin' },
      '',
    )
  ).json.data.token
  await prisma.question.create({
    data: {
      id: 'weights',
      moduleCode: 'T',
      number: 1,
      title: '参数题',
      content: '题面',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      definition: JSON.stringify(definition),
    },
  })
  await prisma.questionRevision.create({
    data: {
      questionId: 'weights',
      revision: 1,
      snapshot: JSON.stringify({
        questionId: 'weights',
        questionVersion: 1,
        category: 'basic',
        role: null,
        scenarioId: null,
        evaluationVersion: 'v1',
        definition,
        teacherBinding: {
          poolId: 'teacher',
          revision: 1,
          name: 'teacher',
          kind: 'teacher',
          model: 'teacher',
          modelVersion: 'v1',
          baseUrl: upstreamUrl,
          credentialEnv: null,
          parameters: {},
        },
      }),
    },
  })
})

after(async () => {
  worker.stopEvaluationWorker()
  const files = await prisma.submission.findMany({
    where: { questionId: 'weights' },
    select: { filePath: true },
  })
  for (const row of files) if (row.filePath) fs.rmSync(row.filePath, { force: true })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await prisma.$disconnect()
  await database.close()
})

function form(key: string, weights: string, code = 'answer', version = 1) {
  const body = new FormData()
  body.set('questionId', 'weights')
  body.set('questionVersion', String(version))
  body.set('code', code)
  body.set('idempotencyKey', key)
  body.set('file', new Blob([weights]), 'weights.json')
  return body
}

test('idempotency includes model bytes, weight presence and frozen question version', async () => {
  const first = await request('/submissions', form('weights-replay', '{"w":1}'))
  assert.equal(first.status, 200)
  const identical = await request('/submissions', form('weights-replay', '{"w":1}'))
  assert.equal(identical.status, 200)
  assert.equal(identical.json.data.id, first.json.data.id)
  assert.equal((await request('/submissions', form('weights-replay', '{"w":2}'))).status, 409)
  assert.equal((await request('/submissions', form('weights-replay', '{"w":1}', 'answer', 2))).status, 409)
  const missing = form('weights-replay', '{}')
  missing.delete('file')
  assert.equal((await request('/submissions', missing)).status, 409)
  assert.equal(await prisma.submission.count({ where: { idempotencyKey: 'weights-replay' } }), 1)
})

test('concurrent different answers under one key conflict instead of silently returning another answer', async () => {
  const results = await Promise.all([
    request('/submissions', form('weights-concurrent', '{}', 'first')),
    request('/submissions', form('weights-concurrent', '{}', 'second')),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(await prisma.submission.count({ where: { idempotencyKey: 'weights-concurrent' } }), 1)
})

async function workerTask(id: string) {
  const revision = await prisma.questionRevision.findUniqueOrThrow({
    where: { questionId_revision: { questionId: 'weights', revision: 1 } },
  })
  await prisma.submission.create({
    data: {
      id,
      userId: 'student',
      questionId: 'weights',
      code: 'answer',
      configSnapshot: revision.snapshot,
      status: 'queued',
    },
  })
  return prisma.evaluationTask.create({ data: { submissionId: id } })
}

test('old failed attempt cannot erase a newer completed score after lease recovery', async () => {
  const task = await workerTask('epoch-failed')
  let attempts = 0
  worker.configureEvaluationRuntime({
    run: async () => {
      attempts += 1
      if (attempts === 1) {
        await prisma.evaluationTask.update({
          where: { id: task.id },
          data: { state: 'queued', lockedAt: null },
        })
        await worker.processEvaluationTask(task.id)
        return { status: 'system_error', cleanupStatus: 'cleaned' }
      }
      return { status: 'completed', score: 90, cleanupStatus: 'cleaned' }
    },
  })
  await worker.processEvaluationTask(task.id)
  const submission = await prisma.submission.findUniqueOrThrow({ where: { id: 'epoch-failed' } })
  assert.equal(submission.status, 'completed')
  assert.equal(submission.score, 90)
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: task.id } })).state, 'completed')
})

test('old successful attempt cannot overwrite the newer attempt or increase its score', async () => {
  const task = await workerTask('epoch-success')
  let attempts = 0
  worker.configureEvaluationRuntime({
    run: async () => {
      attempts += 1
      if (attempts === 1) {
        await prisma.evaluationTask.update({
          where: { id: task.id },
          data: { state: 'queued', lockedAt: null },
        })
        await worker.processEvaluationTask(task.id)
        return { status: 'completed', score: 100, cleanupStatus: 'cleaned' }
      }
      return { status: 'completed', score: 70, cleanupStatus: 'cleaned' }
    },
  })
  await worker.processEvaluationTask(task.id)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'epoch-success' } })).score, 70)
})

test('infrastructure errors retry at most three times, explicit admin retry resets the cap', async () => {
  const task = await workerTask('retries')
  worker.configureEvaluationRuntime({
    run: async () => ({ status: 'system_error', cleanupStatus: 'cleaned', publicMessage: 'fixture failure' }),
  })
  for (let i = 0; i < 3; i += 1) await worker.processEvaluationTask(task.id)
  const failed = await prisma.evaluationTask.findUniqueOrThrow({ where: { id: task.id } })
  assert.equal(failed.state, 'error')
  assert.equal(failed.attempts, 3)
  assert.equal((await request(`/admin/evaluation-tasks/${task.id}/retry`, {}, adminToken)).status, 200)
  assert.equal((await prisma.evaluationTask.findUniqueOrThrow({ where: { id: task.id } })).attempts, 0)
  worker.configureEvaluationRuntime({
    run: async () => ({ status: 'completed', score: 80, cleanupStatus: 'cleaned' }),
  })
  await worker.processEvaluationTask(task.id)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 'retries' } })).score, 80)
})

test('migration preserves reached timestamps after ordinary row edits and preserves exact zero total times', async () => {
  const reached = new Date('2026-10-01T01:00:00Z')
  const task = await workerTask('migration-best')
  await scores.recordBasicResult(task.submissionId, 95, {}, reached)
  await prisma.evaluationTask.update({ where: { id: task.id }, data: { state: 'completed' } })
  await prisma.submission.update({
    where: { id: task.submissionId },
    data: { result: '{"publicMessage":"ordinary edit"}' },
  })
  const report = await migrations.buildMigrationReport()
  assert.equal(
    report.totals.find((r) => r.userId === 'student')!.scoreReachedAt.toISOString(),
    reached.toISOString(),
  )
  await prisma.basicTotal.create({
    data: { userId: 'admin', totalScore: 0, tasksCompleted: 0, scoreReachedAt: reached },
  })
  assert.equal(
    (await migrations.buildMigrationReport()).totals
      .find((r) => r.userId === 'admin')!
      .scoreReachedAt.toISOString(),
    reached.toISOString(),
  )
  await prisma.evaluationTask.updateMany({ where: { state: 'queued' }, data: { state: 'completed' } })
  await migrations.applyBasicMigration('admin')
  assert.equal(
    (
      await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'student' } })
    ).scoreReachedAt.toISOString(),
    reached.toISOString(),
  )
})

test('API pool concurrent edits assign consecutive immutable revisions', async () => {
  const initial = await pools.savePool(
    null,
    {
      name: 'model',
      kind: 'llm',
      model: 'qwen3-8b',
      modelVersion: 'v1',
      baseUrl: upstreamUrl,
      parameters: { temperature: 0 },
      enabled: true,
    },
    'admin',
  )
  const changes = await Promise.all([
    pools.savePool(initial.id, { name: 'renamed' }, 'admin'),
    pools.savePool(initial.id, { parameters: { temperature: 0.1 } }, 'admin'),
  ])
  assert.deepEqual(changes.map((r) => r.revision).sort(), [2, 3])
  assert.equal(await prisma.apiPoolRevision.count({ where: { poolId: initial.id } }), 3)
  const binding = {
    poolId: initial.id,
    revision: 1,
    name: 'model',
    kind: 'llm',
    model: 'fixed',
    modelVersion: 'v1',
    baseUrl: upstreamUrl,
    credentialEnv: null,
    parameters: { systemPrompt: 'fixed system', tools: [] },
  }
  assert.throws(() =>
    pools.fixedModelPayload(binding, { messages: [{ role: 'system', content: 'override' }] }),
  )
  const payload = pools.fixedModelPayload(binding, {
    messages: [{ role: 'user', content: 'prompt' }],
    model: 'caller',
    tools: ['caller'],
  })
  assert.equal(payload.model, 'fixed')
  assert.deepEqual(payload.tools, [])
})

test('stopped creating teacher leases recover with a new nonce and a full two hours', async () => {
  const snapshot = JSON.parse(
    (
      await prisma.questionRevision.findUniqueOrThrow({
        where: { questionId_revision: { questionId: 'weights', revision: 1 } },
      })
    ).snapshot,
  )
  await prisma.teacherLease.create({
    data: {
      userId: 'student',
      questionId: 'weights',
      questionVersion: 1,
      state: 'creating',
      nonce: 'abandoned',
      poolSnapshot: JSON.stringify(snapshot.teacherBinding),
      maxCalls: 3,
      updatedAt: new Date(0),
    },
  })
  await leases.recoverTeacherLeases()
  const row = await prisma.teacherLease.findUniqueOrThrow({
    where: { userId_questionId: { userId: 'student', questionId: 'weights' } },
  })
  assert.equal(row.state, 'active')
  assert.notEqual(row.nonce, 'abandoned')
  assert.equal(row.expiresAt!.getTime() - row.startsAt!.getTime(), leases.LEASE_MS)
})

test('a teacher readiness response cannot activate a newly unpublished question', async () => {
  await prisma.teacherLease.updateMany({ where: { userId: 'student' }, data: { state: 'error' } })
  healthHook = async () => {
    await prisma.question.update({ where: { id: 'weights' }, data: { status: 'draft' } })
  }
  const row = await leases.startTeacherLease('student', 'weights', false)
  assert.equal(row.state, 'revoked')
  assert.equal(row.token, undefined)
})

test('initial admin bootstrap requires an explicit password while existing admin still starts', async () => {
  const auth = await import('../src/lib/auth.js')
  const priorUser = process.env.ADMIN_USERNAME,
    priorPassword = process.env.ADMIN_PASSWORD
  try {
    delete process.env.ADMIN_PASSWORD
    process.env.ADMIN_USERNAME = 'fixtureadmin'
    await auth.ensureAdminUser()
    process.env.ADMIN_USERNAME = 'newadmin'
    await assert.rejects(auth.ensureAdminUser(), /ADMIN_PASSWORD/)
    assert.equal(await prisma.user.count({ where: { username: 'newadmin' } }), 0)
  } finally {
    if (priorUser === undefined) delete process.env.ADMIN_USERNAME
    else process.env.ADMIN_USERNAME = priorUser
    if (priorPassword === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = priorPassword
  }
})

test('authentication responses retain validation details but never expose database failures', async () => {
  const { authPublicMessage } = await import('../src/routes/auth.js')
  assert.equal(authPublicMessage(new Error('用户名或密码错误'), '服务暂不可用'), '用户名或密码错误')
  const failure = new Error('database unavailable at private-host:1234/internal/path')
  failure.name = 'PrismaClientInitializationError'
  assert.equal(authPublicMessage(failure, '服务暂不可用'), '服务暂不可用')
  assert.equal(authPublicMessage(new Error('unrecognized internal detail'), '服务暂不可用'), '服务暂不可用')
})

test('deleted accounts retain audit scores but never occupy live leaderboard ranks', async () => {
  await prisma.user.create({
    data: { id: 'deleted-ranker', username: 'deletedranker', displayName: 'deleted', password: 'unused' },
  })
  await prisma.basicTotal.create({ data: { userId: 'deleted-ranker', totalScore: 9999, tasksCompleted: 1 } })
  await prisma.basicScore.create({
    data: {
      userId: 'deleted-ranker',
      questionId: 'weights',
      questionVersion: 1,
      submissionId: 'audit-only',
      score: 100,
    },
  })
  const { adminDeleteUser } = await import('../src/lib/auth.js')
  await adminDeleteUser('deleted-ranker')
  const leaderboard = await import('../src/services/leaderboard.js')
  assert.equal(
    (await leaderboard.getLeaderboard()).some((row) => row.userId === 'deleted-ranker'),
    false,
  )
  assert.equal(
    (await leaderboard.getModuleLeaderboard('T')).some((row) => row.userId === 'deleted-ranker'),
    false,
  )
  assert.equal((await leaderboard.getMyRank('student'))!.rank, 1)
  assert.equal(await leaderboard.getMyRank('deleted-ranker'), null)
  assert.equal(await prisma.basicTotal.count({ where: { userId: 'deleted-ranker' } }), 1)
  assert.equal(await prisma.basicScore.count({ where: { userId: 'deleted-ranker' } }), 1)
})

test('an identity-store outage yields bounded 503 responses instead of unhandled Express rejections', async () => {
  const original = prisma.user.findUnique
  try {
    prisma.user.findUnique = (() => {
      throw new Error('private-database-host must stay internal')
    }) as typeof original
    for (const url of ['/arena/tasks', '/matches/judge-mode', '/questions']) {
      const result = await request(url)
      assert.equal(result.status, 503)
      assert.doesNotMatch(JSON.stringify(result.json), /private-database-host/)
    }
  } finally {
    prisma.user.findUnique = original
  }
})
