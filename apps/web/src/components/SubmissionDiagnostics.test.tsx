import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SubmissionDiagnostics from './SubmissionDiagnostics'

function render(options: {
  questionId?: string
  role?: string
  threshold?: number
  value?: number | null
  coverage?: unknown
  passed?: boolean | null
  historicalVersion?: boolean
} = {}) {
  const value = {
    role: options.role ?? 'attack',
    evaluationVersion: 'v3-api-citation-queue-20261016-v8',
    historicalVersion: options.historicalVersion ?? false,
    baseline: { metric: 'qualificationMetric', value: options.value ?? 40,
      threshold: options.threshold ?? 40, passed: options.passed ?? true },
    metrics: { unprotectedCoverage: options.coverage ?? 0.4, attackMetric: 0 },
  }
  return renderToStaticMarkup(createElement(SubmissionDiagnostics, {
    questionId: options.questionId ?? 'V3-261012-A28', value,
  }))
}

test('A28 qualification identifies the unprotected test and never presents the defended zero as its result', () => {
  const html = render()
  assert.match(html, /无防御原文覆盖率/)
  assert.match(html, /40%/)
  assert.match(html, /门槛 ≥ 40%/)
  assert.match(html, /通过/)
  assert.match(html, /通过资格后.*学生防御.*正式对抗/)
  assert.doesNotMatch(html, /attackMetric|qualificationMetric/)
})

test('A28 historical failure displays actual coverage with its frozen 60 percent threshold', () => {
  const html = render({ threshold: 60, value: -1, coverage: 0.1667, passed: false, historicalVersion: true })
  assert.match(html, /16\.67%/)
  assert.match(html, /门槛 ≥ 60%/)
  assert.match(html, /未通过/)
  assert.match(html, /旧题目版本/)
  assert.doesNotMatch(html, /-1|门槛 ≥ 40%/)
})

test('A28 coverage and threshold retain equality and zero without treating them as missing', () => {
  const html = render({ threshold: 0, value: 0, coverage: 0 })
  assert.match(html, /<strong>0%<\/strong>/)
  assert.match(html, /门槛 ≥ 0%/)
})

test('A28 does not turn an invalid coverage or negative sentinel into a measured percentage', () => {
  for (const coverage of [NaN, Infinity, -0.2, 1.1, '0.4']) {
    const html = render({ value: -1, coverage, passed: false })
    assert.match(html, /<strong>—<\/strong>/)
    assert.doesNotMatch(html, /NaN|Infinity|-100%|110%/)
  }
})

test('other questions and the defense role keep their existing generic baseline labels', () => {
  for (const options of [{ questionId: 'V3-261012-A27' }, { role: 'defense' }]) {
    const html = render(options)
    assert.match(html, /qualificationMetric/)
    assert.doesNotMatch(html, /无防御原文覆盖率/)
  }
})
