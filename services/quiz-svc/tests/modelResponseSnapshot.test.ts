import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { responseSnapshotContext, withResponseSnapshot, snapshotCallEvidence } from '../src/services/modelResponseSnapshot.js'

const context = { policy: 'first-valid-response-v1', scope: 'V3-261012-A09', evaluationVersion: 'snapshot-v11', packageDigest: 'a'.repeat(64) }
const binding = { poolId: 'p', revision: 1, name: 'test', kind: 'llm', model: 'Qwen/Qwen3-8B', modelVersion: 'frozen', baseUrl: 'https://offline.invalid', credentialEnv: 'TEST_KEY', parameters: { temperature: 0, requestTimeoutMs: 1000 } }
const payload = { model: binding.model, messages: [{ role: 'user', content: 'synthetic request' }], stream: false }
const completion = (text = 'synthetic reply') => ({ choices: [{ message: { role: 'assistant', content: text } }] })
async function setup(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'response-snapshot-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('only the four approved scopes can enable snapshots; old definitions remain unchanged', () => {
  assert.equal(responseSnapshotContext({ evaluation: { version: 'old' } } as any, 'a'.repeat(64)), null)
  for (const scope of ['V3-261012-A02', 'V3-261012-D02', 'V3-261012-A09', 'V3-261012-D09'])
    assert.equal(responseSnapshotContext({ evaluation: { version: 'v11', parameters: { responseSnapshotPolicy: context.policy, responseSnapshotScope: scope } } } as any, context.packageDigest)?.scope, scope)
  for (const scope of ['V3-261012-A08', '../outside', 'V3-261012-A03'])
    assert.throws(() => responseSnapshotContext({ evaluation: { version: 'v11', parameters: { responseSnapshotPolicy: context.policy, responseSnapshotScope: scope } } } as any, context.packageDigest))
})

test('the first valid response persists across separate invocations and canonical object ordering', async t => {
  const root = await setup(t); let calls = 0; const sources: string[] = []
  const invoke = (p = payload) => withResponseSnapshot({ root, context, binding, payload: p, call: async () => { calls++; return completion() }, observe: async s => { sources.push(s) } })
  const first = await invoke(); first.choices[0].message.content = 'caller mutation'
  assert.deepEqual(await invoke({ stream: false, messages: payload.messages, model: binding.model }), completion())
  assert.equal(calls, 1); assert.deepEqual(sources, ['upstream', 'snapshot'])
})

test('changed package, model parameters, revision, scope, evaluation version and input are isolated', async t => {
  const root = await setup(t); let calls = 0
  const options = { root, context, binding, payload, call: async () => { calls++; return completion() } }
  await withResponseSnapshot(options)
  for (const change of [
    { context: { ...context, packageDigest: 'b'.repeat(64) } },
    { context: { ...context, scope: 'V3-261012-D09' } },
    { context: { ...context, evaluationVersion: 'new' } },
    { binding: { ...binding, revision: 2 } },
    { binding: { ...binding, parameters: { ...binding.parameters, temperature: 0.5 } } },
    { payload: { ...payload, messages: [{ role: 'user', content: 'different input' }] } },
  ]) await withResponseSnapshot({ ...options, ...change })
  assert.equal(calls, 7)
})

test('concurrent cold requests all receive the same first response with one upstream call', async t => {
  const root = await setup(t); let calls = 0
  const rows = await Promise.all(Array.from({ length: 12 }, () => withResponseSnapshot({ root, context, binding, payload, call: async () => { const n = ++calls; await new Promise(r => setTimeout(r, 25)); return completion(String(n)) } })))
  assert.equal(calls, 1); assert.ok(rows.every(r => r.choices[0].message.content === '1'))
})

test('timeouts and malformed or empty responses are never cached or automatically retried', async t => {
  const root = await setup(t); let calls = 0
  for (const result of [null, {}, { choices: [] }, completion(''), { choices: [{ message: { tool_calls: [{}] } }] }])
    await assert.rejects(withResponseSnapshot({ root, context, binding, payload, call: async () => { calls++; return result } }))
  await assert.rejects(withResponseSnapshot({ root, context, binding, payload, call: async () => { calls++; throw Error('synthetic timeout') } }))
  assert.deepEqual(await withResponseSnapshot({ root, context, binding, payload, call: async () => { calls++; return completion() } }), completion())
  assert.equal(calls, 7)
})

test('authorization/active-state observer failure prevents both cold calls and warm response release', async t => {
  const root = await setup(t); let calls = 0
  const options = { root, context, binding, payload, call: async () => { calls++; return completion() } }
  await assert.rejects(withResponseSnapshot({ ...options, observe: async () => { throw Error('inactive or exhausted') } }))
  assert.equal(calls, 0); await withResponseSnapshot(options)
  await assert.rejects(withResponseSnapshot({ ...options, observe: async () => { throw Error('inactive') } }))
  assert.equal(calls, 1)
})

