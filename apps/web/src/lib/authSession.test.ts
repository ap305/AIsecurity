import test from 'node:test'
import assert from 'node:assert/strict'
import { apiGet, apiPost, apiPut, ApiError, getAuthToken, setAuthToken, subscribeAuthFailures } from './api'
import { submitMaterials } from './prdApi'
import * as auth from './authSession'

const student = { id: 'a', username: 'first', displayName: 'First', role: 'student', tier: 'bronze' }
function storage(t: { after(fn: () => void): void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    },
  })
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'localStorage', previous)
      : Reflect.deleteProperty(globalThis, 'localStorage'),
  )
  return values
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('returnTo preserves a question query and hash but rejects external, slash and encoded bypasses', () => {
  assert.equal(auth.safeReturnTo('/question/A28?tab=code#answer'), '/question/A28?tab=code#answer')
  for (const path of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/%5cevil',
    '/%2f%2fevil',
    '/%252f%252fevil',
    '/%0a/evil',
    '/a/../../%2f%2fevil',
    '/login?returnTo=//evil',
    '/register',
    '/%6cogin',
    '/bad%',
  ]) {
    assert.equal(auth.safeReturnTo(path), '/', path)
  }
  assert.equal(
    auth.loginHref('/question/A28?tab=code#answer'),
    '/login?returnTo=%2Fquestion%2FA28%3Ftab%3Dcode%23answer',
  )
})

test('new password validation counts Unicode characters and leaves spaces unchanged', () => {
  assert.equal(auth.validateNewPassword('😀'.repeat(15)), null)
  assert.equal(auth.validateNewPassword(' '.repeat(15)), null)
  assert.ok(auth.validateNewPassword('😀'.repeat(14)))
  assert.equal(auth.validateNewPassword('😀'.repeat(128)), null)
  assert.ok(auth.validateNewPassword('😀'.repeat(129)))
})

test('only explicit session-invalid errors expire credentials, never outage, forbidden or required-password', () => {
  assert.equal(auth.isSessionInvalid(new ApiError(401, 'expired', 40100)), true)
  for (const error of [
    new Error('offline'),
    new ApiError(503, 'unavailable', 50300),
    new ApiError(503, 'bad upstream', 40100),
    new ApiError(403, 'forbidden', 40300),
    new ApiError(428, 'change', 42801),
    new ApiError(401, 'gateway'),
  ]) {
    assert.equal(auth.isSessionInvalid(error), false)
  }
})

test('restore keeps credentials and drafts on network errors and 5xx, and a retry restores verified identity', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  values.set('aisec_user', JSON.stringify({ ...student, role: 'admin' }))
  values.set('aisec_draft_a_A28', 'draft')
  const session = new auth.AuthSession()
  assert.equal(session.snapshot.user, null)
  for (const response of [
    () => {
      throw new TypeError('offline')
    },
    () => Response.json({ code: 50300, message: 'offline' }, { status: 503 }),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response())
    await session.restore()
    assert.equal(session.snapshot.status, 'unavailable')
    assert.equal(session.snapshot.user, null)
    assert.equal(values.get('aisec_token'), 'token-a')
    assert.equal(values.get('aisec_draft_a_A28'), 'draft')
    mock.mock.restore()
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data: { user: student } }))
  await session.restore()
  assert.equal(session.snapshot.status, 'authenticated')
  assert.equal(session.getSnapshot().user?.id, 'a')
})

test('an explicit expired restore clears only auth data', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  values.set('original-task-key', 'task')
  values.set('aisec_user', '{}')
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 40100, message: 'expired' }, { status: 401 }),
  )
  const session = new auth.AuthSession()
  await session.restore()
  assert.equal(session.snapshot.status, 'anonymous')
  assert.equal(values.has('aisec_token'), false)
  assert.equal(values.has('aisec_user'), false)
  assert.equal(values.get('original-task-key'), 'task')
})

