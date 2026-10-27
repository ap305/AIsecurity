import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, upstream: http.Server, base: string, upstreamUrl: string
let adminToken: string, studentToken: string
let healthHook: (() => Promise<void>) | undefined
const password = 'fixture-password'
const definition = {
  kind: 'algorithm',
  weights: { enabled: true, required: false, extensions: ['.json'], maxBytes: 1000 },
  teacherApi: { enabled: true, poolId: 'teacher', maxCalls: 10 },
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

async function request(route: string, method = 'GET', body?: unknown, token = adminToken) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  let json: any
  try {
    json = JSON.parse(raw)
  } catch {
    json = { raw }
  }
  return { status: response.status, json }
}
const account = (username: string) => ({
  username,
  password,
  displayName: `测试 ${username}`,
  school: 'fixture',
})
async function create(username: string) {
  const result = await request('/admin/users', 'POST', account(username))
  assert.equal(result.status, 200, JSON.stringify(result.json))
  return result.json.data.user as {
    id: string
    username: string
    accountStatus: string
    isTestAccount: boolean
  }
}
async function login(username: string, role = 'student') {
  return request('/auth/login', 'POST', { username, password, role }, '')
}
async function fingerprint() {
  return JSON.stringify(
    await Promise.all([
      prisma.submission.findMany({ orderBy: { id: 'asc' } }),
      prisma.basicScore.findMany({ orderBy: { id: 'asc' } }),
      prisma.basicTotal.findMany({ orderBy: { userId: 'asc' } }),
      prisma.userScore.findMany({ orderBy: { userId: 'asc' } }),
      prisma.arenaAlgorithm.findMany({ orderBy: { id: 'asc' } }),
      prisma.arenaSlot.findMany({ orderBy: { id: 'asc' } }),
      prisma.arenaScore.findMany({ orderBy: { id: 'asc' } }),
      prisma.arenaPool.findMany({ orderBy: { id: 'asc' } }),
      prisma.arenaEvaluation.findMany({ orderBy: { id: 'asc' } }),
      prisma.evaluationTask.findMany({ orderBy: { id: 'asc' } }),
    ]),
  )
}
async function history(userId: string) {
  const submission = await prisma.submission.create({
    data: {
      questionId: 'lifecycle-question',
      userId,
      code: 'private fixture source',
      status: 'completed',
      score: 75,
    },
  })
  await prisma.basicScore.create({
    data: {
      userId,
      questionId: submission.questionId,
      questionVersion: 1,
      submissionId: submission.id,
      score: 75,
    },
  })
  await prisma.basicTotal.create({ data: { userId, totalScore: 75, tasksCompleted: 1 } })
  await prisma.userScore.create({ data: { userId, displayName: 'fixture', totalScore: 75 } })
  const algorithm = await prisma.arenaAlgorithm.create({
    data: {
      submissionId: submission.id,
      userId,
      questionId: submission.questionId,
      scenarioId: 'lifecycle-pool',
      role: 'attack',
      evaluationVersion: 'v1',
      status: 'active',
    },
  })
  await prisma.arenaSlot.create({
    data: {
      userId,
      scenarioId: algorithm.scenarioId,
      role: algorithm.role,
      evaluationVersion: 'v1',
      algorithmId: algorithm.id,
    },
  })
  await prisma.arenaScore.create({
    data: {
      algorithmId: algorithm.id,
      userId,
      questionId: submission.questionId,
      scenarioId: algorithm.scenarioId,
      role: algorithm.role,
      evaluationVersion: 'v1',
      score: 75,
      successCount: 3,
      opponentCount: 4,
      snapshotRevision: 5,
      snapshotId: 'fixture-snapshot',
      achievedAt: new Date(),
    },
  })
  await prisma.arenaPool.upsert({
    where: {
      scenarioId_evaluationVersion: {
        scenarioId: algorithm.scenarioId,
        evaluationVersion: 'v1',
      },
    },
    create: { scenarioId: algorithm.scenarioId, evaluationVersion: 'v1', revision: 5 },
    update: {},
  })
}

