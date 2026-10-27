import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultAdminUserFilters, filterAdminUsers } from './adminUserFilters'
import type { AdminUser } from './adminUsers'

const base = {
  tier: 'bronze',
  createdAt: '2026-10-27T00:00:00Z',
  role: 'student',
  accountStatus: 'active',
  isTestAccount: false,
} as const
const users: AdminUser[] = [
  { ...base, id: 'admin', username: 'AdminZ', displayName: '管理员', school: '', role: 'admin' },
  {
    ...base,
    id: 'alice',
    username: 'Alice2026',
    displayName: '张三',
    school: '北京理工大学',
    studentId: '000123',
  },
  {
    ...base,
    id: 'test-disabled',
    username: 'FlowQA27',
    displayName: '测试账号',
    school: '北京理工大学',
    isTestAccount: true,
    accountStatus: 'disabled',
    studentId: null,
  },
  {
    ...base,
    id: 'test-active',
    username: 'ActiveQA',
    displayName: '李四',
    school: '清华大学',
    isTestAccount: true,
  },
]
const ids = (rows: AdminUser[]) => rows.map((u) => u.id)

test('default and whitespace-only filters preserve the complete user order without mutating inputs', () => {
  const before = structuredClone(users)
  assert.deepEqual(ids(filterAdminUsers(users, defaultAdminUserFilters())), [
    'admin',
    'alice',
    'test-disabled',
    'test-active',
  ])
  assert.deepEqual(ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), keyword: ' \t\n ' })), [
    'admin',
    'alice',
    'test-disabled',
    'test-active',
  ])
  assert.deepEqual(users, before)
})

test('search matches username, name, school and leading-zero student number independently', () => {
  for (const [keyword, expected] of [
    ['aLiCe', ['alice']],
    ['张三', ['alice']],
    ['清华', ['test-active']],
    ['000123', ['alice']],
    ['  FLOWqa27  ', ['test-disabled']],
  ] as const)
    assert.deepEqual(ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), keyword })), expected)
})

test('multiple keywords can match different fields but never concatenate field boundaries', () => {
  assert.deepEqual(
    ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), keyword: '  北京\t测试  ' })),
    ['test-disabled'],
  )
  assert.deepEqual(
    ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), keyword: 'Alice2026张三' })),
    [],
  )
})

test('account type, role, status and keyword are combined with AND', () => {
  assert.deepEqual(
    ids(
      filterAdminUsers(users, { keyword: '北京', accountType: 'test', role: 'student', status: 'disabled' }),
    ),
    ['test-disabled'],
  )
  assert.deepEqual(
    ids(filterAdminUsers(users, { keyword: '', accountType: 'test', role: 'admin', status: 'all' })),
    [],
  )
  assert.deepEqual(
    ids(filterAdminUsers(users, { keyword: 'QA', accountType: 'test', role: 'student', status: 'active' })),
    ['test-active'],
  )
})

test('formal accounts include administrators while the independent role filter narrows the result', () => {
  assert.deepEqual(ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), accountType: 'regular' })), [
    'admin',
    'alice',
  ])
  assert.deepEqual(
    ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), accountType: 'regular', role: 'admin' })),
    ['admin'],
  )
  assert.deepEqual(
    ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), accountType: 'regular', role: 'student' })),
    ['alice'],
  )
})

test('missing optional profile fields and empty data are safe; deleted accounts remain hidden', () => {
  assert.deepEqual(filterAdminUsers([], defaultAdminUserFilters()), [])
  assert.deepEqual(
    ids(filterAdminUsers(users, { ...defaultAdminUserFilters(), keyword: 'no-such-account' })),
    [],
  )
  assert.deepEqual(
    ids(filterAdminUsers([{ ...users[1], accountStatus: 'deleted' }], defaultAdminUserFilters())),
    [],
  )
  assert.deepEqual(
    ids(filterAdminUsers(users.slice(2), { ...defaultAdminUserFilters(), keyword: '000123' })),
    [],
  )
})

test('the same filters reflect a status refresh and resetting restores all visible accounts', () => {
  const filters = { ...defaultAdminUserFilters(), accountType: 'test' as const, status: 'active' as const }
  assert.deepEqual(ids(filterAdminUsers(users, filters)), ['test-active'])
  const refreshed = users.map((u) =>
    u.id === 'test-active' ? { ...u, accountStatus: 'disabled' as const } : u,
  )
  assert.deepEqual(ids(filterAdminUsers(refreshed, filters)), [])
  assert.deepEqual(filters, { keyword: '', accountType: 'test', role: 'all', status: 'active' })
  assert.deepEqual(ids(filterAdminUsers(refreshed, defaultAdminUserFilters())), [
    'admin',
    'alice',
    'test-disabled',
    'test-active',
  ])
})
