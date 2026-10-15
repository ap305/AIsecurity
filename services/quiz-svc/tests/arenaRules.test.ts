import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateArenaResults,
  arenaScoreReachedAt,
  baselineQualified,
  compareSubmissionOrder,
  isCurrentArenaSubmission,
  opponentFingerprint,
  oppositeRole,
  parseArenaSnapshot,
  type ArenaEvaluationConfig,
  pairwiseSucceeded,
} from '../src/services/arenaRules.js'

const config: ArenaEvaluationConfig = {
  packageId: 'package',
  baselineMetric: 'accuracy',
  baselineThreshold: 0.8,
  successMetric: 'successRatio',
  successThreshold: 0.5,
}

test('baseline equality qualifies; below threshold does not', () => {
  assert.equal(baselineQualified({ accuracy: 0.8 }, config), true)
  assert.equal(baselineQualified({ accuracy: 0.7999 }, config), false)
})

test('configured opponent success metric uses >= and missing metric never becomes a normal loss', () => {
  assert.equal(pairwiseSucceeded({ successRatio: 0.5 }, config), true)
  assert.equal(pairwiseSucceeded({ successRatio: 0.49 }, config), false)
  assert.equal(pairwiseSucceeded({ successRatio: 0.6 }, { ...config, successThreshold: 0.7 }), false)
  assert.throws(() => pairwiseSucceeded({ successRatio: NaN }, config))
  assert.throws(() => pairwiseSucceeded({ anotherMetric: 1 }, config))
})

test('missing, string and nonfinite qualification metrics are platform errors', () => {
  for (const accuracy of [undefined, '1', NaN, Infinity]) {
    assert.throws(() => baselineQualified({ accuracy }, config), /基线指标/)
  }
})

test('empty qualified opponent pool is an explicit 100%, never 0/0', () => {
  assert.deepEqual(aggregateArenaResults([], []), {
    score: 100,
    successCount: 0,
    opponentCount: 0,
    emptyPool: true,
  })
})

test('six successes against eight distinct users is 75%; normal losses stay in denominator', () => {
  const ids = Array.from({ length: 8 }, (_, index) => `opponent-${index}`)
  const result = aggregateArenaResults(
    ids,
    ids.map((opponentId, index) => ({ opponentId, status: 'completed', success: index < 6 })),
  )
  assert.deepEqual(result, { score: 75, successCount: 6, opponentCount: 8, emptyPool: false })
})

test('a normal all-loss evaluation is valid 0%', () => {
  assert.deepEqual(aggregateArenaResults(['a'], [{ opponentId: 'a', status: 'completed', success: false }]), {
    score: 0,
    successCount: 0,
    opponentCount: 1,
    emptyPool: false,
  })
})

test('new opponent changes 6/8 to 6/9 or 7/9', () => {
  const ids = Array.from({ length: 9 }, (_, i) => String(i))
  const calculate = (wins: number) =>
    aggregateArenaResults(
      ids,
      ids.map((opponentId, i) => ({ opponentId, status: 'completed', success: i < wins })),
    ).score
  assert.equal(calculate(6), 66.66666667)
  assert.equal(calculate(7), 77.77777778)
})

test('errors, timeouts, missing opponents and duplicate results never publish partial scores', () => {
  assert.throws(() =>
    aggregateArenaResults(['a', 'b'], [{ opponentId: 'a', status: 'completed', success: true }]),
  )
  for (const status of ['timeout', 'student_error', 'system_error', 'queued']) {
    assert.throws(() => aggregateArenaResults(['a'], [{ opponentId: 'a', status, success: false }]))
  }
  assert.throws(() => aggregateArenaResults(['a'], [{ opponentId: 'a', status: 'completed' }]))
  assert.throws(() =>
    aggregateArenaResults(
      ['a', 'b'],
      [
        { opponentId: 'a', status: 'completed', success: true },
        { opponentId: 'a', status: 'completed', success: false },
      ],
    ),
  )
  assert.throws(() =>
    aggregateArenaResults(
      ['a', 'a'],
      [
        { opponentId: 'a', status: 'completed', success: true },
        { opponentId: 'a', status: 'completed', success: false },
      ],
    ),
  )
})

test('same formal score preserves reached time; decrease and increase update it', () => {
  const old = new Date('2026-10-14T01:00:00Z'),
    now = new Date('2026-10-14T02:00:00Z')
  assert.equal(arenaScoreReachedAt({ score: 75, achievedAt: old }, 75, now), old)
  assert.equal(arenaScoreReachedAt({ score: 75, achievedAt: old }, 0, now), now)
  assert.equal(arenaScoreReachedAt({ score: 75, achievedAt: old }, 100, now), now)
  assert.equal(arenaScoreReachedAt(null, 0, now), now)
})

test('snapshot fingerprints are insensitive to order and change when algorithm version changes', () => {
  assert.equal(opponentFingerprint(['a', 'b']), opponentFingerprint(['b', 'a']))
  assert.notEqual(opponentFingerprint(['a', 'b']), opponentFingerprint(['a-v2', 'b']))
})

test('later submissions win; equal timestamps have deterministic ordering', () => {
  const date = new Date()
  assert.ok(compareSubmissionOrder({ id: 'b', createdAt: date }, { id: 'a', createdAt: date }) > 0)
  assert.ok(
    compareSubmissionOrder({ id: 'a', createdAt: new Date(2) }, { id: 'b', createdAt: new Date(1) }) > 0,
  )
  assert.equal(oppositeRole('attack'), 'defense')
})

test('stale published versions, incompatible rules, mismatched roles and unpublished tasks are ineligible', () => {
  const submission = { questionVersion: 2, evaluationVersion: 'v2', role: 'attack', scenarioId: 'scene' }
  const question = {
    revision: 2,
    evaluationVersion: 'v2',
    role: 'attack',
    scenarioId: 'scene',
    category: 'adversarial',
    status: 'published',
  }
  assert.equal(isCurrentArenaSubmission(submission, question), true)
  for (const override of [
    { revision: 3 },
    { evaluationVersion: 'v3' },
    { role: 'defense' },
    { scenarioId: 'other' },
    { category: 'basic' },
    { status: 'draft' },
  ]) {
    assert.equal(isCurrentArenaSubmission(submission, { ...question, ...override }), false)
  }
})

test('snapshot requires fixed role, environment and finite baseline declaration', () => {
  const value = {
    questionId: 'q',
    questionVersion: 1,
    category: 'adversarial',
    role: 'attack',
    scenarioId: 'scene',
    evaluationVersion: 'v1',
    definition: { evaluation: config },
  }
  assert.equal(parseArenaSnapshot(JSON.stringify(value)).role, 'attack')
  for (const override of [
    { category: 'basic' },
    { role: 'solo_attack' },
    { scenarioId: '' },
    { questionVersion: 0 },
    { definition: { evaluation: { ...config, packageId: '' } } },
  ]) {
    assert.throws(() => parseArenaSnapshot(JSON.stringify({ ...value, ...override })))
  }
})
