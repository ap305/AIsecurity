import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { callPool, callPoolWithResponseSnapshot, poolRequestTimeoutMs, savePool } from '../src/services/apiPool.js'
import { RequestError, type PoolBinding } from '../src/lib/prdContract.js'
import { prisma } from '../src/lib/db.js'

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
const invalidTimeouts = [
  null,
  '300000',
  true,
  {},
  [],
  0,
  -1,
  1.5,
  300001,
  Infinity,
  NaN,
  Number.MAX_SAFE_INTEGER + 1,
]

test('snapshot tasks do not expose ambiguous upstream timeouts as retryable gateway 503 responses', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-unknown-outcome-'))
  const before = process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT
  process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = root
  t.after(async () => {
    if (before === undefined) delete process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT
    else process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = before
    await fs.rm(root, { recursive: true, force: true })
  })
  capture(t, async () => { throw new DOMException('synthetic unknown response', 'TimeoutError') })
  await assert.rejects(callPoolWithResponseSnapshot(binding, request,
    { policy: 'first-valid-response-v1', scope: 'V3-261012-A09', evaluationVersion: 'v11', packageDigest: 'a'.repeat(64) }, async () => {}),
    (error: any) => error instanceof RequestError && error.status === 502)
  assert.deepEqual(await fs.readdir(root), [])
})

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
        }) as unknown as Response,
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
      }) as unknown as Response,
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

test('pool request timeout defaults to 60 seconds and permits only bounded positive integers', () => {
  assert.equal(poolRequestTimeoutMs({}), 60000)
  assert.equal(poolRequestTimeoutMs({ requestTimeoutMs: 1 }), 1)
  assert.equal(poolRequestTimeoutMs({ requestTimeoutMs: 300000 }), 300000)
  for (const requestTimeoutMs of invalidTimeouts) {
    assert.throws(
      () => poolRequestTimeoutMs({ requestTimeoutMs }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError)
        assert.equal(error.status, 400)
        assert.match(error.message, /超时/)
        return true
      },
    )
  }
})

test('saving an API pool rejects invalid request timeouts before writing a revision', async (t) => {
  t.mock.method(prisma, '$transaction', async (work: any) => work({}))
  for (const requestTimeoutMs of invalidTimeouts) {
    await assert.rejects(
      savePool(
        null,
        {
          name: 'test pool',
          kind: 'llm',
          model: 'test-model',
          modelVersion: 'v1',
          baseUrl: 'https://example.invalid',
          parameters: { requestTimeoutMs },
        },
        'admin',
      ),
      (error: unknown) => {
        assert.ok(error instanceof RequestError)
        assert.equal(error.status, 400)
        assert.match(error.message, /超时/)
        return true
      },
    )
  }
})

test('saving a valid timeout retains it in the pool and frozen revision parameters', async (t) => {
  const revisions: any[] = []
  const tx = {
    apiPool: { create: async ({ data }: any) => ({ id: 'new-pool', ...data }) },
    apiPoolRevision: {
      create: async ({ data }: any) => {
        revisions.push(data)
      },
    },
    auditEvent: { create: async () => {} },
  }
  t.mock.method(prisma, '$transaction', async (work: any) => work(tx))
  const result = await savePool(
    null,
    {
      name: 'test pool',
      kind: 'llm',
      model: 'test-model',
      modelVersion: 'v1',
      baseUrl: 'https://example.invalid',
      parameters: { requestTimeoutMs: 300000, max_tokens: 10000 },
    },
    'admin',
  )
  assert.deepEqual(result.parameters, { requestTimeoutMs: 300000, max_tokens: 10000 })
  assert.equal(revisions.length, 1)
  assert.deepEqual(JSON.parse(revisions[0].snapshot).parameters, result.parameters)
})

for (const requestTimeoutMs of [undefined, 300000]) {
  test(`upstream timeout ${requestTimeoutMs ?? 'default'} comes only from the frozen binding`, async (t) => {
    const controller = new AbortController()
    const timeouts: number[] = []
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeouts.push(milliseconds)
      return controller.signal
    })
    const parameters = {
      temperature: 0,
      seed: 42,
      max_tokens: 10000,
      enable_thinking: false,
      requestTimeoutMs,
    }
    let calls = 0
    const log = capture(t, async (_url, init) => {
      calls++
      assert.equal(init?.method, 'POST')
      assert.equal(init?.signal, controller.signal)
      assert.deepEqual(JSON.parse(String(init?.body)), {
        messages: request.messages,
        model: binding.model,
        stream: false,
        temperature: 0,
        seed: 42,
        max_tokens: 10000,
        enable_thinking: false,
      })
      return Response.json({ ok: true })
    })
    assert.deepEqual(
      await callPool(
        { ...binding, parameters },
        {
          ...request,
          requestTimeoutMs: 123,
          timeout: 456,
          parameters: { requestTimeoutMs: 789 },
        },
      ),
      { ok: true },
    )
    assert.deepEqual(timeouts, [requestTimeoutMs ?? 60000])
    assert.equal(calls, 1)
    assert.equal(log.mock.callCount(), 0)
  })
}

