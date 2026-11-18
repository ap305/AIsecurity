import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  UNSAFE_RouteContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_DataRouterContext,
} from 'react-router-dom'
import Classes, { ClassScores } from './Classes'
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
const teaching = () => Classes({ workspace: 'teaching' })
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
  let routeId: string | undefined
  const route = (to: { pathname: string }) => {
    routeId = to.pathname.match(/^\/teaching\/classes\/([^/]+)$/)?.[1]
  }
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
    useContext(context: any) {
      if (context === UNSAFE_RouteContext)
        return { matches: [{ params: { classId: routeId } }], outlet: null, isDataRoute: false }
      if (context === UNSAFE_LocationContext)
        return {
          location: { pathname: '/teaching', search: '', hash: '', state: null, key: 'test' },
          navigationType: 'POP',
        }
      if (context === UNSAFE_NavigationContext)
        return { basename: '/', future: {}, navigator: { push: route, replace: route }, static: false }
      if (context === UNSAFE_DataRouterContext) return null
      return null
    },
    useCallback(callback: unknown) {
      return callback
    },
    useLayoutEffect(effect: () => void) {
      effect()
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
    route(classId?: string) {
      routeId = classId
    },
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
  const view = page(t, teaching)
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

test('saving a previous class cannot overwrite the newly selected class draft', async (t) => {
  const first = { ...classroom, ownerId: 'teacher', inviteCode: 'FIRST' }
  const second = { ...first, id: 'c2', name: '安全二班', description: '二班已保存说明' }
  const pending = deferred<typeof first>()
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [first, second],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'get', async (id: string) => ({
    ...(id === first.id ? first : second),
    canManage: true,
    isMember: false,
    members: [],
  }))
  t.mock.method(classroomsApi, 'update', () => pending.promise)
  const view = page(t, teaching)
  view.render()
  await settle()
  button(view.render(), '管理安全一班').props.onClick()
  view.render()
  await settle()
  button(view.render(), '班级设置').props.onClick()
  const saving = button(view.render(), '保存班级资料').props.onClick()
  button(view.render(), '管理安全二班').props.onClick()
  view.render()
  await settle()
  const name = () => elements(view.render()).find((el) => el.props.id === 'class-edit-name')!
  const description = () => elements(view.render()).find((el) => el.props.id === 'class-edit-description')!
  name().props.onChange({ target: { value: '二班尚未保存的新名称' } })
  description().props.onChange({ target: { value: '二班尚未保存的新说明' } })
  pending.resolve(first)
  await saving
  view.render()
  await settle()
  assert.equal(name().props.value, '二班尚未保存的新名称')
  assert.equal(description().props.value, '二班尚未保存的新说明')
})

test('invite refresh preserves a draft while save and class selection load current server fields', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, 'window', original)
      : Reflect.deleteProperty(globalThis, 'window'),
  )
  let first = { ...classroom, ownerId: 'teacher', inviteCode: 'FIRST' }
  const second = { ...first, id: 'c2', name: '安全二班', description: '二班已保存说明' }
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [first, second],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'get', async (id: string) => ({
    ...(id === first.id ? first : second),
    canManage: true,
    isMember: false,
    members: [],
  }))
  t.mock.method(classroomsApi, 'rotateInvite', async () => {
    first = { ...first, inviteCode: 'ROTATED' }
    return first
  })
  t.mock.method(
    classroomsApi,
    'update',
    async (_id: string, fields: Parameters<typeof classroomsApi.update>[1]) => {
      first = { ...first, name: fields.name!.trim(), description: fields.description! }
      return first
    },
  )
  const view = page(t, teaching)
  const name = () => elements(view.render()).find((el) => el.props.id === 'class-edit-name')!
  const description = () => elements(view.render()).find((el) => el.props.id === 'class-edit-description')!
  view.render()
  await settle()
  button(view.render(), '管理安全一班').props.onClick()
  view.render()
  await settle()
  button(view.render(), '班级设置').props.onClick()
  name().props.onChange({ target: { value: '  一班新名称  ' } })
  description().props.onChange({ target: { value: '一班新说明' } })
  button(view.render(), '重置邀请码').props.onClick()
  await settle()
  view.render()
  await settle()
  assert.equal(name().props.value, '  一班新名称  ')
  assert.equal(description().props.value, '一班新说明')
  assert.match(renderToStaticMarkup(view.render()), /ROTATED/)
  await button(view.render(), '保存班级资料').props.onClick()
  view.render()
  await settle()
  assert.equal(name().props.value, '一班新名称')
  assert.equal(description().props.value, '一班新说明')
  button(view.render(), '管理安全二班').props.onClick()
  view.render()
  await settle()
  assert.equal(name().props.value, '安全二班')
  assert.equal(description().props.value, '二班已保存说明')
})

