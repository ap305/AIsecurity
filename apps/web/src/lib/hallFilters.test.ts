import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultDefinition, type QuestionRecord } from './prdApi'
import { displayQuestionTitle, teachingDifficulty } from './questionPresentation'
import {
  filterHallQuestions,
  hallLibraryQuestions,
  hallFilterParams,
  hallPage,
  hallScene,
  hallSceneLabels,
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

test('role bookmarks narrow a combined catalog and clearing filters shows both roles', () => {
  const rows = (['attack', 'defense'] as const).map(role =>
    question(role, { category: 'adversarial', role, myScore: 0 }),
  )
  for (const role of ['attack', 'defense']) {
    const bookmark = hallFilterParams(new URLSearchParams({ role }), 'adversarial')
    assert.deepEqual(filterHallQuestions(rows, bookmark).map(q => q.role), [role])
  }
  assert.deepEqual(filterHallQuestions(rows, new URLSearchParams()).map(q => q.role), ['attack', 'defense'])
})

test('library scope includes both roles and isolates basic exercises', () => {
  const scope = hallLibraryQuestions
  assert.equal(typeof scope, 'function', 'progress must use the current library scope')
  const rows = [
    question('A', { category: 'adversarial', role: 'attack', myScore: 0 }),
    question('D', { category: 'adversarial', role: 'defense', myScore: 100 }),
    question('B', { category: 'basic' }),
  ]
  const selected = scope(rows, 'adversarial')
  assert.deepEqual(
    selected.map((q: QuestionRecord) => q.id),
    ['A', 'D'],
  )
  assert.equal(selected[0].myScore, 0)
  assert.deepEqual(
    scope(rows, 'basic').map((q: QuestionRecord) => q.id),
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
test('old scenario links and fixed roles combine with search and score filters', () => {
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
      hallFilterParams(new URLSearchParams('scenario=chatops&role=attack&kind=agent&state=scored&q=CHATOPS'), 'adversarial'),
    ).map((q) => q.id),
    ['CHATOPS-AD-ATK'],
  )
  // An unrecognized old scene has no button in the new navigation.
  assert.equal(hallFilterParams(new URLSearchParams('scenario=unknown'), 'adversarial').toString(), '')
  assert.equal(
    filterHallQuestions(rows, new URLSearchParams('scene=agent&role=defense&state=scored')).length,
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

test('old scene links keep supported filters and ignore retired domain and type attributes', () => {
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
    rows.map(q => hallScene(q)),
    ['deep-learning', 'deep-learning', 'agent'],
  )
  const params = hallFilterParams(new URLSearchParams('scenario=V3-261012-ML01&group=模型安全&module=AI_SECURITY_V3&kind=model&page=2'), 'adversarial')
  assert.equal(params.get('scene'), 'deep-learning')
  assert.equal(params.get('scenario'), null)
  assert.equal(params.get('group'), null)
  assert.equal(params.get('module'), null)
  assert.equal(params.get('kind'), null)
  assert.equal(params.get('page'), '2')
  assert.equal(filterHallQuestions(rows, params).length, 2)
  params.set('scene', 'agent')
  assert.equal(filterHallQuestions(rows, params).length, 1)
  assert.deepEqual(
    filterHallQuestions(rows, new URLSearchParams('q=模型安全')),
    [],
  )
})

test('teaching difficulty filters and sorts the 60 imported role entries by their published revisions', () => {
  const rows: QuestionRecord[] = []
  for (let number = 1; number <= 31; number++) {
    if (number === 29) continue
    for (const role of ['A', 'D']) {
      const code = role + String(number).padStart(2, '0')
      rows.push(question('V3-261012-' + code, {
        category: 'adversarial', number, difficulty: 'L3',
        revision: ['A02', 'A08', 'D09', 'A28'].includes(code) ? 3 : 2,
      }))
    }
  }
  const levels = ['L1', 'L2', 'L3']
  const counts = levels.map(difficulty => filterHallQuestions(rows, new URLSearchParams({difficulty})).length)
  assert.deepEqual(counts, [16, 24, 20])
  const sorted = filterHallQuestions(rows, new URLSearchParams('sort=difficulty')).map(teachingDifficulty)
  assert.deepEqual(sorted, [...sorted].sort())
  assert.equal(teachingDifficulty(rows[0]), 'L1')
  assert.equal(teachingDifficulty({ ...rows[0], revision: 3 }), 'L3')
  assert.equal(teachingDifficulty({ ...rows[0], difficulty: 'L2' }), 'L2')
  assert.equal(teachingDifficulty({ ...rows[0], category: 'basic' }), 'L3')
  assert.equal(teachingDifficulty({ ...rows[0], id: 'custom' }), 'L3')
  assert(rows.every(q => q.difficulty === 'L3'))
})

test('arena headings use one full-width role suffix and keep original titles and basic questions intact', () => {
  for (const title of ['标签翻转攻击实验 · 攻击', '标签翻转攻击实验(攻击)', '标签翻转攻击实验（攻击）', '标签翻转攻击实验']) {
    const q = question('V3-261012-A01', { title, category: 'adversarial', role: 'attack' })
    assert.equal(displayQuestionTitle(q), '标签翻转攻击实验（攻击）')
    assert.equal(q.title, title)
  }
  assert.equal(displayQuestionTitle({ title: '自定义 · 攻击', role: 'defense' }), '自定义（防御）')
  assert.equal(displayQuestionTitle({ title: '题目', questionId: 'V3-261012-D04' }), '题目（防御）')
  assert.equal(displayQuestionTitle({ title: '评论 · 攻击', category: 'basic' }), '评论 · 攻击')
})

test('course scene filters partition the 60 official role entries independently of title and exercise kind', () => {
  const rows: QuestionRecord[] = []
  for (let number = 1; number <= 31; number++) {
    if (number === 29) continue
    const suffix = String(number).padStart(2, '0')
    for (const role of ['attack', 'defense'] as const) {
      rows.push(question(`V3-261012-${role === 'attack' ? 'A' : 'D'}${suffix}`, {
        category: 'adversarial', title: '题目', number,
        scenarioId: `V3-261012-${[1, 4, 6, 7].includes(number) ? 'ML' : ''}${suffix}`,
        definition: { ...defaultDefinition(), kind: 'agent', role },
      }))
    }
  }
  const counts = Object.keys(hallSceneLabels).map(scene =>
    filterHallQuestions(rows, new URLSearchParams({ scene })).length,
  )
  assert.deepEqual(counts, [28, 14, 18])
  for (const q of rows) {
    const n = q.number!
    const expected = n >= 14 && n <= 22 ? 'agent' : [2, 3, 8, 9, 13, 27, 28].includes(n) ? 'llm' : 'deep-learning'
    assert.equal(hallScene(q), expected, q.id)
  }
  const unknown = question('custom-general', { category: 'adversarial', moduleCode: 'GENERAL' })
  assert.equal(hallScene(unknown), undefined)
  for (const key of Object.keys(hallSceneLabels)) {
    const authored = { ...unknown, moduleCode: key, difficulty: 'L2' }
    assert.equal(hallScene(authored), key)
    assert.deepEqual(filterHallQuestions([authored], new URLSearchParams({ scene: key, difficulty: 'L2' })), [authored])
  }
  assert.deepEqual(filterHallQuestions([unknown], new URLSearchParams()), [unknown])
  assert.equal(hallScene(question('V3-261012-B01')), undefined)
  assert.equal(hallFilterParams(new URLSearchParams('scene=agent&group=模型安全'), 'basic').toString(), '')
  assert.equal(hallFilterParams(new URLSearchParams('scene=constructor'), 'adversarial').toString(), '')
  assert.equal(hallFilterParams(new URLSearchParams('scene=llm&scenario=V3-261012-14'), 'adversarial').get('scene'), 'llm')
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