before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword } = await import('../src/lib/auth.js')
  await prisma.user.createMany({
    data: ['admin', 'student'].map((role) => ({
      id: `fixture-${role}`,
      username: `fixture${role}`,
      displayName: role,
      password: hashPassword(password),
      role,
    })),
  })
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
  adminToken = (await login('fixtureadmin', 'admin')).json.data.token
  studentToken = (await login('fixturestudent')).json.data.token
  await prisma.question.create({
    data: {
      id: 'lifecycle-question',
      moduleCode: 'TEST',
      number: 1,
      title: '生命周期测试',
      content: 'fixture',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      definition: JSON.stringify(definition),
    },
  })
  await prisma.questionRevision.create({
    data: {
      questionId: 'lifecycle-question',
      revision: 1,
      snapshot: JSON.stringify({
        questionId: 'lifecycle-question',
        questionVersion: 1,
        category: 'basic',
        role: null,
        scenarioId: null,
        evaluationVersion: 'v1',
        definition,
        teacherBinding: {
          poolId: 'teacher',
          revision: 1,
          name: 'fixture',
          kind: 'teacher',
          model: 'fixture',
          modelVersion: 'v1',
          baseUrl: upstreamUrl,
          credentialEnv: null,
          parameters: {},
        },
      }),
    },
  })
  await history('fixture-student')
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
})

test('migration defaults preserve normal students and version-zero sessions', async () => {
  const student = await prisma.user.findUniqueOrThrow({ where: { id: 'fixture-student' } })
  assert.equal(student.isTestAccount, false)
  assert.equal(student.accountStatus, 'active')
  assert.equal(student.sessionVersion, 0)
  const payload = JSON.parse(Buffer.from(studentToken.split('.')[0]!, 'base64url').toString())
  assert.equal(payload.sv, undefined, 'version-zero login exercises the pre-migration token shape')
  assert.equal((await request('/auth/me', 'GET', undefined, studentToken)).status, 200)
})

test('only administrators can create test students and privileged input cannot escalate roles', async () => {
  for (const token of ['', studentToken])
    assert.equal((await request('/admin/users', 'POST', account('unauthorized'), token)).status, 403)
  const initial = await prisma.user.count()
  for (const extra of [
    { role: 'admin' },
    { isTestAccount: false },
    { accountStatus: 'deleted' },
    { sessionVersion: 99 },
  ])
    assert.equal((await request('/admin/users', 'POST', { ...account('spoofed'), ...extra })).status, 400)
  assert.equal(await prisma.user.count(), initial)
})

test('admin creation validates fields and returns public metadata without credentials', async () => {
  const initial = await prisma.user.count()
  for (const patch of [
    { username: 'bad_name' },
    { password: 'tiny' },
    { password: 'x'.repeat(129) },
    { displayName: '' },
    { displayName: 'x'.repeat(65) },
    { school: 'x'.repeat(201) },
    { username: 1234 },
    { password: null },
    { password: '      ' },
    { school: 1 },
  ]) {
    assert.equal((await request('/admin/users', 'POST', { ...account('invalid'), ...patch })).status, 400)
  }
  assert.equal(await prisma.user.count(), initial)
  const created = await create('createdtest')
  assert.equal(created.isTestAccount, true)
  assert.equal(created.accountStatus, 'active')
  const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } })
  assert.equal(row.role, 'student')
  assert.notEqual(row.password, password)
  const publicValue = JSON.stringify(created)
  assert.doesNotMatch(publicValue, /password|sessionVersion|token/)
  assert.equal((await login(created.username)).status, 200)
  const audit = await prisma.auditEvent.findFirstOrThrow({
    where: { targetId: created.id, action: 'user.test.create' },
  })
  assert.equal(audit.actorId, 'fixture-admin')
  assert.doesNotMatch(audit.detail, /fixture-password|password|token|salt/i)
})

test('concurrent duplicate creation produces one account and a public conflict', async () => {
  const results = await Promise.all([
    request('/admin/users', 'POST', account('concurrenttest')),
    request('/admin/users', 'POST', account('concurrenttest')),
  ])
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409])
  assert.equal(await prisma.user.count({ where: { username: 'concurrenttest' } }), 1)
  assert.match(results.find((x) => x.status === 409)!.json.message, /用户名已存在/)
})

