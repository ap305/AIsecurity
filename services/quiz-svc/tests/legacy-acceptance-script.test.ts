import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_ACCEPTANCE_IDS,
  assertPublishedLegacyQuestion,
  assertCountedArenaScore,
  expectedLegacyArenaScore,
  assertAdminLegacyScores,
} from '../scripts/acceptanceLegacyCourses.js'

function course() {
  const evaluation = {
    version: 'legacy-v2-rpc-1',
    baselineMetric: 'qualificationMetric',
    baselineThreshold: 0.6,
    successMetric: 'successMetric',
    successThreshold: 0.05,
    timeoutMs: 30000,
    repetitions: 1,
  }
  const definition = {
    kind: 'algorithm',
    llm: { enabled: false },
    teacherApi: { enabled: false },
    evaluation,
  }
  return {
    row: { questionId: 'CHATOPS-AD-ATK', role: 'attack', scenarioId: 'chatops' },
    frozen: {
      before: { revision: 1 },
      published: { revision: 2 },
      packageId: 'trusted-package',
      definition: structuredClone(definition),
    },
    question: {
      id: 'CHATOPS-AD-ATK',
      category: 'adversarial',
      status: 'published',
      role: 'attack',
      scenarioId: 'chatops',
      revision: 2,
      evaluationVersion: 'legacy-v2-rpc-1',
      answerTemplate: 'def attack(env): pass',
      definition,
    },
  }
}
test('legacy acceptance scope contains all twenty distinct original slots', () => {
  assert.equal(LEGACY_ACCEPTANCE_IDS.length, 20)
  assert.equal(new Set(LEGACY_ACCEPTANCE_IDS).size, 20)
})
test('public question contract requires frozen revision, role, scenario and inclusive thresholds', () => {
  const { question, row, frozen } = course()
  assert.doesNotThrow(() => assertPublishedLegacyQuestion(question, row, frozen))
  for (const [field, value] of [
    ['revision', 3],
    ['role', 'defense'],
    ['scenarioId', 'other'],
  ]) {
    assert.throws(() => assertPublishedLegacyQuestion({ ...question, [String(field)]: value }, row, frozen))
  }
  for (const field of ['baselineThreshold', 'successThreshold']) {
    const changed = structuredClone(question) as any
    changed.definition.evaluation[field] += 0.001
    assert.throws(() => assertPublishedLegacyQuestion(changed, row, frozen))
  }
})
test('public view rejects hidden grader references, pool IDs and solutions', () => {
  const { question, row, frozen } = course()
  for (const field of [
    'packageId',
    'baselineCode',
    'baselineFixture',
    'baselineWeightFixture',
    'calibrationMode',
  ]) {
    const changed = structuredClone(question) as any
    changed.definition.evaluation[field] = 'private-material'
    assert.throws(() => assertPublishedLegacyQuestion(changed, row, frozen))
  }
  const privatePool = structuredClone(question) as any
  privatePool.definition.llm.poolId = 'private-pool'
  assert.throws(() => assertPublishedLegacyQuestion(privatePool, row, frozen))
  assert.throws(() => assertPublishedLegacyQuestion({ ...question, solution: 'answer' }, row, frozen))
})
test('admin view requires the exact published package and cannot retain calibration mode', () => {
  const { question, row, frozen } = course()
  const admin = structuredClone(question) as any
  admin.definition.evaluation.packageId = frozen.packageId
  frozen.definition.evaluation = { ...frozen.definition.evaluation, packageId: frozen.packageId } as any
  assert.doesNotThrow(() => assertPublishedLegacyQuestion(admin, row, frozen, false))
  admin.definition.evaluation.packageId = 'other'
  assert.throws(() => assertPublishedLegacyQuestion(admin, row, frozen, false))
  admin.definition.evaluation.packageId = frozen.packageId
  admin.definition.evaluation.calibrationMode = true
  assert.throws(() => assertPublishedLegacyQuestion(admin, row, frozen, false))
})
const score = (opponentCount: number, successCount: number, points: number) => ({
  counted: true,
  qualified: true,
  updating: false,
  status: 'completed',
  activeSubmissionId: 'sub',
  opponentCount,
  successCount,
  emptyPool: opponentCount === 0,
  score: points,
})
test('empty qualified pools require counted 100 and do not accept an unqualified result', () => {
  assert.doesNotThrow(() => assertCountedArenaScore(score(0, 0, 100), 'sub', 0, 100))
  assert.throws(() => assertCountedArenaScore(score(0, 0, 0), 'sub', 0))
  assert.throws(() => assertCountedArenaScore({ ...score(0, 0, 100), qualified: false }, 'sub', 0))
})
test('normal failed opponent stays in the denominator and is a counted zero', () => {
  assert.doesNotThrow(() => assertCountedArenaScore(score(1, 0, 0), 'sub', 1, 0))
  assert.throws(() =>
    assertCountedArenaScore({ ...score(1, 0, 0), counted: false, score: null }, 'sub', 1, 0),
  )
  assert.throws(() => assertCountedArenaScore(score(0, 0, 100), 'sub', 1))
  assert.throws(() => assertCountedArenaScore(score(1, 2, 200), 'sub', 1))
  assert.throws(() => assertCountedArenaScore(score(1, 0, 0), 'stale-submission', 1))
})

