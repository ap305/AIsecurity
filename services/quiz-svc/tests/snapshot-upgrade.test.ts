import test from 'node:test'
import assert from 'node:assert/strict'
import {buildUpgradePlan, checkUpgradeProof, runUpgradeProofs,publishVerifiedUpgrades,upgradeContractsDigest,questionInventoryDigest,bindOtherQuestionInventory,verifyUpgradePackage,verifyMeasuredUpgrade} from '../scripts/upgradeSnapshotQuestions.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import crypto from 'node:crypto'
import {questionUpdateDigest} from '../src/lib/questionUpdatePrecondition.js'
import {normalizeDefinition, type PoolBinding} from '../src/lib/prdContract.js'
const pool: PoolBinding = {poolId:'pool', revision:1, name:'fixed8B', kind:'llm', model:'Qwen/Qwen3-8B', modelVersion:'v1', baseUrl:'https://provider.invalid', parameters:{max_tokens:512}}
function fixture(id='V3-261012-D02') {
 const definition=normalizeDefinition({llm:{enabled:true,poolId:'pool'},evaluation:{version:'old',packageId:'pkg',baselineThreshold:50,successThreshold:0.5}})
 const current:any={id,role:id.includes('-A')?'attack':'defense',category:'adversarial',scenarioId:'scene',status:'published',revision:2,title:id,content:'original',answerTemplate:'code',moduleCode:'ADV',number:2,difficulty:'L1',definition}
 const candidate:any={...structuredClone(current),deploymentReady:true,requiresCalibration:false,selfTest:{codePath:'reference.py',codeSha256:'b'.repeat(64),opponent:{codePath:'opponent.py',codeSha256:'c'.repeat(64)}}}
 candidate.definition.evaluation.version='v3-261012-response-snapshot4-v11';candidate.definition.evaluation.baselineThreshold=49
 delete candidate.definition.evaluation.packageId
 candidate.definition.evaluation.parameters={responseSnapshotPolicy:'first-valid-response-v1',responseSnapshotScope:id}
 return {current,candidate,plan:()=>buildUpgradePlan(candidate,current,{id:'pkg',digest:'a'.repeat(64)},pool)}
}
function proof(plan:any,phase='baseline',metric=49) {return {id:'12345678-1234-1234-1234-123456789abc',packageId:'pkg',packageDigest:'a'.repeat(64),configurationKey:plan.configurationKey,phase,status:'completed',calls:3,upstreamCalls:0,responseSnapshotHits:3,result:{status:'completed',cleanupStatus:'cleaned',metrics:{[phase==='baseline'?plan.definition.evaluation.baselineMetric:plan.definition.evaluation.successMetric]:metric}}}}
test('upgrade accepts exact baseline equality and a valid zero-score opponent loss',()=>{const p=fixture().plan();checkUpgradeProof(p,'baseline',proof(p));checkUpgradeProof(p,'opponent',proof(p,'opponent',0))})
test('upgrade rejects unapproved scopes and non-snapshot behavior changes',()=>{
 assert.throws(()=>fixture('V3-261012-D08').plan(),/scope/)
 for(const change of [(f:any)=>f.candidate.definition.evaluation.timeoutMs++, (f:any)=>f.candidate.content='changed', (f:any)=>f.candidate.definition.weights.required=true, (f:any)=>f.candidate.definition.llm.poolId='other']) {const f=fixture();change(f);assert.throws(f.plan)}
})
test('upgrade rejects calibration-mode, failed, uncleaned, mismatched and incomplete call evidence',()=>{
 const f=fixture();f.candidate.definition.evaluation.calibrationMode=true;assert.throws(f.plan)
 const p=fixture().plan()
 for(const change of [(r:any)=>r.result.status='system_error',(r:any)=>r.result.cleanupStatus='failed',(r:any)=>r.configurationKey='other',(r:any)=>r.packageDigest='d'.repeat(64),(r:any)=>r.result.metrics[p.definition.evaluation.baselineMetric]=48,(r:any)=>delete r.responseSnapshotHits]) {const r=proof(p);change(r);assert.throws(()=>checkUpgradeProof(p,'baseline',r))}
})
test('unknown self-test POST is recorded once and cannot be duplicated on resume',async()=>{
 const plan=fixture().plan(), state:any={tests:{}}, events:any[]=[];let posts=0
 const request=async (_route:string,method='GET')=>{if(method==='POST'){posts++;throw Error('unknown')}throw Error('unexpected')}
 const save=()=>events.push(structuredClone(state))
 await assert.rejects(runUpgradeProofs([plan],state,request,save,()=>({code:'trusted'})))
 assert.equal(posts,1);assert.equal(events[0].tests[plan.id].baseline.intent,true)
 await assert.rejects(runUpgradeProofs([plan],state,request,save,()=>({code:'trusted'})),/unknown/);assert.equal(posts,1)
})
test('normal completed baseline rejection is retained and never retried',async()=>{
 const plan=fixture().plan();const r=proof(plan);r.result.metrics[plan.definition.evaluation.baselineMetric]=48
 const state:any={tests:{[plan.id]:{baseline:{intent:true,id:r.id,configurationKey:plan.configurationKey}}}};let posts=0
 await assert.rejects(runUpgradeProofs([plan],state,async(_route:string,method='GET')=>{if(method==='POST')posts++;return r},()=>{},()=>({code:'trusted'})))
 assert.equal(posts,0);assert.equal(state.tests[plan.id].baseline.id,r.id)
})

