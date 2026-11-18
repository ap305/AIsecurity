import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TeachingSolutions from './TeachingSolutions'
import {
  questionSolutionsApi,
  type TeachingSolution,
  type TeachingSolutionsPage,
} from '../lib/questionSolutions'
import { ApiError } from '../lib/api'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const event = { preventDefault() {} }
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function view(t: TestContext) {
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
        (v: any) => {
          hooks[key] = typeof v === 'function' ? v(hooks[key]) : v
        },
      ]
    },
    useRef(initial: any) {
      const key = index++
      return hooks[key] ?? (hooks[key] = { current: initial })
    },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const key = index++,
        before = hooks[key]
      if (!before || deps.some((v, i) => !Object.is(v, before[i]))) {
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
      const original = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree
      try {
        tree = TeachingSolutions()
      } finally {
        internals.ReactCurrentDispatcher.current = original
      }
      effects.splice(0).forEach((effect) => effect())
      return tree
    },
  }
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
function button(tree: any, label: string) {
  const node = elements(tree).find((el) => el.type === 'button' && words(el.props.children) === label)
  assert.ok(node, `button ${label}`)
  return node
}
function field(tree: any, name: string) {
  const node = elements(tree).find((el) => el.props.name === name)
  assert.ok(node, `field ${name}`)
  return node
}
const question = { id: 'Q1', title: '已发布题目', revision: 2, category: 'basic', role: null }
const lecture: TeachingSolution = {
  id: 'L1',
  title: '已有讲解',
  explanation: '说明',
  code: 'print(1)',
  questionId: 'Q1',
  questionVersion: 2,
  referenceKind: 'same_role',
  published: true,
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  question: { ...question, status: 'published' },
  canEdit: true,
}
function data(items: TeachingSolution[] = []): TeachingSolutionsPage {
  return {
    scope: 'mine',
    visibility: 'authenticated',
    questions: [question],
    items,
    pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
  }
}
async function setup(t: TestContext, items: TeachingSolution[] = []) {
  t.mock.method(questionSolutionsApi, 'mine', async () => data(items))
  const ui = view(t)
  ui.render()
  await settle()
  return ui
}
function start(ui: ReturnType<typeof view>) {
  field(ui.render(), 'question').props.onChange({ target: { value: 'Q1' } })
  field(ui.render(), 'title').props.onChange({ target: { value: '新讲解' } })
  field(ui.render(), 'explanation').props.onChange({ target: { value: '讲解内容' } })
}
function preview(ui: ReturnType<typeof view>) {
  button(ui.render(), '预览讲解').props.onClick()
  field(ui.render(), 'consent').props.onChange({ target: { checked: true } })
}

test('initial list failure enables refresh and a successful retry restores the workbench', async (t) => {
  let reads = 0
  const mine = t.mock.method(questionSolutionsApi, 'mine', async () => {
    if (++reads === 1) throw new Error('暂时无法读取我的讲解')
    return data([lecture])
  })
  const ui = view(t)
  ui.render()
  await settle()
  const failed = ui.render()
  assert.match(words(failed), /暂时无法读取我的讲解/)
  assert.doesNotMatch(words(failed), /已有讲解/)
  assert.equal(button(failed, '刷新讲解').props.disabled, false)
  button(failed, '刷新讲解').props.onClick()
  ui.render()
  await settle()
  const recovered = ui.render()
  assert.equal(mine.mock.callCount(), 2)
  assert.match(words(recovered), /已有讲解/)
  assert.doesNotMatch(words(recovered), /暂时无法读取我的讲解/)
  assert.ok(field(recovered, 'question'))
  assert.equal(button(recovered, '刷新讲解').props.disabled, false)
})

