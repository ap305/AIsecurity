import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TeacherLeasePanel from './TeacherLeasePanel'
import { prdApi, type TeacherLease } from '../lib/prdApi'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise<void>((done) => setImmediate(done))
function lease(state: string, questionId = 'Q1'): TeacherLease {
  const serverTime = new Date().toISOString()
  return {
    id: `lease-${questionId}`, questionId, questionVersion: 1, state, serverTime,
    startsAt: state === 'active' ? serverTime : null,
    expiresAt: state === 'active' ? new Date(Date.now() + 7200000).toISOString() : null,
    endpoint: state === 'active' ? `https://fixture.invalid/${questionId}` : null,
    calls: 0, maxCalls: 1000, scope: 'user_question',
  }
}

// The repository disallows browser verification; execute the real component's
// hooks and handlers with fixture API responses and controlled interval ticks.
function panel(t: TestContext) {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const hooks: unknown[] = []
  const cleanups = new Map<number, () => void>()
  const effects: Array<() => void> = []
  const intervals = new Map<number, { callback: () => unknown; ms: number }>()
  let index = 0, intervalId = 0, stateUpdates = 0
  let props = { questionId: 'Q1', questionVersion: 1 }
  const dispatcher = {
    useState(initial: unknown) {
      const key = index++
      if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial
      return [hooks[key], (value: unknown) => {
        stateUpdates++
        hooks[key] = typeof value === 'function' ? value(hooks[key]) : value
      }]
    },
    useRef(initial: unknown) {
      const key = index++
      return hooks[key] ?? (hooks[key] = { current: initial })
    },
    useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
      const key = index++
      const previous = hooks[key] as unknown[] | undefined
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        hooks[key] = dependencies
        effects.push(() => {
          cleanups.get(key)?.()
          const cleanup = effect()
          if (cleanup) cleanups.set(key, cleanup)
        })
      }
    },
  }
  t.mock.method(globalThis, 'setInterval', ((callback: () => unknown, ms: number) => {
    intervals.set(++intervalId, { callback, ms })
    return intervalId as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  t.mock.method(globalThis, 'clearInterval', ((id: ReturnType<typeof setInterval>) => {
    intervals.delete(id as unknown as number)
  }) as typeof clearInterval)
  const unmount = () => {
    cleanups.forEach((cleanup) => cleanup())
    cleanups.clear()
  }
  t.after(unmount)
  function render(nextProps = props) {
    props = nextProps
    index = 0
    const previous = internals.ReactCurrentDispatcher.current
    internals.ReactCurrentDispatcher.current = dispatcher
    let tree: React.ReactElement
    try { tree = TeacherLeasePanel(props) }
    finally { internals.ReactCurrentDispatcher.current = previous }
    effects.splice(0).forEach((effect) => effect())
    return tree
  }
  return {
    render,
    unmount,
    stateUpdates: () => stateUpdates,
    tick: () => Promise.all([...intervals.values()].filter(({ ms }) => ms === 15000).map(({ callback }) => callback())),
  }
}
function elements(node: unknown): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement(node)) return []
  return [node, ...elements((node.props as { children?: unknown }).children)]
}
function button(tree: React.ReactElement, label: string) {
  return elements(tree).find((node) => node.type === 'button' && node.props.children === label)
}
function assertActive(tree: React.ReactElement, questionId = 'Q1') {
  assert.ok(elements(tree).some((node) => node.type === 'input' && node.props.value === `https://fixture.invalid/${questionId}`))
  assert.equal(button(tree, '开启临时 API'), undefined)
}

test('a lease poll started before a successful start cannot hide the active endpoint', async (t) => {
  const oldPoll = deferred<TeacherLease>()
  let reads = 0
  t.mock.method(prdApi, 'lease', () => ++reads === 1 ? Promise.resolve(lease('not_started')) : oldPoll.promise)
  t.mock.method(prdApi, 'startLease', async () => lease('active'))
  const view = panel(t)
  view.render()
  await settle()
  const polling = view.tick()
  await button(view.render(), '开启临时 API')!.props.onClick()
  assertActive(view.render())
  oldPoll.resolve(lease('not_started'))
  await polling
  assertActive(view.render())
})

