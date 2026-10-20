import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { SUBMISSION_PREFLIGHT_SOURCE, decodePreflight } from '../src/services/submissionPreflight.js'
import { studentFailureMessage } from '../src/services/studentFailureMessage.js'

const python = process.env.PYTHON || 'python'
function check(code: string, template = '') {
  const run = spawnSync(python, ['-c', SUBMISSION_PREFLIGHT_SOURCE], {
    input: JSON.stringify({ code, template }), encoding: 'utf8', timeout: 10000,
  })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout)
}
const template = 'def solve(x):\n    raise NotImplementedError("TODO")\n'
test('syntax error has only a bounded line number; source is never executed', () => {
  assert.equal(check('def solve(:\n').reason, 'syntax')
  assert.equal(check('raise RuntimeError("must not execute")').ok, true)
})
test('published unfinished functions fail; comments and legitimate empty methods pass', () => {
  for (const code of [template, 'def solve(x): pass', 'def solve(x): ...', 'def solve(x):\n    "doc only"']) {
    assert.equal(check(code, template).reason, 'incomplete')
  }
  assert.equal(check('# TODO retained\ndef solve(x): return None', template).ok, true)
  assert.equal(check('class Helper:\n    def close(self): pass\ndef solve(x): return x', template).ok, true)
  assert.equal(check('def other(x): return x', template).reason, 'missing_entry')
})
test('D28 tuple of unresolved None is rejected without rejecting optional return', () => {
  const base = 'class Guard:\n    def guard_retrieval(self, hits) -> tuple[list[dict], list[str]]:\n        guarded = None\n        masked = None\n        raise NotImplementedError("TODO")\n        return guarded, masked\n'
  const bad = base.replace('        raise NotImplementedError("TODO")\n', '')
  assert.equal(check(bad, base).reason, 'return_format')
  const good = bad.replace('guarded = None', 'guarded = []').replace('masked = None', 'masked = []')
  assert.equal(check(good, base).ok, true)
  assert.equal(check('def solve(x) -> str | None: return None', template).ok, true)
  assert.equal(check('def solve(x) -> None: pass', 'def solve(x) -> None: pass').ok, true)
})
test('unchanged TODO slots inside loops are detected but unrelated conditional errors are not guessed', () => {
  const frame = 'def solve(xs):\n    for x in xs:\n        raise NotImplementedError("TODO D1")\n    return []'
  assert.equal(check(frame, frame).reason, 'incomplete')
  assert.equal(check('def solve(xs):\n    if not xs: raise ValueError("empty")\n    return xs', frame).ok, true)
})
test('unknown branches, subclass inheritance, decorators and abstract methods are not statically guessed', () => {
  assert.equal(check('def solve(x):\n    if x:\n        return 1\n    return None', template).ok, true)
  assert.equal(check('solve = factory()', template).ok, true)
  assert.equal(check('class Guard(Base): pass', 'class Guard:\n    def run(self): raise NotImplementedError("TODO")').ok, true)
  assert.equal(check('@custom\ndef solve(x): pass', template).ok, true)
  assert.equal(check('from helpers import implementation as solve', template).ok, true)
  assert.equal(check('if True:\n    def solve(x): return x', template).ok, true)
  const typed = 'def solve(x) -> list:\n    raise NotImplementedError("TODO")'
  assert.equal(check('def solve(x):\n    try: return []\n    finally: x=1\n    return None', typed).ok, true)
  assert.equal(check('def solve(x):\n    if x: return []\n    else: return []\n    raise NotImplementedError("TODO")', typed).ok, true)
  assert.equal(check('def solve(x):\n    def assign():\n        nonlocal result\n        result = []\n    result = None\n    marker: object = assign()\n    return result', typed).ok, true)
  assert.equal(check('class Guard: pass', 'class Guard:\n    def run(self): raise NotImplementedError("TODO")').reason, 'missing_entry')
  assert.equal(check('def decorate(cls):\n    cls.run = lambda self: []\n    return cls\n@decorate\nclass Guard:\n    def run(self): pass', 'class Guard:\n    def run(self) -> list: raise NotImplementedError("TODO")').ok, true)
})
test('safe diagnostic decoder rejects protocol drift and limits user-visible metadata', () => {
  assert.throws(() => decodePreflight('{"ok":false,"reason":"bad","line":1}'))
  assert.throws(() => decodePreflight('{"ok":true,"secret":"hidden"}'))
  const message = decodePreflight('{"ok":false,"reason":"return_format","line":28}')
  assert.match(message!, /28/)
  assert.match(message!, /返回/)
})
test('unknown control flow, rebinding, class aliases and expression side effects defer to runtime', () => {
  const typed = 'def solve(x) -> list:\n    raise NotImplementedError("TODO")'
  for (const code of [
    'def solve(x):\n    for _ in [0]: return []\n    return None',
    'def solve(x): pass\nsolve = lambda x: []',
    'def solve(x): pass\nif True:\n    def solve(x): return []',
    'def solve(x):\n    result=None\n    ignored=(result:=[])\n    return result',
    'def solve(x):\n    result=None\n    ignored: object=(result:=[])\n    return result',
  ]) assert.equal(check(code, typed).ok, true)
  assert.equal(check('class Guard:\n    run = lambda self: []', 'class Guard:\n    def run(self): raise NotImplementedError("TODO")').ok, true)
  const tuple = 'def solve(x) -> tuple[list,list]: raise NotImplementedError("TODO")'
  assert.equal(check('def solve(x):\n    def update():\n        nonlocal result\n        result = []\n        return []\n    result = None\n    pair = (update(), result)\n    return pair', tuple).ok, true)
  assert.equal(check('def solve(x):\n    result = None\n    return (result := [], result)', tuple).ok, true)
})
test('student error allowlist preserves actionable contract errors but not arbitrary evaluator text', () => {
  assert.match(studentFailureMessage('防御检索接口不符合题目要求'), /guard_retrieval/)
  assert.match(studentFailureMessage('防御输出接口不符合题目要求'), /guard_response/)
  assert.doesNotMatch(studentFailureMessage('token=secret /app/private'), /secret|private/)
  assert.equal(studentFailureMessage(studentFailureMessage('防御检索接口不符合题目要求')), studentFailureMessage('防御检索接口不符合题目要求'))
})
