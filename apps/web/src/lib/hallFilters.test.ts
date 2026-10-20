import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultDefinition, type QuestionRecord } from './prdApi'
import {
  filterHallQuestions,
  resetHallFilters,
  hallLibraryQuestions,
  hallFilterParams,
  hallPage,
  hallScenarios,
  questionAttemptState,
  questionLibraryType,
  questionLibraryLabel,
  questionModuleLabel,
  isCurrentLibraryQuestion,
} from './hallFilters'

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

test('resetting attack and defense filters keeps the selected library and clears stale pagination', () => {
  const reset = resetHallFilters
  assert.equal(typeof reset, 'function', 'reset action must preserve the current library')
  for (const role of ['attack', 'defense']) {
    const input = new URLSearchParams(`role=${role}&q=test&page=5&scenario=one&sort=score`)
    assert.equal(reset(input, 'adversarial').toString(), `role=${role}`)
    assert.equal(input.get('page'), '5')
  }
  assert.equal(reset(new URLSearchParams('role=attack&q=test'), 'basic').toString(), '')
})

test('library progress counts the selected role while search filters do not change its total', () => {
  const scope = hallLibraryQuestions
  assert.equal(typeof scope, 'function', 'progress must use the current library scope')
  const rows = [
    question('A', { category: 'adversarial', role: 'attack', myScore: 0 }),
    question('D', { category: 'adversarial', role: 'defense', myScore: 100 }),
    question('B', { category: 'basic' }),
  ]
  const selected = scope(rows, 'adversarial', new URLSearchParams('role=attack&q=missing'))
  assert.deepEqual(
    selected.map((q: QuestionRecord) => q.id),
    ['A'],
  )
  assert.equal(selected[0].myScore, 0)
  assert.deepEqual(
    scope(rows, 'basic', new URLSearchParams('role=defense')).map((q: QuestionRecord) => q.id),
    ['B'],
  )
})

test('legacy role and module query parameters cannot hide basic questions', () => {
  const normalize = hallFilterParams
  assert.equal(typeof normalize, 'function', 'stale bookmark parameters need normalization')
  const original = new URLSearchParams('role=attack&module=M3&q=activation')
  const params = normalize(original, 'basic')
  assert.equal(params.get('role'), null)
  assert.equal(params.get('module'), null)
  assert.equal(params.get('q'), 'activation')
  assert.equal(original.get('role'), 'attack')
  assert.equal(normalize(new URLSearchParams('role=invalid'), 'adversarial').get('role'), null)
})
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

test('retired module bookmarks cannot hide newly published basic questions', () => {
  const rows = [
    question('V3-261012-B01', { moduleCode: 'AI_BASIC_V3' }),
    question('V3-261012-B02', { moduleCode: 'AI_BASIC_V3' }),
  ]
  for (const module of ['M1', 'M2', 'M3', 'M4', 'M5']) {
    assert.equal(filterHallQuestions(rows, new URLSearchParams({ module })).length, 2)
    assert.notEqual(questionModuleLabel(module), module)
  }
  assert.equal(filterHallQuestions(rows, new URLSearchParams('q=not-present&module=M1')).length, 0)
})

test('teacher and student library classifications use basic, attack, and defense rather than module codes', () => {
  assert.equal(questionLibraryType(question('B', { moduleCode: 'M1' })), 'basic')
  const attack = question('A', { category: 'adversarial', role: 'attack', moduleCode: 'M4' })
  const defense = question('D', {
    category: 'adversarial',
    definition: { ...defaultDefinition(), role: 'defense' },
  })
  assert.equal(questionLibraryLabel(attack), '攻击题')
  assert.equal(questionLibraryLabel(defense), '防御题')
  assert.deepEqual(
    filterHallQuestions([attack, defense], new URLSearchParams('role=attack')).map((q) => q.id),
    ['A'],
  )
  assert.deepEqual(
    filterHallQuestions([attack, defense], new URLSearchParams('role=defense')).map((q) => q.id),
    ['D'],
  )
})

test('teacher library excludes every M1-M5 question regardless of status or legacy ID', () => {
  assert.equal(isCurrentLibraryQuestion({ id: 'LENET-01', moduleCode: 'M1', status: 'pending' }), false)
  assert.equal(isCurrentLibraryQuestion({ id: 'M1-T-01', moduleCode: 'M1', status: 'archived' }), false)
  for (const row of [
    { id: 'V3-261012-B01', moduleCode: 'AI_BASIC_V3', status: 'draft' },
    { id: 'custom-task', moduleCode: 'GENERAL', status: 'draft' },
  ])
    assert.equal(isCurrentLibraryQuestion(row), true)
  for (const moduleCode of ['M1', 'M2', 'M3', 'M4', 'M5'])
    for (const status of ['pending', 'draft', 'review', 'published', 'archived'])
      assert.equal(isCurrentLibraryQuestion({ id: 'legacy-without-module-prefix', moduleCode, status }), false)
})
