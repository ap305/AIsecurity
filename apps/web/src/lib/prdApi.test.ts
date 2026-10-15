import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultDefinition,
  dynamicSummary,
  isTerminal,
  normalizeQuestion,
  parsedResult,
  prdApi,
  questionDefinitionErrors,
  validateMaterial,
  type QuestionRecord,
  type SubmissionRecord,
} from './prdApi'

test('arena hall uses complete published definitions and actual per-user states', async (t) => {
  const definition = defaultDefinition()
  definition.kind = 'agent'
  definition.role = 'defense'
  definition.scenarioId = 'chatops'
  let requested = ''
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested = url
    return new Response(
      JSON.stringify({
        code: 0,
        data: [
          {
            id: 'CHATOPS-AD-DEF',
            category: 'adversarial',
            revision: 2,
            definition,
            myScore: 0,
            attempted: true,
            latestSubmissionStatus: 'completed',
            tags: ['LLM 安全'],
            dynamicScore: { emptyPool: false },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  })
  const [question] = await prdApi.questions('adversarial')
  assert.equal(requested, '/api/questions?category=adversarial')
  assert.equal(question.definition.kind, 'agent')
  assert.equal(question.definition.role, 'defense')
  assert.equal(question.myScore, 0)
  assert.equal(question.attempted, true)
  assert.equal(question.latestSubmissionStatus, 'completed')
  assert.deepEqual(question.tags, ['LLM 安全'])
})

test('material validation follows per-question capability and preserves size/extension rules', () => {
  const definition = defaultDefinition()
  const file = { name: 'MODEL.PT', size: 10, lastModified: 1 } as File
  assert.match(validateMaterial(definition, 'pass', file)!, /不接受/)
  definition.weights.enabled = true
  definition.weights.required = true
  definition.weights.maxBytes = 20
  assert.match(validateMaterial(definition, 'pass', null)!, /请上传/)
  assert.equal(validateMaterial(definition, 'pass', file), null)
  assert.match(validateMaterial(definition, 'pass', { ...file, name: 'model.exe' } as File)!, /格式/)
  assert.match(validateMaterial(definition, 'pass', { ...file, size: 21 } as File)!, /上限/)
  assert.match(validateMaterial(definition, '   ', file)!, /代码/)
})
test('fixed identity comes from the server question and legacy category maps to adversarial', () => {
  const question = normalizeQuestion({
    id: 'Q',
    category: 'security',
    revision: 4,
    role: 'defense',
    scenarioId: 'pair',
    definition: defaultDefinition(),
  } as QuestionRecord)
  assert.equal(question.category, 'adversarial')
  assert.equal(question.definition.role, 'defense')
  assert.equal(question.definition.scenarioId, 'pair')
  assert.equal(question.revision, 4)
})
test('required special capabilities are checked before publish', () => {
  const definition = defaultDefinition()
  definition.evaluation.packageId = 'validated'
  assert.deepEqual(questionDefinitionErrors(definition, 'basic'), [])
  definition.kind = 'distillation'
  assert.equal(questionDefinitionErrors(definition, 'basic').length, 2)
  definition.weights.enabled = true
  definition.weights.required = true
  definition.teacherApi.enabled = true
  definition.teacherApi.poolId = 'teacher'
  assert.deepEqual(questionDefinitionErrors(definition, 'basic'), [])
  assert.match(questionDefinitionErrors(definition, 'adversarial')[0], /固定角色/)
})
test('normal completed zero-percent scores remain distinct from a non-counted null score', () => {
  const base = { id: 'S', questionId: 'Q', status: 'completed', createdAt: '2026-10-14T00:00:00Z' }
  const zero = {
    ...base,
    score: 0,
    result: { qualified: true, successCount: 0, opponentCount: 3 },
  } as SubmissionRecord
  const uncounted = { ...base, score: null, result: { qualified: false } } as SubmissionRecord
  assert.equal(zero.score, 0)
  assert.equal(uncounted.score, null)
  assert.equal(dynamicSummary(zero).opponentCount, 3)
  assert.equal(dynamicSummary(uncounted).qualified, false)
})
test('serialized results are parsed safely and queue/baseline phases are not terminal', () => {
  assert.deepEqual(parsedResult({ result: 'invalid' } as SubmissionRecord), {})
  assert.equal(
    dynamicSummary({
      result: JSON.stringify({ details: { opponentCount: 0, emptyPool: true } }),
    } as SubmissionRecord).emptyPool,
    true,
  )
  for (const status of ['queued', 'pending', 'baseline', 'opponents', 'judging'])
    assert.equal(isTerminal(status), false)
  for (const status of ['completed', 'error', 'failed', 'passed', 'timeout'])
    assert.equal(isTerminal(status), true)
})
