import test from 'node:test'
import assert from 'node:assert/strict'
import { questionSolutionsApi, readSolutionFile } from './questionSolutions'

test('source upload rejects binary and oversized text before sending any request', async () => {
  await assert.rejects(() => readSolutionFile({ size: 262145, text: async () => 'a' }), /256 KiB/)
  await assert.rejects(() => readSolutionFile({ size: 3, text: async () => 'a\0b' }), /文本/)
  await assert.rejects(
    () => readSolutionFile({ size: 90000, text: async () => '中'.repeat(90000) }),
    /256 KiB/,
  )
  assert.equal(await readSolutionFile({ size: 12, text: async () => 'print("你好")' }), 'print("你好")')
})

test('teacher API scopes lists to mine, encodes search and preserves revision conflict tokens on writes', async (t) => {
  const requests: Array<{ url: string; method: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify({ code: 0, message: 'ok', data: {} }), { status: 200 })
  })
  await questionSolutionsApi.mine('讲解 & 代码', 2)
  await questionSolutionsApi.update('lecture/id', {
    title: 'new',
    published: true,
    expectedUpdatedAt: '2026-11-18T00:00:00.000Z',
  })
  await questionSolutionsApi.publish('question/id', {
    kind: 'standard',
    title: 'new',
    explanation: 'explain',
    questionVersion: 3,
  })
  assert.equal(
    requests[0].url,
    '/api/teaching/solutions?scope=mine&search=%E8%AE%B2%E8%A7%A3+%26+%E4%BB%A3%E7%A0%81&page=2',
  )
  assert.equal(requests[1].url, '/api/solutions/lecture%2Fid')
  assert.equal(requests[1].method, 'PUT')
  assert.equal(requests[1].body.expectedUpdatedAt, '2026-11-18T00:00:00.000Z')
  assert.equal(requests[2].body.questionVersion, 3)
})
