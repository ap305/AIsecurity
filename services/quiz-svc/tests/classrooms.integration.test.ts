import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import AdmZip from 'adm-zip'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, base: string
const tokens: Record<string, string> = {}
let sequence = 0
async function request(path: string, user = 'teacher', method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.headers.get('content-type')?.includes('application/json'))
    return { status: response.status, body: (await response.json()) as any, response, bytes: Buffer.alloc(0) }
  return { status: response.status, body: null, response, bytes: Buffer.from(await response.arrayBuffer()) }
}
async function create(name = `班级${++sequence}`, user = 'teacher') {
  const result = await request('/classrooms', user, 'POST', { name, description: '课程说明' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.data
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  const password = hashPassword('test-only-password')
  for (const id of [
    'admin',
    'teacher',
    'otherteacher',
    'student',
    'another',
    'testaccount',
    'throttled',
    'revoked',
  ]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        displayName: id === 'student' ? '=危险姓名' : `${id}姓名`,
        studentId: id === 'student' ? '0007' : null,
        phone: 'PRIVATE_PHONE',
        school: '学校',
        password,
        role: id === 'admin' ? 'admin' : 'student',
        isTestAccount: id === 'testaccount',
      },
    })
    tokens[id] = (await loginUser(id, 'test-only-password', id === 'admin' ? 'admin' : 'student')).token
  }
  const app = express()
  app.use(express.json())
  app.use('/api', (await import('../src/routes/classrooms.js')).default)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma?.$disconnect()
  await database?.close()
})

test('an old student session cannot acquire admin bypasses after a database role change', async () => {
  await prisma.user.update({ where: { id: 'another' }, data: { role: 'admin' } })
  try {
    assert.equal((await request('/admin/users/student/teaching', 'another')).status, 401)
    assert.equal((await request('/classrooms', 'another')).status, 401)
    assert.equal((await request('/classrooms', 'another', 'POST', { name: 'stale-role' })).status, 401)
    assert.equal(await prisma.classroom.count({ where: { name: 'stale-role' } }), 0)
  } finally {
    await prisma.user.update({ where: { id: 'another' }, data: { role: 'student' } })
  }
})

test('only current administrators grant teaching; grants preserve student role and current sessions', async () => {
  assert.equal((await request('/classrooms', 'anonymous')).status, 401)
  assert.equal(
    (await request('/admin/users/teacher/teaching', 'student', 'PUT', { enabled: true })).status,
    403,
  )
  assert.equal((await request('/classrooms', 'teacher', 'POST', { name: '未授权' })).status, 403)
  for (const id of ['teacher', 'otherteacher']) {
    const result = await request(`/admin/users/${id}/teaching`, 'admin', 'PUT', { enabled: true })
    assert.equal(result.status, 200)
    assert.equal(result.body.data.enabled, true)
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id } })).role, 'student')
    assert.equal((await request(`/admin/users/${id}/teaching`, 'admin')).body.data.enabled, true)
  }
  assert.equal(
    (await request('/admin/users/teacher/teaching', 'admin', 'PUT', { enabled: 'false' })).status,
    400,
  )
  assert.equal(
    (await request('/admin/users/missing/teaching', 'admin', 'PUT', { enabled: true })).status,
    404,
  )
})

test('students join multiple classes idempotently; student responses never reveal roster or invite secrets', async () => {
  const a = await create(),
    b = await create()
  assert.match(a.inviteCode, /^[A-Z0-9]{16,}$/)
  for (const classroom of [a, a, b]) {
    const joined = await request('/classrooms/join', 'student', 'POST', {
      inviteCode: ` ${classroom.inviteCode.toLowerCase()} `,
    })
    assert.equal(joined.status, 200)
    assert.doesNotMatch(JSON.stringify(joined.body.data), /inviteCode|members|PRIVATE_PHONE|0007/)
  }
  await request('/classrooms/join', 'another', 'POST', { inviteCode: a.inviteCode })
  assert.equal(
    await prisma.classMembership.count({ where: { userId: 'student', classroomId: { in: [a.id, b.id] } } }),
    2,
  )
  const list = (await request('/classrooms', 'student')).body.data
  assert.equal(list.canTeach, false)
  assert.equal(list.owned.length, 0)
  assert.deepEqual(list.joined.map((c: any) => c.id).sort(), [a.id, b.id].sort())
  const detail = await request(`/classrooms/${a.id}`, 'student')
  assert.equal(detail.status, 200)
  assert.equal(detail.body.data.canManage, false)
  assert.doesNotMatch(JSON.stringify(detail.body.data), /inviteCode|members|PRIVATE_PHONE|another姓名|0007/)
  const roster = (await request(`/classrooms/${a.id}`)).body.data
  assert.equal(roster.members.length, 2)
  assert.equal(roster.members.find((m: any) => m.userId === 'student').studentId, '0007')
  assert.doesNotMatch(JSON.stringify(roster), /PRIVATE_PHONE|password|configSnapshot|filePath/)
})