test('status endpoint cannot change ordinary students or administrators', async () => {
  const before = await fingerprint()
  for (const id of ['fixture-student', 'fixture-admin'])
    assert.equal((await request(`/admin/users/${id}/status`, 'PUT', { status: 'disabled' })).status, 403)
  assert.equal((await request('/admin/users/absent/status', 'PUT', { status: 'disabled' })).status, 404)
  const user = await create('statusvalidation')
  for (const status of ['deleted', 'arbitrary', null, true])
    assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status })).status, 400)
  assert.equal(
    (await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' }, studentToken)).status,
    403,
  )
  assert.equal(await fingerprint(), before)
  assert.equal((await request('/questions', 'GET', undefined, studentToken)).status, 200)
})

test('teacher credentials cannot be reused as an ordinary login session', async () => {
  const user = await create('scopedcredential')
  const token = (await login(user.username)).json.data.token
  const lease = await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  assert.equal(lease.status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, lease.json.data.token)).status, 401)
  assert.equal((await request('/questions', 'GET', undefined, lease.json.data.token)).status, 401)
  assert.equal(
    (await request(`/teacher/${lease.json.data.id}/query`, 'POST', {}, lease.json.data.token)).status,
    200,
  )
})

test('disable revokes sessions and teacher leases while preserving all submissions scores and pool revisions', async () => {
  const user = await create('disabledtest')
  const token = (await login(user.username)).json.data.token
  await history(user.id)
  const lease = await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  assert.equal(lease.status, 200)
  const before = await fingerprint()
  const result = await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })
  assert.equal(result.status, 200)
  assert.equal(result.json.data.user.accountStatus, 'disabled')
  const version = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion
  assert.equal(version, 1)
  assert.equal((await login(user.username)).status, 403)
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await request('/auth/me', 'PUT', { displayName: 'forbidden' }, token)).status, 401)
  assert.equal((await request('/questions', 'GET', undefined, token)).status, 401)
  assert.equal(
    (await request(`/teacher/${lease.json.data.id}/query`, 'POST', {}, lease.json.data.token)).status,
    401,
  )
  assert.equal(
    (await prisma.teacherLease.findUniqueOrThrow({ where: { id: lease.json.data.id } })).state,
    'revoked',
  )
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, version)
  assert.equal(await prisma.auditEvent.count({ where: { targetId: user.id, action: 'user.test.status' } }), 1)
  assert.equal(await fingerprint(), before)
})

test('reenable requires fresh login and fresh teacher credentials without restoring old tokens', async () => {
  const user = await create('reenabledtest')
  const old = (await login(user.username)).json.data.token
  const oldLease = (await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, old)).json
    .data
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, old)).status, 401)
  const fresh = await login(user.username)
  assert.equal(fresh.status, 200)
  assert.equal((await request('/auth/me', 'GET', undefined, fresh.json.data.token)).status, 200)
  assert.equal((await request(`/teacher/${oldLease.id}/query`, 'POST', {}, oldLease.token)).status, 401)
  const lease = await request(
    '/questions/lifecycle-question/teacher-lease/start',
    'POST',
    {},
    fresh.json.data.token,
  )
  assert.equal(lease.status, 200)
  assert.equal(lease.json.data.state, 'active')
  assert.notEqual(lease.json.data.token, oldLease.token)
  assert.equal(
    (await request(`/teacher/${lease.json.data.id}/query`, 'POST', {}, lease.json.data.token)).status,
    200,
  )
})

test('reenable preserves a teacher lease explicitly revoked by an administrator', async () => {
  const user = await create('manualrevocation')
  const token = (await login(user.username)).json.data.token
  const lease = (await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)).json
    .data
  assert.equal(
    (await request(`/admin/teacher-leases/${lease.id}/revoke`, 'POST', { reason: 'manual fixture decision' }))
      .status,
    200,
  )
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 200)
  const fresh = (await login(user.username)).json.data.token
  assert.equal(
    (await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, fresh)).status,
    403,
  )
  const row = await prisma.teacherLease.findUniqueOrThrow({ where: { id: lease.id } })
  assert.equal(row.state, 'revoked')
  assert.equal(row.reason, 'manual fixture decision')
})