test('a late first-tab restore cannot replace a switched account or clear its token', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  const delayed = deferred<Response>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? delayed.promise
      : Response.json({ code: 0, data: { user: { ...student, id: 'b', username: 'second' } } }),
  )
  const session = new auth.AuthSession()
  const old = session.restore()
  setAuthToken('token-b')
  await session.syncStorage()
  delayed.resolve(Response.json({ code: 40100, message: 'expired' }, { status: 401 }))
  await old
  assert.equal(session.snapshot.user?.id, 'b')
  assert.equal(values.get('aisec_token'), 'token-b')
  values.delete('aisec_token')
  await session.syncStorage()
  assert.equal(session.snapshot.status, 'anonymous')
  assert.equal(session.snapshot.user, null)
})

test('a late login cannot undo a different account selected in another tab', async (t) => {
  storage(t)
  const delayed = deferred<Response>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1 ? delayed.promise : Response.json({ code: 0, data: { user: { ...student, id: 'b' } } }),
  )
  const session = new auth.AuthSession()
  const old = session.login('first', 'old password', 'student')
  setAuthToken('token-b')
  await session.syncStorage()
  delayed.resolve(Response.json({ code: 0, data: { token: 'token-a', user: student } }))
  await assert.rejects(old, /变化|切换|过期/)
  assert.equal(session.snapshot.user?.id, 'b')
})

test('logout failure still exits locally and reports unconfirmed revocation', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  values.set('draft', 'kept')
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('offline')
  })
  const session = new auth.AuthSession()
  const result = await session.logout()
  assert.equal(result.revoked, false)
  assert.equal(session.snapshot.status, 'anonymous')
  assert.match(session.snapshot.notice ?? '', /撤销.*未确认/)
  assert.equal(values.has('aisec_token'), false)
  assert.equal(values.get('draft'), 'kept')
})

test('password and logout-others update the token only after server confirmation', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  const requests: Array<{ url: unknown; body: unknown }> = []
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(options?.body)) })
    return Response.json({
      code: 0,
      data: { token: requests.length === 1 ? 'token-b' : 'token-c', user: student },
    })
  })
  const session = new auth.AuthSession()
  await session.changePassword('  legacy  ', '😀'.repeat(15))
  assert.equal(values.get('aisec_token'), 'token-b')
  await session.logoutOthers()
  assert.equal(values.get('aisec_token'), 'token-c')
  assert.deepEqual(requests, [
    {
      url: '/api/auth/change-password',
      body: { currentPassword: '  legacy  ', newPassword: '😀'.repeat(15) },
    },
    { url: '/api/auth/logout-others', body: {} },
  ])
})

test('POST and PUT auth requests time out and reject a stalled response body', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start() {} })))
  for (const request of [
    () => apiPost('/auth/login', {}, 5),
    () => apiPut('/auth/me', {}, 5),
    () => apiGet('/auth/me', 5),
  ]) {
    const outcome = await Promise.race([
      request().then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ])
    assert.equal(outcome, 'rejected')
  }
})

test('restricted sessions cannot enter protected business pages and preserve their return question', () => {
  const restricted = {
    status: 'authenticated' as const,
    user: { ...student, role: 'student' as const, tier: 'bronze' as const, mustChangePassword: true },
  }
  assert.equal(
    auth.protectedDestination(restricted, '/question/A28?mode=code#answer'),
    '/auth/change-password?returnTo=%2Fquestion%2FA28%3Fmode%3Dcode%23answer',
  )
  assert.equal(
    auth.protectedDestination(restricted, '/admin/users', true),
    '/auth/change-password?returnTo=%2Fadmin%2Fusers',
  )
  assert.equal(
    auth.protectedDestination(restricted, '/auth/change-password?returnTo=%2Fquestion%2FA28'),
    null,
  )
  assert.equal(
    auth.protectedDestination({ status: 'unavailable', user: restricted.user }, '/admin/users', true),
    'unavailable',
  )
  assert.equal(
    auth.protectedDestination(
      { status: 'authenticated', user: { ...restricted.user, mustChangePassword: false } },
      '/question/A28',
    ),
    null,
  )
})

