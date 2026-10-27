import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createTestAccount,
  setTestAccountStatus,
  validateTestAccountForm,
  userDeleteConfirmation,
  type AdminUser,
  type TestAccountForm,
} from './adminUsers'
import TestAccountCreateForm from '../pages/admin/TestAccountCreateForm'
import UserManager from '../pages/admin/UserManager'

const form: TestAccountForm = {
  username: '  reviewTest27  ',
  displayName: '  教师测试  ',
  password: ' test-initial-value ',
  school: '  北京理工大学  ',
}

const user: AdminUser = {
  id: 'test/account-27',
  username: 'reviewTest27',
  displayName: '教师测试',
  role: 'student',
  tier: 'bronze',
  school: '北京理工大学',
  createdAt: '2026-10-27T10:00:00.000Z',
  isTestAccount: true,
  accountStatus: 'active',
}

function storedAdmin(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map([
    ['aisec_token', 'current-admin-token'],
    ['aisec_user', '{"id":"admin"}'],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    },
  })
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'localStorage', previous)
      : Reflect.deleteProperty(globalThis, 'localStorage'),
  )
  return data
}

test('test account creation uses the admin endpoint and preserves the current admin session', async (t) => {
  const storage = storedAdmin(t)
  const requests: { url: string; options: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, options })
    return Response.json({ code: 0, message: 'ok', data: { user } })
  })

  assert.deepEqual(await createTestAccount(form), user)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/admin/users')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    username: 'reviewTest27',
    displayName: '教师测试',
    password: ' test-initial-value ',
    school: '北京理工大学',
  })
  assert.equal(new Headers(requests[0].options.headers).get('Authorization'), 'Bearer current-admin-token')
  assert.equal(storage.get('aisec_token'), 'current-admin-token')
  assert.equal(storage.get('aisec_user'), '{"id":"admin"}')
})

test('required fields and username limits block invalid test accounts before any request', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1
    return Response.json({ code: 0, message: 'ok', data: { user } })
  })
  for (const invalid of [
    { ...form, username: '' },
    { ...form, username: 'ab' },
    { ...form, username: 'a'.repeat(33) },
    { ...form, username: 'test_27' },
    { ...form, displayName: '   ' },
    { ...form, password: '' },
    { ...form, password: '     ' },
    { ...form, password: '12345' },
  ]) {
    assert.ok(validateTestAccountForm(invalid))
    await assert.rejects(createTestAccount(invalid), /用户名|姓名|密码/)
  }
  assert.equal(requests, 0)
  assert.equal(validateTestAccountForm({ ...form, school: '' }), null)
  assert.equal(validateTestAccountForm({ ...form, username: 'abc' }), null)
  assert.equal(validateTestAccountForm({ ...form, username: 'a'.repeat(32) }), null)
})

test('optional school can be empty and unexpected privilege fields never enter creation payloads', async (t) => {
  let payload: Record<string, unknown> | null = null
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    payload = JSON.parse(String(options.body))
    return Response.json({ code: 0, message: 'ok', data: { user } })
  })
  await createTestAccount({ ...form, school: ' ', role: 'admin', isTestAccount: false } as TestAccountForm)
  assert.deepEqual(payload, {
    username: 'reviewTest27',
    displayName: '教师测试',
    password: ' test-initial-value ',
  })
})

test('creation enforces server field length limits before sending a request', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return Response.json({ code: 0, message: 'ok', data: { user } })
  })
  for (const invalid of [
    { ...form, displayName: '名'.repeat(65) },
    { ...form, school: '校'.repeat(201) },
    { ...form, password: 'p'.repeat(129) },
  ])
    await assert.rejects(createTestAccount(invalid))
  assert.equal(requests, 0)
  assert.equal(
    validateTestAccountForm({
      ...form,
      displayName: '名'.repeat(64),
      school: '校'.repeat(200),
      password: 'p'.repeat(128),
    }),
    null,
  )
})

