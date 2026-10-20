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