test('a 42801 response restricts an existing page without clearing credentials', async (t) => {
  const values = storage(t)
  setAuthToken('token-a')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data: { user: student } }))
  const session = new auth.AuthSession()
  await session.restore()
  session.onAuthFailure(new ApiError(428, '请刷新页面并修改密码', 42801), 'token-a')
  assert.equal(session.snapshot.user?.mustChangePassword, true)
  assert.equal(values.get('aisec_token'), 'token-a')
})

test('legacy login preserves exact usernames and long passwords, while limited login requires change first', async (t) => {
  storage(t)
  let body: unknown
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    body = JSON.parse(String(options?.body))
    return Response.json({
      code: 0,
      data: { token: 'limited', user: { ...student, mustChangePassword: true } },
    })
  })
  const session = new auth.AuthSession()
  const password = '  ' + '原'.repeat(500) + '  '
  const user = await session.login(' CaseSensitive ', password, 'student')
  assert.deepEqual(body, { username: ' CaseSensitive ', password, role: 'student' })
  assert.equal(user.mustChangePassword, true)
  assert.equal(
    auth.protectedDestination(session.getSnapshot(), '/question/A28?tab=answer#editor'),
    '/auth/change-password?returnTo=%2Fquestion%2FA28%3Ftab%3Danswer%23editor',
  )
})

test('confirmed password change removes the restriction and allows the saved question again', async (t) => {
  storage(t)
  setAuthToken('limited')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      code: 0,
      data:
        ++calls === 1
          ? { user: { ...student, mustChangePassword: true } }
          : { token: 'full', user: { ...student, mustChangePassword: false } },
    }),
  )
  const session = new auth.AuthSession()
  await session.restore()
  await session.changePassword('initial', 'a'.repeat(15))
  assert.equal(getAuthToken(), 'full')
  assert.equal(auth.protectedDestination(session.getSnapshot(), '/question/A28?tab=answer#editor'), null)
})

test('logout still clears the old local credential if a later same-token verification fails', async (t) => {
  storage(t)
  setAuthToken('token-a')
  const delayed = deferred<Response>()
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) =>
    String(url).endsWith('/logout') ? delayed.promise : Response.json({ code: 50300 }, { status: 503 }),
  )
  const session = new auth.AuthSession()
  const logout = session.logout()
  await session.restore()
  delayed.resolve(Response.json({ code: 0, data: { ok: true } }))
  await logout
  assert.equal(getAuthToken(), null)
  assert.equal(session.snapshot.status, 'anonymous')
})

test('a delayed logout never logs out the account chosen in another tab', async (t) => {
  storage(t)
  setAuthToken('token-a')
  const delayed = deferred<Response>()
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) =>
    String(url).endsWith('/logout')
      ? delayed.promise
      : Response.json({ code: 0, data: { user: { ...student, id: 'b' } } }),
  )
  const session = new auth.AuthSession()
  const logout = session.logout()
  setAuthToken('token-b')
  await session.syncStorage()
  delayed.resolve(Response.json({ code: 0, data: { ok: true } }))
  assert.equal((await logout).sessionChanged, true)
  assert.equal(getAuthToken(), 'token-b')
  assert.equal(session.snapshot.user?.id, 'b')
})

test('failed password rotation preserves the current token and verified identity', async (t) => {
  storage(t)
  setAuthToken('token-a')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({ code: 0, data: { user: student } })
      : Response.json({ code: 50300, message: 'unavailable' }, { status: 503 }),
  )
  const session = new auth.AuthSession()
  await session.restore()
  await assert.rejects(session.changePassword('old', 'a'.repeat(15)), /unavailable/)
  assert.equal(getAuthToken(), 'token-a')
  assert.equal(session.snapshot.user?.id, 'a')
})

