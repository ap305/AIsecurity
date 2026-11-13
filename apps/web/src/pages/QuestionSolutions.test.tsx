import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SolutionCards } from './QuestionSolutions'
import type { QuestionSolution } from '../lib/questionSolutions'

const solution: QuestionSolution = {
  id: 'safe-id',
  title: '公开学习',
  explanation: '**说明** <script>alert(1)</script> ![remote](https://tracking.invalid/pixel)',
  code: '<script>globalThis.hacked = true</script>',
  kind: 'user',
  author: '学生',
  questionVersion: 1,
  source: 'submission',
  referenceKind: null,
  actualEvaluationReference: false,
  score: 0,
  updating: true,
  emptyPool: false,
  notice: '成绩更新中，显示上次有效成绩',
  needsModelAttachment: true,
  canWithdraw: true,
  createdAt: '2026-11-13T00:00:00.000Z',
  sourceCreatedAt: '2026-11-12T00:00:00.000Z',
}
const render = (rows: QuestionSolution[], kind: 'standard' | 'user' | 'top') =>
  renderToStaticMarkup(createElement(SolutionCards, { rows, kind, busyId: '', onWithdraw: () => {} }))
test('public code is inert text, Markdown has no HTML or remote images, and zero is a real score', () => {
  const html = render([solution], 'user')
  assert.match(html, /&lt;script&gt;globalThis.hacked/)
  assert.doesNotMatch(html, /<script|<img|tracking\.invalid/)
  assert.match(html, /<strong>说明<\/strong>/)
  assert.match(html, /分数：0/)
  assert.match(html, /缺少模型附件/)
  assert.match(html, /成绩更新中/)
  assert.match(html, /撤回公开/)
})
test('empty tabs explain missing standard and explicit consent for highest public solutions', () => {
  assert.match(render([], 'standard'), /尚未发布标准题解/)
  assert.match(render([], 'top'), /主动公开.*最高/)
  assert.match(render([], 'user'), /尚无用户题解/)
})
test('manual standard reference cannot imply the actual evaluator and distinguishes reference role', () => {
  const html = render(
    [
      {
        ...solution,
        kind: 'standard',
        source: 'manual',
        score: null,
        referenceKind: 'opponent',
        canWithdraw: false,
        notice: '教师手工发布的学习参考，不代表当前线上实际评测实现或资格基线。',
      },
    ],
    'standard',
  )
  assert.match(html, /对手参考/)
  assert.match(html, /手工发布/)
  assert.doesNotMatch(html, /撤回公开/)
  assert.match(html, /不代表当前线上实际评测/)
})