function verifiedOpponent(success: unknown) {
  return {
    verifiedAt: '2026-10-15T00:00:00Z',
    verifiedMaterial: { codeDigest: 'same-verified-code' },
    verification: {
      opponent: {
        codeDigest: 'same-verified-code',
        record: { status: 'completed', result: { status: 'completed', cleanupStatus: 'cleaned', success } },
      },
    },
  }
}

test('four live course scores bind to frozen opponent outcomes, independently for each role', () => {
  assert.equal(expectedLegacyArenaScore('CHATOPS-AD-ATK', verifiedOpponent(false)), 0)
  assert.equal(expectedLegacyArenaScore('CHATOPS-AD-DEF', verifiedOpponent(true)), 100)
  assert.throws(() => expectedLegacyArenaScore('CHATOPS-AD-ATK', verifiedOpponent(true)))
  assert.throws(() => expectedLegacyArenaScore('CHATOPS-AD-DEF', verifiedOpponent(false)))
  for (const id of ['MNIST-BD', 'MNIST-BD-DEF']) {
    const expected = expectedLegacyArenaScore(id, verifiedOpponent(false))
    assert.equal(expected, 0)
    assert.doesNotThrow(() => assertCountedArenaScore(score(1, 0, 0), 'sub', 1, expected))
    assert.throws(() => assertCountedArenaScore(score(1, 1, 100), 'sub', 1, expected))
    assert.equal(expectedLegacyArenaScore(id, verifiedOpponent(true)), 100)
    // No-opponent admission is 100 even when the frozen real-opponent result is a loss.
    assert.doesNotThrow(() => assertCountedArenaScore(score(0, 0, 100), 'sub', 0, 100))
  }
})

test('frozen opponent expectations reject stale code, incomplete cleanup and missing success', () => {
  for (const mutate of [
    (proof: any) => {
      proof.verifiedAt = undefined
    },
    (proof: any) => {
      proof.verification.opponent.codeDigest = 'different-code'
    },
    (proof: any) => {
      proof.verification.opponent.record.status = 'running'
    },
    (proof: any) => {
      proof.verification.opponent.record.result.status = 'system_error'
    },
    (proof: any) => {
      proof.verification.opponent.record.result.cleanupStatus = 'failed'
    },
    (proof: any) => {
      proof.verification.opponent.record.result.success = undefined
    },
    (proof: any) => {
      proof.verification.opponent.record.result.success = 0
    },
  ]) {
    const proof = verifiedOpponent(false)
    mutate(proof)
    assert.throws(() => expectedLegacyArenaScore('MNIST-BD', proof))
  }
  assert.throws(() => expectedLegacyArenaScore('unrelated-question', verifiedOpponent(true)))
})
function studentDetail() {
  const expected = [
    { questionId: 'CHATOPS-AD-ATK', submissionId: 'chat-sub', revision: 2, score: 0 },
    { questionId: 'MNIST-BD', submissionId: 'mnist-sub', revision: 3, score: 100 },
  ]
  const detail = {
    student: { userId: 'student-a', basicTotalScore: 0, submittedQuestionCount: 2 },
    questions: expected.map((e) => ({
      questionId: e.questionId,
      category: 'adversarial',
      questionVersion: e.revision,
      scoreKind: 'current',
      state: 'scored',
      updating: false,
      score: e.score,
      scoringSubmissionId: e.submissionId,
      submissionCount: 1,
      currentSubmissionCount: 1,
      latestSubmission: { id: e.submissionId },
    })),
  }
  return { detail, expected }
}
test('administrator detail verifies each question independently, including zero', () => {
  const { detail, expected } = studentDetail()
  assert.doesNotThrow(() => assertAdminLegacyScores(detail, 'student-a', expected))
  detail.questions[0].score = 100
  assert.throws(() => assertAdminLegacyScores(detail, 'student-a', expected))
})
test('administrator detail rejects duplicates, stale versions and sensitive submission fields', () => {
  for (const mutate of [
    (d: any) => d.questions[0].submissionCount++,
    (d: any) => d.questions[0].questionVersion--,
    (d: any) => (d.questions[0].latestSubmission.code = 'private code'),
    (d: any) => d.questions.pop(),
  ]) {
    const { detail, expected } = studentDetail()
    mutate(detail)
    assert.throws(() => assertAdminLegacyScores(detail, 'student-a', expected))
  }
})
