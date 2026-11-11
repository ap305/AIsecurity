import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from './api'
import { modelUsageApi, parseUsagePolicyDraft, type UsagePolicyDraft } from './modelUsage'

const draft: UsagePolicyDraft = {
  globalDaily: '10000',
  userDaily: '4000',
  globalTotal: '100000',
  userTotal: '20000',
  warnPercent: '80',
}

test('policy input keeps warning-only numeric limits and rejects empty, fractional and excessive values', () => {
  assert.deepEqual(parseUsagePolicyDraft(draft, 3), {
    revision: 3,
    globalDaily: 10000,
    userDaily: 4000,
    globalTotal: 100000,
    userTotal: 20000,
    warnPercent: 80,
  })
  for (const value of ['', ' ', '0', '-1', '1.5', 'Infinity', '1000000001', '2e3'])
    assert.throws(() => parseUsagePolicyDraft({ ...draft, globalDaily: value }, 3), /次数阈值/)
  for (const value of ['', '0', '100', '1.5'])
    assert.throws(() => parseUsagePolicyDraft({ ...draft, warnPercent: value }, 3), /预警百分比/)
  assert.equal(
    parseUsagePolicyDraft({ ...draft, globalDaily: '1000000000', warnPercent: '99' }, 3).globalDaily,
    1000000000,
  )
})

test('usage API bounds day filters and sends only editable policy fields to administrator routes', async (t) => {
  const requests: { url: string; options: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, options })
    return Response.json({ code: 0, data: { mode: 'observe' } })
  })
  await modelUsageApi.get(7)
  await modelUsageApi.get(30)
  for (const days of [0, 31, 7.5, NaN]) await assert.rejects(modelUsageApi.get(days), /天数/)
  await modelUsageApi.savePolicy({
    ...parseUsagePolicyDraft(draft, 3),
    mode: 'hard',
    secret: 'fixture',
  } as never)
  await modelUsageApi.acknowledge('alert/one')
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      '/api/admin/model-usage?days=7',
      '/api/admin/model-usage?days=30',
      '/api/admin/model-usage/policy',
      '/api/admin/model-usage/alerts/alert%2Fone/ack',
    ],
  )
  assert.equal(requests[2].options.method, 'PUT')
  assert.deepEqual(JSON.parse(String(requests[2].options.body)), {
    revision: 3,
    globalDaily: 10000,
    userDaily: 4000,
    globalTotal: 100000,
    userTotal: 20000,
    warnPercent: 80,
  })
  assert.equal(requests[3].options.method, 'POST')
  assert.equal(requests[3].options.body, '{}')
  assert.ok(requests.every(({ options }) => options.cache === 'no-store' && options.signal))
})

test('policy version conflicts remain identifiable without consuming the server error text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 40900, message: '版本冲突', data: null }, { status: 409 }),
  )
  await assert.rejects(
    modelUsageApi.savePolicy(parseUsagePolicyDraft(draft, 3)),
    (reason: unknown) => reason instanceof ApiError && reason.status === 409,
  )
})

for (const stalled of ['fetch', 'body'] as const) {
  test(`usage reads, policy saves and acknowledgements release a stalled ${stalled} within 30 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let release!: (value: Response) => void
    const pendingResponse = new Promise<Response>((resolve) => {
      release = resolve
    })
    t.after(() => release(Response.json({ code: 0, data: null })))
    t.mock.method(globalThis, 'fetch', async () =>
      stalled === 'fetch' ? pendingResponse : new Response(new ReadableStream({ pull() {} })),
    )
    const outcomes = ['pending', 'pending', 'pending']
    const pending = [
      modelUsageApi.get(7),
      modelUsageApi.savePolicy(parseUsagePolicyDraft(draft, 1)),
      modelUsageApi.acknowledge('A'),
    ].map((operation, index) =>
      operation.then(
        () => {
          outcomes[index] = 'resolved'
        },
        () => {
          outcomes[index] = 'rejected'
        },
      ),
    )
    await new Promise<void>((done) => setImmediate(done))
    t.mock.timers.tick(30000)
    await Promise.all(pending)
    assert.deepEqual(outcomes, ['rejected', 'rejected', 'rejected'])
  })
}