test('teacher publishes from a selected question after preview and global-scope consent', async (t) => {
  const ui = await setup(t)
  const publish = t.mock.method(questionSolutionsApi, 'publish', async () => ({ id: 'L2' }))
  assert.match(words(ui.render()), /我的讲解/)
  assert.match(words(ui.render()), /全站已登录用户可见/)
  assert.match(words(ui.render()), /不会替换.*实际评测基线/)
  start(ui)
  preview(ui)
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.equal(publish.mock.callCount(), 1)
  assert.equal(publish.mock.calls[0].arguments[0], 'Q1')
  assert.deepEqual(publish.mock.calls[0].arguments[1], {
    kind: 'standard',
    title: '新讲解',
    explanation: '讲解内容',
    code: '',
    referenceKind: 'same_role',
    questionVersion: 2,
  })
  assert.match(words(ui.render()), /讲解已发布/)
})

test('editing, withdrawing and republishing use existing IDs and optimistic concurrency', async (t) => {
  const ui = await setup(t, [lecture])
  const update = t.mock.method(questionSolutionsApi, 'update', async () => ({ id: 'L1', published: true }))
  const withdraw = t.mock.method(questionSolutionsApi, 'withdraw', async () => ({}))
  button(ui.render(), '编辑讲解').props.onClick()
  field(ui.render(), 'title').props.onChange({ target: { value: '更新讲解' } })
  preview(ui)
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.equal(update.mock.calls[0].arguments[0], 'L1')
  assert.equal(update.mock.calls[0].arguments[1]!.expectedUpdatedAt, lecture.updatedAt)
  assert.equal(update.mock.calls[0].arguments[1]!.title, '更新讲解')
  ui.render()
  await settle()
  await button(ui.render(), '撤回公开').props.onClick()
  assert.equal(withdraw.mock.calls[0].arguments[0], 'L1')
  t.mock.method(questionSolutionsApi, 'mine', async () => data([{ ...lecture, published: false }]))
  ui.render()
  await settle()
  button(ui.render(), '编辑并重新发布').props.onClick()
  preview(ui)
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.equal(update.mock.callCount(), 2)
  assert.equal(update.mock.calls[1].arguments[1]!.published, true)
})

test('failed publication keeps the draft and blocks duplicate submissions while pending', async (t) => {
  const ui = await setup(t)
  const pending = deferred<{ id: string }>()
  const publish = t.mock.method(questionSolutionsApi, 'publish', () => pending.promise)
  start(ui)
  preview(ui)
  const submit = elements(ui.render()).find(
    (el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器',
  )!.props.onSubmit
  const first = submit(event)
  await submit(event)
  assert.equal(publish.mock.callCount(), 1)
  pending.resolve({ id: 'L1' })
  await first
  start(ui)
  preview(ui)
  t.mock.method(questionSolutionsApi, 'publish', async () => {
    throw new Error('网络中断')
  })
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  button(ui.render(), '返回编辑').props.onClick()
  assert.equal(field(ui.render(), 'title').props.value, '新讲解')
  assert.match(words(ui.render()), /网络中断/)
})

test('revoked teacher permission clears private drafts and management data', async (t) => {
  const ui = await setup(t, [lecture])
  start(ui)
  preview(ui)
  t.mock.method(questionSolutionsApi, 'publish', async () => {
    throw new ApiError(403, '教师权限已撤销')
  })
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.match(words(ui.render()), /教师权限已撤销/)
  assert.doesNotMatch(words(ui.render()), /已有讲解/)
  assert.equal(
    elements(ui.render()).some((el) => el.props.name === 'title'),
    false,
  )
})

test('credential changes hide the prior editor immediately and late publication results cannot restore it', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let token = 'teacher-a'
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => token } })
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, 'localStorage', original)
      : Reflect.deleteProperty(globalThis, 'localStorage'),
  )
  const ui = await setup(t, [lecture])
  start(ui)
  preview(ui)
  const pending = deferred<{ id: string }>()
  t.mock.method(questionSolutionsApi, 'publish', () => pending.promise)
  const submit = elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  token = 'teacher-b'
  t.mock.method(questionSolutionsApi, 'mine', async () => data())
  assert.doesNotMatch(words(ui.render()), /已有讲解/)
  assert.equal(
    elements(ui.render()).some((el) => el.props.name === 'title'),
    false,
  )
  await settle()
  pending.resolve({ id: 'old' })
  await submit
  assert.doesNotMatch(words(ui.render()), /讲解已发布，全站|已有讲解/)
  assert.equal(
    elements(ui.render()).some((el) => el.props.name === 'title'),
    false,
  )
})

