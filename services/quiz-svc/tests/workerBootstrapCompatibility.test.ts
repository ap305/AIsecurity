import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {compatibleWorkerBootstrap} from '../src/services/workerBootstrapCompatibility.js'

test('only the exact reviewed legacy ML bootstrap receives AST line normalization', () => {
  const current = fs.readFileSync(new URL('../course-pack-v3/ml/bootstrap.py', import.meta.url), 'utf8')
  const old = current.replace('compile(ast.unparse(ast.fix_missing_locations(backend)),', 'compile(ast.fix_missing_locations(backend),')
  const repaired = compatibleWorkerBootstrap('public/bootstrap.py', Buffer.from(old))
  assert.equal(repaired.toString(), current)
  assert.deepEqual(compatibleWorkerBootstrap('public/other.py', Buffer.from(old)), Buffer.from(old))
  const changed = Buffer.from(old + '\n# unreviewed\n')
  assert.deepEqual(compatibleWorkerBootstrap('public/bootstrap.py', changed), changed)
  assert.deepEqual(compatibleWorkerBootstrap('public/bootstrap.py', Buffer.from(current)), Buffer.from(current))
})

test('the exact reviewed API bootstrap receives the same future-import compatibility in both roles', () => {
  const current = fs.readFileSync(new URL('../course-pack-v3/adversarial/bot_bootstrap.py', import.meta.url), 'utf8')
  const old = current.replace('compile(ast.unparse(ast.fix_missing_locations(backend)),', 'compile(ast.fix_missing_locations(backend),')
  assert.equal(compatibleWorkerBootstrap('public/bootstrap.py',Buffer.from(old)).toString(),current)
  const changed=Buffer.from(old+'\n# unreviewed\n')
  assert.deepEqual(compatibleWorkerBootstrap('public/bootstrap.py',changed),changed)
  assert.deepEqual(compatibleWorkerBootstrap('public/other.py',Buffer.from(old)),Buffer.from(old))
})
