import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiGet, apiPost } from './api'
import { submitMaterials } from './prdApi'

test('a successful HTTP response with HTML cannot be treated as a successful action', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>upstream fallback</html>'))
  await assert.rejects(apiPost('/profile', { displayName: 'Student' }), /格式|JSON|报文/)
})

test('incomplete or malformed success envelopes are rejected instead of returning undefined', async (t) => {
  for (const payload of [null, [], { code: 0 }, { code: '0', data: {} }, { data: {} }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(payload))
    await assert.rejects(apiGet('/questions'), /格式|JSON|报文/)
    mock.mock.restore()
  }
})

test('valid API envelopes retain null, false, zero and array payloads', async (t) => {
  for (const data of [null, false, 0, []]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data }))
    assert.deepEqual(await apiGet('/fixture'), data)
    mock.mock.restore()
  }
})

test('failed API actions preserve the server message and gateway errors remain errors', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 40001, message: '请先选择题目', data: null }, { status: 400 }),
  )
  await assert.rejects(apiPost('/fixture', {}), /请先选择题目/)
  mock.mock.restore()
  t.mock.method(globalThis, 'fetch', async () => new Response('Bad Gateway', { status: 502 }))
  await assert.rejects(apiGet('/fixture'), /502/)
})

test('HTTP failures retain their status so a missing task is not retried like an outage', async (t) => {
  for (const status of [401, 403, 404, 503]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ code: 40001, message: '查询失败', data: null }, { status }),
    )
    await assert.rejects(apiGet('/submissions/task'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { status?: number }).status, status)
      assert.match(error.message, /查询失败/)
      return true
    })
    mocked.mock.restore()
  }
})

test('a bounded progress read aborts a stalled response instead of keeping the form locked indefinitely', async (t) => {
  let aborted = false
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('Timed out', 'AbortError'))
      }, { once: true })
    }),
  )
  const outcome = await Promise.race([
    apiGet('/submissions/task', 5).then(() => 'resolved', () => 'rejected'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 40)),
  ])
  assert.equal(outcome, 'rejected')
  assert.equal(aborted, true)
})

test('an aborted upload rejects so its caller can leave the uploading state and retry safely', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  class AbortedRequest {
    upload = {}
    onabort?: () => void
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onabort?.()) }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: AbortedRequest })
  t.after(() => previous ? Object.defineProperty(globalThis, 'XMLHttpRequest', previous) : Reflect.deleteProperty(globalThis, 'XMLHttpRequest'))
  const outcome = await Promise.race([
    submitMaterials(new FormData(), () => {}).then(() => 'resolved', () => 'rejected'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 40)),
  ])
  assert.equal(outcome, 'rejected')
})

test('submission upload rejects missing acceptance IDs and handles timeout', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  let payload: unknown = { code: 0 }
  let timeout = false
  class Request {
    upload = {}
    status = 200
    responseText = ''
    timeout = 0
    onload?: () => void
    ontimeout?: () => void
    open() {}
    setRequestHeader() {}
    send() {
      this.responseText = JSON.stringify(payload)
      if (timeout) this.ontimeout?.()
      else this.onload?.()
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Request })
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'XMLHttpRequest', previous)
      : Reflect.deleteProperty(globalThis, 'XMLHttpRequest'),
  )
  await assert.rejects(
    submitMaterials(new FormData(), () => {}),
    /受理|报文|响应/,
  )
  payload = { code: 0, data: { id: 'accepted-id', status: 'queued' } }
  assert.equal((await submitMaterials(new FormData(), () => {})).id, 'accepted-id')
  timeout = true
  await assert.rejects(
    submitMaterials(new FormData(), () => {}),
    /超时/,
  )
})