test('material failure before POST leaves no ambiguous intent and permits a corrected start',async()=>{
 const plan=fixture().plan(),state:any={tests:{}};let posts=0
 await assert.rejects(runUpgradeProofs([plan],state,async()=>{posts++;throw Error('unexpected')},()=>{},()=>{throw Error('bad_local_file')}),/bad_local_file/)
 assert.equal(posts,0);assert.equal(state.tests[plan.id].baseline,undefined)
})
test('independent final phases preserve exact contract and can be reverified without duplicate POSTs',async()=>{
 const plan=fixture().plan(),state:any={tests:{}};const records=new Map<string,any>();let posts=0
 const request=async(route:string,method='GET',body?:any)=>{
  if(method==='POST'){
   posts++;assert.equal(body.definition.evaluation.calibrationMode,undefined);assert.equal(body.code,'trusted');assert.equal(body.role,plan.role)
   const r=proof(plan,body.phase,body.phase==='baseline'?49:0);r.id=body.phase==='baseline'?'12345678-1234-1234-1234-123456789abc':'22345678-1234-1234-1234-123456789abc';records.set(r.id,r);return {id:r.id}
  }
  return records.get(route.split('/').at(-1)!)
 }
 await runUpgradeProofs([plan],state,request,()=>{},()=>({code:'trusted'}),0)
 await runUpgradeProofs([plan],state,request,()=>{},()=>({code:'trusted'}),0)
 assert.equal(posts,2);assert.equal(state.tests[plan.id].opponent.record.metric,0)
})

