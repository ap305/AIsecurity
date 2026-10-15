import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultDefinition, type QuestionRecord } from './prdApi'
import { filterHallQuestions, hallPage, questionAttemptState } from './hallFilters'

function question(id: string, extra: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id,
    title: id,
    category: 'basic',
    revision: 1,
    difficulty: 'L1',
    definition: defaultDefinition(),
    ...extra,
  }
}
test('zero is a scored result while running/error attempts retain their distinct latest state', () => {
  assert.equal(questionAttemptState(question('A', { myScore: 0 })), 'scored')
  assert.equal(questionAttemptState(question('A', { attempted: true, myScore: null })), 'attempted')
  assert.equal(questionAttemptState(question('A', { hasHistoricalAttempts: true })), 'not_submitted')
  assert.equal(questionAttemptState(question('A', { myScore: 80, latestSubmissionStatus: 'error' })), 'error')
  assert.equal(
    questionAttemptState(question('A', { myScore: 80, latestSubmissionStatus: 'baseline' })),
    'running',
  )
})
test('old scenario links and fixed roles combine with search, type and score filters', () => {
  const definition = defaultDefinition()
  definition.kind = 'agent'
  const rows = [
    question('CHATOPS-AD-ATK', {
      category: 'adversarial',
      title: 'ChatOps 攻击',
      definition: { ...definition, role: 'attack', scenarioId: 'chatops' },
      myScore: 0,
    }),
    question('CHATOPS-AD-DEF', {
      category: 'adversarial',
      definition: { ...definition, role: 'defense', scenarioId: 'chatops' },
    }),
    question('WEBBOT-AD-ATK', {
      category: 'adversarial',
      definition: { ...definition, role: 'attack', scenarioId: 'webbot' },
    }),
  ]
  assert.deepEqual(
    filterHallQuestions(
      rows,
      new URLSearchParams('scenario=chatops&role=attack&kind=agent&state=scored&q=CHATOPS'),
    ).map((q) => q.id),
    ['CHATOPS-AD-ATK'],
  )
  assert.equal(filterHallQuestions(rows, new URLSearchParams('scenario=unknown')).length, 0)
  assert.equal(
    filterHallQuestions(rows, new URLSearchParams('scenario=chatops&role=defense&state=scored')).length,
    0,
  )
})
test('score ordering distinguishes null from a valid zero and does not mutate source rows', () => {
  const rows = [question('none'), question('zero', { myScore: 0 }), question('high', { myScore: 80 })]
  assert.deepEqual(
    filterHallQuestions(rows, new URLSearchParams('sort=score')).map((q) => q.id),
    ['high', 'zero', 'none'],
  )
  assert.deepEqual(
    rows.map((q) => q.id),
    ['none', 'zero', 'high'],
  )
})
test('invalid and stale page positions stay inside the filtered result range', () => {
  for (const raw of [null, 'NaN', '-1', '1.5', '0', 'Infinity']) assert.equal(hallPage(raw, 21, 20).page, 1)
  assert.deepEqual(hallPage('999', 21, 20), { page: 2, pages: 2 })
  assert.deepEqual(hallPage('2', 0, 20), { page: 1, pages: 1 })
})
