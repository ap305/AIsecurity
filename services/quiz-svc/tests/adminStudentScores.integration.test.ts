import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { createTestDatabase } from './database.js'

let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let server: http.Server, base: string, adminToken: string, studentToken: string
let sequence = 0
const epoch = Date.parse('2026-10-14T00:00:00.000Z')
async function request(route: string, token = adminToken) {
  const response = await fetch(`${base}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return { status: response.status, body: (await response.json()) as any }
}
async function question(id: string, options: Record<string, any> = {}) {
  const row = await prisma.question.create({
    data: {
      id,
      moduleCode: 'TEST',
      number: ++sequence,
      title: `题目 ${id}`,
      content: 'private question content',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
      status: 'published',
      definition: JSON.stringify({ evaluation: { packageId: 'test-package' } }),
      ...options,
    },
  })
  await prisma.questionRevision.create({
    data: {
      questionId: row.id,
      revision: row.revision,
      snapshot: JSON.stringify({
        questionId: row.id,
        questionVersion: row.revision,
        category: row.category,
        role: row.role,
        scenarioId: row.scenarioId,
        evaluationVersion: row.evaluationVersion,
        definition: JSON.parse(row.definition),
      }),
    },
  })
  return row
}
async function submission(
  id: string,
  q: Awaited<ReturnType<typeof question>>,
  options: Record<string, any> = {},
) {
  const at = new Date(epoch + ++sequence * 1000)
  return prisma.submission.create({
    data: {
      id,
      questionId: q.id,
      userId: 'alice',
      code: 'DO_NOT_EXPOSE_STUDENT_SOURCE',
      filePath: '/DO_NOT_EXPOSE_PRIVATE_WEIGHTS',
      result: '{"secret":"DO_NOT_EXPOSE_RESULT"}',
      questionVersion: q.revision,
      category: q.category,
      role: q.role,
      scenarioId: q.scenarioId,
      evaluationVersion: q.evaluationVersion,
      status: 'completed',
      score: null,
      createdAt: at,
      updatedAt: at,
      configSnapshot: JSON.stringify({
        questionId: q.id,
        questionVersion: q.revision,
        definition: { evaluation: { packageId: 'test-package' } },
        privateConfig: 'DO_NOT_EXPOSE_EVALUATOR_CONFIG',
      }),
      ...options,
    },
  })
}
async function basicScore(s: Awaited<ReturnType<typeof submission>>, score: number) {
  await prisma.basicScore.create({
    data: {
      userId: s.userId,
      questionId: s.questionId,
      questionVersion: s.questionVersion,
      submissionId: s.id,
      score,
      scoreReachedAt: s.updatedAt,
    },
  })
}
async function arena(s: Awaited<ReturnType<typeof submission>>, score: number, active: boolean) {
  const algorithm = await prisma.arenaAlgorithm.create({
    data: {
      id: `${s.id}-algorithm`,
      submissionId: s.id,
      userId: s.userId,
      questionId: s.questionId,
      scenarioId: s.scenarioId!,
      role: s.role!,
      evaluationVersion: s.evaluationVersion,
      status: active ? 'active' : 'superseded',
    },
  })
  await prisma.arenaScore.create({
    data: {
      algorithmId: algorithm.id,
      userId: s.userId,
      questionId: s.questionId,
      scenarioId: s.scenarioId!,
      role: s.role!,
      evaluationVersion: s.evaluationVersion,
      score,
      successCount: score === 0 ? 0 : 1,
      opponentCount: 1,
      snapshotRevision: active ? 2 : 1,
      snapshotId: `${s.id}-snapshot`,
      achievedAt: s.updatedAt,
    },
  })
  if (active)
    await prisma.arenaSlot.create({
      data: {
        userId: s.userId,
        scenarioId: s.scenarioId!,
        role: s.role!,
        evaluationVersion: s.evaluationVersion,
        algorithmId: algorithm.id,
      },
    })
  return algorithm
}
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  const { hashPassword, loginUser } = await import('../src/lib/auth.js')
  for (const [id, username, displayName, studentId, role] of [
    ['admin', 'scoreadmin', '管理员', null, 'admin'],
    ['alice', 'AliceAccount', '张小明', '0007', 'student'],
    ['bob', 'BobAccount', '无提交同学', '0008', 'student'],
    ['carol', 'CarolAccount', '零分同学', null, 'student'],
  ])
    await prisma.user.create({
      data: {
        id: id!,
        username: username!,
        displayName: displayName!,
        studentId,
        role: role!,
        school: '北京理工大学',
        password: hashPassword('test-only-password'),
      },
    })
  adminToken = (await loginUser('scoreadmin', 'test-only-password', 'admin')).token
  studentToken = (await loginUser('AliceAccount', 'test-only-password', 'student')).token

  const best = await question('basic-best', { revision: 2 })
  await submission('old-best-100', best, { questionVersion: 1, score: 100 })
  const effective = await submission('current-best-70', best, { score: 70 })
  await basicScore(effective, 70)
  await submission('latest-low-10', best, { score: 10 })
  await submission('latest-queued', best, { status: 'queued' })
  const zero = await question('basic-zero')
  await submission('zero-result', zero, { score: 0 })
  await submission('carol-zero', zero, { userId: 'carol', score: 0 })
  const archived = await question('basic-archived', { status: 'archived' })
  await basicScore(await submission('archived-score-20', archived, { score: 20 }), 20)
  const outdated = await question('basic-outdated', { revision: 2 })
  await basicScore(await submission('outdated-score-99', outdated, { questionVersion: 1, score: 99 }), 99)
  const legacy = await question('basic-legacy', { definition: 'null' })
  await submission('legacy-old-88', legacy, { score: 88, status: 'passed', configSnapshot: 'null' })
  await submission('basic-pending', await question('basic-pending'), { status: 'judging' })
  await submission('basic-no-score', await question('basic-no-score'), { status: 'failed' })
  const attack = await question('attack', { category: 'adversarial', role: 'attack', scenarioId: 'scenario' })
  await arena(await submission('historical-attack-100', attack, { score: 100 }), 100, false)
  const active = await arena(await submission('current-attack-0', attack, { score: 0 }), 0, true)
  await submission('rejected-attack', attack, { status: 'baseline_failed' })
  await prisma.arenaEvaluation.create({
    data: {
      submissionId: 'current-attack-0',
      algorithmId: active.id,
      scenarioId: 'scenario',
      role: 'attack',
      evaluationVersion: 'v1',
      kind: 'recompute',
      status: 'error',
    },
  })
  const retiredArena = await question('arena-archived', {
    category: 'adversarial',
    role: 'defense',
    scenarioId: 'retired',
    status: 'archived',
  })
  await arena(await submission('retired-arena-100', retiredArena, { score: 100 }), 100, true)
  await submission(
    'arena-pending',
    await question('arena-pending', {
      category: 'adversarial',
      role: 'defense',
      scenarioId: 'pending',
    }),
    { status: 'baseline' },
  )
  await submission(
    'arena-no-score',
    await question('arena-no-score', {
      category: 'adversarial',
      role: 'attack',
      scenarioId: 'unqualified',
    }),
    { status: 'baseline_failed' },
  )
  await prisma.basicTotal.create({ data: { userId: 'alice', totalScore: 90, tasksCompleted: 2 } })
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

test('administrator-only list/detail reject anonymous and student callers; non-students return 404', async () => {
  for (const route of ['/admin/student-scores', '/admin/student-scores/alice']) {
    assert.equal((await request(route, '')).status, 403)
    assert.equal((await request(route, studentToken)).status, 403)
  }
  assert.equal((await request('/admin/student-scores/admin')).status, 404)
  assert.equal((await request('/admin/student-scores/missing')).status, 404)
})

test('paged student list includes empty students and searches username, display name and leading-zero student id', async () => {
  const first = (await request('/admin/student-scores?page=1&pageSize=1')).body.data
  const second = (await request('/admin/student-scores?page=2&pageSize=1')).body.data
  assert.equal(first.total, 3)
  assert.equal(first.page, 1)
  assert.equal(first.pageSize, 1)
  assert.equal(first.students[0].userId, 'alice')
  assert.equal(second.students[0].userId, 'bob')
  assert.equal(second.students[0].submittedQuestionCount, 0)
  assert.equal(second.students[0].basicTotalScore, 0)
  assert.equal(second.students[0].lastSubmittedAt, null)
  for (const term of ['ALICE', '张小明', '0007']) {
    const result = (await request(`/admin/student-scores?search=${encodeURIComponent(term)}`)).body.data
    assert.equal(result.total, 1)
    assert.equal(result.students[0].userId, 'alice')
  }
  assert.equal((await request('/admin/student-scores?page=0')).status, 400)
  assert.equal((await request('/admin/student-scores?pageSize=2.5')).status, 400)
  assert.equal((await request('/admin/student-scores?pageSize=500')).body.data.pageSize, 100)
  assert.deepEqual((await request('/admin/student-scores/bob')).body.data.questions, [])
})

test('basic current ledger wins over earlier version, lower latest score and pending submission; archived basic points stay valid', async () => {
  const detail = (await request('/admin/student-scores/alice')).body.data
  const best = detail.questions.find((q: any) => q.questionId === 'basic-best')
  assert.equal(best.score, 70)
  assert.equal(best.scoreKind, 'best')
  assert.equal(best.state, 'scored')
  assert.equal(best.updating, true)
  assert.equal(best.scoringSubmissionId, 'current-best-70')
  assert.equal(best.latestSubmission.id, 'latest-queued')
  assert.equal(best.submissionCount, 4)
  assert.equal(best.currentSubmissionCount, 3)
  const archived = detail.questions.find((q: any) => q.questionId === 'basic-archived')
  assert.equal(archived.questionStatus, 'archived')
  assert.equal(archived.score, 20)
  assert.equal(archived.state, 'scored')
  assert.equal(detail.student.basicTotalScore, 90)
  assert.equal(detail.student.basicScoredQuestionCount, 3)
  assert.equal(detail.student.submittedQuestionCount, 11)
  const leaderboard = (await request('/leaderboard')).body.data
  assert.equal(leaderboard.find((s: any) => s.userId === 'alice').totalScore, detail.student.basicTotalScore)
  const listed = (await request('/admin/student-scores?search=0007')).body.data.students[0]
  assert.deepEqual(listed, detail.student)
})

test('a completed current protocol zero remains a scored zero even without a BasicScore ledger row', async () => {
  assert.equal(await prisma.basicScore.count({ where: { userId: 'carol' } }), 0)
  const detail = (await request('/admin/student-scores/carol')).body.data
  assert.equal(detail.questions[0].score, 0)
  assert.equal(detail.questions[0].state, 'scored')
  assert.equal(detail.questions[0].scoringSubmissionId, 'carol-zero')
  assert.equal(detail.student.basicTotalScore, 0)
  assert.equal(detail.student.basicScoredQuestionCount, 1)
})

test('arena displays active slot dynamic zero rather than historical 100, retaining score while a recalculation has failed', async () => {
  const detail = (await request('/admin/student-scores/alice')).body.data
  const row = detail.questions.find((q: any) => q.questionId === 'attack')
  assert.equal(row.score, 0)
  assert.equal(row.scoreKind, 'current')
  assert.equal(row.state, 'scored')
  assert.equal(row.scoringSubmissionId, 'current-attack-0')
  assert.equal(row.latestSubmission.id, 'rejected-attack')
  assert.equal(row.latestSubmission.status, 'baseline_failed')
  assert.equal(row.updating, true)
  assert.equal(detail.student.basicTotalScore, 90)
  const retired = detail.questions.find((q: any) => q.questionId === 'arena-archived')
  assert.equal(retired.score, null)
  assert.equal(retired.state, 'outdated')
  assert.equal(retired.latestSubmission.score, 100)
  assert.equal(retired.updating, false)
})

test('all submitted questions remain visible with pending, unscored, version-expired and legacy states', async () => {
  const detail = (await request('/admin/student-scores/alice')).body.data
  const expected = new Map([
    ['basic-pending', 'pending'],
    ['arena-pending', 'pending'],
    ['basic-no-score', 'no_score'],
    ['arena-no-score', 'no_score'],
    ['basic-outdated', 'outdated'],
    ['basic-legacy', 'outdated'],
  ])
  for (const [id, state] of expected) {
    const row = detail.questions.find((q: any) => q.questionId === id)
    assert.ok(row, id)
    assert.equal(row.state, state, id)
    assert.equal(row.score, null, id)
  }
  const outdated = detail.questions.find((q: any) => q.questionId === 'basic-outdated')
  assert.equal(outdated.currentSubmissionCount, 0)
  assert.equal(outdated.latestSubmission.questionVersion, 1)
  assert.equal(outdated.questionVersion, 2)
  assert.equal(outdated.latestSubmission.score, 99)
})

test('response whitelist excludes student source, parameter paths, internal results, frozen config and passwords', async () => {
  const detail = (await request('/admin/student-scores/alice')).body.data
  const list = (await request('/admin/student-scores')).body.data
  const serialized = JSON.stringify({ detail, list })
  assert.doesNotMatch(
    serialized,
    /DO_NOT_EXPOSE|test-only-password|"password"|"configSnapshot"|"filePath"|"code"/,
  )
  assert.deepEqual(Object.keys(detail.questions[0].latestSubmission).sort(), [
    'createdAt',
    'id',
    'questionVersion',
    'score',
    'status',
  ])
})

test('unpublished draft package edits preserve the prior revision frozen zero score and pending submission status', async () => {
  await prisma.question.update({
    where: { id: 'basic-zero' },
    data: {
      status: 'draft',
      definition: JSON.stringify({ evaluation: { packageId: 'different-draft-package' } }),
    },
  })
  await prisma.question.update({
    where: { id: 'basic-pending' },
    data: {
      status: 'draft',
      definition: JSON.stringify({ evaluation: { packageId: 'different-draft-package' } }),
    },
  })
  const carol = (await request('/admin/student-scores/carol')).body.data
  assert.equal(carol.questions[0].questionStatus, 'draft')
  assert.equal(carol.questions[0].questionVersion, 1)
  assert.equal(carol.questions[0].state, 'scored')
  assert.equal(carol.questions[0].score, 0)
  assert.equal(carol.questions[0].scoringSubmissionId, 'carol-zero')
  assert.equal(carol.student.basicScoredQuestionCount, 1)
  const alice = (await request('/admin/student-scores/alice')).body.data
  const pending = alice.questions.find((q: any) => q.questionId === 'basic-pending')
  assert.equal(pending.questionStatus, 'draft')
  assert.equal(pending.state, 'pending')
  assert.equal(pending.updating, true)
})

test('changing a scored basic question into an unpublished adversarial draft preserves the published scoring identity and total', async () => {
  const { saveQuestion } = await import('../src/services/questions.js')
  const draft = await saveQuestion(
    'basic-best',
    {
      status: 'draft',
      category: 'adversarial',
      role: 'attack',
      scenarioId: 'unpublished-arena',
    },
    'admin',
  )
  assert.equal(draft.revision, 2)
  assert.equal(draft.category, 'adversarial')
  const detail = (await request('/admin/student-scores/alice')).body.data
  const row = detail.questions.find((q: any) => q.questionId === 'basic-best')
  assert.equal(row.questionStatus, 'draft')
  assert.equal(row.category, 'basic')
  assert.equal(row.role, null)
  assert.equal(row.scoreKind, 'best')
  assert.equal(row.score, 70)
  assert.equal(row.scoringSubmissionId, 'current-best-70')
  assert.equal(row.currentSubmissionCount, 3)
  assert.equal(detail.student.basicTotalScore, 90)
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'alice' } })).totalScore, 90)
  const listed = (await request('/admin/student-scores?search=0007')).body.data.students[0]
  assert.equal(listed.basicTotalScore, detail.student.basicTotalScore)
})
