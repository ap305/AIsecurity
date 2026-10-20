/** Dedicated08 proofs and explicitly guarded publication. No08 response snapshots. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import {loadCoursePack} from './importCoursePackV3.js'
import {packageArchive} from './calibrateCoursePackV3.js'
import {questionInventoryDigest,verifyUpgradePackage,upgradeContractsDigest} from './upgradeSnapshotQuestions.js'
import {verifyMeasuredCourseContract} from './measuredCourseUpgrade.js'
import {normalizeDefinition,type PoolBinding,type QuestionDefinition} from '../src/lib/prdContract.js'
import {questionUpdateDigest} from '../src/lib/questionUpdatePrecondition.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import type {CoursePackQuestion} from './importCoursePackV3.js'
import type {UpgradePlan} from './upgradeSnapshotQuestions.js'
import {runBoundFinalProofs} from './courseFinalProofs.js'
const ids=['V3-261012-A08','V3-261012-D08']
function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v)}
const hash=(v:any)=>crypto.createHash('sha256').update(canonical(v)).digest('hex')
function check(v:any,reason:string):asserts v {if(!v)throw Error(reason)}
function stableContract(d:QuestionDefinition){const value=structuredClone(d);delete value.llm.poolId;const e:any=value.evaluation;for(const key of ['version','baselineThreshold','successThreshold','packageId','packageDigest'])delete e[key];if(e.parameters)delete e.parameters.successThreshold;if(e.parameters&&Object.keys(e.parameters).length===0)delete e.parameters;return value}
export function buildPaced08Plan(q:CoursePackQuestion,current:any,pkg:{id:string;digest:string},oldPool:PoolBinding,pool:PoolBinding):UpgradePlan {
 check(ids.includes(q.id)&&q.id===current.id,'paced08_scope_invalid')
 check(q.deploymentReady===true&&q.requiresCalibration===false,'paced08_candidate_not_ready')
 check(['draft','published'].includes(current.status)&&Number.isSafeInteger(current.revision)&&current.revision>0,'paced08_current_status_invalid')
 for(const key of ['title','content','answerTemplate','category','role','scenarioId','moduleCode','number','difficulty']as const)check(q[key]===current[key],'paced08_metadata_changed')
 const definition=normalizeDefinition(q.definition),before=normalizeDefinition(current.definition),e=definition.evaluation,params:any=e.parameters
 check(e.version==='v3-261012-api-rpc-paced08-v12'&&!e.calibrationMode&&!params?.calibrationMode&&!params?.calibrationReferenceBinding&&!params?.responseSnapshotPolicy&&!params?.responseSnapshotScope,'paced08_policy_invalid')
 check(definition.llm.enabled&&before.llm.enabled&&definition.llm.poolId===pool.poolId&&before.llm.poolId===oldPool.poolId&&pool.poolId!==oldPool.poolId&&oldPool.kind==='llm'&&pool.kind==='llm'&&pool.model==='Qwen/Qwen3-8B','paced08_model_changed')
 for(const key of ['model','modelVersion','baseUrl','credentialEnv']as const)check(canonical(pool[key])===canonical(oldPool[key]),'paced08_model_changed')
 const oldParams={...oldPool.parameters},newParams={...pool.parameters};check((oldParams.requestTimeoutMs??60000)===60000&&newParams.requestTimeoutMs===180000,'paced08_transport_invalid');delete oldParams.requestTimeoutMs;delete newParams.requestTimeoutMs
 check(canonical(oldParams)===canonical(newParams),'paced08_inference_parameters_changed')
 check(canonical(stableContract(definition))===canonical(stableContract(before)),'paced08_unapproved_contract_change')
 check(/^[a-f0-9]{64}$/.test(pkg.digest)&&/^[A-Za-z0-9_-]{1,80}$/.test(pkg.id),'paced08_package_invalid')
 definition.evaluation.packageId=pkg.id;definition.evaluation.packageDigest=pkg.digest
 const body={id:q.id,definition,packageId:pkg.id,packageDigest:pkg.digest,configurationKey:selfTestConfigurationKey(definition,q.role!,q.category,pool),role:q.role!,category:q.category,beforeQuestionDigest:questionUpdateDigest(current),reference:q.selfTest,beforeRevision:current.revision,beforeStatus:current.status,retainedQuestionFields:Object.fromEntries(Object.entries(current).filter(([key])=>!['definition','status','revision','updatedAt','evaluationVersion'].includes(key)))}
 return {...body,digest:hash(body)}
}
export function checkPaced08Proof(plan:UpgradePlan,phase:'baseline'|'opponent',r:any){
 check(ids.includes(plan.id)&&plan.definition.evaluation.version==='v3-261012-api-rpc-paced08-v12','paced08_scope_invalid')
 check(r&&/^[0-9a-f-]{36}$/.test(r.id)&&r.packageId===plan.packageId&&r.packageDigest===plan.packageDigest&&r.configurationKey===plan.configurationKey&&r.phase===phase,'paced08_proof_identity_mismatch')
 check(r.status==='completed'&&r.result?.status==='completed'&&r.result.cleanupStatus==='cleaned','paced08_proof_failed_or_uncleaned')
 check(Number.isSafeInteger(r.calls)&&r.calls>0&&(r.responseSnapshotHits===undefined||r.responseSnapshotHits===0)&&(r.upstreamCalls===undefined||r.upstreamCalls===r.calls),'paced08_real_upstream_calls_required')
 const e=plan.definition.evaluation,metric=r.result.metrics?.[phase==='baseline'?e.baselineMetric:e.successMetric];check(typeof metric==='number'&&Number.isFinite(metric),'paced08_metric_invalid')
 if(phase==='baseline')check(metric>=e.baselineThreshold,'paced08_baseline_rejected')
 return {id:r.id,phase,configurationKey:r.configurationKey,metric,calls:r.calls,status:'completed',cleanupStatus:'cleaned',responseSnapshots:false}
}
export async function runPaced08Proofs(plans:UpgradePlan[],state:any,request:(route:string,method?:string,body?:any)=>Promise<any>,save:()=>void,material:(plan:UpgradePlan,phase:'baseline'|'opponent')=>any,pollMs=10000){
 check(plans.length>0&&plans.every(plan=>ids.includes(plan.id)),'paced08_scope_invalid')
 return runBoundFinalProofs(plans,state,request,save,material,checkPaced08Proof,pollMs)
}

type Request=(route:string,method?:string,body?:any)=>Promise<any>
const retained=(q:any)=>Object.fromEntries(Object.entries(q).filter(([key])=>!['definition','status','revision','updatedAt','evaluationVersion'].includes(key)))
export async function publishVerifiedPaced08(plans:UpgradePlan[],state:any,request:Request,save:()=>void,acceptance:any){
 check(canonical(plans.map(p=>p.id).sort())===canonical([...ids].sort())&&plans.every(p=>p.definition.evaluation.version==='v3-261012-api-rpc-paced08-v12'),'paced08_publication_scope_invalid')
 check(acceptance?.status==='passed'&&acceptance.kind==='real-student-submit'&&acceptance.api==='http://127.0.0.1:14006/api'&&acceptance.contractsDigest===upgradeContractsDigest(plans)&&Array.isArray(acceptance.questionIds)&&canonical([...acceptance.questionIds].sort())===canonical([...ids].sort())&&['baselineAccepted','emptyArena100','normalLossZero','adminPerQuestion'].every(k=>acceptance.checks?.[k]===true),'paced08_real_student_acceptance_missing')
 for(const plan of plans)for(const phase of ['baseline','opponent']as const){const proof=state.tests[plan.id]?.[phase];check(proof?.id&&proof.configurationKey===plan.configurationKey,'paced08_final_proof_missing');checkPaced08Proof(plan,phase,await request(`/admin/evaluation-packages/${plan.packageId}/self-tests/${proof.id}`))}
 state.publications??={}
 const route=(id:string)=>'/admin/questions/'+encodeURIComponent(id)
 const matches=(p:UpgradePlan,q:any)=>q?.id===p.id&&q.status==='published'&&canonical(normalizeDefinition(q.definition))===canonical(p.definition)&&canonical(retained(q))===canonical(p.retainedQuestionFields)&&(p.beforeStatus==='published'?q.revision===p.beforeRevision+1:[p.beforeRevision,p.beforeRevision+1].includes(q.revision))
 for(const p of plans){const current=await request(route(p.id)),publication=state.publications[p.id];if(publication?.intent){check(matches(p,current),'paced08_publication_outcome_unknown_requires_reconciliation');publication.completed=true;publication.revision=current.revision;save()}else check(questionUpdateDigest(current)===p.beforeQuestionDigest,'paced08_question_changed_since_final_proofs')}
 for(const p of plans){if(state.publications[p.id]?.completed)continue;check(questionUpdateDigest(await request(route(p.id)))===p.beforeQuestionDigest,'paced08_question_changed_before_publication');state.publications[p.id]={intent:true,targetDefinitionDigest:hash(p.definition)};save();const updated=await request(route(p.id),'PUT',{definition:p.definition,status:'published',expectedQuestionDigest:p.beforeQuestionDigest});check(matches(p,updated),'paced08_published_contract_mismatch');const actual=await request(route(p.id));check(matches(p,actual),'paced08_published_get_mismatch');state.publications[p.id].completed=true;state.publications[p.id].revision=actual.revision;save()}
 return {status:'passed',published:2,contractsDigest:upgradeContractsDigest(plans)}
}

function realCalls(r:any){check(Number.isSafeInteger(r.calls)&&r.calls>0&&(r.responseSnapshotHits===undefined||r.responseSnapshotHits===0)&&(r.upstreamCalls===undefined||r.upstreamCalls===r.calls),'paced08_real_upstream_calls_required')}
export function verifyPaced08MeasuredContract(q:CoursePackQuestion,raw:CoursePackQuestion,pkg:{id:string;digest:string},pool:PoolBinding,cal:any,metadata:any,files:Array<{path:string;sha256:string}>){
 check(ids.includes(q.id)&&q.id===raw.id&&raw.definition.evaluation.version==='v3-261012-api-rpc-paced08-v12'&&!(raw.definition.evaluation.parameters as any)?.responseSnapshotPolicy,'paced08_scope_invalid')
 return verifyMeasuredCourseContract(q,raw,pkg,pool,cal,metadata,realCalls,files)
}
const byteHash=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex')
async function main(){
 const {values:v}=parseArgs({options:{manifest:{type:'string'},'calibration-state':{type:'string'},'prior-calibration-state':{type:'string'},state:{type:'string'},api:{type:'string'},'token-file':{type:'string'},stage:{type:'string',default:'plan'},'acceptance-report':{type:'string'},'backup-report':{type:'string'}}})
 for(const key of ['manifest','calibration-state','prior-calibration-state','state','api','token-file']as const)check(v[key],'paced08_required_argument_missing')
 check(['plan','self-test','verify','publish'].includes(v.stage!),'paced08_stage_invalid')
 const input=loadCoursePack(path.resolve(v.manifest!)),rawInput=loadCoursePack(path.join(input.root,'manifest.json')),calBytes=fs.readFileSync(v['calibration-state']!),priorBytes=fs.readFileSync(v['prior-calibration-state']!),cal=JSON.parse(calBytes.toString('utf8')),prior=JSON.parse(priorBytes.toString('utf8')),evidenceBytes=fs.readFileSync(path.join(input.root,'build-evidence.json')),evidence=JSON.parse(evidenceBytes.toString('utf8'))
 check(input.manifest.deploymentReady===true&&!input.manifest.requiresCalibration&&cal.api===v.api&&prior.api===v.api,'paced08_inputs_not_ready')
 check(cal.manifestDigest===rawInput.manifestDigest&&cal.evidenceDigest===byteHash(evidenceBytes)&&cal.refreshFrom?.stateDigest===byteHash(priorBytes)&&canonical(input.manifest.packages)===canonical(rawInput.manifest.packages),'paced08_calibration_source_changed')
 const url=new URL(v.api!);check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&!url.search&&/\/api\/?$/.test(url.pathname),'paced08_api_invalid')
 const token=fs.readFileSync(v['token-file']!,'utf8').trim();check(token.length>=16&&!/\s/.test(token),'paced08_token_invalid')
 const request=async(route:string,method='GET',body?:any)=>{let r:Response;try{r=await fetch(v.api!.replace(/\/$/,'')+route,{method,redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)})}catch{throw Error('paced08_http_outcome_unknown')}check(r.ok,'paced08_http_rejected');const data=await r.json();check(data.code===0,'paced08_api_rejected');return data.data}
 const pools=await request('/admin/api-pool'),questions=await request('/admin/questions');check(Array.isArray(pools)&&Array.isArray(questions),'paced08_inventory_invalid')
 // Freeze this checkpoint only after the separately approved four-question upgrade.
 for(const suffix of ['A02','D02','A09','D09']){const q=questions.find((q:any)=>q.id==='V3-261012-'+suffix);check(q?.status==='published'&&q.definition?.evaluation?.version==='v3-261012-response-snapshot4-v11','paced08_prior_four_upgrade_pending')}
 const statePath=path.resolve(v.state!);check(![v.manifest,v['calibration-state'],v['prior-calibration-state'],v['token-file'],v['acceptance-report'],v['backup-report']].filter(Boolean).some(p=>path.resolve(p!)===statePath),'paced08_state_path_conflict')
 const initial=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):undefined,original=initial?.originalQuestions??questions.filter((q:any)=>ids.includes(q.id));check(Array.isArray(original)&&canonical(original.map((q:any)=>q.id).sort())===canonical([...ids].sort()),'paced08_original_inventory_invalid')
 const freeze=(saved:any)=>{const p=pools.find((p:any)=>p.id===saved?.id&&p.enabled&&p.revision===saved.revision);check(p,'paced08_pool_missing');const selected={id:p.id,revision:p.revision,model:p.model,modelVersion:p.modelVersion,baseUrl:p.baseUrl,credentialEnv:p.credentialEnv,parameters:p.parameters};check(byteHash(Buffer.from(JSON.stringify(selected)))===saved.fingerprint,'paced08_pool_changed');return {poolId:p.id,revision:p.revision,name:p.name,kind:p.kind,model:p.model,modelVersion:p.modelVersion,baseUrl:p.baseUrl,credentialEnv:p.credentialEnv,parameters:p.parameters}as PoolBinding}
 const plans:UpgradePlan[]=[]
 for(const id of ids){const q=input.manifest.questions.find(q=>q.id===id)!,raw=rawInput.manifest.questions.find(q=>q.id===id)!,pkg=cal.packages?.[q.packageKey];check(pkg,'paced08_package_missing');const pool=freeze(cal.pools?.[id]),oldPool=freeze(prior.pools?.[id]),sourcePackage=rawInput.manifest.packages.find(p=>p.key===q.packageKey)!;const archive=packageArchive(rawInput.root,sourcePackage)
  check(/@sha256:[a-f0-9]{64}$/.test(evidence.image)&&JSON.parse(fs.readFileSync(path.resolve(rawInput.root,sourcePackage.directory,'manifest.json'),'utf8')).image===evidence.image,'paced08_source_image_changed')
  await verifyUpgradePackage(pkg,request,{digest:archive.digest,inputDigest:byteHash(Buffer.from(JSON.stringify(sourcePackage.files))),image:evidence.image})
  const records=verifyPaced08MeasuredContract(q,raw,pkg,pool,cal,evidence.questions?.find((m:any)=>m.sourceId===id.replace('V3-261012-','')),sourcePackage.files)
  for(const record of records){const actual=await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${record.id}`);check(actual.id===record.id&&actual.phase===record.phase&&actual.packageId===pkg.id&&actual.packageDigest===pkg.digest&&actual.configurationKey===record.configurationKey&&actual.status==='completed'&&actual.result?.status==='completed'&&actual.result.cleanupStatus==='cleaned'&&canonical(actual.result.metrics)===canonical(record.result.metrics)&&actual.calls===record.calls,'paced08_actual_calibration_proof_changed');realCalls(actual)}
  plans.push(buildPaced08Plan(q,original.find((row:any)=>row.id===id),pkg,oldPool,pool))
 }
 const identity={manifestDigest:input.manifestDigest,calibrationStateDigest:byteHash(calBytes),priorCalibrationStateDigest:byteHash(priorBytes),api:v.api,plansDigest:hash(plans)}
 if(v.stage==='plan'){console.log(JSON.stringify({status:'planned',...identity,questions:2,modelCalls:0,questionWrites:0}));return}
 fs.mkdirSync(path.dirname(statePath),{recursive:true});const lock=fs.openSync(statePath+'.lock','wx',0o600)
 try{
  const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{...identity,originalQuestions:original,inventoryDigestVersion:1,otherQuestionsDigest:questionInventoryDigest(questions.filter((q:any)=>!ids.includes(q.id))),tests:{}}
  for(const[key,value]of Object.entries(identity))check(state[key]===value,'paced08_state_inputs_changed')
  check(state.inventoryDigestVersion===1&&state.otherQuestionsDigest===questionInventoryDigest(questions.filter((q:any)=>!ids.includes(q.id))),'paced08_other_questions_changed')
  const save=()=>{const tmp=statePath+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,statePath)}
  const material=(plan:UpgradePlan,phase:'baseline'|'opponent')=>{const read=(m:CoursePackQuestion['selfTest'])=>{const bytes=fs.readFileSync(path.resolve(input.root,m.codePath));check(byteHash(bytes)===m.codeSha256,'paced08_reference_changed');return {code:bytes.toString('utf8'),...(m.weightFixture?{weightFixture:m.weightFixture}:{})}};return {...read(plan.reference),...(phase==='opponent'?{opponent:read(plan.reference.opponent!)}:{})}}
  if(v.stage==='self-test')await runPaced08Proofs(plans,state,request,save,material)
  else if(v.stage==='verify')for(const plan of plans)for(const phase of ['baseline','opponent']as const){const proof=state.tests[plan.id]?.[phase];check(proof?.id&&proof.configurationKey===plan.configurationKey,'paced08_final_proof_missing');checkPaced08Proof(plan,phase,await request(`/admin/evaluation-packages/${plan.packageId}/self-tests/${proof.id}`))}
  if(v.stage==='publish'){
   check(v['acceptance-report']&&v['backup-report']&&initial,'paced08_publication_evidence_required')
   const acceptance=JSON.parse(fs.readFileSync(v['acceptance-report'],'utf8')),backup=JSON.parse(fs.readFileSync(v['backup-report'],'utf8'))
   check(backup.status==='ready'&&backup.api===v.api&&backup.manifestDigest===identity.manifestDigest&&backup.plansDigest===identity.plansDigest&&backup.otherQuestionsDigest===state.otherQuestionsDigest,'paced08_publication_backup_mismatch')
   check(typeof backup.databaseDumpFile==='string'&&path.isAbsolute(backup.databaseDumpFile)&&/^[a-f0-9]{64}$/.test(backup.databaseDumpSha256),'paced08_backup_file_invalid')
   const stat=fs.lstatSync(backup.databaseDumpFile);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&(process.platform==='win32'||(stat.mode&0o077)===0),'paced08_backup_file_not_private')
   check(byteHash(fs.readFileSync(backup.databaseDumpFile))===backup.databaseDumpSha256,'paced08_database_backup_changed')
   await publishVerifiedPaced08(plans,state,request,save,acceptance)
  }
  const after=await request('/admin/questions');check(questionInventoryDigest(after.filter((q:any)=>!ids.includes(q.id)))===state.otherQuestionsDigest,'paced08_other_questions_changed')
  if(v.stage!=='publish')check(questionInventoryDigest(after)===questionInventoryDigest(questions),'paced08_question_inventory_changed')
  check(loadCoursePack(path.resolve(v.manifest!)).manifestDigest===input.manifestDigest&&byteHash(fs.readFileSync(v['calibration-state']!))===identity.calibrationStateDigest&&byteHash(fs.readFileSync(v['prior-calibration-state']!))===identity.priorCalibrationStateDigest,'paced08_source_changed_during_proofs')
  console.log(JSON.stringify({status:'passed',stage:v.stage,...identity,contractsDigest:upgradeContractsDigest(plans),independentFinalProofs:4,questionWrites:v.stage==='publish'?2:0,responseSnapshotsOn08:false}))
 }finally{fs.closeSync(lock);fs.unlinkSync(statePath+'.lock')}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'paced08_failed_private_details_omitted');process.exitCode=1})