test('XHR uploads preserve auth status codes and stale upload results cannot enter the new account', async (t) => {
  storage(t)
  setAuthToken('token-a')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')
  let current!: Request
  class Request {
    upload = {}
    status = 401
    responseText = ''
    timeout = 0
    onload?: () => void
    open() {}
    setRequestHeader() {}
    send() {
      current = this
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: Request })
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'XMLHttpRequest', previous)
      : Reflect.deleteProperty(globalThis, 'XMLHttpRequest'),
  )
  const events: number[] = []
  const unsubscribe = subscribeAuthFailures((error) => {
    events.push(error.code!)
  })
  t.after(unsubscribe)
  const denied = submitMaterials(new FormData(), () => {})
  current.responseText = JSON.stringify({ code: 42801, message: '请刷新并修改密码' })
  current.status = 428
  current.onload?.()
  await assert.rejects(denied, (error: unknown) => error instanceof ApiError && error.code === 42801)
  assert.deepEqual(events, [42801])
  assert.equal(getAuthToken(), 'token-a')
  const late = submitMaterials(new FormData(), () => {})
  setAuthToken('token-b')
  current.status = 200
  current.responseText = JSON.stringify({ code: 0, data: { id: 'old-task' } })
  current.onload?.()
  await assert.rejects(late, /变化|切换/)
  assert.equal(getAuthToken(), 'token-b')
})

test('a successful response from a previously selected account cannot expose data after a token switch', async (t) => {
  storage(t)
  setAuthToken('old')
  const delayed = deferred<Response>()
  t.mock.method(globalThis, 'fetch', async () => delayed.promise)
  const request = apiGet('/admin/users')
  setAuthToken('new')
  delayed.resolve(Response.json({ code: 0, data: [{ id: 'private-old-account' }] }))
  await assert.rejects(request, /变化|切换/)
})

test('cross-tab login then logout invalidates a pending login even when storage returns to the same empty value', async (t) => {
  storage(t)
  const delayed = deferred<Response>()
  t.mock.method(globalThis, 'fetch', async () => delayed.promise)
  const session = new auth.AuthSession()
  const login = session.login('first', 'legacy', 'student')
  setAuthToken('other-tab-token')
  setAuthToken(null)
  await session.syncStorage(true)
  delayed.resolve(Response.json({ code: 0, data: { token: 'late-login', user: student } }))
  await assert.rejects(login, /变化|切换/)
  assert.equal(getAuthToken(), null)
  assert.equal(session.snapshot.status, 'anonymous')
})

test('returnTo preserves valid encoded query values and hash without decoding query percent literals', () => {
  for (const path of [
    '/question/A28?note=hello%20world#answer',
    '/question/A28?progress=100%25#answer',
    '/question/A28?link=https%3A%2F%2Fexample.com%2Fa#answer',
  ])
    assert.equal(auth.safeReturnTo(path), path)
})

test('failed credential persistence rejects login instead of publishing a new user with no usable token', async (t) => {
  const values = storage(t)
  values.set('draft', 'kept')
  t.mock.method(localStorage, 'setItem', () => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  const headers: Array<string | null> = []
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    headers.push(new Headers(options?.headers).get('Authorization'))
    return Response.json({ code: 0, data: { token: 'new-token', user: student } })
  })
  const session = new auth.AuthSession()
  await assert.rejects(session.login('first', 'legacy', 'student'), /存储|保存|凭据/)
  assert.equal(session.snapshot.status, 'anonymous')
  assert.equal(session.snapshot.user, null)
  assert.equal(getAuthToken(), null)
  assert.match(session.snapshot.notice ?? '', /存储|保存|凭据/)
  await apiGet('/fixture')
  assert.deepEqual(headers, [null, null])
  assert.equal(values.get('draft'), 'kept')
})