test('an older lease poll cannot replace a newer active response', async (t) => {
  const oldPoll = deferred<TeacherLease>()
  let reads = 0
  t.mock.method(prdApi, 'lease', () => ++reads === 2 ? oldPoll.promise : Promise.resolve(lease(reads === 1 ? 'not_started' : 'active')))
  const view = panel(t)
  view.render()
  await settle()
  const polling = view.tick()
  await view.tick()
  oldPoll.resolve(lease('not_started'))
  await polling
  assertActive(view.render())
})

test('a successful slow lease read can finish loading while the next poll is still pending', async (t) => {
  const firstRead = deferred<TeacherLease>(), nextRead = deferred<TeacherLease>()
  let reads = 0
  t.mock.method(prdApi, 'lease', () => ++reads === 1 ? firstRead.promise : nextRead.promise)
  t.after(() => nextRead.resolve(lease('active')))
  const view = panel(t)
  view.render()
  const polling = view.tick()
  firstRead.resolve(lease('active'))
  await settle()
  assertActive(view.render())
  nextRead.resolve(lease('active'))
  await polling
})

test('polling and repeated clicks cannot start another request while a lease action is pending', async (t) => {
  const start = deferred<TeacherLease>()
  const get = t.mock.method(prdApi, 'lease', async () => lease('not_started'))
  const post = t.mock.method(prdApi, 'startLease', () => start.promise)
  const view = panel(t)
  view.render()
  await settle()
  const startButton = button(view.render(), '开启临时 API')!
  const first = startButton.props.onClick()
  const second = startButton.props.onClick()
  await view.tick()
  assert.equal(button(view.render(), '正在开启…')!.props.disabled, true)
  start.resolve(lease('active'))
  await Promise.all([first, second])
  assert.equal(post.mock.callCount(), 1)
  assert.equal(get.mock.callCount(), 1)
  assertActive(view.render())
})

test('a start response from a previous question cannot enter the new question panel', async (t) => {
  const start = deferred<TeacherLease>()
  t.mock.method(prdApi, 'lease', async (id: string) => lease('not_started', id))
  t.mock.method(prdApi, 'startLease', () => start.promise)
  const view = panel(t)
  view.render()
  await settle()
  const pending = button(view.render(), '开启临时 API')!.props.onClick()
  view.render({ questionId: 'Q2', questionVersion: 1 })
  await settle()
  start.resolve(lease('active', 'Q1'))
  await pending
  const current = view.render()
  assert.ok(button(current, '开启临时 API'))
  assert.ok(!elements(current).some((node) => node.type === 'input' && node.props.value === 'https://fixture.invalid/Q1'))
})

test('an older question action cannot unlock a newer pending action', async (t) => {
  const oldStart = deferred<TeacherLease>(), newStart = deferred<TeacherLease>()
  t.mock.method(prdApi, 'lease', async (id: string) => lease('not_started', id))
  t.mock.method(prdApi, 'startLease', (id: string) => id === 'Q1' ? oldStart.promise : newStart.promise)
  const view = panel(t)
  view.render()
  await settle()
  const oldPending = button(view.render(), '开启临时 API')!.props.onClick()
  view.render({ questionId: 'Q2', questionVersion: 1 })
  await settle()
  const newControl = button(view.render(), '开启临时 API')
  assert.ok(newControl, 'the new question must reset the old action busy state')
  const newPending = newControl.props.onClick()
  oldStart.resolve(lease('active', 'Q1'))
  await oldPending
  assert.equal(button(view.render(), '正在开启…')!.props.disabled, true)
  newStart.resolve(lease('active', 'Q2'))
  await newPending
  assertActive(view.render(), 'Q2')
})

