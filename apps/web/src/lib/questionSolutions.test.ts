import test from 'node:test'
import assert from 'node:assert/strict'
import { readSolutionFile } from './questionSolutions'

test('source upload rejects binary and oversized text before sending any request', async () => {
  await assert.rejects(() => readSolutionFile({ size: 262145, text: async () => 'a' }), /256 KiB/)
  await assert.rejects(() => readSolutionFile({ size: 3, text: async () => 'a\0b' }), /文本/)
  await assert.rejects(
    () => readSolutionFile({ size: 90000, text: async () => '中'.repeat(90000) }),
    /256 KiB/,
  )
  assert.equal(await readSolutionFile({ size: 12, text: async () => 'print("你好")' }), 'print("你好")')
})
