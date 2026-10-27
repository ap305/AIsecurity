import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluationModelCallLimit } from '../src/lib/modelCallBudget.js'
import { normalizeDefinition } from '../src/lib/prdContract.js'

const originalD02 = {
  version: 'v3-261012-d02-original300-v12', maxModelCalls: 3600,
  parameters: { number: '02', role: 'defense', samples: 300 },
}

test('full original D02 reserves all 1200 logical requests and bounded 503 attempts', () => {
  assert.equal(evaluationModelCallLimit(originalD02, 'defense'), 3600)
  assert.equal(evaluationModelCallLimit({ ...originalD02, maxModelCalls: 1200 }, 'defense'), 1200)
  assert.equal(evaluationModelCallLimit({ ...originalD02, maxModelCalls: 10000 }, 'defense'), 3600)
})

test('real builder top-level frozen fields take precedence over nested compatibility fields', () => {
  const raw = { version: originalD02.version, maxModelCalls: 3600, number: '02', role: 'defense', samples: 300 }
  assert.equal(evaluationModelCallLimit(raw, 'defense'), 3600)
  assert.equal(evaluationModelCallLimit({ ...raw, samples: 20, parameters: originalD02.parameters }, 'defense'), 1000)
  assert.equal(evaluationModelCallLimit({ ...raw, parameters: { samples: 20 } }, 'defense'), 3600)
})

test('only the restored original D02 definition can reserve a bounded 24-hour evaluation', () => {
  const evaluation = { version: originalD02.version, number: '02', role: 'defense', samples: 300, timeoutMs: 86400000 }
  assert.equal(normalizeDefinition({ evaluation }).evaluation.timeoutMs, 86400000)
  assert.throws(() => normalizeDefinition({ evaluation: { ...evaluation, timeoutMs: 86400001 } }), /超时/)
  for (const changed of [{ version: 'v11' }, { role: 'attack' }, { number: '09' }, { samples: 20 }])
    assert.throws(() => normalizeDefinition({ evaluation: { ...evaluation, ...changed } }), /超时/)
  assert.equal(normalizeDefinition({ evaluation: { timeoutMs: 3600000 } }).evaluation.timeoutMs, 3600000)
})

test('the expanded budget never applies to another role, version or frozen sample scope', () => {
  for (const evaluation of [
    { ...originalD02, version: 'v3-261012-response-snapshot4-v11' },
    { ...originalD02, parameters: { ...originalD02.parameters, number: '09' } },
    { ...originalD02, parameters: { ...originalD02.parameters, role: 'attack' } },
    { ...originalD02, parameters: { ...originalD02.parameters, samples: 20 } },
    { ...originalD02, parameters: { ...originalD02.parameters, samples: '300' } },
    { ...originalD02, parameters: undefined },
  ]) assert.equal(evaluationModelCallLimit(evaluation, 'defense'), 1000)
  assert.equal(evaluationModelCallLimit(originalD02, 'attack'), 1000)
  assert.equal(evaluationModelCallLimit(originalD02), 1000)
})

test('legacy and invalid budgets retain the existing bounded defaults', () => {
  assert.equal(evaluationModelCallLimit({ maxModelCalls: 600 }), 600)
  assert.equal(evaluationModelCallLimit({ maxModelCalls: 10000 }), 1000)
  for (const value of [undefined, 0, -1, 1.5, Infinity, 'invalid'])
    assert.equal(evaluationModelCallLimit({ maxModelCalls: value }), 32)
})