test('ownership, rotation, archive, member removal and leave change only membership', async () => {
  const a = await create()
  assert.equal((await request(`/classrooms/${a.id}`, 'otherteacher')).status, 403)
  assert.equal((await request(`/classrooms/${a.id}`, 'otherteacher', 'PUT', { name: '越权' })).status, 403)
  assert.equal((await request(`/classrooms/${a.id}/invite`, 'otherteacher', 'POST', {})).status, 403)
  assert.equal((await request(`/classrooms/${a.id}`, 'admin')).status, 200)
  const rotated = (await request(`/classrooms/${a.id}/invite`, 'teacher', 'POST', {})).body.data
  assert.notEqual(rotated.inviteCode, a.inviteCode)
  assert.equal(
    (await request('/classrooms/join', 'student', 'POST', { inviteCode: a.inviteCode })).status,
    404,
  )
  assert.equal(
    (await request('/classrooms/join', 'student', 'POST', { inviteCode: rotated.inviteCode })).status,
    200,
  )
  assert.equal((await request(`/classrooms/${a.id}/members/student`, 'otherteacher', 'DELETE')).status, 403)
  assert.equal((await request(`/classrooms/${a.id}/members/student`, 'teacher', 'DELETE')).status, 200)
  assert.equal((await request(`/classrooms/${a.id}`, 'student')).status, 403)
  await request('/classrooms/join', 'student', 'POST', { inviteCode: rotated.inviteCode })
  assert.equal((await request(`/classrooms/${a.id}`, 'teacher', 'PUT', { archived: true })).status, 200)
  assert.equal(
    (await request('/classrooms/join', 'another', 'POST', { inviteCode: rotated.inviteCode })).status,
    404,
  )
  assert.equal((await request(`/classrooms/${a.id}/membership`, 'student', 'DELETE')).status, 200)
  assert.equal((await request(`/classrooms/${a.id}/membership`, 'student', 'DELETE')).status, 200)
  assert.equal(
    (await request(`/classrooms/${a.id}`, 'teacher', 'PUT', { archived: false, name: '恢复的班级' })).status,
    200,
  )
  for (const body of [
    { name: '' },
    { name: 'x'.repeat(81) },
    { description: 'x'.repeat(1001) },
    { archived: 'false' },
  ])
    assert.equal((await request(`/classrooms/${a.id}`, 'teacher', 'PUT', body)).status, 400)
})

test('grant revocation immediately blocks former teacher reads and writes without removing classes or memberships', async () => {
  const a = await create()
  await request('/classrooms/join', 'student', 'POST', { inviteCode: a.inviteCode })
  assert.equal(
    (await request('/admin/users/teacher/teaching', 'admin', 'PUT', { enabled: false })).status,
    200,
  )
  assert.equal((await request('/classrooms', 'teacher')).body.data.canTeach, false)
  for (const [path, method, body] of [
    [`/classrooms/${a.id}`, 'GET', undefined],
    [`/classrooms/${a.id}`, 'PUT', { name: '撤权后改名' }],
    [`/classrooms/${a.id}/invite`, 'POST', {}],
    ['/classrooms/export', 'POST', { classroomIds: [a.id] }],
  ] as const)
    assert.equal((await request(path, 'teacher', method, body)).status, 403)
  assert.equal(await prisma.classMembership.count({ where: { classroomId: a.id } }), 1)
  assert.equal((await request(`/classrooms/${a.id}`, 'admin')).status, 200)
  await request('/admin/users/teacher/teaching', 'admin', 'PUT', { enabled: true })
})

