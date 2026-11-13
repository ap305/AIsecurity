import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {
  UNSAFE_RouteContext,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_DataRouterContext,
} from 'react-router-dom'
import QuestionSolutions, { SolutionCards } from './QuestionSolutions'
import PasswordRecovery from './PasswordRecovery'
import EmailVerification from './EmailVerification'
import Classes from './Classes'
import AccountSecurity from '../components/AccountSecurity'
import Register from './Register'
import { questionSolutionsApi, type QuestionSolution, type SolutionPage } from '../lib/questionSolutions'
import { authEmailApi } from '../lib/authEmail'
import { classroomsApi } from '../lib/classrooms'

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const event = { preventDefault() {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
// Same real-hook/handler harness used by the existing lease and classroom lifecycle tests.
function view(t: TestContext, component: () => React.ReactElement) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const state: any[] = [],
    effects: Array<() => void> = [],
    cleanups = new Map<number, () => void>()
  let index = 0,
    questionId = 'Q1'
  const dispatcher = {
    useState(initial: any) {
      const slot = index++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [
        state[slot],
        (value: any) => {
          state[slot] = typeof value === 'function' ? value(state[slot]) : value
        },
      ]
    },
    useRef(initial: any) {
      const slot = index++
      return state[slot] ?? (state[slot] = { current: initial })
    },
    useContext(context: any) {
      if (context === UNSAFE_RouteContext)
        return { matches: [{ params: { questionId } }], outlet: null, isDataRoute: false }
      if (context === UNSAFE_LocationContext)
        return {
          location: { pathname: '/register', search: '', hash: '', state: null, key: 'test' },
          navigationType: 'POP',
        }
      if (context === UNSAFE_NavigationContext)
        return { basename: '/', future: {}, navigator: { push() {}, replace() {} }, static: false }
      if (context === UNSAFE_DataRouterContext) return null
      return { user: { id: 'student', displayName: '学生' }, logout: async () => {} }
    },
    useCallback(callback: unknown) {
      return callback
    },
    useLayoutEffect() {},
    useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
      const slot = index++,
        before = state[slot]
      if (!before || dependencies.some((value, i) => !Object.is(value, before[i]))) {
        state[slot] = dependencies
        effects.push(() => {
          cleanups.get(slot)?.()
          const cleanup = effect()
          if (cleanup) cleanups.set(slot, cleanup)
        })
      }
    },
  }
  t.after(() => cleanups.forEach((cleanup) => cleanup()))
  return {
    render(id = questionId) {
      questionId = id
      index = 0
      const original = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree: React.ReactElement
      try {
        tree = component()
      } finally {
        internals.ReactCurrentDispatcher.current = original
      }
      effects.splice(0).forEach((effect) => effect())
      return tree
    },
  }
}
function elements(node: unknown): React.ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return React.isValidElement<{ children?: unknown }>(node) ? [node, ...elements(node.props.children)] : []
}
function words(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return React.isValidElement<{ children?: unknown }>(node) ? words(node.props.children) : ''
}
function button(tree: React.ReactElement, label: string) {
  const found = elements(tree).find((node) => node.type === 'button' && words(node.props.children) === label)
  assert.ok(found, `button ${label}`)
  return found
}
function input(tree: React.ReactElement, label: string) {
  const parent = elements(tree).find(
    (node) => node.type === 'label' && words(node.props.children).startsWith(label),
  )
  const found = parent && elements(parent).find((node) => ['input', 'textarea'].includes(String(node.type)))
  assert.ok(found, `input ${label}`)
  return found
}
function cards(tree: React.ReactElement) {
  const found = elements(tree).find((node) => node.type === SolutionCards)
  assert.ok(found)
  return found
}
function page(id = 'Q1', rows: QuestionSolution[] = []): SolutionPage {
  return {
    question: { id, title: `题目 ${id}`, revision: 1, category: 'basic', role: null },
    canPublishStandard: false,
    standard: [],
    user: rows,
    top: rows,
    pagination: { page: 1, pageSize: 20, total: rows.length, totalPages: rows.length ? 1 : 0 },
  }
}
function row(id: string): QuestionSolution {
  return {
    id,
    title: id,
    explanation: '',
    code: id,
    kind: 'user',
    author: '学生',
    questionVersion: 1,
    source: 'submission',
    referenceKind: null,
    actualEvaluationReference: false,
    score: 80,
    updating: false,
    emptyPool: false,
    notice: '',
    needsModelAttachment: false,
    canWithdraw: true,
    createdAt: '2026-11-13T00:00:00Z',
    sourceCreatedAt: null,
  }
}
function setupSolutions(t: TestContext) {
  t.mock.method(questionSolutionsApi, 'list', async (id: string) => page(id))
  t.mock.method(questionSolutionsApi, 'candidates', async () => [])
  return view(t, QuestionSolutions)
}
function fill(tree: React.ReactElement, title = '我的题解') {
  input(tree, '标题').props.onChange({ target: { value: title } })
  input(tree, '代码').props.onChange({ target: { value: 'print(1)' } })
  elements(tree)
    .find((node) => node.type === 'input' && node.props.type === 'checkbox')!
    .props.onChange({ target: { checked: true } })
}
function form(tree: React.ReactElement) {
  return elements(tree).find((node) => node.type === 'form')!
}

