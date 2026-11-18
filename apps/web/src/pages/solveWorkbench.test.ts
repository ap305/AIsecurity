import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftStorageKey,
  editorLanguage,
  publicMetrics,
  submissionPhaseLabel,
  hallReturnLocation,
  createLatestRequest,
} from './solveWorkbench'
import type { QuestionRecord, SubmissionRecord } from '../lib/prdApi'
import * as workbench from './solveWorkbench'
import { apiGet } from '../lib/api'

test('draft identities preserve the existing key and isolate accounts, questions and revisions', () => {
  const keys = [
    draftStorageKey('alice', 'Q1', 2),
    draftStorageKey('bob', 'Q1', 2),
    draftStorageKey('alice', 'Q2', 2),
    draftStorageKey('alice', 'Q1', 3),
  ]
  assert.equal(keys[0], 'prd_draft_alice_Q1_2')
  assert.equal(new Set(keys).size, keys.length)
})

function draftStorage() {
  const rows = new Map<string, string>()
  const writes: string[] = []
  const read = (key: string) => rows.get(key) ?? null
  const write = (key: string, value: string) => {
    rows.set(key, value)
    writes.push(key)
    return true
  }
  return { rows, writes, read, write }
}

test('passive draft views never overwrite a newer legacy-format draft on timer, reload or close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rows, writes, read, write } = draftStorage()
  const key = draftStorageKey('alice', 'Q', 2)
  rows.set(key, 'old')
  assert.equal(typeof workbench.createQuestionDraft, 'function', 'require draft persistence scoped to local edits')
  const open = () => workbench.createQuestionDraft(key, 'template', read, write, () => {})
  const observer = open()
  assert.equal(observer.value, 'old')
  rows.set(key, 'new from the old-version tab')
  t.mock.timers.tick(600)
  observer.flush()
  observer.flush()
  for (let reload = 0; reload < 2; reload++) {
    const refreshed = open()
    assert.equal(refreshed.value, 'new from the old-version tab')
    refreshed.flush()
  }
  assert.deepEqual(writes, [])
  assert.equal(observer.save(), 'new from the old-version tab')
  assert.deepEqual(writes, [])
})

test('coalesces actual draft edits, flushes the latest even on immediate close and isolates keys', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rows, writes, read, write } = draftStorage()
  const keys = [draftStorageKey('alice', 'A', 1), draftStorageKey('bob', 'A', 1), draftStorageKey('alice', 'B', 2)]
  for (const key of keys) {
    const draft = workbench.createQuestionDraft(key, 'template', read, write, () => {})
    draft.edit('first edit')
    draft.edit('history copy')
    t.mock.timers.tick(599)
    assert.equal(rows.has(key), false)
    draft.flush()
    draft.flush()
    assert.equal(rows.get(key), 'history copy')
    draft.edit('') // An intentionally empty reset or edit is a valid draft.
    t.mock.timers.tick(600)
    assert.equal(rows.get(key), '')
    rows.set(key, 'newer external change')
    draft.flush()
    assert.equal(rows.get(key), 'newer external change')
  }
  assert.deepEqual(writes, keys.flatMap((key) => [key, key]))
})

test('manual save persists an untouched template only when absent, and retries storage errors', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rows, writes, read, write } = draftStorage()
  const states: string[] = []
  let available = true
  const draft = workbench.createQuestionDraft('key', 'template', read,
    (key, value) => available && write(key, value), (state) => states.push(state))
  assert.equal(states.at(-1), 'pristine')
  assert.equal(draft.save(), 'template')
  assert.equal(rows.get('key'), 'template')
  available = false
  draft.edit('modified')
  t.mock.timers.tick(600)
  assert.equal(states.at(-1), 'error')
  available = true
  assert.equal(draft.save(), 'modified')
  assert.equal(states.at(-1), 'saved')
  draft.flush()
  assert.deepEqual(writes, ['key', 'key'])
})

test('public metric summary accepts real zero and rejects nested data and nonfinite values', () => {
  const row = {
    diagnostics: {
      metrics: {
        accuracy: 0,
        total: 30,
        internal: { path: '/private' },
        raw: 'log',
        invalid: Number.NaN,
        unbounded: Infinity,
      },
    },
  } as unknown as SubmissionRecord
  assert.deepEqual(publicMetrics(row), [
    ['accuracy', 0],
    ['total', 30],
  ])
  assert.deepEqual(publicMetrics({ result: 'malformed' } as SubmissionRecord), [])
  assert.deepEqual(publicMetrics({ result: { metrics: [1, 2] } } as SubmissionRecord), [])
  assert.deepEqual(publicMetrics({ result: { metrics: { privateMetric: 7 } } } as SubmissionRecord), [])
})

