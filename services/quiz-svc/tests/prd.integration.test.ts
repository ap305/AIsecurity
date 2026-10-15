import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase } from './database.js'
let database: Awaited<ReturnType<typeof createTestDatabase>>
let prisma: (typeof import('../src/lib/db.js'))['prisma']
let scores: typeof import('../src/services/basicScores.js')
let leaderboard: typeof import('../src/services/leaderboard.js')
before(async () => {
  database = await createTestDatabase()
  prisma = (await import('../src/lib/db.js')).prisma
  scores = await import('../src/services/basicScores.js')
  leaderboard = await import('../src/services/leaderboard.js')
  await prisma.user.createMany({
    data: ['first', 'second'].map((id) => ({ id, username: id, displayName: id, password: 'unused' })),
  })
  await prisma.question.create({
    data: {
      id: 'basic',
      moduleCode: 'T',
      number: 1,
      title: '题',
      content: '题面',
      type: 'code',
      difficulty: 'L1',
      category: 'basic',
    },
  })
})
after(async () => {
  await prisma?.$disconnect()
  await database?.close()
})
async function submit(id: string, userId = 'first', version = 1) {
  return prisma.submission.create({
    data: { id, userId, questionId: 'basic', questionVersion: version, code: 'answer', status: 'judging' },
  })
}
test('AC-15: 70→85→60 only increases total; duplicate result is idempotent', async () => {
  await submit('s70')
  await scores.recordBasicResult('s70', 70, {}, new Date('2026-01-01T00:00:00Z'))
  await submit('s85')
  await scores.recordBasicResult('s85', 85, {}, new Date('2026-01-02T00:00:00Z'))
  await submit('s60')
  await scores.recordBasicResult('s60', 60, {}, new Date('2026-01-03T00:00:00Z'))
  await scores.recordBasicResult('s85', 85, {}, new Date('2026-01-04T00:00:00Z'))
  const total = await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'first' } })
  assert.equal(total.totalScore, 85)
  assert.equal(total.tasksCompleted, 1)
  assert.equal(total.scoreReachedAt.toISOString(), '2026-01-02T00:00:00.000Z')
})
test('AC-21: same total uses achieved time; profile update does not reorder', async () => {
  await submit('second85', 'second')
  await scores.recordBasicResult('second85', 85, {}, new Date('2026-01-03T00:00:00Z'))
  await prisma.user.update({ where: { id: 'first' }, data: { displayName: 'updated' } })
  const rows = await leaderboard.getLeaderboard()
  assert.deepEqual(
    rows.map((x) => x.userId),
    ['first', 'second'],
  )
  assert.equal((await leaderboard.getMyRank('second'))?.rank, 2)
})
test('AC-19: version reset subtracts contribution and late old result cannot restore it', async () => {
  await submit('late')
  const tx = await import('../src/lib/transaction.js')
  await tx.transaction(async (t) => {
    await scores.resetQuestionScores(t, 'basic')
    await t.question.update({ where: { id: 'basic' }, data: { revision: 2 } })
  })
  await scores.recordBasicResult('late', 100, {})
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'first' } })).totalScore, 0)
  assert.equal(await prisma.basicScore.count(), 0)
  assert.equal((await prisma.submission.findUniqueOrThrow({ where: { id: 's85' } })).score, 85)
  await submit('new90', 'first', 2)
  await scores.recordBasicResult('new90', 90, {})
  assert.equal((await prisma.basicTotal.findUniqueOrThrow({ where: { userId: 'first' } })).totalScore, 90)
})
test('AC-15: old mixed UserScore never participates in new basic leaderboard', async () => {
  await prisma.userScore.create({ data: { userId: 'second', displayName: 'second', totalScore: 99999 } })
  assert.equal((await leaderboard.getLeaderboard())[0].userId, 'first')
})
test('AC-16: optional profile accepts blanks and preserves student ID leading zeros', async () => {
  const { validateOptionalProfile } = await import('../src/lib/prdContract.js')
  assert.deepEqual(validateOptionalProfile({}), { studentId: null, phone: null })
  assert.equal(validateOptionalProfile({ studentId: '001234', phone: '+8613812345678' }).studentId, '001234')
  assert.throws(() => validateOptionalProfile({ phone: 'invalid' }))
})
test('AC-14/22: fixed binding overrides all caller-selected model and sampling fields', async () => {
  const { fixedModelPayload } = await import('../src/services/apiPool.js')
  const binding = {
    poolId: 'p',
    revision: 1,
    name: 'model',
    kind: 'llm',
    model: 'qwen3-8b',
    modelVersion: '1',
    baseUrl: 'http://localhost',
    credentialEnv: null,
    parameters: { temperature: 0, max_tokens: 50, enable_thinking: false },
  }
  const payload = fixedModelPayload(binding, {
    model: 'other',
    temperature: 1,
    max_tokens: 100000,
    apiKey: 'caller',
    enable_thinking: true,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(payload.model, 'qwen3-8b')
  assert.equal(payload.temperature, 0)
  assert.equal(payload.max_tokens, 50)
  assert.equal(payload.apiKey, undefined)
  assert.equal(payload.enable_thinking, false)
})
test('AC-12: backend clock expires exactly at lease end', async () => {
  const { leaseState, LEASE_MS } = await import('../src/services/teacherLeases.js')
  const row = { state: 'active', expiresAt: new Date(LEASE_MS) }
  assert.equal(leaseState(row, new Date(LEASE_MS - 1)), 'active')
  assert.equal(leaseState(row, new Date(LEASE_MS)), 'expired')
  assert.equal(leaseState({ ...row, state: 'revoked' }, new Date(0)), 'revoked')
})
