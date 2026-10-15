import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { callPool } from '../src/services/apiPool.js'
import { RequestError, type PoolBinding } from '../src/lib/prdContract.js'

const privateValues = [
  'fixture-secret-token',
  'private-host.invalid',
  'private-request-text',
  'private-response-text',
  'private-error-message',
]
const binding: PoolBinding = {
  poolId: 'pool-diagnostic-test',
  revision: 3,
  name: 'private-pool-name',
  kind: 'llm',
  model: 'private-model',
  modelVersion: 'v1',
  baseUrl: 'https://private-host.invalid',
  credentialEnv: 'API_POOL_DIAGNOSTIC_TEST_KEY',
  parameters: { temperature: 0 },
}
const request = { messages: [{ role: 'user', content: 'private-request-text' }] }

function capture(t: TestContext, fetch: typeof globalThis.fetch) {
  const old = process.env.API_POOL_DIAGNOSTIC_TEST_KEY
  process.env.API_POOL_DIAGNOSTIC_TEST_KEY = 'fixture-secret-token'
  t.after(() => {
    if (old === undefined) delete process.env.API_POOL_DIAGNOSTIC_TEST_KEY
    else process.env.API_POOL_DIAGNOSTIC_TEST_KEY = old
  })
  t.mock.method(globalThis, 'fetch', fetch)
  return t.mock.method(console, 'warn', () => {})
}

function assertDiagnostic(log: ReturnType<typeof capture>, reason: string, status: number | null) {
  assert.equal(log.mock.callCount(), 1)
  const args = log.mock.calls[0].arguments
  assert.equal(args.length, 1)
  assert.deepEqual(JSON.parse(args[0]), {
    event: 'model_upstream_failure',
    poolId: binding.poolId,
    revision: 3,
    status,
    reason,
  })
  for (const value of [...privateValues, binding.name, binding.model, binding.credentialEnv!])
    assert.ok(!args[0].includes(value))
}

async function assertGenericFailure(status: number) {
  await assert.rejects(callPool(binding, request), (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.status, status)
    assert.match(error.message, /本次不产生正式成绩/)
    for (const value of privateValues) assert.ok(!error.message.includes(value))
    return true
  })
}

for (const status of [400, 429, 500]) {
  test(`upstream HTTP ${status} logs only allowlisted diagnostics and hides its body`, async (t) => {
    let read = false
    let canceled = false
    const log = capture(
      t,
      async () =>
        ({
          ok: false,
          status,
          body: {
            cancel: async () => {
              canceled = true
              throw new Error('private-error-message')
            },
          },
          json: async () => {
            read = true
            return { message: 'private-response-text' }
          },
        }) as Response,
    )
    await assertGenericFailure(502)
    assert.equal(read, false)
    assert.equal(canceled, true)
    assertDiagnostic(log, 'http', status)
  })
}

for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
  test(`upstream ${name} hides exception content and classifies transport failure`, async (t) => {
    const log = capture(t, async () => {
      const error = new Error('private-error-message')
      error.name = name
      throw error
    })
    await assertGenericFailure(503)
    assertDiagnostic(log, name === 'TypeError' ? 'transport' : 'timeout', null)
  })
}

test('invalid upstream JSON is logged without its response content and returns a generic failure', async (t) => {
  const log = capture(t, async () => new Response('private-response-text', { status: 200 }))
  await assertGenericFailure(502)
  assertDiagnostic(log, 'invalid_json', 200)
})

test('a response body read timeout remains a timeout instead of invalid JSON', async (t) => {
  const log = capture(
    t,
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new DOMException('private-error-message', 'TimeoutError')
        },
      }) as Response,
  )
  await assertGenericFailure(502)
  assertDiagnostic(log, 'timeout', 200)
})

test('successful calls preserve the fixed payload and do not emit failure diagnostics', async (t) => {
  const result = { choices: [{ message: { content: 'private-response-text' } }] }
  const log = capture(t, async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-secret-token')
    const payload = JSON.parse(String(init?.body))
    assert.equal(payload.model, binding.model)
    assert.equal(payload.temperature, 0)
    return Response.json(result)
  })
  assert.deepEqual(await callPool(binding, request), result)
  assert.equal(log.mock.callCount(), 0)
})

test('local payload validation is not mislabeled as an upstream outage', async (t) => {
  const log = capture(t, async () => {
    assert.fail('invalid input must not contact upstream')
  })
  await assert.rejects(callPool(binding, { messages: [] }), /messages 必须是非空数组/)
  assert.equal(log.mock.callCount(), 0)
})