test('failed solution publication restores retry and preserves the authored draft', async (t) => {
  const ui = setupSolutions(t)
  t.mock.method(questionSolutionsApi, 'publish', async () => {
    throw new Error('network unavailable')
  })
  ui.render()
  await settle()
  fill(ui.render())
  await form(ui.render()).props.onSubmit(event)
  const tree = ui.render()
  assert.equal(input(tree, '标题').props.value, '我的题解')
  assert.equal(input(tree, '代码').props.value, 'print(1)')
  assert.equal(button(tree, '确认公开题解').props.disabled, false)
  assert.match(words(tree), /network unavailable/)
})

test('an older question read cannot replace the new question solutions', async (t) => {
  const ui = setupSolutions(t),
    old = deferred<SolutionPage>()
  t.mock.method(questionSolutionsApi, 'list', (id: string) =>
    id === 'Q1' ? old.promise : Promise.resolve(page(id)),
  )
  ui.render()
  ui.render('Q2')
  await settle()
  old.resolve(page('Q1'))
  await settle()
  assert.match(words(ui.render()), /题目 Q2/)
  assert.doesNotMatch(words(ui.render()), /题目 Q1/)
})

test('the first render for a new question cannot display or submit the previous question form', async (t) => {
  const ui = setupSolutions(t)
  ui.render()
  await settle()
  fill(ui.render())
  const changed = ui.render('Q2')
  assert.doesNotMatch(words(changed), /题目 Q1/)
  assert.equal(
    elements(changed).find((node) => node.type === 'form'),
    undefined,
  )
})

test('a source-file read from the previous question cannot fill the new question code', async (t) => {
  const ui = setupSolutions(t),
    source = deferred<string>()
  ui.render()
  await settle()
  const fileInput = elements(ui.render()).find((node) => node.type === 'input' && node.props.type === 'file')!
  const pending = fileInput.props.onChange({
    target: { files: [{ size: 24, text: () => source.promise }], value: 'source.py' },
  })
  ui.render('Q2')
  await settle()
  ui.render()
  source.resolve('private_code_for_Q1()')
  await pending
  assert.equal(input(ui.render(), '代码').props.value, '')
})

test('a completed publication for the previous question cannot announce success in the new question', async (t) => {
  const ui = setupSolutions(t),
    publication = deferred<{ id: string }>()
  t.mock.method(questionSolutionsApi, 'publish', () => publication.promise)
  ui.render()
  await settle()
  fill(ui.render())
  const pending = form(ui.render()).props.onSubmit(event)
  ui.render('Q2')
  await settle()
  ui.render()
  publication.resolve({ id: 'from-Q1' })
  await pending
  assert.doesNotMatch(words(ui.render()), /题解已公开/)
})

test('finishing one withdrawal cannot unlock another pending withdrawal', async (t) => {
  const ui = setupSolutions(t),
    first = deferred<unknown>(),
    second = deferred<unknown>()
  t.mock.method(questionSolutionsApi, 'list', async () => page('Q1', [row('first'), row('second')]))
  t.mock.method(questionSolutionsApi, 'withdraw', (id: string) =>
    id === 'first' ? first.promise : second.promise,
  )
  ui.render()
  await settle()
  button(ui.render(), '用户题解').props.onClick()
  const one = cards(ui.render()).props.onWithdraw('first')
  const two = cards(ui.render()).props.onWithdraw('second')
  first.resolve({})
  await one
  const renderedCards = SolutionCards(cards(ui.render()).props)
  assert.equal(button(renderedCards, '撤回中…').props.disabled, true)
  second.resolve({})
  await two
})

test('a pre-withdrawal refresh cannot briefly restore withdrawn code while the fresh read is pending', async (t) => {
  const ui = setupSolutions(t),
    stale = deferred<SolutionPage>(),
    fresh = deferred<SolutionPage>()
  let reads = 0
  t.mock.method(questionSolutionsApi, 'list', () =>
    ++reads === 1
      ? Promise.resolve(page('Q1', [row('withdrawn')]))
      : reads === 2
        ? stale.promise
        : fresh.promise,
  )
  t.mock.method(questionSolutionsApi, 'withdraw', async () => ({}))
  ui.render()
  await settle()
  button(ui.render(), '当前最高分').props.onClick()
  button(ui.render(), '刷新题解和当前分数').props.onClick()
  ui.render()
  await cards(ui.render()).props.onWithdraw('withdrawn')
  // Both callbacks can finish before React flushes the reload effect cleanup.
  stale.resolve(page('Q1', [row('withdrawn')]))
  await settle()
  assert.deepEqual(cards(ui.render()).props.rows, [])
  fresh.resolve(page())
  await settle()
})

test('a hanging withdrawal request releases its busy state within the normal request timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}))
  let settled = false
  void questionSolutionsApi
    .withdraw('solution')
    .finally(() => {
      settled = true
    })
    .catch(() => {})
  t.mock.timers.tick(20000)
  await settle()
  assert.equal(settled, true)
})

