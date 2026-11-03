import test from 'node:test'
import assert from 'node:assert/strict'
import * as security from './adminAuth'

test('manual password setting validates Unicode length and confirmation before making any request', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ code: 0, data: { ok: true } })
  })
  await assert.rejects(security.setUserPassword('student/1', 'too short', 'too short'), /15/)
  await assert.rejects(security.setUserPassword('student/1', '😀'.repeat(15), 'different'), /不一致/)
  assert.equal(calls, 0)
  await security.setUserPassword('student/1', '😀'.repeat(15), '😀'.repeat(15))
  assert.equal(calls, 1)
})

test('manual recovery requires identity verification and obtains the password from the server', async (t) => {
  const calls: Array<{ url: unknown; method: unknown; body: unknown }> = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push({ url, method: options?.method, body: JSON.parse(String(options?.body)) })
    return Response.json({
      code: 0,
      data: { ok: true, temporaryPassword: 'server-returned-only', expiresAt: '2026-11-03T12:15:00.000Z' },
    })
  })
  await assert.rejects(security.recoverInitialPassword('student/1', false), /核验/)
  assert.equal(calls.length, 0)
  const response = await security.recoverInitialPassword('student/1', true)
  assert.equal(response.temporaryPassword, 'server-returned-only')
  assert.deepEqual(calls, [
    { url: '/api/admin/users/student%2F1/password-reset', method: 'POST', body: { identityVerified: true } },
  ])
})

test('auth event query encodes the user identity and bounds event reads', async (t) => {
  const urls: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    urls.push(url)
    return Response.json({
      code: 0,
      data: [
        {
          id: 'event1',
          action: 'auth.password.reset',
          type: 'auth.password.reset',
          createdAt: '2026-11-03T12:00:00.000Z',
          userId: 'student/1',
          actorId: 'admin',
          success: true,
        },
      ],
    })
  })
  const events = await security.fetchAuthEvents('student/1')
  assert.equal(events[0].action, 'auth.password.reset')
  assert.deepEqual(urls, ['/api/admin/auth-events?userId=student%2F1&limit=20'])
})