test('soft deletion is idempotent reserves the username and preserves business records and scores', async () => {
  const user = await create('deletedtest')
  const token = (await login(user.username)).json.data.token
  await history(user.id)
  const before = await fingerprint()
  assert.equal((await request(`/admin/users/${user.id}`, 'DELETE')).status, 200)
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(row.accountStatus, 'deleted')
  assert.equal(row.sessionVersion, 1)
  assert.equal(
    (await request('/admin/users')).json.data.some((x: any) => x.id === user.id),
    false,
  )
  assert.equal((await request('/auth/me', 'GET', undefined, token)).status, 401)
  assert.equal((await login(user.username)).status, 403)
  assert.equal((await request('/admin/users', 'POST', account(user.username))).status, 409)
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 409)
  assert.equal((await request(`/admin/users/${user.id}`, 'DELETE')).status, 200)
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
    row.sessionVersion,
  )
  assert.equal(await prisma.auditEvent.count({ where: { targetId: user.id, action: 'user.test.delete' } }), 1)
  assert.equal(await fingerprint(), before)
})

test('a teacher readiness response cannot reactivate an account disabled during readiness', async () => {
  const user = await create('readinessrace')
  const token = (await login(user.username)).json.data.token
  healthHook = async () => {
    assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  }
  const result = await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  assert.equal(result.status, 401)
  assert.equal(result.json.data, null)
  assert.equal(
    (
      await prisma.teacherLease.findUniqueOrThrow({
        where: { userId_questionId: { userId: user.id, questionId: 'lifecycle-question' } },
      })
    ).state,
    'revoked',
  )
})

test('an old readiness request cannot return credentials created by a fresh login after reenable', async (t) => {
  const user = await create('readinesscredentialrace')
  const oldToken = (await login(user.username)).json.data.token
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => {
    healthHook = undefined
    release()
  })
  healthHook = async () => {
    entered()
    await paused
  }
  const oldRequest = request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, oldToken)
  await Promise.race([
    started,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('old request did not reach health check')), 5000).unref()
    }),
  ])
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 200)
  const freshToken = (await login(user.username)).json.data.token
  const fresh = await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, freshToken)
  assert.equal(fresh.status, 200)
  assert.equal(fresh.json.data.state, 'active')
  assert.ok(fresh.json.data.token)
  release()
  const stale = await oldRequest
  assert.equal(stale.status, 401)
  assert.equal(stale.json.data, null)
  assert.equal(
    (await request(`/teacher/${fresh.json.data.id}/query`, 'POST', {}, fresh.json.data.token)).status,
    200,
  )
})

test('a replaced teacher preparation cannot return the replacement nonce credentials', async (t) => {
  const user = await create('replacedpreparation')
  const token = (await login(user.username)).json.data.token
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => {
    healthHook = undefined
    release()
  })
  healthHook = async () => {
    entered()
    await paused
  }
  const oldRequest = request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  await Promise.race([
    started,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('old request did not reach health check')), 5000).unref()
    }),
  ])
  const prepared = await prisma.teacherLease.findUniqueOrThrow({
    where: { userId_questionId: { userId: user.id, questionId: 'lifecycle-question' } },
  })
  // Model recovery of a preparation whose owner was paused beyond the recovery window.
  await prisma.teacherLease.update({
    where: { id: prepared.id },
    data: {
      updatedAt: new Date(Date.now() - 60000),
    },
  })
  const replacement = await request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  assert.equal(replacement.status, 200)
  assert.equal(replacement.json.data.state, 'active')
  release()
  const stale = await oldRequest
  assert.equal(stale.status, 409)
  assert.equal(stale.json.data, null)
  assert.equal(
    (await request(`/teacher/${replacement.json.data.id}/query`, 'POST', {}, replacement.json.data.token))
      .status,
    200,
  )
})

test('a delayed teacher request cannot use its stale session after disable and reenable', async (t) => {
  const user = await create('teacherrequestdelay')
  const token = (await login(user.username)).json.data.token
  const original = prisma.question.findUnique
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let blocked = false
  prisma.question.findUnique = (async (...args: Parameters<typeof original>) => {
    if (!blocked && args[0].where.id === 'lifecycle-question') {
      blocked = true
      entered()
      await paused
    }
    return original.apply(prisma.question, args)
  }) as typeof original
  t.after(() => {
    prisma.question.findUnique = original
    release()
  })
  const pending = request('/questions/lifecycle-question/teacher-lease/start', 'POST', {}, token)
  await Promise.race([
    started,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('teacher request did not reach readiness')), 5000).unref()
    }),
  ])
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 200)
  release()
  const result = await pending
  assert.equal(result.status, 401)
  assert.equal(await prisma.teacherLease.count({ where: { userId: user.id } }), 0)
})

