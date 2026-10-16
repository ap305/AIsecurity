import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultDefinition, type QuestionRecord } from './prdApi'
import { filterHallQuestions, hallPage, hallScenarios, questionAttemptState } from './hallFilters'

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

test('new course scenarios remain discoverable alongside legacy scenarios and filter both roles', () => {
  const rows = ['attack', 'defense'].map((role) =>
    question(`V3-261012-${role === 'attack' ? 'A' : 'D'}01`, {
      category: 'adversarial',
      moduleCode: 'AI_SECURITY_V3',
      title: `标签翻转 · ${role === 'attack' ? '攻击' : '防御'}`,
      definition: {
        ...defaultDefinition(),
        role: role as 'attack' | 'defense',
        scenarioId: 'V3-261012-ML01',
      },
    }),
  )
  rows.push(
    question('CHATOPS-AD-ATK', {
      category: 'adversarial',
      definition: { ...defaultDefinition(), role: 'attack' },
    }),
  )
  assert.deepEqual(
    hallScenarios(rows).map((s) => [s.id, s.title, s.group]),
    [
      ['V3-261012-ML01', '标签翻转', '模型安全'],
      ['chatops', 'ChatOps 运维', 'Agent 攻防'],
    ],
  )
  assert.equal(filterHallQuestions(rows, new URLSearchParams('scenario=V3-261012-ML01')).length, 2)
  assert.deepEqual(
    filterHallQuestions(rows, new URLSearchParams('group=模型安全&role=defense&q=模型安全')).map((q) => q.id),
    ['V3-261012-D01'],
  )
})