test('workbench distinguishes an active phase from the final evaluation outcome', () => {
  assert.equal(
    submissionPhaseLabel({ status: 'running', phase: 'baseline' } as SubmissionRecord),
    '基线评测中',
  )
  assert.equal(submissionPhaseLabel({ status: 'timeout' } as SubmissionRecord), '评测超时')
  assert.equal(
    submissionPhaseLabel({ status: 'completed', phase: 'baseline' } as SubmissionRecord),
    '评测完成',
  )
  assert.equal(submissionPhaseLabel(null), '尚未提交')
})

test('unqualified and obsolete outcomes take precedence over their last active phase', () => {
  assert.equal(
    submissionPhaseLabel({ status: 'baseline_failed', phase: 'baseline' } as SubmissionRecord),
    '未过基线',
  )
  assert.equal(
    submissionPhaseLabel({ status: 'stale', phase: 'opponents' } as SubmissionRecord),
    '旧版本已失效',
  )
})

test('missing submissions unlock, expired sessions pause, and transient failures keep their active task', async (t) => {
  assert.equal(typeof workbench.submissionPollingFailure, 'function')
  for (const [status, code, action] of [
    [404, 40001, 'missing'],
    [401, 40100, 'sign_in'],
    [403, 40300, 'forbidden'],
    [428, 42801, 'change_password'],
    [401, 40001, 'retry'],
    [500, 50300, 'retry'],
    [502, 40100, 'retry'],
    [503, 50300, 'retry'],
  ] as const) {
    const mocked = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ code, message: '查询失败', data: null }, { status }),
    )
    const error = await apiGet('/submissions/task').catch((reason: unknown) => reason)
    assert.equal(workbench.submissionPollingFailure(error), action)
    mocked.mock.restore()
  }
  assert.equal(workbench.submissionPollingFailure(new TypeError('Network unavailable')), 'retry')
  assert.equal(workbench.submissionPollingFailure(new Error('404 proxy text')), 'retry')
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>Proxy route unavailable</html>', { status: 404 }),
  )
  const proxyError = await apiGet('/submissions/task').catch((reason: unknown) => reason)
  assert.equal(workbench.submissionPollingFailure(proxyError), 'retry')
})

test('return navigation preserves filters only within the same local hall', () => {
  assert.equal(hallReturnLocation('/?difficulty=L2&page=3', false), '/?difficulty=L2&page=3')
  assert.equal(
    hallReturnLocation('/arena?scenario=chatops&role=attack', true),
    '/arena?scenario=chatops&role=attack',
  )
  for (const input of [
    'https://evil.example/',
    '//evil.example/',
    '/\\evil.example/',
    '/admin',
    '/arena?role=attack',
    null,
  ]) {
    assert.equal(hallReturnLocation(input, false), '/')
  }
  assert.equal(hallReturnLocation('/?page=2', true), '/arena')
})

test('existing theory and language templates retain their editing modes', () => {
  assert.equal(
    editorLanguage({ type: 'T', answerTemplate: 'const example = 1' } as QuestionRecord),
    'markdown',
  )
  assert.equal(
    editorLanguage({ type: 'C', answerTemplate: 'import java.util.List;' } as QuestionRecord),
    'java',
  )
  assert.equal(editorLanguage({ type: 'C', answerTemplate: 'import torch' } as QuestionRecord), 'python')
})

test('a late historical response cannot replace a newer choice or a newly selected live result', async () => {
  const selection = createLatestRequest()
  const applied: string[] = []
  let completeFirst!: () => void
  const first = selection.next()
  const pending = new Promise<void>((resolve) => {
    completeFirst = resolve
  }).then(() => {
    if (selection.isCurrent(first)) applied.push('first')
  })
  const second = selection.next()
  if (selection.isCurrent(second)) applied.push('second')
  completeFirst()
  await pending
  assert.deepEqual(applied, ['second'])
  const historical = selection.next()
  selection.invalidate()
  assert.equal(selection.isCurrent(historical), false)
})
