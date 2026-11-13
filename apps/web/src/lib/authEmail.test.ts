import test from 'node:test'
import assert from 'node:assert/strict'
import { authEmailApi, parseEmailLink } from './authEmail'
import { getAuthToken, setAuthToken } from './api'

test('email link accepts only fragment capabilities and known purposes', () => {
  const token = 'a'.repeat(43)
  assert.deepEqual(parseEmailLink(`#token=${token}&purpose=reset`), { token, purpose: 'reset' })
  assert.equal(parseEmailLink(`?token=${token}&purpose=reset`), null)
  assert.equal(parseEmailLink(`#token=${token}&purpose=admin`), null)
  assert.equal(parseEmailLink('#token=short&purpose=bind'), null)
})
test('anonymous registration and recovery never attach stored bearer or erase it on invalid verification', async (t) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = globalThis.fetch
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  })
  t.after(() => {
    globalThis.fetch = originalFetch
    previousStorage
      ? Object.defineProperty(globalThis, 'localStorage', previousStorage)
      : Reflect.deleteProperty(globalThis, 'localStorage')
  })
  setAuthToken('previous-session')
  const requests: Array<{ url: string; headers: Headers; body: any }> = []
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      headers: new Headers(options?.headers),
      body: JSON.parse(String(options?.body ?? '{}')),
    })
    return new Response(JSON.stringify({ code: 40016, message: '验证链接无效', data: null }), { status: 400 })
  }
  await assert.rejects(authEmailApi.request('reset', 'someone@example.test'))
  await assert.rejects(authEmailApi.recover('a'.repeat(43), 'new passphrase 123'))
  await assert.rejects(
    authEmailApi.register({
      username: 'student',
      password: 'new passphrase 123',
      displayName: 'Student',
      emailToken: 'a'.repeat(43),
    }),
  )
  assert.deepEqual(
    requests.map((r) => r.url),
    ['/api/auth/email/request', '/api/auth/password-recovery', '/api/auth/register'],
  )
  assert.ok(requests.every((r) => !r.headers.has('authorization')))
  assert.equal(getAuthToken(), 'previous-session')
  assert.equal(values.size, 1, 'passwords and email capabilities are not persisted')
})