test('an older list read cannot restore a withdrawn lecture after mutation', async (t) => {
  const ui = await setup(t, [lecture])
  const old = deferred<TeachingSolutionsPage>(),
    fresh = deferred<TeachingSolutionsPage>()
  let reads = 0
  t.mock.method(questionSolutionsApi, 'mine', () => (++reads === 1 ? old.promise : fresh.promise))
  t.mock.method(questionSolutionsApi, 'withdraw', async () => ({}))
  button(ui.render(), '刷新讲解').props.onClick()
  ui.render()
  await button(ui.render(), '撤回公开').props.onClick()
  ui.render()
  old.resolve(data([lecture]))
  await settle()
  assert.match(words(ui.render()), /已撤回 · 不公开/)
  assert.equal(
    elements(ui.render()).some((el) => el.type === 'button' && words(el) === '撤回公开'),
    false,
  )
  fresh.resolve(data([{ ...lecture, published: false }]))
  await settle()
})

test('refreshing a changed question revision never silently retargets an existing draft', async (t) => {
  const ui = await setup(t)
  start(ui)
  const publish = t.mock.method(questionSolutionsApi, 'publish', async () => ({ id: 'should-not-publish' }))
  t.mock.method(questionSolutionsApi, 'mine', async () => ({
    ...data(),
    questions: [{ ...question, revision: 3 }],
  }))
  button(ui.render(), '刷新讲解').props.onClick()
  ui.render()
  await settle()
  assert.match(words(ui.render()), /题目版本已变化/)
  assert.equal(field(ui.render(), 'title').props.value, '新讲解')
  assert.equal(button(ui.render(), '预览讲解').props.disabled, true)
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.equal(publish.mock.callCount(), 0)
})

test('concurrent update conflicts retain authored content and require reopening latest lecture', async (t) => {
  const ui = await setup(t, [lecture])
  t.mock.method(questionSolutionsApi, 'update', async () => {
    throw new ApiError(409, '讲解已被更新或撤回，请重新打开最新讲解后再修改')
  })
  button(ui.render(), '编辑讲解').props.onClick()
  field(ui.render(), 'title').props.onChange({ target: { value: '尚未保存的修改' } })
  preview(ui)
  await elements(ui.render())
    .find((el) => el.type === 'form' && el.props['aria-label'] === '讲解编辑器')!
    .props.onSubmit(event)
  assert.equal(field(ui.render(), 'consent').props.checked, false)
  assert.match(words(ui.render()), /请重新打开最新讲解/)
  button(ui.render(), '返回编辑').props.onClick()
  assert.equal(field(ui.render(), 'title').props.value, '尚未保存的修改')
})

test('outdated lecture is preview-only, and old source-file reads cannot fill a replacement draft', async (t) => {
  const ui = await setup(t, [{ ...lecture, questionVersion: 1, canEdit: false }])
  assert.match(words(ui.render()), /旧版本/)
  assert.equal(
    elements(ui.render()).some((el) => el.type === 'button' && words(el) === '编辑讲解'),
    false,
  )
  start(ui)
  const pending = deferred<string>()
  const fileRead = field(ui.render(), 'file').props.onChange({
    target: { files: [{ size: 3, text: () => pending.promise }], value: 'source.py' },
  })
  field(ui.render(), 'question').props.onChange({ target: { value: '' } })
  start(ui)
  pending.resolve('OLD_CODE')
  await fileRead
  assert.equal(field(ui.render(), 'code').props.value, '')
})