for (const change of ['version', 'identity'] as const) {
  test(`a previous ${change} action cannot enter or unlock the new lease scope`, async (t) => {
    const oldStart = deferred<TeacherLease>(), newStart = deferred<TeacherLease>()
    let currentToken = 'fixture-account-a'
    if (change === 'identity') {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: (key: string) => key === 'aisec_token' ? currentToken : null },
      })
      t.after(() => previous
        ? Object.defineProperty(globalThis, 'localStorage', previous)
        : Reflect.deleteProperty(globalThis, 'localStorage'))
    }
    let starts = 0
    t.mock.method(prdApi, 'lease', async () => lease('not_started'))
    t.mock.method(prdApi, 'startLease', () => ++starts === 1 ? oldStart.promise : newStart.promise)
    const view = panel(t)
    view.render()
    await settle()
    const oldPending = button(view.render(), '开启临时 API')!.props.onClick()
    currentToken = 'fixture-account-b'
    view.render({ questionId: 'Q1', questionVersion: change === 'version' ? 2 : 1 })
    await settle()
    const newControl = button(view.render(), '开启临时 API')
    assert.ok(newControl, 'a new scope must not inherit the old action busy state')
    const newPending = newControl.props.onClick()
    oldStart.resolve(lease('active'))
    await oldPending
    assert.equal(button(view.render(), '正在开启…')!.props.disabled, true)
    newStart.resolve({ ...lease('active'), questionVersion: change === 'version' ? 2 : 1 })
    await newPending
    assertActive(view.render())
  })
}

test('an unmounted lease panel ignores a pending action response and its final state updates', async (t) => {
  const start = deferred<TeacherLease>()
  t.mock.method(prdApi, 'lease', async () => lease('not_started'))
  t.mock.method(prdApi, 'startLease', () => start.promise)
  const view = panel(t)
  view.render()
  await settle()
  const pending = button(view.render(), '开启临时 API')!.props.onClick()
  view.unmount()
  const before = view.stateUpdates()
  start.resolve(lease('active'))
  await pending
  assert.equal(view.stateUpdates(), before)
})

test('captured lease controls cannot send requests after the stored login changes before a render', async (t) => {
  let currentToken = 'fixture-account-a'
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === 'aisec_token' ? currentToken : null },
  })
  t.after(() => previous
    ? Object.defineProperty(globalThis, 'localStorage', previous)
    : Reflect.deleteProperty(globalThis, 'localStorage'))
  const get = t.mock.method(prdApi, 'lease', async () => lease('not_started'))
  const post = t.mock.method(prdApi, 'startLease', async () => lease('active'))
  const view = panel(t)
  view.render()
  await settle()
  const captured = button(view.render(), '开启临时 API')!
  currentToken = 'fixture-account-b'
  await captured.props.onClick()
  await view.tick()
  assert.equal(post.mock.callCount(), 0)
  assert.equal(get.mock.callCount(), 1)
})

for (const action of ['start', 'renew'] as const) {
  test(`a timed-out lease ${action} restores controls and a status recheck never repeats the mutation`, async (t) => {
    let reads = 0
    t.mock.method(prdApi, 'lease', async () => lease(++reads === 1 ? (action === 'renew' ? 'expired' : 'not_started') : 'active'))
    const mutate = t.mock.method(prdApi, action === 'start' ? 'startLease' : 'renewLease', async () => { throw new Error('请求超时') })
    const view = panel(t)
    view.render()
    await settle()
    const label = action === 'start' ? '开启临时 API' : '手动续期两小时'
    await button(view.render(), label)!.props.onClick()
    assert.equal(button(view.render(), label)!.props.disabled, false)
    const recheck = button(view.render(), '重新查询租约')
    assert.ok(recheck, 'a failed action must offer a read-only status recheck')
    await recheck.props.onClick()
    assertActive(view.render())
    assert.equal(mutate.mock.callCount(), 1)
    assert.equal(reads, 2)
  })
}