test('failed login persistence never sends a leftover previous-account token or restores that account on focus', async (t) => {
  const values = storage(t)
  setAuthToken('old-account')
  values.set('draft', 'kept')
  values.set('original-task-key', 'task')
  const session = new auth.AuthSession()
  t.mock.method(localStorage, 'setItem', () => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  t.mock.method(localStorage, 'removeItem', () => {
    throw new DOMException('denied', 'SecurityError')
  })
  const headers: Array<string | null> = []
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    headers.push(new Headers(options?.headers).get('Authorization'))
    return Response.json({ code: 0, data: { token: 'new-account', user: { ...student, id: 'b' } } })
  })
  await assert.rejects(session.login('second', 'legacy', 'student'), /存储|保存|凭据/)
  assert.equal(values.get('aisec_token'), 'old-account')
  assert.equal(getAuthToken(), null)
  await session.syncStorage()
  await session.syncStorage(true)
  assert.equal(session.snapshot.status, 'anonymous')
  await apiGet('/fixture')
  assert.deepEqual(headers, ['Bearer old-account', null])
  assert.equal(values.get('draft'), 'kept')
  assert.equal(values.get('original-task-key'), 'task')
})

test('failed token rotation persistence ends local authentication without using a revoked old token', async (t) => {
  const values = storage(t)
  for (const action of ['password', 'others'] as const) {
    setAuthToken('old-token')
    const session = new auth.AuthSession()
    const fetch = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) =>
      Response.json({
        code: 0,
        data: String(url).endsWith('/me') ? { user: student } : { token: 'new-token', user: student },
      }),
    )
    await session.restore()
    const set = t.mock.method(localStorage, 'setItem', () => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const remove = t.mock.method(localStorage, 'removeItem', () => {
      throw new DOMException('denied', 'SecurityError')
    })
    await assert.rejects(
      action === 'password' ? session.changePassword('legacy', 'a'.repeat(15)) : session.logoutOthers(),
      /存储|保存|凭据/,
    )
    assert.equal(values.get('aisec_token'), 'old-token')
    assert.equal(getAuthToken(), null)
    assert.equal(session.getSnapshot().status, 'anonymous')
    await session.syncStorage(true)
    assert.equal(session.getSnapshot().status, 'anonymous')
    set.mock.restore()
    remove.mock.restore()
    fetch.mock.restore()
  }
})

test('failed logout removal suppresses the residual token across focus and storage retries and explains the failure', async (t) => {
  const values = storage(t)
  setAuthToken('old-token')
  values.set('draft', 'kept')
  values.set('original-task-key', 'task')
  const session = new auth.AuthSession()
  t.mock.method(localStorage, 'removeItem', () => {
    throw new DOMException('denied', 'SecurityError')
  })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new TypeError('offline')
    return Response.json({ code: 0, data: { user: student } })
  })
  assert.equal((await session.logout()).revoked, false)
  assert.equal(values.get('aisec_token'), 'old-token')
  assert.equal(getAuthToken(), null)
  await session.syncStorage()
  await session.syncStorage(true)
  await session.restore()
  assert.equal(calls, 1)
  assert.equal(session.snapshot.status, 'anonymous')
  assert.match(session.snapshot.notice ?? '', /清除|删除/)
  assert.match(session.snapshot.notice ?? '', /屏蔽|禁用/)
  assert.equal(values.get('draft'), 'kept')
  assert.equal(values.get('original-task-key'), 'task')
})

test('restoration after a storage failure keeps the safety fence and never deletes another tab’s new credential', async (t) => {
  const values = storage(t)
  setAuthToken('old-token')
  const session = new auth.AuthSession()
  const removal = t.mock.method(localStorage, 'removeItem', () => {
    throw new DOMException('denied', 'SecurityError')
  })
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('offline')
  })
  await session.logout()
  removal.mock.restore()
  values.set('aisec_token', 'other-tab-new-token')
  await session.syncStorage(true)
  assert.equal(values.get('aisec_token'), 'other-tab-new-token')
  assert.equal(getAuthToken(), null)
  assert.equal(session.snapshot.status, 'anonymous')
  assert.match(session.snapshot.notice ?? '', /屏蔽|禁用/)
})
