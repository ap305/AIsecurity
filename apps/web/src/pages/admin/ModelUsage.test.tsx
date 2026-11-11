import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api'
import {
  modelUsageApi,
  type ModelUsageDashboard,
  type UsagePolicyUpdate,
  type UsageTotals,
} from '../../lib/modelUsage'
import ModelUsage, { UsageOverview } from './ModelUsage'

const totals: UsageTotals = {
  upstreamAttempts: 4,
  successes: 1,
  failures: 1,
  pending: 2,
  snapshotHits: 3,
  teacherRequests: 2,
  healthChecks: 1,
  knownUsageRequests: 1,
  unknownUsageRequests: 3,
  inputTokens: 0,
  outputTokens: null,
  totalTokens: 0,
}
function dashboard(revision = 1): ModelUsageDashboard {
  return {
    mode: 'observe',
    timezone: 'Asia/Shanghai',
    days: 7,
    from: '2026-11-05T16:00:00.000Z',
    to: '2026-11-12T16:00:00.000Z',
    coverage: { startedAt: '2026-11-11T00:00:00.000Z', historicalUsage: 'unknown', currencyCost: 'unknown' },
    today: totals,
    range: totals,
    allTime: totals,
    daily: [{ ...totals, day: '2026-11-11' }],
    byModel: [{ ...totals, model: 'fixture-model' }],
    byQuestion: [{ ...totals, questionId: 'Q1', title: '题目一' }],
    byUser: [
      { ...totals, actorId: 'U1', username: 'testuser', displayName: '测试教师', isTestAccount: true },
    ],
    policy: {
      mode: 'observe',
      revision,
      globalDaily: 10000,
      userDaily: 4000,
      globalTotal: 100000,
      userTotal: 20000,
      warnPercent: 80,
      updatedAt: '2026-11-11T00:00:00.000Z',
    },
    alerts: [
      {
        id: 'A1',
        type: 'threshold',
        severity: 'warning',
        code: 'daily_warn',
        message: '平台日调用量达到预警阈值。',
        scope: 'global',
        scopeId: null,
        period: 'daily',
        value: 8000,
        threshold: 10000,
        firstSeenAt: '2026-11-11T00:00:00.000Z',
        lastSeenAt: '2026-11-11T00:00:00.000Z',
        occurrences: 1,
        acknowledgedAt: null,
        acknowledgedBy: null,
      },
    ],
  }
}

test('usage overview preserves zero versus unknown tokens and includes test accounts without currency estimates', () => {
  const html = renderToStaticMarkup(React.createElement(UsageOverview, { data: dashboard() }))
  for (const label of [
    '今日',
    '近 7 天',
    '累计',
    '按日',
    '按模型',
    '按题目',
    '按账号',
    '测试账号',
    '测试教师',
    '题目一',
    'fixture-model',
    '缓存命中',
    '待完成',
    '未报告',
    '缺 usage',
    '未知',
  ])
    assert.ok(html.includes(label), label)
  assert.match(html, /<td>0<\/td>/)
  assert.match(html, /不代表零费用/)
  assert.match(html, /包含测试账号/)
  assert.doesNotMatch(html, /[¥￥]|0\.00 元/)
})

