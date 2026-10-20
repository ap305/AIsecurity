import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import {certifyBasics} from '../scripts/certifyCoursePackBasics.js'
import {COURSE_PACK_IDS, loadCoursePack, sha256} from '../scripts/importCoursePackV3.js'
import {normalizeDefinition} from '../src/lib/prdContract.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import {decodeEvaluationArchive} from '../src/lib/evaluationPackage.js'

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'basic-checkpoint-')),folder=path.join(root,'package')
  fs.mkdirSync(folder)
  const image='test/evaluator@sha256:'+'a'.repeat(64)
  const files={'manifest.json':JSON.stringify({image}),'compose.yaml':'services: {}','grader.py':'# private'}
  for(const [n,v]of Object.entries(files))fs.writeFileSync(path.join(folder,n),v)
  const packageFiles=Object.entries(files).map(([path,data])=>({path,sha256:sha256(data)}))
  const zip=new AdmZip()
  for(const [n,v]of Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))zip.addFile(n,Buffer.from(v))
  const packageDigest=sha256(JSON.stringify(Object.fromEntries([...decodeEvaluationArchive(zip.toBuffer())].map(([n,b])=>[n,sha256(b)]))))
  fs.writeFileSync(path.join(root,'reference.py'),'def solve(): return 1\n')
  const material={codePath:'reference.py',codeSha256:sha256(fs.readFileSync(path.join(root,'reference.py')))}
  const manifest={schemaVersion:1,packId:'V3-261012',sourceArchiveSha256:'b'.repeat(64),requiresCalibration:true,deploymentReady:false,
    packages:[{key:'pkg',directory:'package',files:packageFiles}],questions:COURSE_PACK_IDS.map(id=>{
      const basic=id.includes('-B');return {id,title:id,moduleCode:'test',number:Number(id.slice(-2)),difficulty:'L1',category:basic?'basic':'adversarial',
        ...(basic?{}:{role:id.includes('-A')?'attack':'defense',scenarioId:'scene-'+id.slice(-2)}),content:'Task',answerTemplate:'def solve(): pass',packageKey:'pkg',requiresCalibration:!basic,deploymentReady:false,
        definition:normalizeDefinition({evaluation:{version:'test',baselineThreshold:0,successThreshold:1,parameters:{calibrationMode:true}}}),
        selfTest:{...material,...(basic?{}:{opponent:material})},resources:[]}
    })}
  const options={manifest:path.join(root,'manifest.json'),evidence:path.join(root,'evidence.json'),state:path.join(root,'state.json'),output:path.join(root,'basic-ready.json'),api:'http://127.0.0.1:14004/api',tokenFile:path.join(root,'token')}
  fs.writeFileSync(options.manifest,JSON.stringify(manifest));fs.writeFileSync(options.evidence,JSON.stringify({image}));fs.writeFileSync(options.tokenFile,'private-test-token-0123456')
  const {manifest:loaded,manifestDigest}=loadCoursePack(options.manifest)
  const records=new Map<string,any>(),state:any={manifestDigest,evidenceDigest:sha256(fs.readFileSync(options.evidence)),api:options.api,packages:{pkg:{id:'package-1',digest:packageDigest,inputDigest:sha256(JSON.stringify(packageFiles))}},tests:{}}
  for(const q of loaded.questions.filter(q=>q.category==='basic')){
    const definition=structuredClone(q.definition)
    definition.evaluation={...definition.evaluation,packageId:'package-1',calibrationMode:true,baselineThreshold:0,successThreshold:1,
      parameters:{calibrationMode:true,calibrationReferenceBinding:sha256(JSON.stringify({manifestDigest,questionId:q.id,phase:'basic',code:material.codeSha256,weights:null,opponentCode:null,opponentWeights:null}))}}
    const key=selfTestConfigurationKey(normalizeDefinition(definition),null,'basic'),id='test-'+q.id
    const record={id,packageId:'package-1',packageDigest,phase:'basic',configurationKey:key,status:'completed',result:{status:'completed',cleanupStatus:'cleaned',score:100,maxScore:100}}
    records.set(id,record);state.tests[q.id]={basic:{id,configurationKey:key,record:structuredClone(record)}}
  }
  fs.writeFileSync(options.state,JSON.stringify(state))
  const requests:string[]=[]
  const transport=(async(url:any,init:any)=>{
    assert.equal(init.method,undefined);assert.equal(init.redirect,'error');requests.push(String(url))
    const data=String(url).endsWith('/auth/me')?{user:{role:'admin'}}:records.get(String(url).split('/').pop()!)
    assert.ok(data);return new Response(JSON.stringify({code:0,data}),{status:200})
  }) as typeof fetch
  return {options,records,state,requests,transport,clean:()=>fs.rmSync(root,{recursive:true,force:true})}
}
test('basic certificate checks live proofs via GET and leaves all 60 adversarial questions unready',async()=>{
  const f=fixture();try{
    const report=await certifyBasics(f.options,f.transport),result=loadCoursePack(f.options.output).manifest
    assert.equal(report.basicProofs.length,17);assert.equal(report.apiWrites,0);assert.equal(f.requests.length,18)
    assert.equal(result.requiresCalibration,true);assert.equal(result.deploymentReady,false)
    assert.equal(result.questions.filter(q=>q.deploymentReady).length,17)
    assert.ok(result.questions.filter(q=>q.category==='adversarial').every(q=>q.requiresCalibration&&!q.deploymentReady))
  }finally{f.clean()}
})
test('unclean, changed binding, and invalid score proofs cannot produce a ready-basic checkpoint',async()=>{
  for(const kind of ['cleanup','binding','score']as const){const f=fixture();try{
    const record=[...f.records.values()][0]
    if(kind==='cleanup')record.result.cleanupStatus='pending'
    if(kind==='binding')record.configurationKey='a'.repeat(64)
    if(kind==='score')record.result.score=0
    await assert.rejects(certifyBasics(f.options,f.transport),/basic_proof_not_completed_and_clean|live_proof_binding_changed|basic_measured_score_invalid/)
    assert.equal(fs.existsSync(f.options.output),false)
  }finally{f.clean()}}
})
test('concurrently changed source state invalidates the certificate without manipulating its lock',async()=>{
  const f=fixture();try{
    fs.writeFileSync(f.options.state+'.lock','another owner')
    const transport=(async(...args:any[])=>{const r=await (f.transport as any)(...args);if(f.requests.length===18)fs.appendFileSync(f.options.state,' ');return r})as typeof fetch
    await assert.rejects(certifyBasics(f.options,transport),/certificate_inputs_changed/)
    assert.equal(fs.existsSync(f.options.output),false);assert.equal(fs.readFileSync(f.options.state+'.lock','utf8'),'another owner')
  }finally{f.clean()}
})
