import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {
  Link,
  Outlet,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
  UNSAFE_NavigationContext,
  UNSAFE_DataRouterContext,
} from 'react-router-dom'
import { TeachingProvider } from './TeachingContext'
import { classroomsApi } from '../lib/classrooms'
import { setAuthToken } from '../lib/api'
import Sidebar from '../components/Sidebar'
import Topbar from '../components/Topbar'
import ProtectedTeachingRoute, { WorkspaceLanding } from '../components/ProtectedTeachingRoute'
import Login from '../pages/Login'
import { TeachingGrantControl } from '../pages/admin/UserManager'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function elements(node: any): React.ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return React.isValidElement<{ children?: unknown }>(node) ? [node, ...elements(node.props.children)] : []
}
function words(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return React.isValidElement<{ children?: unknown }>(node) ? words(node.props.children) : ''
}
function harness(t: TestContext, component: () => React.ReactElement, browser = true) {
  const memory = new Map<string, string>(),
    handlers = new Map<string, Set<() => void>>()
  const oldStorage = globalThis.localStorage,
    oldWindow = globalThis.window
  if (browser)
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
      },
    })
  if (browser)
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (name: string, callback: () => void) => {
          if (!handlers.has(name)) handlers.set(name, new Set())
          handlers.get(name)!.add(callback)
        },
        removeEventListener: (name: string, callback: () => void) => handlers.get(name)?.delete(callback),
      },
    })
  if (browser) setAuthToken('teacher-token')
  const env = {
    pathname: '/',
    search: '',
    context: {
      user: { id: 'teacher', role: 'student', displayName: '张老师', mustChangePassword: false },
      isAuthenticated: true,
      isAdmin: false,
      canTeach: true,
      status: 'ready',
      refresh: async () => {},
      login: async () => ({ role: 'student', mustChangePassword: false }),
    },
    navigation: [] as string[],
  }
  const values: any[] = [],
    effects: Array<() => void> = [],
    cleanups = new Map<number, () => void>()
  let index = 0
  function effect(callback: () => (() => void) | void, dependencies: unknown[]) {
    const slot = index++,
      before = values[slot]
    if (!before || dependencies.some((value, i) => !Object.is(value, before[i]))) {
      values[slot] = dependencies
      effects.push(() => {
        cleanups.get(slot)?.()
        const cleanup = callback()
        if (cleanup) cleanups.set(slot, cleanup)
      })
    }
  }
  const dispatcher = {
    useState(initial: any) {
      const slot = index++
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial
      return [
        values[slot],
        (value: any) => {
          values[slot] = typeof value === 'function' ? value(values[slot]) : value
        },
      ]
    },
    useRef(initial: any) {
      const slot = index++
      return values[slot] ?? (values[slot] = { current: initial })
    },
    useCallback(callback: unknown, dependencies: unknown[]) {
      const slot = index++,
        before = values[slot]
      if (!before || dependencies.some((value, i) => !Object.is(value, before.dependencies[i])))
        values[slot] = { callback, dependencies }
      return values[slot].callback
    },
    useContext(context: any) {
      if (context === UNSAFE_LocationContext)
        return {
          location: { pathname: env.pathname, search: env.search, hash: '', state: null, key: 'test' },
        }
      if (context === UNSAFE_RouteContext) return { matches: [], outlet: null, isDataRoute: false }
      if (context === UNSAFE_DataRouterContext) return null
      if (context === UNSAFE_NavigationContext)
        return {
          basename: '/',
          future: {},
          static: false,
          navigator: {
            push: (path: any) =>
              env.navigation.push(typeof path === 'string' ? path : path.pathname + path.search),
            replace: (path: any) =>
              env.navigation.push(typeof path === 'string' ? path : path.pathname + path.search),
          },
        }
      return env.context
    },
    useEffect: effect,
    useLayoutEffect: effect,
  }
  const unmount = () => {
    cleanups.forEach((cleanup) => cleanup())
    cleanups.clear()
  }
  t.after(() => {
    unmount()
    if (browser) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: oldStorage })
      Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
    }
  })
  return {
    env,
    unmount,
    focus: () => handlers.get('focus')?.forEach((callback) => callback()),
    render() {
      index = 0
      const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
      const original = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree: React.ReactElement<any>
      try {
        tree = component()
      } finally {
        internals.ReactCurrentDispatcher.current = original
      }
      effects.splice(0).forEach((callback) => callback())
      return tree
    },
  }
}

test('teaching grants refresh on focus, fail closed, support retry and observe revocation', async (t) => {
  const ui = harness(t, () => TeachingProvider({ children: null }))
  let result: Promise<{ canTeach: boolean }> = Promise.resolve({ canTeach: true })
  t.mock.method(classroomsApi, 'capabilities', () => result)
  assert.equal(ui.render().props.value.status, 'loading')
  await settle()
  assert.equal(ui.render().props.value.canTeach, true)
  const failed = deferred<{ canTeach: boolean }>()
  result = failed.promise
  ui.focus()
  assert.equal(ui.render().props.value.canTeach, false)
  failed.reject(new Error('offline'))
  await settle()
  assert.equal(ui.render().props.value.status, 'unavailable')
  result = Promise.resolve({ canTeach: true })
  await ui.render().props.value.refresh()
  assert.equal(ui.render().props.value.canTeach, true)
  result = Promise.resolve({ canTeach: false })
  ui.focus()
  await settle()
  assert.equal(ui.render().props.value.canTeach, false)
  assert.equal(ui.render().props.value.status, 'ready')
})

