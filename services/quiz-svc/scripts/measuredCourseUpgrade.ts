import crypto from 'node:crypto'
import type {PoolBinding} from '../src/lib/prdContract.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import {thresholds} from './calibrateCoursePackV3.js'
import type {CoursePackQuestion} from './importCoursePackV3.js'
function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v)}
function check(v:any,reason:string):asserts v {if(!v)throw Error(reason)}
/** Reconstruct the original calibrator contract. Scope/call-policy guards belong to each dedicated caller. */
export function verifyMeasuredCourseContract(q:CoursePackQuestion,raw:CoursePackQuestion,pkg:{id:string;digest:string},pool:PoolBinding,cal:any,metadata:any,callEvidence:(record:any)=>unknown,packageFiles:Array<{path:string;sha256:string}>=[]) {
 check(q.id===raw.id,'upgrade_calibration_scope_invalid')
 const records:any[]=[]
 const fixtureDigest=(name?:string)=>{if(!name)return null;const file=packageFiles.find(f=>f.path===name);check(file,'upgrade_calibration_weight_missing');return file.sha256}
 for(const phase of ['baseline','opponent']as const) {
  const p=cal.tests?.[q.id]?.[phase],record=p?.record
  check(record&&record.id===p.id&&record.phase===phase&&record.packageId===pkg.id&&record.packageDigest===pkg.digest&&record.status==='completed'&&record.result?.status==='completed'&&record.result.cleanupStatus==='cleaned','upgrade_calibration_proof_invalid')
  const definition=structuredClone(raw.definition)
  definition.evaluation={...definition.evaluation,packageId:pkg.id,calibrationMode:true,baselineThreshold:0,successThreshold:1}
  const referenceBinding=crypto.createHash('sha256').update(JSON.stringify({manifestDigest:cal.references?.[q.id]?.referenceManifestDigest??cal.manifestDigest,questionId:q.id,phase,
   code:q.selfTest.codeSha256,weights:fixtureDigest(q.selfTest.weightFixture),opponentCode:phase==='opponent'?q.selfTest.opponent!.codeSha256:null,opponentWeights:phase==='opponent'?fixtureDigest(q.selfTest.opponent!.weightFixture):null})).digest('hex')
  definition.evaluation.parameters={...(definition.evaluation.parameters as any),calibrationReferenceBinding:referenceBinding}
  definition.llm.poolId=cal.pools[q.id].id
  const key=selfTestConfigurationKey(definition,q.role!,q.category,pool)
  check(p.configurationKey===key&&record.configurationKey===key,'upgrade_calibration_binding_mismatch');callEvidence(record);records.push(record)
 }
 const expected=structuredClone(raw), measured=thresholds(records[0].result.metrics.qualificationMetric,records[1].result.metrics.successMetric,metadata?.minimumPositiveSuccessThreshold)
 Object.assign(expected.definition.evaluation,measured)
 if(expected.definition.evaluation.parameters&&typeof expected.definition.evaluation.parameters==='object')Object.assign(expected.definition.evaluation.parameters,{successThreshold:measured.successThreshold})
 delete expected.definition.evaluation.calibrationMode
 if(expected.definition.evaluation.parameters&&typeof expected.definition.evaluation.parameters==='object'){
  delete (expected.definition.evaluation.parameters as any).calibrationMode;delete (expected.definition.evaluation.parameters as any).calibrationReferenceBinding
 }
 expected.definition.llm.poolId=cal.pools[q.id].id;expected.requiresCalibration=false;expected.deploymentReady=true
 check(canonical(expected)===canonical(q),'upgrade_final_manifest_not_measured_contract')
 return records
}
