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
