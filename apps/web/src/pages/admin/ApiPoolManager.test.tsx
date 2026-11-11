import test from 'node:test'
import assert from 'node:assert/strict'
import { containsCredential } from './ApiPoolManager'

test('API pool accepts credential-named JSON Schema properties without treating their definitions as secrets', () => {
  assert.equal(
    containsCredential({
      tools: [
        {
          type: 'function',
          function: {
            name: 'inspect_token',
            parameters: {
              type: 'object',
              properties: {
                token: { type: 'string' },
                secret_code: { type: 'string' },
                password: { type: 'string' },
              },
            },
          },
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'status',
          schema: { type: 'object', properties: { apiKey: { type: 'string' } } },
        },
      },
    }),
    false,
  )
})

test('API pool rejects primitive credential values at any depth and still inspects definition objects', () => {
  for (const value of [
    { apiKey: 'fixture-key' },
    { headers: { Authorization: 'Bearer fixture-key' } },
    { rows: [{ secret: 'fixture-key' }] },
    { token: { headers: { Authorization: 'Bearer fixture-key' } } },
    { password: 123456 },
    { secret: null },
  ])
    assert.equal(containsCredential(value), true)
  assert.equal(containsCredential({ max_tokens: 50, temperature: 0, enable_thinking: false }), false)
})
