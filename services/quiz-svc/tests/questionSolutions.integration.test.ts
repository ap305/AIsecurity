import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, base: string
const tokens: Record<string, string> = {}
let serial = 0
async function request(path: string, user = 'alice', method = 'GET', data?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(tokens[user] ? { Authorization: `Bearer ${tokens[user]}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}
async function question(id: string, overrides: Record<string, any> = {}) {
  return prisma.question.create({
    data: {
      id,
      moduleCode: 'TEST',
      number: ++serial,
      title: id,
      content: 'question',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      status: 'published',
      definition: JSON.stringify({ evaluation: { packageId: 'safe-package' }, weights: { enabled: true } }),
      ...overrides,
    },
  })
}
async function submission(
  q: Awaited<ReturnType<typeof question>>,
  userId = 'alice',
  overrides: Record<string, any> = {},
) {
  return prisma.submission.create({
    data: {
      questionId: q.id,
      userId,
      code: `print('source-${++serial}')`,
      filePath: '/PRIVATE_WEIGHTS',
      result: '{"secret":"PRIVATE_RESULT"}',
      questionVersion: q.revision,
      category: q.category,
      role: q.role,
      scenarioId: q.scenarioId,
      evaluationVersion: q.evaluationVersion,
      configSnapshot: JSON.stringify({
        questionId: q.id,
        questionVersion: q.revision,
        definition: { evaluation: { packageId: 'safe-package' } },
        secret: 'PRIVATE_CONFIG',
      }),
      status: 'completed',
      score: 80,
      createdAt: new Date(1800000000000 + serial * 1000),
      ...overrides,
    },
  })
}
async function share(qid: string, sid: string, user = 'alice') {
  const result = await request(`/questions/${qid}/solutions`, user, 'POST', {
    kind: 'user',
    title: '公开实现',
    explanation: '我主动公开此提交',
    sourceSubmissionId: sid,
  })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  return result.body.data
}
async function best(s: Awaited<ReturnType<typeof submission>>, score = s.score!) {
  await prisma.basicScore.upsert({
    where: { userId_questionId: { userId: s.userId, questionId: s.questionId } },
    create: {
      userId: s.userId,
      questionId: s.questionId,
      questionVersion: s.questionVersion,
      submissionId: s.id,
      score,
    },
    update: { score, submissionId: s.id, questionVersion: s.questionVersion },
  })
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  for (const id of ['admin', 'teacher', 'alice', 'bob', 'carol', 'tester']) {
    await prisma.user.create({
      data: {
        id,
        username: `solutions${id}`,
        displayName: `展示${id}`,
        password: hashPassword('testing-only-password'),
        role: id === 'admin' ? 'admin' : 'student',
        isTestAccount: id === 'tester',
        phone: 'PRIVATE_PHONE',
        studentId: 'PRIVATE_STUDENT_ID',
      },
    })
    tokens[id] = (
      await loginUser(`solutions${id}`, 'testing-only-password', id === 'admin' ? 'admin' : 'student')
    ).token
  }
  const { app } = await import('../src/app.js')
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (prisma) await prisma.$disconnect()
  if (database) await database.close()
})

test('private submissions never appear before explicit opt-in; withdrawal removes public code and top immediately', async () => {
  const q = await question('solutions-private')
  const s = await submission(q)
  await best(s)
  const empty = await request(`/questions/${q.id}/solutions`)
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.data.user, [])
  assert.deepEqual(empty.body.data.top, [])
  const shared = await share(q.id, s.id)
  const visible = (await request(`/questions/${q.id}/solutions`, 'bob')).body.data
  assert.equal(visible.user[0].code, s.code)
  assert.equal(visible.top[0].code, s.code)
  assert.equal(visible.user[0].needsModelAttachment, true)
  assert.doesNotMatch(
    JSON.stringify(visible),
    /PRIVATE_|configSnapshot|filePath|"result"|password|sourceSubmissionId|authorId/,
  )
  assert.equal((await request(`/solutions/${shared.id}`, 'bob', 'DELETE')).status, 403)
  assert.equal((await request(`/solutions/${shared.id}`, 'alice', 'DELETE')).status, 200)
  const hidden = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.deepEqual(hidden.user, [])
  assert.deepEqual(hidden.top, [])
})

test('candidate access is own current completed code only; anonymous, foreign, stale and unfinished references are rejected', async () => {
  const q = await question('solutions-ownership', { revision: 2 })
  const own = await submission(q)
  const foreign = await submission(q, 'bob')
  const stale = await submission(q, 'alice', { questionVersion: 1 })
  const pending = await submission(q, 'alice', { status: 'queued' })
  const wrongVersion = await submission(q, 'alice', { evaluationVersion: 'old' })
  assert.equal((await request(`/questions/${q.id}/solutions`, 'anonymous')).status, 401)
  const candidates = (await request(`/questions/${q.id}/solution-candidates`)).body.data
  assert.deepEqual(
    candidates.map((c: any) => c.id),
    [own.id],
  )
  assert.doesNotMatch(JSON.stringify(candidates), /PRIVATE_|configSnapshot|filePath|source-/)
  for (const s of [foreign, stale, pending, wrongVersion])
    assert.equal(
      (
        await request(`/questions/${q.id}/solutions`, 'alice', 'POST', {
          kind: 'user',
          title: 'x',
          sourceSubmissionId: s.id,
        })
      ).status,
      400,
    )
  const shared = await share(q.id, own.id)
  assert.equal(
    (await request(`/solutions/${shared.id}`, 'alice', 'PUT', { code: 'changed source' })).status,
    400,
  )
  await prisma.question.update({ where: { id: q.id }, data: { revision: 3 } })
  assert.deepEqual((await request(`/questions/${q.id}/solutions`)).body.data.user, [])
  assert.equal((await request(`/solutions/${shared.id}`, 'alice', 'PUT', { published: true })).status, 409)
  await prisma.question.update({ where: { id: q.id }, data: { status: 'draft' } })
  assert.equal((await request(`/questions/${q.id}/solutions`)).status, 404)
})

test('top uses highest opted-in scores bounded by the ledger, exact ties, latest source dates and two authors', async () => {
  const q = await question('solutions-ties')
  const old = await submission(q)
  await best(old)
  await share(q.id, old.id)
  const bob = await submission(q, 'bob')
  await best(bob)
  await share(q.id, bob.id, 'bob')
  const latest = await submission(q)
  await share(q.id, latest.id)
  const duplicate = await share(q.id, latest.id)
  const carol = await submission(q, 'carol')
  await best(carol)
  await share(q.id, carol.id, 'carol')
  const privateHigher = await submission(q, 'bob', { score: 99 })
  await best(privateHigher)
  const tester = await submission(q, 'tester', { score: 100 })
  await best(tester)
  await share(q.id, tester.id, 'tester')
  let view = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.deepEqual(
    view.top.map((r: any) => r.code),
    [carol.code, latest.code],
  )
  assert.equal(view.top[1].id, duplicate.id)
  assert.equal(
    (
      await prisma.basicScore.findUniqueOrThrow({
        where: { userId_questionId: { userId: 'alice', questionId: q.id } },
      })
    ).submissionId,
    old.id,
  )
  await request(`/solutions/${view.top[0].id}`, 'carol', 'DELETE')
  view = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.equal(view.top.length, 2)
  assert.equal(view.top[0].score, 80)
  assert.deepEqual(
    view.top.map((r: any) => r.code),
    [latest.code, bob.code],
  )
  await share(q.id, privateHigher.id, 'bob')
  view = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.equal(view.top.length, 1)
  assert.equal(view.top[0].code, privateHigher.code)
})

test('valid zero has a solution without ledger, while positive historical submission without a ledger cannot lead', async () => {
  const q = await question('solutions-zero')
  const zero = await submission(q, 'alice', { score: 0 })
  await share(q.id, zero.id)
  const uncounted = await submission(q, 'bob', { score: 100 })
  await share(q.id, uncounted.id, 'bob')
  const top = (await request(`/questions/${q.id}/solutions`)).body.data.top
  assert.equal(top.length, 1)
  assert.equal(top[0].score, 0)
  assert.equal(top[0].code, zero.code)
})

test('two newest distinct tied submissions may be from one consenting author, but repeated posts do not duplicate a submission', async () => {
  const q = await question('solutions-same-author-ties')
  const old = await submission(q, 'alice', { score: 90 })
  await best(old)
  await share(q.id, old.id)
  const newer = await submission(q, 'alice', { score: 90 })
  await share(q.id, newer.id)
  await share(q.id, newer.id)
  const top = (await request(`/questions/${q.id}/solutions`)).body.data.top
  assert.deepEqual(
    top.map((row: any) => row.code),
    [newer.code, old.code],
  )
})

test('arena top follows active slot and dynamic score and discloses empty pool and updating state', async () => {
  const q = await question('solutions-arena', {
    category: 'adversarial',
    role: 'attack',
    scenarioId: 'solutions-scene',
  })
  const old = await submission(q, 'alice', { score: 100 })
  await share(q.id, old.id)
  const active = await submission(q, 'alice', { score: 99 })
  await share(q.id, active.id)
  const algorithm = await prisma.arenaAlgorithm.create({
    data: {
      submissionId: active.id,
      userId: 'alice',
      questionId: q.id,
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: 'v1',
      status: 'active',
    },
  })
  await prisma.arenaSlot.create({
    data: {
      userId: 'alice',
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: 'v1',
      algorithmId: algorithm.id,
    },
  })
  const score = await prisma.arenaScore.create({
    data: {
      algorithmId: algorithm.id,
      userId: 'alice',
      questionId: q.id,
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: 'v1',
      score: 40,
      successCount: 2,
      opponentCount: 5,
      snapshotRevision: 1,
      snapshotId: 'private-snapshot',
      achievedAt: new Date(),
    },
  })
  let top = (await request(`/questions/${q.id}/solutions`)).body.data.top
  assert.equal(top.length, 1)
  assert.equal(top[0].code, active.code)
  assert.equal(top[0].score, 40)
  await prisma.arenaScore.update({ where: { id: score.id }, data: { score: 100, opponentCount: 0 } })
  await prisma.arenaEvaluation.create({
    data: {
      algorithmId: algorithm.id,
      submissionId: active.id,
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: 'v1',
      kind: 'recompute',
      status: 'error',
    },
  })
  top = (await request(`/questions/${q.id}/solutions`)).body.data.top
  assert.equal(top[0].emptyPool, true)
  assert.equal(top[0].updating, true)
  assert.match(top[0].notice, /暂无有效对手/)
  assert.match(top[0].notice, /保留上次有效成绩/)
  await prisma.arenaSlot.deleteMany({ where: { algorithmId: algorithm.id } })
  assert.deepEqual((await request(`/questions/${q.id}/solutions`)).body.data.top, [])
})

test('standard publishing requires a current teacher grant, labels manual sources honestly and never changes question or scores', async () => {
  const q = await question('solutions-standard', {
    category: 'adversarial',
    role: 'defense',
    scenarioId: 'standard-scene',
  })
  const payload = {
    kind: 'standard',
    title: '教师参考',
    explanation: '说明',
    code: '<script>alert(1)</script>',
    referenceKind: 'opponent',
  }
  assert.equal((await request(`/questions/${q.id}/solutions`, 'teacher', 'POST', payload)).status, 403)
  await prisma.teacherGrant.create({ data: { userId: 'teacher', grantedBy: 'admin' } })
  assert.equal((await request(`/questions/${q.id}/solutions`, 'teacher')).body.data.canPublishStandard, true)
  const saved = await request(`/questions/${q.id}/solutions`, 'teacher', 'POST', payload)
  assert.equal(saved.status, 201)
  const view = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.equal(view.standard[0].referenceKind, 'opponent')
  assert.equal(view.standard[0].source, 'manual')
  assert.equal(view.standard[0].actualEvaluationReference, false)
  assert.match(view.standard[0].notice, /不代表.*实际/)
  assert.deepEqual(await prisma.question.findUnique({ where: { id: q.id } }), q)
  await prisma.teacherGrant.delete({ where: { userId: 'teacher' } })
  assert.equal(
    (await request(`/solutions/${saved.body.data.id}`, 'teacher', 'PUT', { title: 'new' })).status,
    403,
  )
  assert.equal((await request(`/solutions/${saved.body.data.id}`, 'admin', 'DELETE')).status, 200)
  const extra = await request(`/questions/${q.id}/solutions`, 'admin', 'POST', {
    ...payload,
    referenceKind: 'actual-baseline',
  })
  assert.equal(extra.status, 400)
})

test('publishing validates UTF-8 size and plain text; disabled authors and invalid sessions lose access', async () => {
  const q = await question('solutions-limits')
  for (const code of ['中'.repeat(90000), 'hello\u0000binary'])
    assert.equal(
      (await request(`/questions/${q.id}/solutions`, 'alice', 'POST', { kind: 'user', title: 'bad', code }))
        .status,
      400,
    )
  const posted = await request(`/questions/${q.id}/solutions`, 'bob', 'POST', {
    kind: 'user',
    title: 'manual',
    explanation: 'only text',
  })
  assert.equal(posted.status, 201)
  assert.deepEqual((await request(`/questions/${q.id}/solutions`)).body.data.top, [])
  await prisma.user.update({ where: { id: 'bob' }, data: { accountStatus: 'disabled' } })
  assert.deepEqual((await request(`/questions/${q.id}/solutions`)).body.data.user, [])
  assert.equal((await request(`/questions/${q.id}/solutions`, 'bob')).status, 401)
})

test('the service rechecks a revoked session inside writes even if route identity was already read', async () => {
  const { verifyToken, logoutSession, loginUser } = await import('../src/lib/auth.js')
  const { createQuestionSolution } = await import('../src/services/questionSolutions.js')
  const q = await question('solutions-revoked-session')
  const token = (await loginUser('solutionsalice', 'testing-only-password', 'student')).token
  const payload = verifyToken(token)!
  await logoutSession(payload)
  await assert.rejects(
    () =>
      createQuestionSolution(q.id, { ...payload, id: payload.uid, sessionVersion: payload.sv ?? 0 } as any, {
        kind: 'user',
        title: 'revoked',
        code: 'private',
      }),
    (error: any) => error.status === 401,
  )
  assert.equal(await prisma.questionSolution.count({ where: { questionId: q.id } }), 0)
})

test('old student role sessions cannot gain standard publishing through a database admin promotion', async () => {
  const q = await question('solutions-stale-role')
  await prisma.user.update({ where: { id: 'carol' }, data: { role: 'admin' } })
  try {
    assert.equal(
      (
        await request(`/questions/${q.id}/solutions`, 'carol', 'POST', {
          kind: 'standard',
          title: 'stale promotion',
          code: 'print(1)',
        })
      ).status,
      401,
    )
    assert.equal(await prisma.questionSolution.count({ where: { questionId: q.id } }), 0)
  } finally {
    await prisma.user.update({ where: { id: 'carol' }, data: { role: 'student' } })
  }
})

test('user pages bound code response while an older highest public solution remains selected across pages', async () => {
  const q = await question('solutions-paging')
  const highest = await submission(q, 'alice', { score: 95 })
  await best(highest)
  await share(q.id, highest.id)
  for (let i = 0; i < 24; i++) {
    const uid = `paged-${i}`
    await prisma.user.create({
      data: { id: uid, username: uid, displayName: uid, password: 'unused', role: 'student' },
    })
    await prisma.questionSolution.create({
      data: {
        questionId: q.id,
        questionVersion: q.revision,
        authorId: uid,
        kind: 'user',
        title: `article-${i}`,
        code: 'x'.repeat(64 * 1024),
      },
    })
  }
  const first = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.equal(first.user.length, 20)
  assert.equal(first.pagination.total, 25)
  assert.equal(first.pagination.page, 1)
  assert.equal(first.pagination.totalPages, 2)
  assert.equal(first.top[0].code, highest.code)
  assert.ok(JSON.stringify(first).length < 1400000)
  assert.ok(!first.user.some((r: any) => r.code === highest.code))
  const second = (await request(`/questions/${q.id}/solutions?page=2`)).body.data
  assert.equal(second.user.length, 5)
  assert.equal(second.top[0].code, highest.code)
  assert.equal((await request(`/questions/${q.id}/solutions?page=0`)).status, 400)
  assert.equal((await request(`/questions/${q.id}/solutions?pageSize=100`)).body.data.pagination.pageSize, 50)
})

test('publication caps prevent unlimited posts and a withdrawal frees a slot; required model material is disclosed', async () => {
  const q = await question('solutions-post-cap', {
    definition: JSON.stringify({ evaluation: { packageId: 'safe-package' }, weights: { required: true } }),
  })
  for (let i = 0; i < 20; i++)
    assert.equal(
      (
        await request(`/questions/${q.id}/solutions`, 'alice', 'POST', {
          kind: 'user',
          title: `post-${i}`,
          code: 'print(1)',
        })
      ).status,
      201,
    )
  assert.equal(
    (
      await request(`/questions/${q.id}/solutions`, 'alice', 'POST', {
        kind: 'user',
        title: 'over-limit',
        code: 'print(1)',
      })
    ).status,
    409,
  )
  const page = (await request(`/questions/${q.id}/solutions`)).body.data
  assert.equal(page.user[0].needsModelAttachment, true)
  await request(`/solutions/${page.user[0].id}`, 'alice', 'DELETE')
  assert.equal(
    (
      await request(`/questions/${q.id}/solutions`, 'alice', 'POST', {
        kind: 'user',
        title: 'freed-slot',
        code: 'print(1)',
      })
    ).status,
    201,
  )
})
