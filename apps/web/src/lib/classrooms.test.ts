import test from 'node:test'
import assert from 'node:assert/strict'
import { classroomsApi } from './classrooms'
import { setAuthToken, subscribeAuthFailures } from './api'

test('export reports JSON authorization failures instead of downloading an error document', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 40300, message: '无权导出所选班级', data: null }, { status: 403 }),
  )
  await assert.rejects(classroomsApi.export(['one', 'foreign']), /无权导出/)
})

test('export posts selected class IDs with a deadline and returns only supported downloadable files', async (t) => {
  const calls: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push({
      url,
      method: options?.method,
      body: JSON.parse(String(options?.body)),
      signal: options?.signal,
    })
    return new Response('\uFEFF"账号","学号"\r\n"student","0007"', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="classroom-one.csv"',
      },
    })
  })
  const file = await classroomsApi.export(['one'])
  assert.equal(file.filename, 'classroom-one.csv')
  assert.match(await file.blob.text(), /0007/)
  assert.equal(calls[0].url, '/api/classrooms/export')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { classroomIds: ['one'] })
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('binary export rejects obsolete credentials and propagates current-session expiry', async (t) => {
  const storage = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  t.after(() => {
    setAuthToken(null)
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete (globalThis as any).localStorage
  })
  setAuthToken('first')
  t.mock.method(globalThis, 'fetch', async () => {
    setAuthToken('second')
    return new Response('scores', { headers: { 'Content-Type': 'text/csv' } })
  })
  await assert.rejects(classroomsApi.export(['one']), /账号已变化/)
  let expired = 0
  const unsubscribe = subscribeAuthFailures(() => expired++)
  t.after(unsubscribe)
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 40100, message: '登录已失效', data: null }, { status: 401 }),
  )
  await assert.rejects(classroomsApi.export(['one']), /登录已失效/)
  assert.equal(expired, 1)
})