test('a long upload cannot enqueue with its stale session after disable and reenable', async (t) => {
  const user = await create('uploadrace')
  const token = (await login(user.username)).json.data.token
  const uploadRoot = path.resolve('uploads/submissions')
  const existing = new Set(await fs.readdir(uploadRoot))
  const boundary = 'lifecycle-upload-boundary'
  const url = new URL(`${base}/submissions`)
  const upload = http.request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
  })
  t.after(() => upload.destroy())
  const response = new Promise<{ status: number; json: any }>((resolve, reject) => {
    upload.on('error', reject)
    upload.on('response', (res) => {
      let raw = ''
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(raw) }))
      res.on('error', reject)
    })
  })
  upload.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.json"\r\nContent-Type: application/json\r\n\r\n{"part":`,
  )
  const deadline = Date.now() + 5000
  let newFiles: string[] = []
  while (Date.now() < deadline) {
    newFiles = (await fs.readdir(uploadRoot)).filter((x) => !existing.has(x))
    if (newFiles.length) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(newFiles.length, 1, 'Multer must have authenticated and begun receiving the upload')
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'disabled' })).status, 200)
  const fields = {
    questionId: 'lifecycle-question',
    questionVersion: '1',
    code: 'answer',
    idempotencyKey: 'long-upload-race',
  }
  assert.equal((await request(`/admin/users/${user.id}/status`, 'PUT', { status: 'active' })).status, 200)
  upload.end(
    `1}\r\n${Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join('')}--${boundary}--\r\n`,
  )
  const result = await response
  assert.equal(result.status, 401)
  assert.equal(await prisma.submission.count({ where: { userId: user.id } }), 0)
  assert.equal(await prisma.evaluationTask.count(), 0)
  assert.deepEqual(
    (await fs.readdir(uploadRoot)).filter((x) => !existing.has(x)),
    [],
  )
})

test('bulk student clearing preserves test accounts deleted tombstones usernames and their arena slots', async () => {
  const testUsers = await prisma.user.findMany({ where: { isTestAccount: true }, orderBy: { id: 'asc' } })
  const testIds = testUsers.map((user) => user.id)
  const slots = await prisma.arenaSlot.findMany({
    where: { userId: { in: testIds } },
    orderBy: { id: 'asc' },
  })
  const algorithms = await prisma.arenaAlgorithm.findMany({
    where: { userId: { in: testIds } },
    orderBy: { id: 'asc' },
  })
  const pool = await prisma.arenaPool.findUniqueOrThrow({
    where: {
      scenarioId_evaluationVersion: {
        scenarioId: 'lifecycle-pool',
        evaluationVersion: 'v1',
      },
    },
  })
  const result = await request('/admin/users', 'DELETE')
  assert.equal(result.status, 200)
  assert.equal(result.json.data.deleted, 1, 'only the original ordinary student is cleared')
  assert.equal(await prisma.user.count({ where: { id: 'fixture-student' } }), 0)
  assert.deepEqual(
    await prisma.user.findMany({ where: { isTestAccount: true }, orderBy: { id: 'asc' } }),
    testUsers,
  )
  assert.deepEqual(
    await prisma.arenaSlot.findMany({ where: { userId: { in: testIds } }, orderBy: { id: 'asc' } }),
    slots,
  )
  assert.deepEqual(
    await prisma.arenaAlgorithm.findMany({ where: { userId: { in: testIds } }, orderBy: { id: 'asc' } }),
    algorithms,
  )
  assert.equal(
    (await prisma.arenaPool.findUniqueOrThrow({ where: { id: pool.id } })).revision,
    pool.revision + 1,
    'only the ordinary student leaves the formal arena; test accounts do not invalidate the pool',
  )
  assert.equal((await request('/admin/users', 'POST', account('deletedtest'))).status, 409)
})