test('password recovery captures the fragment only in memory and failures permit retry', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const location = {
    hash: `#token=${'x'.repeat(43)}&purpose=reset`,
    pathname: '/password-recovery',
    search: '',
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        state: null,
        replaceState: () => {
          location.hash = ''
        },
      },
    },
  })
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, 'window', original)
      : Reflect.deleteProperty(globalThis, 'window'),
  )
  t.mock.method(authEmailApi, 'config', async () => ({ emailEnabled: true, manualResetEnabled: true }))
  t.mock.method(authEmailApi, 'recover', async () => {
    throw new Error('invalid or expired')
  })
  const ui = view(t, () => PasswordRecovery({}))
  ui.render()
  await settle()
  assert.equal(location.hash, '')
  input(ui.render(), '新密码').props.onChange({ target: { value: 'new safe password 123' } })
  input(ui.render(), '确认新密码').props.onChange({ target: { value: 'new safe password 123' } })
  await form(ui.render()).props.onSubmit(event)
  assert.equal(button(ui.render(), '确认恢复密码').props.disabled, false)
  assert.match(words(ui.render()), /重新申请恢复链接/)
  const reloaded = view(t, () => PasswordRecovery({}))
  reloaded.render()
  await settle()
  assert.ok(input(reloaded.render(), '已绑定邮箱'))
})

test('opening a verification link never consumes it and a missing fragment explains retry', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const location = {
    hash: `#token=${'x'.repeat(43)}&purpose=bind`,
    pathname: '/email-verification',
    search: '',
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        state: null,
        replaceState: () => {
          location.hash = ''
        },
      },
    },
  })
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, 'window', original)
      : Reflect.deleteProperty(globalThis, 'window'),
  )
  const bind = t.mock.method(authEmailApi, 'bind', async () => ({
    ok: true as const,
    relogin: true as const,
  }))
  const ui = view(t, EmailVerification)
  ui.render()
  await settle()
  assert.equal(bind.mock.callCount(), 0)
  assert.equal(location.hash, '')
  assert.ok(button(ui.render(), '确认绑定并重新登录'))
  const reloaded = view(t, EmailVerification)
  assert.match(words(reloaded.render()), /重新打开邮件中的链接/)
})

test('leaving a previous class cannot close the newly selected class details', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: () => true } })
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, 'window', original)
      : Reflect.deleteProperty(globalThis, 'window'),
  )
  const first = {
    id: 'first',
    name: '一班',
    description: '',
    archivedAt: null,
    createdAt: '2026-11-13T00:00:00Z',
  }
  const second = { ...first, id: 'second', name: '二班' }
  const leave = deferred<{ ok: true }>()
  t.mock.method(classroomsApi, 'list', async () => ({ canTeach: false, joined: [first, second], owned: [] }))
  t.mock.method(classroomsApi, 'get', async (id: string) => ({
    ...(id === first.id ? first : second),
    canManage: false,
    isMember: true,
  }))
  t.mock.method(classroomsApi, 'leave', () => leave.promise)
  const ui = view(t, Classes)
  ui.render()
  await settle()
  button(ui.render(), '查看一班').props.onClick()
  ui.render()
  await settle()
  button(ui.render(), '退出班级').props.onClick()
  button(ui.render(), '查看二班').props.onClick()
  ui.render()
  await settle()
  leave.resolve({ ok: true })
  await settle()
  ui.render()
  await settle()
  assert.match(words(ui.render()), /班级详情：二班/)
})

test('a failed mailbox binding request restores its button and keeps the destination for retry', async (t) => {
  t.mock.method(authEmailApi, 'own', async () => ({ email: null, emailEnabled: true, verifiedAt: null }))
  t.mock.method(authEmailApi, 'request', async () => {
    throw new Error('mail service unavailable')
  })
  const ui = view(t, () => AccountSecurity({}))
  ui.render()
  await settle()
  input(ui.render(), '邮箱').props.onChange({ target: { value: 'student@example.test' } })
  input(ui.render(), '核验当前密码').props.onChange({ target: { value: 'current passphrase' } })
  await form(ui.render()).props.onSubmit(event)
  assert.equal(button(ui.render(), '发送绑定验证链接').props.disabled, false)
  assert.equal(input(ui.render(), '邮箱').props.value, 'student@example.test')
  assert.match(words(ui.render()), /mail service unavailable/)
})

test('registration can retry a failed config read and keep legacy registration enabled when email is off', async (t) => {
  let reads = 0
  t.mock.method(authEmailApi, 'config', async () => {
    if (++reads === 1) throw new Error('config unavailable')
    return { emailEnabled: false, manualResetEnabled: true }
  })
  const ui = view(t, () => Register({}))
  ui.render()
  await settle()
  assert.equal(button(ui.render(), '注 册').props.disabled, true)
  button(ui.render(), '重试').props.onClick()
  await settle()
  assert.equal(button(ui.render(), '注 册').props.disabled, false)
  assert.doesNotMatch(words(ui.render()), /发送注册验证链接/)
})