test('disabled, stale-version, signed-out and must-change-password sessions cannot access or mutate class data', async () => {
  const a = await create()
  await prisma.user.update({ where: { id: 'revoked' }, data: { accountStatus: 'disabled' } })
  assert.equal((await request('/classrooms', 'revoked')).status, 401)
  assert.equal(
    (await request('/classrooms/join', 'revoked', 'POST', { inviteCode: a.inviteCode })).status,
    401,
  )
  await prisma.user.update({
    where: { id: 'revoked' },
    data: { accountStatus: 'active', sessionVersion: { increment: 1 } },
  })
  assert.equal((await request('/classrooms', 'revoked')).status, 401)
  const { loginUser, logoutSession, verifyToken } = await import('../src/lib/auth.js')
  tokens.revoked = (await loginUser('revoked', 'test-only-password', 'student')).token
  await logoutSession(verifyToken(tokens.revoked))
  assert.equal((await request('/classrooms', 'revoked')).status, 401)
  await prisma.userSecurity.update({ where: { userId: 'teacher' }, data: { mustChangePassword: true } })
  assert.equal((await request('/classrooms', 'teacher', 'POST', { name: '限制会话' })).status, 428)
  await prisma.userSecurity.update({ where: { userId: 'teacher' }, data: { mustChangePassword: false } })
  assert.equal(await prisma.classMembership.count({ where: { userId: 'revoked' } }), 0)
})

test('invite guessing is persisted and bounded per user without locking other students', async () => {
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await request('/classrooms/join', 'throttled', 'POST', { inviteCode: 'AAAAAAAAAAAAAAAA' })).status,
      404,
    )
  assert.equal(
    (await request('/classrooms/join', 'throttled', 'POST', { inviteCode: 'AAAAAAAAAAAAAAAA' })).status,
    429,
  )
  const a = await create()
  assert.equal(
    (await request('/classrooms/join', 'another', 'POST', { inviteCode: a.inviteCode })).status,
    200,
  )
  await prisma.classJoinThrottle.update({
    where: { userId: 'throttled' },
    data: { windowStartedAt: new Date(0) },
  })
  assert.equal(
    (await request('/classrooms/join', 'throttled', 'POST', { inviteCode: a.inviteCode })).status,
    200,
  )
})

