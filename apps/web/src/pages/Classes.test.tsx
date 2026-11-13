import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Classes from './Classes'
import { classroomsApi } from '../lib/classrooms'
import { TeachingGrantControl } from './admin/UserManager'

const classroom = {
  id: 'c1',
  name: '安全一班',
  description: '课程说明',
  createdAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
}
const joined = { canTeach: false, owned: [], joined: [classroom] }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
// Use the same hook harness as the existing admin page tests; exercise actual handlers without a browser.
function page(t: TestContext, component = Classes) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const hooks: any[] = [],
    effects: Array<() => void> = [],
    cleanups = new Map<number, () => void>()
  let index = 0
  const dispatcher = {
    useState(initial: any) {
      const key = index++
      if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial
      return [
        hooks[key],
        (value: any) => {
          hooks[key] = typeof value === 'function' ? value(hooks[key]) : value
        },
      ]
    },
    useRef(initial: any) {
      const key = index++
      return hooks[key] ?? (hooks[key] = { current: initial })
    },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const key = index++,
        old = hooks[key]
      if (!old || deps.some((v, i) => !Object.is(v, old[i]))) {
        hooks[key] = deps
        effects.push(() => {
          cleanups.get(key)?.()
          const cleanup = effect()
          if (cleanup) cleanups.set(key, cleanup)
        })
      }
    },
  }
  t.after(() => cleanups.forEach((cleanup) => cleanup()))
  return {
    render() {
      index = 0
      const old = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree
      try {
        tree = component()
      } finally {
        internals.ReactCurrentDispatcher.current = old
      }
      effects.splice(0).forEach((e) => e())
      return tree
    },
  }
}
function elements(node: unknown): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return React.isValidElement<{ children?: unknown }>(node) ? [node, ...elements(node.props.children)] : []
}
function button(tree: React.ReactElement, label: string) {
  const value = elements(tree).find((el) => el.type === 'button' && el.props.children === label)
  assert.ok(value, label)
  return value
}
function input(tree: React.ReactElement, name: string) {
  const value = elements(tree).find((el) => el.type === 'input' && el.props.name === name)
  assert.ok(value, name)
  return value
}

test('class page recovers from failed loading and shows joined classes without teacher controls', async (t) => {
  let reads = 0
  t.mock.method(classroomsApi, 'list', async () => {
    if (++reads === 1) throw new Error('连接失败')
    return joined
  })
  const view = page(t)
  view.render()
  await settle()
  let tree = view.render()
  assert.match(renderToStaticMarkup(tree), /加载失败/)
  assert.equal(button(tree, '刷新班级').props.disabled, false)
  button(tree, '刷新班级').props.onClick()
  view.render()
  await settle()
  tree = view.render()
  assert.match(renderToStaticMarkup(tree), /安全一班/)
  assert.doesNotMatch(renderToStaticMarkup(tree), /创建班级|导出所选班级/)
})

test('failed join preserves the invite input and allows retry without disabling unrelated actions', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => joined)
  const pending = deferred<typeof classroom>()
  let writes = 0
  t.mock.method(classroomsApi, 'join', () => {
    writes++
    return pending.promise
  })
  const view = page(t)
  view.render()
  await settle()
  input(view.render(), 'inviteCode').props.onChange({ target: { value: 'ABC123' } })
  const control = button(view.render(), '加入班级')
  const operation = control.props.onClick()
  await control.props.onClick()
  assert.equal(writes, 1)
  assert.equal(button(view.render(), '加入中…').props.disabled, true)
  assert.equal(button(view.render(), '刷新班级').props.disabled, false)
  pending.reject(new Error('邀请码无效'))
  await operation
  assert.equal(input(view.render(), 'inviteCode').props.value, 'ABC123')
  assert.equal(button(view.render(), '加入班级').props.disabled, false)
})

test('older detail responses cannot reveal the previously selected class roster', async (t) => {
  const other = { ...classroom, id: 'c2', name: '安全二班' }
  t.mock.method(classroomsApi, 'list', async () => ({ ...joined, joined: [classroom, other] }))
  const old = deferred<any>(),
    next = deferred<any>()
  t.mock.method(classroomsApi, 'get', (id: string) => (id === 'c1' ? old.promise : next.promise))
  const view = page(t)
  view.render()
  await settle()
  button(view.render(), '查看安全一班').props.onClick()
  view.render()
  button(view.render(), '查看安全二班').props.onClick()
  view.render()
  next.resolve({ ...other, canManage: false, isMember: true })
  await settle()
  view.render()
  old.resolve({
    ...classroom,
    canManage: true,
    isMember: false,
    inviteCode: 'PRIVATE_INVITE',
    members: [
      {
        userId: 'u1',
        username: 'PRIVATE_ACCOUNT',
        displayName: '旧班成员',
        studentId: 'PRIVATE_ID',
        isTestAccount: false,
        joinedAt: classroom.createdAt,
      },
    ],
  })
  await settle()
  const html = renderToStaticMarkup(view.render())
  assert.doesNotMatch(html, /PRIVATE_|旧班成员/)
  assert.match(html, /班级详情：安全二班/)
})

test('teacher sees safe export instructions and export failure releases only its action', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [{ ...classroom, ownerId: 'u1', inviteCode: 'ABCD' }],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'export', async () => {
    throw new Error('无权导出')
  })
  const view = page(t)
  view.render()
  await settle()
  const tree = view.render()
  assert.match(renderToStaticMarkup(tree), /学号.*文本/)
  const checkbox = elements(tree).find((el) => el.type === 'input' && el.props.type === 'checkbox')!
  checkbox.props.onChange({ target: { checked: true } })
  await button(view.render(), '导出所选班级').props.onClick()
  assert.equal(button(view.render(), '导出所选班级').props.disabled, false)
  assert.match(renderToStaticMarkup(view.render()), /导出失败/)
})

test('administrator teaching control reads the grant, saves explicitly and remains usable after failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'PUT')
      return Response.json({ code: 50300, message: '暂不可用', data: null }, { status: 503 })
    return Response.json({ code: 0, message: 'ok', data: { userId: 'teacher', enabled: false } })
  })
  const view = page(t, () => TeachingGrantControl({ userId: 'teacher', displayName: '测试教师' }))
  view.render()
  await settle()
  assert.match(renderToStaticMarkup(view.render()), /未授予教师权限/)
  await button(view.render(), '授予教师权限').props.onClick()
  assert.match(renderToStaticMarkup(view.render()), /操作失败/)
  assert.equal(button(view.render(), '授予教师权限').props.disabled, false)
})