test('status actions use the exact target and allow disabling and re-enabling only test students', async (t) => {
  const calls: { url: string; status: string }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, 'PUT')
    const { status } = JSON.parse(String(options.body))
    calls.push({ url, status })
    return Response.json({ code: 0, message: 'ok', data: { user: { ...user, accountStatus: status } } })
  })
  assert.equal((await setTestAccountStatus(user, 'disabled')).accountStatus, 'disabled')
  assert.equal(
    (await setTestAccountStatus({ ...user, accountStatus: 'disabled' }, 'active')).accountStatus,
    'active',
  )
  assert.deepEqual(calls, [
    { url: '/api/admin/users/test%2Faccount-27/status', status: 'disabled' },
    { url: '/api/admin/users/test%2Faccount-27/status', status: 'active' },
  ])
  for (const invalid of [
    { ...user, isTestAccount: false },
    { ...user, role: 'admin' },
    { ...user, accountStatus: 'deleted' as const },
  ])
    await assert.rejects(setTestAccountStatus(invalid, 'disabled'), /测试账号/)
  await assert.rejects(setTestAccountStatus(user, 'deleted' as 'active'), /状态/)
  assert.equal(calls.length, 2)
})

test('failed creation preserves the entered form and reports the actual server error', async (t) => {
  const before = { ...form }
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        code: 40001,
        message: '用户名已存在',
        data: null,
      },
      { status: 400 },
    ),
  )
  await assert.rejects(createTestAccount(form), /用户名已存在/)
  assert.deepEqual(form, before)
})

test('a missing created user cannot be accepted as success and clear the entered form', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, message: 'ok', data: {} }))
  await assert.rejects(createTestAccount(form), /账号.*信息|响应/)
})

test('a status response for another account cannot be accepted as a completed action', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      code: 0,
      message: 'ok',
      data: { user: { ...user, id: 'other-account', accountStatus: 'disabled' } },
    }),
  )
  await assert.rejects(setTestAccountStatus(user, 'disabled'), /账号.*信息|响应/)
})

test('deletion confirmation distinguishes retained test history from the original student action', () => {
  assert.match(userDeleteConfirmation(user), /测试账号/)
  assert.match(userDeleteConfirmation(user), /历史.*保留|保留.*历史/)
  assert.match(userDeleteConfirmation(user), /用户名.*保留|保留.*用户名/)
  assert.match(userDeleteConfirmation({ ...user, isTestAccount: false }), /删除学员.*不可恢复/)
})

test('the creation form labels required fields, masks the initial password and retains failed input', () => {
  const html = renderToStaticMarkup(
    createElement(TestAccountCreateForm, {
      value: form,
      busy: false,
      error: '用户名已存在',
      onChange: () => {},
      onSubmit: () => {},
    }),
  )
  for (const id of [
    'test-account-username',
    'test-account-display-name',
    'test-account-password',
    'test-account-school',
  ]) {
    assert.match(html, new RegExp(`for="${id}"`))
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /type="password"/)
  assert.match(html, /value="  reviewTest27  "/)
  assert.match(html, /role="alert"[^>]*>用户名已存在/)
  assert.equal((html.match(/required=""/g) ?? []).length, 3)
  assert.match(html, /学校（选填）/)
  assert.match(html, /不计入正式排行榜和学生成绩汇总/)
})

test('the creation form disables every input and submit button while the request is pending', () => {
  const html = renderToStaticMarkup(
    createElement(TestAccountCreateForm, {
      value: form,
      busy: true,
      error: null,
      onChange: () => {},
      onSubmit: () => {},
    }),
  )
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5)
  assert.match(html, /正在创建/)
})

test('another account action blocks creation without claiming a new account is being created', () => {
  const html = renderToStaticMarkup(
    createElement(TestAccountCreateForm, {
      value: form,
      busy: false,
      blocked: true,
      error: null,
      onChange: () => {},
      onSubmit: () => {},
    }),
  )
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5)
  assert.doesNotMatch(html, /正在创建/)
})

test('user management exposes account creation even before its user list has loaded', () => {
  const html = renderToStaticMarkup(createElement(UserManager))
  assert.match(html, /用户管理/)
  assert.match(html, /创建测试账号/)
  assert.match(html, /id="test-account-password"/)
  assert.match(html, /加载用户中/)
})
