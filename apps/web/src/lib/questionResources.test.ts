import assert from 'node:assert/strict'
import test from 'node:test'
import { groupResources, isPublicResource, resourceSize } from './questionResources'

test('resources reject unsafe paths and invalid sizes', () => {
  for (const filename of ['../key', '.env', 'dir/file.py', 'dir\\file.py', 'a\u0000b'])
    assert.equal(isPublicResource({ filename, size: 1 }), false)
  for (const size of [-1, NaN, Infinity, '12'])
    assert.equal(isPublicResource({ filename: 'student.py', size }), false)
  assert.equal(isPublicResource({ filename: '学生本地实验包.zip', size: 0 }), true)
})

test('grouping keeps every attachment and input order without modifying input', () => {
  const resources = ['图.png', '未知.bin', 'blank.py', '实验.zip', '说明.md', 'diagram.SVG'].map(
    (filename) => ({ filename, size: 1024 }),
  )
  const original = JSON.stringify(resources)
  const groups = groupResources(resources)
  assert.deepEqual(
    groups.map((group) => group.kind),
    ['code', 'bundle', 'document', 'other', 'image'],
  )
  assert.deepEqual(
    groups.at(-1)?.resources.map((r) => r.filename),
    ['图.png', 'diagram.SVG'],
  )
  assert.equal(groups.flatMap((group) => group.resources).length, resources.length)
  assert.equal(JSON.stringify(resources), original)
  assert.deepEqual(groupResources([]), [])
})

test('download sizes distinguish bytes KB and MB', () => {
  assert.equal(resourceSize(0), '0 B')
  assert.equal(resourceSize(1024), '1.0 KB')
  assert.equal(resourceSize(1572864), '1.5 MB')
})
