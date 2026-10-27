import test from 'node:test'
import assert from 'node:assert/strict'
import {createColdRequestGate} from '../src/services/modelRequestPacing.js'
test('cold request pacing serializes the same model while separating accounts and rejecting overload',async()=>{
 let now=1000;const waits:number[]=[];const gate=createColdRequestGate(()=>now,async ms=>{waits.push(ms);now+=ms})
 await gate('account/model',35000);await gate('account/model',35000);await gate('account/model',35000)
 assert.deepEqual(waits,[35000,35000]);await gate('other/model',35000);assert.deepEqual(waits,[35000,35000])
 let time=0;const blocked:Array<()=>void>=[];const queued=createColdRequestGate(()=>time,()=>new Promise<void>(resolve=>blocked.push(resolve)))
 await queued('key',35000);const waiting=queued('key',35000);await assert.rejects(queued('key',35000),/调用繁忙/);time=35000;blocked.shift()!();await waiting
})
test('invalid pacing values fail before occupying a request slot',async()=>{
 const gate=createColdRequestGate(()=>0,async()=>{})
 for(const ms of [-1,1.1,65001,NaN])await assert.rejects(gate('key',ms))
 await gate('key',0);await gate('key',0)
})

test('a waiting background request does not reserve the next ordinary admission slot', async () => {
  let time = 0
  const waiting: Array<{ ms: number; resolve: () => void }> = []
  const gate = createColdRequestGate(() => time, ms => new Promise<void>(resolve => waiting.push({ ms, resolve })))
  const background = gate.background
  await gate('model', 35000)
  time = 8000
  const heavy = background('model', 35000, 290000)
  time = 10000
  const ordinary = gate('model', 35000)
  void ordinary.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(waiting.map(w => w.ms), [27000, 25000],
    'ordinary traffic must be admitted at t35 while background waits without booking t35')
  time = 35000
  waiting[0].resolve(); await Promise.resolve()
  waiting[1].resolve(); await ordinary
  assert.deepEqual(waiting.map(w => w.ms), [27000, 25000, 35000])
  time = 70000
  waiting[2].resolve(); await heavy
})

test('ordinary activity may defer background traffic only until its bounded deadline', async () => {
  let time = 0
  const waiting: Array<{ ms: number; resolve: () => void }> = []
  const gate = createColdRequestGate(() => time, ms => new Promise<void>(resolve => waiting.push({ ms, resolve })))
  const background = gate.background
  assert.equal(typeof background, 'function')
  await gate('model', 35000)
  time = 8000
  const heavy = background('model', 35000, 50000)
  const rejected = assert.rejects(heavy, /时限|超时/)
  time = 35000
  await gate('model', 35000)
  waiting[0].resolve(); await Promise.resolve()
  assert.deepEqual(waiting.map(w => w.ms), [27000, 15000])
  time = 50000
  waiting[1].resolve(); await rejected
  const ordinary = gate('model', 35000)
  assert.equal(waiting[2].ms, 20000, 'expired background request must leave no reservation')
  time = 70000; waiting[2].resolve(); await ordinary
})

test('background claims are atomic, isolated by model key and reject invalid or expired bounds', async () => {
  let time = 1000
  const waits: number[] = []
  const gate = createColdRequestGate(() => time, async ms => { waits.push(ms); time += ms })
  const background = gate.background
  assert.equal(typeof background, 'function')
  for (const ms of [-1, 1.1, 65001, NaN]) await assert.rejects(background('key', ms, 100000))
  for (const deadline of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(background('key', 35000, deadline))
  await assert.rejects(background('key', 0, time), /时限|超时/)
  await background('key', 35000, 100000)
  await background('other', 35000, 100000)
  assert.deepEqual(waits, [])
  await background('key', 35000, 100000)
  assert.deepEqual(waits, [35000])
  await background('key', 0, 100000)
  assert.deepEqual(waits, [35000])
})