test('practice space remains join-only for teachers and teaching puts managed classes first', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [{ ...classroom, ownerId: 'teacher', inviteCode: 'ABCD' }],
    joined: [classroom],
  }))
  const practice = page(t)
  practice.render()
  await settle()
  assert.doesNotMatch(renderToStaticMarkup(practice.render()), /创建班级|导出所选班级|管理安全一班/)
  assert.match(renderToStaticMarkup(practice.render()), /已加入的班级/)
  const teacher = page(t, teaching)
  teacher.render()
  await settle()
  const html = renderToStaticMarkup(teacher.render())
  assert.doesNotMatch(html, /加入班级|已加入的班级/)
  assert.ok(html.indexOf('可管理的班级') < html.indexOf('创建班级'))
})

test('teacher tabs separate member, score and settings views; failed invite copy shows a selectable code', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [{ ...classroom, ownerId: 'teacher', inviteCode: 'ABCD' }],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'get', async () => ({
    ...classroom,
    canManage: true,
    isMember: false,
    inviteCode: 'COPY_CODE',
    members: [],
  }))
  const view = page(t, teaching)
  view.render()
  await settle()
  button(view.render(), '管理安全一班').props.onClick()
  view.render()
  await settle()
  assert.match(renderToStaticMarkup(view.render()), /班级成员/)
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /保存班级资料/)
  await button(view.render(), '复制邀请码').props.onClick()
  assert.match(renderToStaticMarkup(view.render()), /无法自动复制/)
  assert.ok(
    elements(view.render()).some(
      (el) => el.type === 'input' && el.props.readOnly && el.props.value === 'COPY_CODE',
    ),
  )
  button(view.render(), '班级设置').props.onClick()
  assert.ok(button(view.render(), '保存班级资料'))
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /班级成员（/)
})

test('teacher deep links load the selected class and returning to the workspace closes its detail', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [{ ...classroom, ownerId: 'teacher', inviteCode: 'ABCD' }],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'get', async () => ({
    ...classroom,
    canManage: true,
    isMember: false,
    members: [],
  }))
  const view = page(t, teaching)
  view.route('c1')
  view.render()
  await settle()
  assert.match(renderToStaticMarkup(view.render()), /班级详情：安全一班/)
  button(view.render(), '管理安全一班').props.onClick()
  view.render()
  view.route()
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /班级详情：/)
})