function publicationFixture(){
 const plans=['V3-261012-A02','V3-261012-D02','V3-261012-A09','V3-261012-D09'].map(id=>fixture(id).plan()),state:any={tests:{}},records=new Map<string,any>(),current=new Map(plans.map(p=>[p.id,fixture(p.id).current]));let posts=0,proofReads=0
 for(const[i,p]of plans.entries()){state.tests[p.id]={};for(const[j,phase]of ['baseline','opponent'].entries()){const r=proof(p,phase,phase==='baseline'?49:0);r.id=String(i*2+j+1).padStart(8,'0')+'-1234-1234-1234-123456789abc';records.set(r.id,r);state.tests[p.id][phase]={id:r.id,configurationKey:p.configurationKey}}}
 const request=async(route:string,method='GET',body?:any)=>{
  if(route.includes('/self-tests/')){proofReads++;return structuredClone(records.get(route.split('/').at(-1)!))}
  const id=decodeURIComponent(route.split('/').at(-1)!);const q=current.get(id);assert.ok(q)
  if(method==='PUT'){assert.ok(proofReads>=8);assert.equal(body.expectedQuestionDigest,questionUpdateDigest(q));posts++;q.definition=structuredClone(body.definition);q.status=body.status;q.revision++;q.updatedAt='new'}
  return structuredClone(q)
 }
 return {plans,state,records,current,request,posts:()=>posts,acceptance:()=>({status:'passed',kind:'real-student-submit',api:'http://127.0.0.1:14006/api',contractsDigest:upgradeContractsDigest(plans),questionIds:plans.map(p=>p.id),checks:{baselineAccepted:true,emptyArena100:true,normalLossZero:true,adminPerQuestion:true}})}
}
test('all eight final proofs and exact real-student acceptance must pass before any question PUT',async()=>{
 const f=publicationFixture();const last=[...f.records.values()].at(-1);last.configurationKey='wrong'
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,f.request,()=>{},f.acceptance()));assert.equal(f.posts(),0)
 const g=publicationFixture();const acceptance=g.acceptance();acceptance.contractsDigest='wrong';await assert.rejects(publishVerifiedUpgrades(g.plans,g.state,g.request,()=>{},acceptance));assert.equal(g.posts(),0)
})
test('successful publication changes only definition and status and resumes without duplicate PUT',async()=>{
 const f=publicationFixture();await publishVerifiedUpgrades(f.plans,f.state,f.request,()=>{},f.acceptance());assert.equal(f.posts(),4)
 await publishVerifiedUpgrades(f.plans,f.state,f.request,()=>{},f.acceptance());assert.equal(f.posts(),4)
})
test('unknown publication outcome preserves intent and refuses to repeat an unchanged question',async()=>{
 const f=publicationFixture();let attempts=0
 const request=async(route:string,method='GET',body?:any)=>{if(method==='PUT'){attempts++;throw Error('unknown')}return f.request(route,method,body)}
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,request,()=>{},f.acceptance()));assert.equal(attempts,1)
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,request,()=>{},f.acceptance()),/unknown/);assert.equal(attempts,1)
})
test('an unknown successful PUT is reconciled by exact GET rather than resent',async()=>{
 const f=publicationFixture();let interrupted=false
 const request=async(route:string,method='GET',body?:any)=>{const result=await f.request(route,method,body);if(method==='PUT'&&!interrupted){interrupted=true;throw Error('unknown')}return result}
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,request,()=>{},f.acceptance()));assert.equal(f.posts(),1)
 await publishVerifiedUpgrades(f.plans,f.state,request,()=>{},f.acceptance());assert.equal(f.posts(),4)
})

test('a concurrent question edit or incomplete acceptance stops the entire publication batch',async()=>{
 const f=publicationFixture();f.current.get(f.plans[3].id)!.content='teacher edit'
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,f.request,()=>{},f.acceptance()),/changed/);assert.equal(f.posts(),0)
 const g=publicationFixture();const a=g.acceptance();a.checks.normalLossZero=false
 await assert.rejects(publishVerifiedUpgrades(g.plans,g.state,g.request,()=>{},a));assert.equal(g.posts(),0)
})

test('package preflight binds original source digest, input file list and immutable image',async()=>{
 const pkg={id:'pkg',digest:'a'.repeat(64),inputDigest:'c'.repeat(64)},expected={digest:pkg.digest,inputDigest:pkg.inputDigest,image:'runtime@sha256:'+'d'.repeat(64)};let called=0
 const request=async(route:string,method?:string)=>{called++;assert.equal(route,'/admin/evaluation-packages/pkg/validate');assert.equal(method,'POST');return {...pkg,valid:true,manifest:{image:expected.image}}}
 await verifyUpgradePackage(pkg,request,expected);assert.equal(called,1)
 await assert.rejects(verifyUpgradePackage({...pkg,digest:'b'.repeat(64)},request,expected));assert.equal(called,1)
 await assert.rejects(verifyUpgradePackage({...pkg,inputDigest:'b'.repeat(64)},request,expected));assert.equal(called,1)
 await assert.rejects(verifyUpgradePackage(pkg,async()=>({...pkg,valid:true,manifest:{image:'other'}}),expected))
})
test('server-side question digest prevents a teacher edit in the last GET to PUT window',async()=>{
 const f=publicationFixture();let reads=0
 const request=async(route:string,method='GET',body?:any)=>{
  const result=await f.request(route,method,body)
  if(method==='GET'&&route==='/admin/questions/'+f.plans[0].id&&++reads===2)f.current.get(f.plans[0].id)!.content='teacher edit after GET'
  return result
 }
 await assert.rejects(publishVerifiedUpgrades(f.plans,f.state,request,()=>{},f.acceptance()));assert.equal(f.posts(),0)
 assert.equal(f.current.get(f.plans[0].id)!.content,'teacher edit after GET')
})

