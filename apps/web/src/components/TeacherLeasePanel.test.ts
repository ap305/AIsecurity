import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teacherLeaseControls as controls } from './TeacherLeasePanel'

test('a new teacher lease returned as not_started offers the start action', () => {
  const value = controls('not_started')
  assert.equal(value.canStart, true)
  assert.equal(value.canRenew, false)
  assert.equal(value.label, '尚未开启')
})

test('a creating teacher lease shows preparation without offering another start', () => {
  const value = controls('creating')
  assert.equal(value.canStart, false)
  assert.equal(value.canRenew, false)
  assert.match(value.label, /准备中.*尚未开始计时/)
})

test('an expired teacher lease offers renewal rather than a fresh start', () => {
  const value = controls('expired')
  assert.equal(value.canStart, false)
  assert.equal(value.canRenew, true)
  assert.equal(value.label, '已到期')
})

test('a revoked teacher lease cannot be reopened or renewed by its owner', () => {
  const value = controls('revoked')
  assert.equal(value.canStart, false)
  assert.equal(value.canRenew, false)
  assert.equal(value.label, '已撤销')
})

test('active leases remain single-use while absent and failed leases can be started', () => {
  assert.equal(controls('active').canStart, false)
  assert.equal(controls('active').canRenew, false)
  for (const state of [undefined, 'idle', 'error', 'unavailable']) {
    assert.equal(controls(state).canStart, true, state)
    assert.equal(controls(state).canRenew, false, state)
  }
})

test('an active, expired or revoked lease from an older question version offers a fresh start and hides its credentials', () => {
  for (const state of ['active', 'expired', 'revoked']) {
    const value = controls(state, 1, 2)
    assert.equal(value.canStart, true, state)
    assert.equal(value.canRenew, false, state)
    assert.equal(value.isCurrentVersion, false, state)
    assert.equal(value.label, '尚未开启', state)
  }
})

test('a revoked lease for the current question version stays revoked', () => {
  const value = controls('revoked', 2, 2)
  assert.equal(value.canStart, false)
  assert.equal(value.canRenew, false)
  assert.equal(value.isCurrentVersion, true)
  assert.equal(value.label, '已撤销')
})

test('lease callers without version metadata retain their existing state', () => {
  for (const versions of [[undefined, 2], [2, undefined], [undefined, undefined]] as const) {
    const value = controls('active', ...versions)
    assert.equal(value.isCurrentVersion, true)
    assert.equal(value.canStart, false)
    assert.equal(value.canRenew, false)
  }
})

test('administrators can revoke a creating lease before readiness activates it', () => {
  for (const state of ['creating', 'preparing', 'active'])
    assert.equal(controls(state).canRevoke, true, state)
  for (const state of ['not_started', 'expired', 'revoked', 'error', 'unavailable'])
    assert.equal(controls(state).canRevoke, false, state)
})