test('credential and route changes fence late grants before rendering protected controls', async (t) => {
  const ui = harness(t, () => TeachingProvider({ children: null }))
  const old = deferred<{ canTeach: boolean }>(),
    current = deferred<{ canTeach: boolean }>()
  let call = 0
  t.mock.method(classroomsApi, 'capabilities', () => (++call === 1 ? old.promise : current.promise))
  ui.render()
  setAuthToken('other-token')
  ui.env.context.user.id = 'other'
  assert.equal(ui.render().props.value.canTeach, false)
  old.resolve({ canTeach: true })
  await settle()
  assert.equal(ui.render().props.value.canTeach, false)
  current.resolve({ canTeach: true })
  await settle()
  assert.equal(ui.render().props.value.canTeach, true)
  ui.env.pathname = '/teaching/classes/C1'
  assert.equal(ui.render().props.value.canTeach, false)
  await settle()
  assert.equal(ui.render().props.value.canTeach, true)
  assert.equal(call, 3)
})

test('logout, required password change and unmount cannot retain or restore a grant', async (t) => {
  const ui = harness(t, () => TeachingProvider({ children: null }))
  const late = deferred<{ canTeach: boolean }>()
  let calls = 0
  t.mock.method(classroomsApi, 'capabilities', () => {
    calls++
    return late.promise
  })
  ui.env.context.user.mustChangePassword = true
  assert.equal(ui.render().props.value.canTeach, false)
  assert.equal(calls, 0)
  ui.env.context.user.mustChangePassword = false
  ui.render()
  ui.env.context.isAuthenticated = false
  setAuthToken(null)
  assert.equal(ui.render().props.value.canTeach, false)
  late.resolve({ canTeach: true })
  await settle()
  assert.equal(ui.render().props.value.canTeach, false)
  ui.unmount()
  ui.focus()
  assert.equal(calls, 1)
})

test('teacher navigation has one workspace switch, clear role badge and non-overlapping teaching links', (t) => {
  const top = harness(t, Topbar, false)
  let tree = top.render()
  assert.match(words(tree), /教师/)
  assert.doesNotMatch(words(tree), /任务大厅|对战大厅/)
  assert.equal(
    elements(tree).filter((node) => node.type === 'nav' && node.props['aria-label'] === '空间切换').length,
    1,
  )
  assert.deepEqual(
    elements(tree)
      .filter((node) => node.type === Link)
      .map((node) => node.props.to),
    ['/', '/', '/teaching'],
  )
  top.env.context.canTeach = false
  assert.equal(
    elements(top.render()).some((node) => node.type === Link && node.props.to === '/teaching'),
    false,
  )
  const side = harness(t, Sidebar, false)
  side.env.pathname = '/teaching/solutions'
  tree = side.render()
  assert.match(words(tree), /管理的班级我的讲解/)
  const active = elements(tree).filter((node) => node.type === Link && node.props['aria-current'] === 'page')
  assert.deepEqual(
    active.map((node) => node.props.to),
    ['/teaching/solutions'],
  )
  side.env.pathname = '/'
  assert.match(words(side.render()), /基础题库对抗题库/)
  for (const pathname of ['/arena', '/arena/V3-261012-D04']) {
    side.env.pathname = pathname
    const current = elements(side.render()).filter((node) => node.type === Link && node.props['aria-current'] === 'page')
    assert.deepEqual(current.map((node) => node.props.to), ['/arena'])
  }
})

test('teaching guard hides controls on denied or unavailable access and offers a retry', (t) => {
  const ui = harness(t, ProtectedTeachingRoute, false)
  assert.equal(
    elements(ui.render()).some((node) => node.type === Outlet),
    true,
  )
  ui.env.context.canTeach = false
  let tree = ui.render()
  assert.match(words(tree), /暂无教学权限/)
  assert.equal(
    elements(tree).some((node) => node.type === Outlet),
    false,
  )
  assert.equal(
    elements(tree).some((node) => node.type === 'button' && words(node) === '刷新教学权限'),
    true,
  )
  ui.env.context.status = 'unavailable'
  assert.notEqual(ui.render().type, Outlet)
  const landing = harness(t, WorkspaceLanding, false)
  assert.equal(landing.render().props.to, '/teaching')
  landing.env.context.canTeach = false
  assert.equal(landing.render().props.to, '/')
})