test('corrupted persisted response fails closed without new model calls', async t => {
  const root = await setup(t); let calls = 0
  const options = { root, context, binding, payload, call: async () => { calls++; return completion() } }
  await withResponseSnapshot(options)
  const names = await fs.readdir(root); const entry = names.find((n: string) => n.endsWith('.json'))!
  const record = JSON.parse(await fs.readFile(path.join(root, entry), 'utf8')); record.response = completion('tampered')
  await fs.writeFile(path.join(root, entry), JSON.stringify(record))
  await assert.rejects(withResponseSnapshot(options)); assert.equal(calls, 1)
})

test('a missing private root cannot silently fall back to live scoring', async () => {
  await assert.rejects(withResponseSnapshot({ root: '', context, binding, payload, call: async () => { throw Error('must not call') } }))
})

test('ranking judge invalid JSON is not persisted; original fenced object parsing remains valid', async t => {
  const root = await setup(t); let calls = 0
  const options = { root, context: { ...context, scope: 'V3-261012-A02' }, binding, payload }
  await assert.rejects(withResponseSnapshot({ ...options, call: async () => { calls++; return completion('not JSON') } }))
  const value = completion('```json\n{"overall_score": 5, "reason":"brace } in string"}\n```')
  assert.deepEqual(await withResponseSnapshot({ ...options, call: async () => { calls++; return value } }), value)
  await withResponseSnapshot({ ...options, call: async () => { assert.fail('warm snapshot must not call') } })
  assert.equal(calls, 2)
})

test('proof evidence separates upstream attempts and snapshot hits without claiming replay as a new model call', () => {
  assert.deepEqual(snapshotCallEvidence({ calls: 3, upstreamCalls: 1, responseSnapshotHits: 2 }), { upstreamCalls: 1, responseSnapshotHits: 2 })
  assert.deepEqual(snapshotCallEvidence({ calls: 2, upstreamCalls: 0, responseSnapshotHits: 2 }), { upstreamCalls: 0, responseSnapshotHits: 2 })
  for (const record of [{ calls: 2 }, { calls: 2, upstreamCalls: 2, responseSnapshotHits: 1 }, { calls: 2, upstreamCalls: -1, responseSnapshotHits: 3 }])
    assert.throws(() => snapshotCallEvidence(record))
})

test('separate Node processes share the first response under the filesystem lock', async t => {
  const root = await setup(t), worker = path.join(root, 'worker.mjs')
  const moduleUrl = new URL('../src/services/modelResponseSnapshot.ts', import.meta.url).href
  await fs.writeFile(worker, `import fs from 'node:fs/promises'; import {withResponseSnapshot} from ${JSON.stringify(moduleUrl)};
const args=${JSON.stringify({ root, context, binding, payload })};
const result=await withResponseSnapshot({...args,call:async()=>{await fs.appendFile(${JSON.stringify(path.join(root, 'upstream.log'))},'call\\n');await new Promise(r=>setTimeout(r,50));return {choices:[{message:{content:String(process.pid)}}]}}}); console.log(JSON.stringify(result));`)
  const run = promisify(execFile)
  const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, ['--import', 'tsx', worker])))
  assert.ok(results.every(r => r.stdout === results[0].stdout))
  assert.equal((await fs.readFile(path.join(root, 'upstream.log'), 'utf8')).trim().split('\n').length, 1)
})

test('an abandoned cold lock fails closed rather than starting a second upstream request', async t => {
  const root = await setup(t)
  const options = { root, context, binding, payload, call: async () => completion() }
  await withResponseSnapshot(options)
  const file = (await fs.readdir(root)).find(n => n.endsWith('.json'))!
  await fs.unlink(path.join(root, file)); await fs.mkdir(path.join(root, file.replace(/\.json$/, '.lock')))
  await assert.rejects(withResponseSnapshot({ ...options, waitMs: 5, call: async () => { assert.fail('must not steal a lock') } }))
})

test('POSIX private-root permissions and symlink records are enforced', async t => {
  if (process.platform === 'win32') { t.skip('Verified on Linux; Windows does not expose POSIX permission semantics'); return }
  const root = await setup(t)
  const options = { root, context, binding, payload, call: async () => completion() }
  await fs.chmod(root, 0o755); await assert.rejects(withResponseSnapshot(options)); await fs.chmod(root, 0o700)
  await withResponseSnapshot(options)
  const file = (await fs.readdir(root)).find(n => n.endsWith('.json'))!
  await fs.rename(path.join(root, file), path.join(root, 'target.txt'))
  await fs.symlink(path.join(root, 'target.txt'), path.join(root, file))
  await assert.rejects(withResponseSnapshot({ ...options, call: async () => { assert.fail('must not follow symlink') } }))
})


test('cold pacing happens before final activity admission; warm snapshots bypass pacing',async t=>{
 const root=await setup(t),events:string[]=[]
 const options={root,context,binding,payload,beforeCall:async()=>{events.push('pace')},observe:async(source:'upstream'|'snapshot')=>{events.push(source)},call:async()=>{events.push('call');return completion()}}
 await withResponseSnapshot(options);await withResponseSnapshot(options)
 assert.deepEqual(events,['pace','upstream','call','snapshot'])
 let calls=0
 await assert.rejects(withResponseSnapshot({...options,payload:{...payload,messages:[{role:'user',content:'another'}]},beforeCall:async()=>{},observe:async()=>{throw Error('ended')},call:async()=>{calls++;return completion()}}),/ended/)
 assert.equal(calls,0)
})