test('CSV and multi-class ZIP preserve current scores, zeros, IDs and safe cells, exclude tests, and refuse mixed ownership', async () => {
  const a = await create('../../导出班级'),
    b = await create('第二班'),
    foreign = await create('其他教师', 'otherteacher')
  for (const user of ['student', 'another', 'testaccount'])
    await request('/classrooms/join', user, 'POST', { inviteCode: a.inviteCode })
  await request('/classrooms/join', 'student', 'POST', { inviteCode: b.inviteCode })
  const makeQuestion = async (id: string, extra = {}) =>
    prisma.question.create({
      data: {
        id,
        title: id,
        moduleCode: 'TEST',
        number: ++sequence,
        content: 'private',
        type: 'code',
        difficulty: 'L1',
        category: 'basic',
        status: 'published',
        definition: JSON.stringify({ evaluation: { packageId: 'pkg' } }),
        ...extra,
      },
    })
  const best = await makeQuestion('basic-best'),
    zero = await makeQuestion('basic-zero'),
    outdated = await makeQuestion('basic-outdated', { revision: 2 }),
    arena = await makeQuestion('arena-current', {
      category: 'adversarial',
      scenarioId: 'test-arena',
      role: 'attack',
    })
  await makeQuestion('unsubmitted')
  const archived = await makeQuestion('archived-private', { status: 'archived' })
  const submit = async (q: typeof best, score: number, extra = {}) =>
    prisma.submission.create({
      data: {
        questionId: q.id,
        userId: 'student',
        code: 'PRIVATE_CODE',
        filePath: '/PRIVATE_PATH',
        result: 'PRIVATE_RESULT',
        status: 'completed',
        score,
        questionVersion: q.revision,
        category: q.category,
        role: q.role,
        scenarioId: q.scenarioId,
        evaluationVersion: q.evaluationVersion,
        configSnapshot: JSON.stringify({
          questionId: q.id,
          questionVersion: q.revision,
          definition: { evaluation: { packageId: 'pkg' } },
        }),
        ...extra,
      },
    })
  const s = await submit(best, 70)
  await prisma.basicScore.create({
    data: {
      userId: 'student',
      questionId: best.id,
      questionVersion: 1,
      submissionId: s.id,
      score: 70,
      scoreReachedAt: s.updatedAt,
    },
  })
  await submit(best, 100, { questionVersion: 0 })
  await submit(zero, 0)
  await submit(outdated, 99, { questionVersion: 1 })
  const archivedSubmission = await submit(archived, 20)
  await prisma.basicScore.create({
    data: {
      userId: 'student',
      questionId: archived.id,
      questionVersion: 1,
      submissionId: archivedSubmission.id,
      score: 20,
      scoreReachedAt: archivedSubmission.updatedAt,
    },
  })
  await submit(arena, 100)
  const activeSubmission = await submit(arena, 100)
  const algorithm = await prisma.arenaAlgorithm.create({
    data: {
      submissionId: activeSubmission.id,
      userId: 'student',
      questionId: arena.id,
      scenarioId: arena.scenarioId!,
      role: 'attack',
      evaluationVersion: 'v1',
      status: 'active',
    },
  })
  await prisma.arenaSlot.create({
    data: {
      userId: 'student',
      scenarioId: arena.scenarioId!,
      role: 'attack',
      evaluationVersion: 'v1',
      algorithmId: algorithm.id,
    },
  })
  await prisma.arenaScore.create({
    data: {
      algorithmId: algorithm.id,
      userId: 'student',
      questionId: arena.id,
      scenarioId: arena.scenarioId!,
      role: 'attack',
      evaluationVersion: 'v1',
      score: 25,
      successCount: 1,
      opponentCount: 4,
      snapshotRevision: 1,
      snapshotId: 'snapshot',
      achievedAt: new Date(),
    },
  })
  const before = {
    scores: await prisma.basicScore.findMany(),
    arena: await prisma.arenaScore.findMany(),
    submissions: await prisma.submission.count(),
  }
  const single = await request('/classrooms/export', 'teacher', 'POST', { classroomIds: [a.id] })
  assert.equal(single.status, 200)
  assert.equal(single.bytes.subarray(0, 3).toString('hex'), 'efbbbf')
  const csv = single.bytes.toString('utf8')
  assert.match(csv, /^\uFEFF"班级","账号","姓名","学号"/)
  assert.match(csv, /"\.\.\/\.\.\/导出班级","student"/)
  assert.match(csv, /"0007"/)
  assert.match(csv, /"'=危险姓名"/)
  assert.match(csv, /"70"/)
  assert.match(csv, /"0"/)
  assert.match(csv, /"25"/)
  assert.match(csv, /旧版本已失效/)
  assert.match(csv, /未提交/)
  assert.match(csv, /"90"/)
  assert.doesNotMatch(csv, /testaccount|PRIVATE_|archived-private|"99"|"100"/)
  const zipResult = await request('/classrooms/export', 'teacher', 'POST', { classroomIds: [a.id, b.id] })
  const entries = new AdmZip(zipResult.bytes).getEntries()
  assert.equal(entries.length, 2)
  for (const entry of entries) {
    assert.match(entry.entryName, /\.csv$/)
    assert.doesNotMatch(entry.entryName, /\.\.|[\\/]/)
    assert.equal(entry.getData().subarray(0, 3).toString('hex'), 'efbbbf')
  }
  assert.equal(
    (await request('/classrooms/export', 'teacher', 'POST', { classroomIds: [a.id, foreign.id] })).status,
    403,
  )
  assert.equal((await request('/classrooms/export', 'student', 'POST', { classroomIds: [a.id] })).status, 403)
  assert.equal(
    (await request('/classrooms/export', 'admin', 'POST', { classroomIds: [a.id, foreign.id] })).status,
    200,
  )
  assert.deepEqual(
    {
      scores: await prisma.basicScore.findMany(),
      arena: await prisma.arenaScore.findMany(),
      submissions: await prisma.submission.count(),
    },
    before,
  )
})

test('teaching grants and revocations are auditable while a demoted admin cannot grant access', async () => {
  for (const enabled of [true, false])
    assert.equal((await request('/admin/users/revoked/teaching', 'admin', 'PUT', { enabled })).status, 200)
  const audit = await prisma.auditEvent.findMany({
    where: { targetId: 'revoked', action: { startsWith: 'classroom.teaching.' } },
    orderBy: { createdAt: 'asc' },
  })
  assert.deepEqual(
    audit.map((event) => ({
      action: event.action,
      actorId: event.actorId,
      detail: JSON.parse(event.detail),
    })),
    [
      { action: 'classroom.teaching.grant', actorId: 'admin', detail: {} },
      { action: 'classroom.teaching.revoke', actorId: 'admin', detail: {} },
    ],
  )
  await prisma.user.update({ where: { id: 'admin' }, data: { role: 'student' } })
  assert.equal(
    (await request('/admin/users/revoked/teaching', 'admin', 'PUT', { enabled: true })).status,
    401,
  )
  assert.equal(await prisma.teacherGrant.count({ where: { userId: 'revoked' } }), 0)
  await prisma.user.update({ where: { id: 'admin' }, data: { role: 'admin' } })
})
