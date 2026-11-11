import test from 'node:test'
import assert from 'node:assert/strict'
import { modelUsageTokens } from '../src/lib/modelUsageTokens.js'

test('usage counts only exact nonnegative provider integers, preserving unknown and real zero', () => {
  assert.deepEqual(modelUsageTokens({ usage: { prompt_tokens: 0, completion_tokens: 3, total_tokens: 3 } }), { inputTokens: 0, outputTokens: 3, totalTokens: 3 })
  assert.deepEqual(modelUsageTokens({ usage: { input_tokens: 5, output_tokens: 7 } }), { inputTokens: 5, outputTokens: 7, totalTokens: null })
  for (const invalid of [undefined, null, '123', -1, 1.5, Infinity, 2147483648]) {
    assert.deepEqual(modelUsageTokens({ usage: { prompt_tokens: invalid, completion_tokens: invalid, total_tokens: invalid } }), { inputTokens: null, outputTokens: null, totalTokens: null })
  }
  assert.deepEqual(modelUsageTokens(null), { inputTokens: null, outputTokens: null, totalTokens: null })
})