test('focus verification retains the same hidden outlet; revocation, error and identity changes discard it', (t) => {
  const ui = harness(t, ProtectedTeachingRoute)
  ui.env.pathname = '/teaching/solutions'
  const first = ui.render()
  const firstOutlet = elements(first).find((node) => node.type === Outlet)!
  assert.ok(firstOutlet)
  ui.env.context.status = 'loading'
  ui.env.context.canTeach = false
  let tree = ui.render()
  const retained = elements(tree).find((node) => node.type === Outlet)
  assert.ok(retained, 'the same outlet remains mounted while its parent is hidden')
  assert.equal(retained.type, firstOutlet.type)
  assert.equal(retained.key, firstOutlet.key)
  assert.equal(
    elements(tree).some(
      (node) => node.type === 'div' && node.props.hidden === true && elements(node).includes(retained),
    ),
    true,
  )
  ui.env.context.status = 'ready'
  ui.env.context.canTeach = true
  assert.equal(
    elements(ui.render()).some((node) => node.type === 'div' && node.props.hidden === false),
    true,
  )
  ui.env.context.status = 'unavailable'
  ui.env.context.canTeach = false
  assert.equal(
    elements(ui.render()).some((node) => node.type === Outlet),
    false,
  )
  ui.env.context.status = 'ready'
  ui.env.context.canTeach = true
  ui.render()
  ui.env.context.status = 'loading'
  ui.env.context.canTeach = false
  setAuthToken('new-credential')
  assert.equal(
    elements(ui.render()).some((node) => node.type === Outlet),
    false,
  )
  ui.env.context.status = 'ready'
  ui.env.context.canTeach = true
  ui.render()
  ui.env.context.status = 'loading'
  ui.env.context.canTeach = false
  ui.env.pathname = '/teaching/classes/C1'
  assert.equal(
    elements(ui.render()).some((node) => node.type === Outlet),
    false,
  )
  ui.env.context.status = 'ready'
  tree = ui.render()
  assert.match(words(tree), /暂无教学权限/)
  assert.equal(
    elements(tree).some((node) => node.type === Outlet),
    false,
  )
})

test('login preserves explicit deep links and routes forced password changes through the default workspace', async (t) => {
  const ui = harness(t, Login, false)
  const fill = () => {
    const tree = ui.render()
    for (const [id, value] of [
      ['login-username', 'teacher'],
      ['login-password', 'valid password'],
    ]) {
      elements(tree)
        .find((node) => node.props.id === id)!
        .props.onChange({ target: { value } })
    }
  }
  fill()
  assert.match(words(ui.render()), /师生登录/)
  ui.env.search = '?returnTo=%2Fteaching%2Fclasses%2FC1'
  await elements(ui.render())
    .find((node) => node.type === 'form')!
    .props.onSubmit({ preventDefault() {} })
  assert.equal(ui.env.navigation.at(-1), '/teaching/classes/C1')
  ui.env.search = '?returnTo=%2F'
  await elements(ui.render())
    .find((node) => node.type === 'form')!
    .props.onSubmit({ preventDefault() {} })
  assert.equal(ui.env.navigation.at(-1), '/workspace')
  ui.env.search = ''
  ui.env.context.login = async () => ({ role: 'student', mustChangePassword: true })
  await elements(ui.render())
    .find((node) => node.type === 'form')!
    .props.onSubmit({ preventDefault() {} })
  assert.equal(ui.env.navigation.at(-1), '/auth/change-password?returnTo=%2Fworkspace')
})

test('teacher grant changes update the list only after confirmed saves; disabled accounts cannot gain grants', async (t) => {
  const changed: boolean[] = []
  let status = 'disabled'
  t.mock.method(classroomsApi, 'getTeaching', async () => ({ userId: 'teacher', enabled: false }))
  const save = t.mock.method(classroomsApi, 'setTeaching', async (_id: string, enabled: boolean) => ({
    userId: 'teacher',
    enabled,
  }))
  const ui = harness(
    t,
    () =>
      TeachingGrantControl({
        userId: 'teacher',
        displayName: '张老师',
        accountStatus: status,
        onChanged: (value) => changed.push(value),
      }),
    false,
  )
  ui.render()
  await settle()
  let grant = elements(ui.render()).find((node) => node.type === 'button' && words(node) === '授予教师权限')!
  assert.equal(grant.props.disabled, true)
  await grant.props.onClick()
  assert.equal(save.mock.callCount(), 0)
  status = 'active'
  grant = elements(ui.render()).find((node) => node.type === 'button' && words(node) === '授予教师权限')!
  await grant.props.onClick()
  assert.deepEqual(changed, [true])
  assert.match(words(ui.render()), /已授予教师权限/)
  const pending = deferred<{ userId: string; enabled: boolean }>()
  t.mock.method(classroomsApi, 'setTeaching', () => pending.promise)
  const revoke = elements(ui.render())
    .find((node) => node.type === 'button' && words(node) === '撤销教师权限')!
    .props.onClick()
  ui.unmount()
  pending.resolve({ userId: 'teacher', enabled: false })
  await revoke
  assert.deepEqual(changed, [true])
})