test('member search matches account, name and student ID and preserves the full roster', async (t) => {
  t.mock.method(classroomsApi, 'list', async () => ({
    canTeach: true,
    owned: [{ ...classroom, ownerId: 'teacher', inviteCode: 'ABCD' }],
    joined: [],
  }))
  t.mock.method(classroomsApi, 'get', async () => ({
    ...classroom,
    canManage: true,
    isMember: false,
    members: [
      {
        userId: 's1',
        username: 'alice',
        displayName: '张同学',
        studentId: '0001',
        isTestAccount: false,
        joinedAt: classroom.createdAt,
      },
      {
        userId: 's2',
        username: 'bob',
        displayName: '李同学',
        studentId: '0002',
        isTestAccount: false,
        joinedAt: classroom.createdAt,
      },
    ],
  }))
  const view = page(t, teaching)
  view.route('c1')
  view.render()
  await settle()
  for (const search of ['ALICE', '张', '0001']) {
    input(view.render(), 'memberSearch').props.onChange({ target: { value: search } })
    const html = renderToStaticMarkup(view.render())
    assert.match(html, /张同学/)
    assert.doesNotMatch(html, /李同学/)
  }
  input(view.render(), 'memberSearch').props.onChange({ target: { value: '不存在' } })
  assert.match(renderToStaticMarkup(view.render()), /没有匹配的成员/)
  input(view.render(), 'memberSearch').props.onChange({ target: { value: '' } })
  assert.match(renderToStaticMarkup(view.render()), /李同学/)
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

const scorePage = (id = 'c1') => ({
  classroom: { id, name: '安全一班' },
  total: 1,
  page: 1,
  pageSize: 20,
  questions: [
    { id: 'q1', title: '基础题', moduleCode: 'T', number: 1, category: 'basic' as const, role: null },
    { id: 'q2', title: '零分题', moduleCode: 'T', number: 2, category: 'basic' as const, role: null },
    { id: 'q3', title: '未提交题', moduleCode: 'T', number: 3, category: 'basic' as const, role: null },
  ],
  students: [
    {
      userId: 'student',
      username: 'student',
      displayName: '张同学',
      studentId: '0001',
      basicTotalScore: 70,
      scores: [
        {
          questionId: 'q1',
          score: 70,
          state: 'scored' as const,
          updating: false,
          latestSubmission: {
            id: 'latest',
            status: 'completed',
            outcome: 'baseline_failed' as const,
            score: null,
            questionVersion: 1,
            createdAt: '2026-11-18T00:00:00Z',
          },
        },
        { questionId: 'q2', score: 0, state: 'scored' as const, updating: false, latestSubmission: null },
        {
          questionId: 'q3',
          score: null,
          state: 'not_submitted' as const,
          updating: false,
          latestSubmission: null,
        },
      ],
    },
  ],
})
test('score table separates current grades, baseline failures, zero and absent submission', async (t) => {
  t.mock.method(classroomsApi, 'scores', async () => scorePage())
  const view = page(t, () => ClassScores({ classId: 'c1' }))
  view.render()
  await settle()
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /当前成绩：.*70/)
  assert.match(html, /最近提交：未过基线/)
  assert.match(html, /当前成绩：.*0/)
  assert.match(html, /未提交/)
  assert.doesNotMatch(html, /value="70"|修改成绩/)
})

test('score filters apply together and both exports retain explicit all versus current-filter scope', async (t) => {
  const requests: any[] = [],
    exports: any[] = []
  t.mock.method(
    classroomsApi,
    'scores',
    async (id: string, filters: Parameters<typeof classroomsApi.scores>[1]) => {
      requests.push({ id, filters })
      return scorePage()
    },
  )
  t.mock.method(classroomsApi, 'export', async (...args: Parameters<typeof classroomsApi.export>) => {
    exports.push(args)
    throw new Error('下载中断')
  })
  const view = page(t, () => ClassScores({ classId: 'c1' }))
  view.render()
  await settle()
  input(view.render(), 'scoreSearch').props.onChange({ target: { value: '张' } })
  elements(view.render())
    .find((el) => el.props.name === 'scoreCategory')!
    .props.onChange({ target: { value: 'attack' } })
  elements(view.render())
    .find((el) => el.props.name === 'scoreQuestion')!
    .props.onChange({ target: { value: 'q1' } })
  button(view.render(), '应用筛选').props.onClick()
  view.render()
  await settle()
  assert.deepEqual(requests.at(-1).filters, {
    search: '张',
    category: 'attack',
    questionId: 'q1',
    page: 1,
    pageSize: 20,
  })
  await button(view.render(), '导出当前筛选').props.onClick()
  await button(view.render(), '导出全班成绩').props.onClick()
  assert.deepEqual(exports, [
    [['c1'], { search: '张', category: 'attack', questionId: 'q1' }],
    [['c1'], undefined],
  ])
  assert.equal(button(view.render(), '导出当前筛选').props.disabled, false)
  assert.match(renderToStaticMarkup(view.render()), /下载中断/)
})

test('score class changes hide old data before effects and late responses cannot restore it', async (t) => {
  let id = 'c1'
  const older = deferred<ReturnType<typeof scorePage>>()
  t.mock.method(classroomsApi, 'scores', (classId: string) =>
    classId === 'c1' ? older.promise : Promise.resolve({ ...scorePage('c2'), students: [] }),
  )
  const view = page(t, () => ClassScores({ classId: id }))
  view.render()
  id = 'c2'
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /张同学/)
  await settle()
  older.resolve(scorePage())
  await settle()
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /张同学/)
})

test('revoked score refresh clears sensitive rows and permits retry after failure', async (t) => {
  let reads = 0
  t.mock.method(classroomsApi, 'scores', async () => {
    if (++reads > 1) throw new Error('无权查看')
    return scorePage()
  })
  const view = page(t, () => ClassScores({ classId: 'c1' }))
  view.render()
  await settle()
  assert.match(renderToStaticMarkup(view.render()), /张同学/)
  button(view.render(), '刷新成绩').props.onClick()
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /张同学/)
  await settle()
  assert.match(renderToStaticMarkup(view.render()), /无权查看/)
  assert.equal(button(view.render(), '刷新成绩').props.disabled, false)
})
