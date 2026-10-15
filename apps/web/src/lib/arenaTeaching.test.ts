import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARENA_TEACHING_SCENARIOS,
  ARENA_TEACHING_GROUPS,
  arenaScoringRules,
  getArenaTeaching,
  matchesArenaScenario,
  resolveArenaScenario,
} from './arenaTeaching'
import { defaultDefinition, type ProblemRole, type QuestionRecord } from './prdApi'

function question(scenarioId?: string, role: ProblemRole = 'attack', id = 'CUSTOM-ID'): QuestionRecord {
  return {
    id,
    title: '发布中的题目',
    category: 'adversarial',
    difficulty: 'L2',
    revision: 7,
    definition: { ...defaultDefinition(), role, scenarioId },
  }
}

test('the original ten student scenarios expose complete role-specific teaching without old scoring', () => {
  assert.deepEqual(
    ARENA_TEACHING_SCENARIOS.map((item) => item.id).sort(),
    [
      'chatops',
      'supportbot',
      'agendabot',
      'webbot',
      'mnist_backdoor',
      'mnist_poison',
      'deepfake_audio',
      'deepfake_image',
      'watermark_image',
      'patch_attack',
    ].sort(),
  )
  assert.equal(new Set(ARENA_TEACHING_SCENARIOS.flatMap((item) => Object.values(item.questionIds))).size, 20)
  for (const scenario of ARENA_TEACHING_SCENARIOS) {
    assert.ok(ARENA_TEACHING_GROUPS.includes(scenario.group))
    for (const role of ['attack', 'defense'] as const) {
      const brief = getArenaTeaching(question(scenario.id, role))!
      assert.equal(brief.role, role)
      assert.ok(brief.objective && brief.input.length && brief.output.length && brief.constraints.length)
      assert.ok(brief.environment.length && brief.resourceHints.length)
      assert.ok(!('scoring' in brief))
    }
  }
})

test('legacy question IDs resolve only when the publisher has not declared another scenario', () => {
  assert.equal(resolveArenaScenario(question(undefined, 'defense', 'MNIST-BD-DEF'))?.id, 'mnist_backdoor')
  assert.equal(resolveArenaScenario(question('new-course', 'attack', 'MNIST-BD')), undefined)
  const explicit = question('chatops')
  explicit.scenarioId = 'webbot'
  assert.equal(resolveArenaScenario(explicit)?.id, 'webbot')
  const basic = { ...question('chatops'), category: 'basic' as const }
  assert.equal(resolveArenaScenario(basic), undefined)
  assert.equal(resolveArenaScenario({ ...question(), moduleCode: 'M2' } as QuestionRecord), undefined)
})

test('legacy scenario links select both fixed roles and never turn unknown scenes into the default', () => {
  const questions = ARENA_TEACHING_SCENARIOS.flatMap((scenario) =>
    (['attack', 'defense'] as const).map((role) => question(scenario.id, role, scenario.questionIds[role])),
  )
  assert.deepEqual(
    questions.filter((q) => matchesArenaScenario(q, 'chatops')).map((q) => q.id),
    ['CHATOPS-AD-ATK', 'CHATOPS-AD-DEF'],
  )
  assert.equal(questions.filter((q) => matchesArenaScenario(q, 'unknown')).length, 0)
})

test('the fixed published role wins and a missing role does not silently become attack', () => {
  const q = question('chatops')
  q.role = 'defense'
  assert.equal(getArenaTeaching(q)?.role, 'defense')
  q.role = undefined
  q.definition.role = undefined
  assert.equal(getArenaTeaching(q), undefined)
})

test('current v2 input contracts replace incompatible old env/task and embed interfaces', () => {
  const mnist = getArenaTeaching(question('mnist_backdoor'))!
  assert.match(mnist.input.join(' '), /attack\(images, labels/)
  const watermark = getArenaTeaching(question('watermark_image', 'defense'))!
  assert.match(watermark.input.join(' '), /defense\(sample\)/)
  assert.doesNotMatch(watermark.input.join(' '), /embed\(/)
  const patch = getArenaTeaching(question('patch_attack'))!
  assert.match(patch.output.join(' '), /3, 32, 32/)
  const chatops = getArenaTeaching(question('chatops', 'defense'))!
  assert.match(chatops.input.join(' '), /序列化文本/)
})

test('scoring text follows the published thresholds including equality and zero without exposing private config', () => {
  const q = question('chatops')
  q.definition.evaluation.baselineMetric = 'new_qualification'
  q.definition.evaluation.baselineThreshold = 0
  q.definition.evaluation.successMetric = 'new_pair_metric'
  q.definition.evaluation.successThreshold = 0.123456789
  q.definition.evaluation.baselineCode = 'PRIVATE_REFERENCE_DO_NOT_RENDER'
  const text = arenaScoringRules(q).join('\n')
  assert.match(text, /new_qualification ≥ 0/)
  assert.match(text, /new_pair_metric ≥ 0\.123456789/)
  assert.match(text, /无有效对手.*100%/)
  assert.match(text, /失败计入分母/)
  assert.doesNotMatch(text, /PRIVATE_REFERENCE|查询次数.*分|score.*100/)
})