test('empty coverage is presented as no collected records rather than a historical zero bill', () => {
  const data = dashboard()
  data.coverage.startedAt = null
  data.daily = data.byModel = data.byQuestion = data.byUser = []
  const html = renderToStaticMarkup(React.createElement(UsageOverview, { data }))
  assert.match(html, /尚无记录/)
  assert.match(html, /历史用量未知/)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const settle = () => new Promise<void>((done) => setImmediate(done))

// Execute the real component handlers with the repository's existing hook harness pattern.
function page(t: TestContext) {
  const internals = (
    React as unknown as {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
    }
  ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const hooks: unknown[] = [],
    effects: Array<() => void> = []
  const cleanups = new Map<number, () => void>()
  let index = 0,
    updates = 0
  const dispatcher = {
    useState(initial: unknown) {
      const key = index++
      if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial
      return [
        hooks[key],
        (value: unknown) => {
          updates++
          hooks[key] = typeof value === 'function' ? value(hooks[key]) : value
        },
      ]
    },
    useRef(initial: unknown) {
      const key = index++
      return hooks[key] ?? (hooks[key] = { current: initial })
    },
    useEffect(effect: () => (() => void) | void, dependencies: unknown[]) {
      const key = index++,
        previous = hooks[key] as unknown[] | undefined
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
  const unmount = () => {
    cleanups.forEach((cleanup) => cleanup())
    cleanups.clear()
  }
  t.after(unmount)
  return {
    render() {
      index = 0
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      let tree: React.ReactElement
      try {
        tree = ModelUsage()
      } finally {
        internals.ReactCurrentDispatcher.current = previous
      }
      effects.splice(0).forEach((effect) => effect())
      return tree
    },
    unmount,
    updates: () => updates,
  }
}
function elements(node: unknown): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement(node)) return []
  return [node, ...elements((node.props as { children?: unknown }).children)]
}
function button(tree: React.ReactElement, label: string) {
  const result = elements(tree).find((node) => node.type === 'button' && node.props.children === label)
  assert.ok(result, `button ${label}`)
  return result
}
function field(tree: React.ReactElement, name: string) {
  const result = elements(tree).find((node) => node.type === 'input' && node.props.name === name)
  assert.ok(result, `input ${name}`)
  return result
}

test('failed initial load offers retry and releases the refresh control after recovery', async (t) => {
  let reads = 0
  t.mock.method(modelUsageApi, 'get', async () => {
    if (++reads === 1) throw new Error('private-upstream-secret')
    return dashboard()
  })
  const view = page(t)
  view.render()
  await settle()
  let tree = view.render()
  assert.equal(button(tree, '重试加载').props.disabled, false)
  assert.doesNotMatch(renderToStaticMarkup(tree), /private-upstream-secret/)
  button(tree, '重试加载').props.onClick()
  view.render()
  await settle()
  tree = view.render()
  assert.equal(button(tree, '刷新统计').props.disabled, false)
  assert.match(renderToStaticMarkup(tree), /仅预警，不拦截提交/)
})

test('a conflicting policy save preserves draft input, exposes the latest policy and permits explicit retry', async (t) => {
  let reads = 0,
    saves = 0
  t.mock.method(modelUsageApi, 'get', async () => ({
    ...dashboard(++reads),
    policy: { ...dashboard(reads).policy, globalDaily: reads === 1 ? 10000 : 15000 },
  }))
  t.mock.method(modelUsageApi, 'savePolicy', async (input: UsagePolicyUpdate) => {
    if (++saves === 1) throw new ApiError(409, 'conflict', 40900)
    assert.equal(input.revision, 2)
    assert.equal(input.globalDaily, 12000)
    return { ...dashboard(3).policy, ...input, revision: 3 }
  })
  const view = page(t)
  view.render()
  await settle()
  field(view.render(), 'globalDaily').props.onChange({ target: { value: '12000' } })
  await button(view.render(), '保存预警设置').props.onClick()
  view.render()
  await settle()
  const tree = view.render()
  assert.equal(field(tree, 'globalDaily').props.value, '12000')
  assert.match(renderToStaticMarkup(tree), /15,000/)
  assert.equal(button(tree, '按最新版本保存我的输入').props.disabled, false)
  await button(tree, '按最新版本保存我的输入').props.onClick()
  assert.equal(button(view.render(), '保存预警设置').props.disabled, false)
})

test('policy save prevents duplicate submissions and retains input after failure', async (t) => {
  const save = deferred<ModelUsageDashboard['policy']>()
  let writes = 0
  t.mock.method(modelUsageApi, 'get', async () => dashboard())
  t.mock.method(modelUsageApi, 'savePolicy', () => {
    writes++
    return save.promise
  })
  const view = page(t)
  view.render()
  await settle()
  field(view.render(), 'userTotal').props.onChange({ target: { value: '25000' } })
  const control = button(view.render(), '保存预警设置')
  const pending = control.props.onClick()
  await control.props.onClick()
  assert.equal(button(view.render(), '保存中…').props.disabled, true)
  assert.equal(field(view.render(), 'userTotal').props.disabled, true)
  save.reject(new Error('timeout'))
  await pending
  assert.equal(writes, 1)
  assert.equal(field(view.render(), 'userTotal').props.value, '25000')
  assert.equal(button(view.render(), '保存预警设置').props.disabled, false)
})

test('acknowledgement failure releases its button and retry preserves the acknowledged event', async (t) => {
  let writes = 0
  t.mock.method(modelUsageApi, 'get', async () => dashboard())
  t.mock.method(modelUsageApi, 'acknowledge', async () => {
    if (++writes === 1) throw new Error('private-upstream-error')
    return { ...dashboard().alerts[0], acknowledgedAt: '2026-11-11T01:00:00.000Z', acknowledgedBy: 'admin' }
  })
  const view = page(t)
  view.render()
  await settle()
  await button(view.render(), '确认告警').props.onClick()
  assert.equal(button(view.render(), '确认告警').props.disabled, false)
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /private-upstream-error/)
  await button(view.render(), '确认告警').props.onClick()
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /已确认/)
  assert.match(html, /平台日调用量达到预警阈值/)
})

test('unmounted pages ignore a pending save response and its final state changes', async (t) => {
  const save = deferred<ModelUsageDashboard['policy']>()
  t.mock.method(modelUsageApi, 'get', async () => dashboard())
  t.mock.method(modelUsageApi, 'savePolicy', () => save.promise)
  const view = page(t)
  view.render()
  await settle()
  const pending = button(view.render(), '保存预警设置').props.onClick()
  view.unmount()
  const before = view.updates()
  save.resolve(dashboard(2).policy)
  await pending
  assert.equal(view.updates(), before)
})

test('invalid threshold input stays editable and never reaches the policy endpoint', async (t) => {
  let writes = 0
  t.mock.method(modelUsageApi, 'get', async () => dashboard())
  t.mock.method(modelUsageApi, 'savePolicy', async () => {
    writes++
    return dashboard().policy
  })
  const view = page(t)
  view.render()
  await settle()
  field(view.render(), 'warnPercent').props.onChange({ target: { value: '100' } })
  await button(view.render(), '保存预警设置').props.onClick()
  assert.equal(writes, 0)
  assert.equal(field(view.render(), 'warnPercent').props.value, '100')
  assert.equal(field(view.render(), 'warnPercent').props.disabled, false)
  assert.match(renderToStaticMarkup(view.render()), /预警百分比须为/)
})

test('changing the time range hides the old period while loading and preserves policy edits', async (t) => {
  const next = deferred<ModelUsageDashboard>()
  t.mock.method(modelUsageApi, 'get', (days: number) =>
    days === 7 ? Promise.resolve(dashboard()) : next.promise,
  )
  const view = page(t)
  view.render()
  await settle()
  field(view.render(), 'globalDaily').props.onChange({ target: { value: '12000' } })
  const select = elements(view.render()).find((node) => node.type === 'select')!
  select.props.onChange({ target: { value: '30' } })
  const pending = view.render()
  assert.equal(button(pending, '刷新统计').props.disabled, true)
  assert.doesNotMatch(renderToStaticMarkup(pending), /fixture-model/)
  next.resolve({ ...dashboard(), days: 30 })
  await settle()
  const ready = view.render()
  assert.match(renderToStaticMarkup(ready), /近 30 天/)
  assert.equal(field(ready, 'globalDaily').props.value, '12000')
})

test('acknowledgement prevents duplicate clicks and restores all controls after rejection', async (t) => {
  const acknowledgement = deferred<ModelUsageDashboard['alerts'][number]>()
  let writes = 0
  t.mock.method(modelUsageApi, 'get', async () => dashboard())
  t.mock.method(modelUsageApi, 'acknowledge', () => {
    writes++
    return acknowledgement.promise
  })
  const view = page(t)
  view.render()
  await settle()
  const control = button(view.render(), '确认告警')
  const pending = control.props.onClick()
  await control.props.onClick()
  assert.equal(button(view.render(), '确认中…').props.disabled, true)
  assert.equal(button(view.render(), '保存预警设置').props.disabled, true)
  acknowledgement.reject(new Error('timeout'))
  await pending
  assert.equal(writes, 1)
  assert.equal(button(view.render(), '确认告警').props.disabled, false)
  assert.equal(button(view.render(), '保存预警设置').props.disabled, false)
})

test('a failed conflict refresh preserves the draft and requires a successful policy recheck before saving', async (t) => {
  let reads = 0,
    writes = 0
  t.mock.method(modelUsageApi, 'get', async () => {
    if (++reads === 2) throw new Error('offline')
    return dashboard(reads === 1 ? 1 : 2)
  })
  t.mock.method(modelUsageApi, 'savePolicy', async () => {
    writes++
    throw new ApiError(409, 'conflict', 40900)
  })
  const view = page(t)
  view.render()
  await settle()
  field(view.render(), 'userDaily').props.onChange({ target: { value: '5000' } })
  await button(view.render(), '保存预警设置').props.onClick()
  view.render()
  await settle()
  assert.equal(button(view.render(), '保存预警设置').props.disabled, true)
  assert.equal(field(view.render(), 'userDaily').props.value, '5000')
  button(view.render(), '重试加载').props.onClick()
  view.render()
  await settle()
  assert.equal(button(view.render(), '按最新版本保存我的输入').props.disabled, false)
  assert.equal(field(view.render(), 'userDaily').props.value, '5000')
  assert.equal(writes, 1)
})