test('invalid frozen request timeout is a local configuration error with no upstream call', async (t) => {
  const log = capture(t, async () => {
    assert.fail('invalid timeout must not contact upstream')
  })
  for (const requestTimeoutMs of invalidTimeouts)
    await assert.rejects(
      callPool({ ...binding, parameters: { requestTimeoutMs } }, request),
      (error: unknown) => {
        assert.ok(error instanceof RequestError)
        assert.equal(error.status, 400)
        assert.match(error.message, /超时/)
        return true
      },
    )
  assert.equal(log.mock.callCount(), 0)
})

test('configured deadline aborts exactly one upstream POST and remains a non-scoring timeout', async (t) => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 300000)
    return controller.signal
  })
  let calls = 0
  const log = capture(t, async (_url, init) => {
    calls++
    assert.equal(init?.method, 'POST')
    assert.equal(init?.signal, controller.signal)
    controller.abort()
    throw new Error('private-error-message')
  })
  await assert.rejects(
    callPool({ ...binding, parameters: { requestTimeoutMs: 300000 } }, request),
    (error: unknown) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.status, 503)
      assert.match(error.message, /本次不产生正式成绩/)
      return true
    },
  )
  assert.equal(calls, 1)
  assertDiagnostic(log, 'timeout', null)
})


test('snapshot 429 diagnostics expose bounded rate enums without provider bodies or retrying inference', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-rate-limit-'))
  const previous = process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT
  process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = root
  t.after(async () => { if (previous === undefined) delete process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT; else process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT = previous; await fs.rm(root, { recursive: true, force: true }) })
  let calls = 0
  const log = capture(t, async () => { calls++; return new Response(JSON.stringify({code: 50304, message: 'Request was rejected due to TPM rate limit: private-response-text'}), {status: 429, headers: {'retry-after': '30'}}) })
  await assert.rejects(callPoolWithResponseSnapshot(binding, request,
    {policy: 'first-valid-response-v1', scope: 'V3-261012-A02', evaluationVersion: 'v11', packageDigest: 'a'.repeat(64)}, async () => {}), (e: any) => e.status === 502)
  assert.equal(calls, 1)
  const event = log.mock.calls.map(c => JSON.parse(c.arguments[0])).find(e => e.event === 'model_rate_limit_diagnostic')
  assert.deepEqual(event, {event: 'model_rate_limit_diagnostic', poolId: binding.poolId, revision: 3, rateDimension: 'TPM', retryAfterSeconds: 30, numericProviderCode: 50304})
  for (const call of log.mock.calls) for (const secret of privateValues) assert.ok(!call.arguments[0].includes(secret))
  assert.deepEqual(await fs.readdir(root), [])
})


test('snapshot rate diagnostics discard oversized bodies and unsafe retry metadata', async t => {
  const log = capture(t, async () => new Response(JSON.stringify({code: 'private-response-text', message: 'TPM ' + 'x'.repeat(9000)}), {status: 429, headers: {'retry-after': 'private-response-text'}}))
  await assert.rejects(callPool(binding, request, false, true), (e: any) => e.status === 502)
  const event = log.mock.calls.map(c => JSON.parse(c.arguments[0])).find(e => e.event === 'model_rate_limit_diagnostic')
  assert.deepEqual(event, {event: 'model_rate_limit_diagnostic', poolId: binding.poolId, revision: 3, rateDimension: null, retryAfterSeconds: null, numericProviderCode: null})
})


test('a paced snapshot request keeps an overall gateway deadline without changing its model payload',async t=>{
 const deadlines:number[]=[];const signal=new AbortController().signal
 t.mock.method(Date,'now',()=>100000)
 t.mock.method(AbortSignal,'timeout',(ms:number)=>{deadlines.push(ms);return signal})
 capture(t,async(_url,init)=>{assert.equal(JSON.parse(String(init?.body)).model,binding.model);return Response.json({ok:true})})
 await callPool(binding,request,false,true,145000)
 assert.deepEqual(deadlines,[45000])
})
