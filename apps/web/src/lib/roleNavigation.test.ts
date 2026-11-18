import test from 'node:test'
import assert from 'node:assert/strict'
import { loginWorkspaceDestination, workspaceRoleLabel } from './roleNavigation'

test('only the default student login destination resolves the granted teaching workspace', () => {
  assert.equal(loginWorkspaceDestination(null, 'student'), '/workspace')
  assert.equal(loginWorkspaceDestination(null, 'admin'), '/')
  assert.equal(loginWorkspaceDestination('/', 'student'), '/workspace')
  assert.equal(loginWorkspaceDestination('/', 'admin'), '/')
  for (const destination of [
    '/classes',
    '/arena?role=attack',
    '/question/Q1?tab=code#draft',
    '/teaching/classes/C1',
    '/admin/users',
  ]) {
    assert.equal(loginWorkspaceDestination(destination, 'student'), destination)
    assert.equal(loginWorkspaceDestination(destination, 'admin'), destination)
  }
  for (const unsafe of [
    'https://elsewhere.invalid',
    '//elsewhere.invalid',
    '/login',
    '/%2felsewhere.invalid',
  ]) {
    assert.equal(loginWorkspaceDestination(unsafe, 'student'), '/workspace')
  }
})

test('visible identity follows a confirmed grant, not a legacy teacher role string', () => {
  assert.equal(workspaceRoleLabel('admin', false), '管理员')
  assert.equal(workspaceRoleLabel('student', true), '教师')
  assert.equal(workspaceRoleLabel('teacher', false), '学生')
})