function measuredFixture(){
 const f=fixture();const q=structuredClone(f.candidate);q.definition.evaluation.successThreshold=0.5;q.definition.evaluation.parameters.successThreshold=0.5
 const raw=structuredClone(q);raw.requiresCalibration=true;raw.deploymentReady=false;raw.definition.evaluation.baselineThreshold=0;raw.definition.evaluation.successThreshold=1;raw.definition.evaluation.parameters.successThreshold=1
 const pkg={id:'pkg',digest:'a'.repeat(64)},cal:any={manifestDigest:'d'.repeat(64),pools:{[q.id]:{id:'pool'}},tests:{[q.id]:{}}}
 for(const phase of ['baseline','opponent']){
  const d=structuredClone(raw.definition);d.evaluation.packageId='pkg';d.evaluation.calibrationMode=true
  d.evaluation.parameters.calibrationReferenceBinding=crypto.createHash('sha256').update(JSON.stringify({manifestDigest:cal.manifestDigest,questionId:q.id,phase,code:q.selfTest.codeSha256,weights:null,opponentCode:phase==='opponent'?q.selfTest.opponent.codeSha256:null,opponentWeights:null})).digest('hex')
  const key=selfTestConfigurationKey(d,q.role,q.category,pool),r=proof({...f.plan(),configurationKey:key},phase,phase==='baseline'?49:0.5)
  cal.tests[q.id][phase]={id:r.id,configurationKey:key,record:r}
 }
 return {q,raw,pkg,cal,check:()=>verifyMeasuredUpgrade(q,raw,pkg,pool,cal,{minimumPositiveSuccessThreshold:0.1})}
}
test('the final four-question contract must derive its exact thresholds from bound measured calibration',()=>{
 const f=measuredFixture();assert.equal(f.check().length,2)
 for(const change of [(x:any)=>x.q.definition.evaluation.baselineThreshold=48,(x:any)=>x.q.definition.evaluation.successThreshold=0.1,(x:any)=>x.cal.tests[x.q.id].baseline.record.packageDigest='f'.repeat(64),(x:any)=>x.cal.tests[x.q.id].baseline.configurationKey='wrong']){
  const x=measuredFixture();change(x);assert.throws(x.check)
 }
})


test('inventory digest ignores row order but rejects changed rows and duplicate IDs',()=>{
 const rows=[{id:'b',content:'one'},{id:'a',content:'two'}]
 assert.equal(questionInventoryDigest(rows),questionInventoryDigest([...rows].reverse()))
 assert.notEqual(questionInventoryDigest(rows),questionInventoryDigest([{...rows[0],content:'changed'},rows[1]]))
 assert.throws(()=>questionInventoryDigest([rows[0],rows[0]]),/inventory/)
})
test('legacy inventory checkpoint migrates only after its exact old hash matches',()=>{
 const rows=[{id:'b',content:'one'},{id:'a',content:'two'}]
 const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)
 const legacy={otherQuestionsDigest:crypto.createHash('sha256').update(canonical(rows)).digest('hex')}
 const state:any={...legacy};assert.equal(bindOtherQuestionInventory(state,rows),true)
 assert.equal(state.inventoryDigestVersion,1);assert.equal(state.otherQuestionsDigest,questionInventoryDigest(rows))
 assert.equal(bindOtherQuestionInventory(state,[...rows].reverse()),false)
 assert.throws(()=>bindOtherQuestionInventory({...legacy},[...rows].reverse()),/changed/)
 assert.throws(()=>bindOtherQuestionInventory(state,[{...rows[0],content:'changed'},rows[1]]),/changed/)
 assert.throws(()=>bindOtherQuestionInventory({...state,inventoryDigestVersion:2},rows),/version/)
})
