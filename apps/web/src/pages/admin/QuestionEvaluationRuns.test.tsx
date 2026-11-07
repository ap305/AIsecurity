import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvaluationRunsTable, type EvaluationRunRow } from './QuestionEvaluationRuns'

const date = '2026-11-07T04:00:00.000Z'
const row: EvaluationRunRow = {
  id: 'submission-id',
  userId: 'user-id',
  username: 'student',
  displayName: '学生甲',
  isTestAccount: false,
  questionVersion: 1,
  evaluationVersion: 'v1',
  status: 'completed',
  score: null,
  createdAt: date,
  updatedAt: date,
  task: null,
  arenaRuns: [],
  arenaRunCount: 0,
  result: null,
}

function render(overrides: Partial<EvaluationRunRow>) {
  return renderToStaticMarkup(createElement(EvaluationRunsTable, { rows: [{ ...row, ...overrides }] }))
}

test('question history distinguishes the recorded zero score from a submission without a score', () => {
  assert.match(render({ score: 0 }), /<td>0<\/td>/)
  assert.match(render({ status: 'queued' }), /<td>未出分<\/td>/)
})

test('question history distinguishes baseline, queue, error, and completion statuses', () => {
  assert.match(render({ status: 'baseline' }), /基线评测中/)
  assert.match(render({ status: 'queued' }), /排队中/)
  assert.match(render({ status: 'error' }), /运行异常/)
  assert.match(render({ status: 'completed' }), /评测完成/)
  assert.match(render({ status: 'failed', result: { evaluationStatus: 'student_error' } }), /提交内容异常/)
  assert.match(render({ status: 'failed', result: { qualified: false } }), /未过基线/)
  assert.match(
    render({ status: 'error', result: { evaluationStatus: 'system_error', failedPhase: 'baseline' } }),
    /评测系统异常.*失败阶段 · 基线评测/,
  )
})

test('question history shows the full arena run count with the available recent runs and their attempts', () => {
  const html = render({
    isTestAccount: true,
    score: 42,
    arenaRunCount: 8,
    arenaRuns: [
      {
        id: 'recent-run',
        kind: 'recompute',
        status: 'completed',
        attempts: 2,
        snapshotRevision: 0,
        createdAt: date,
        updatedAt: date,
        result: { score: 0, qualified: true, counted: true, successCount: 0, opponentCount: 2 },
      },
    ],
  })
  assert.match(html, /测试账号/)
  assert.match(html, /<summary>8 次（最近 1 次）<\/summary>/)
  assert.match(html, /既有算法重评.*尝试 2 次.*快照版本 0/)
  assert.match(html, /本次得分 0.*通过基线.*本次计分.*成功 0 次 · 对手 2 个 · 未成功 2 次/)
  assert.doesNotMatch(html, /本次得分 42/)
})
