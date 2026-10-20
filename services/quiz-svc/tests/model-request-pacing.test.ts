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
