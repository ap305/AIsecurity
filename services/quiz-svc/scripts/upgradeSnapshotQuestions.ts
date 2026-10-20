/** Plan, independently self-test, verify or publish the four approved upgrades.
 * Publication requires matching real-student acceptance and a verified private
 * database backup. Never edits another question or forges importer ownership.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import {normalizeDefinition, type PoolBinding, type QuestionDefinition} from '../src/lib/prdContract.js'
import {questionUpdateDigest} from '../src/lib/questionUpdatePrecondition.js'
import {selfTestConfigurationKey} from '../src/lib/selfTestContract.js'
import {snapshotCallEvidence} from '../src/services/modelResponseSnapshot.js'
import {packageArchive} from './calibrateCoursePackV3.js'
import {verifyMeasuredCourseContract} from './measuredCourseUpgrade.js'
import {runBoundFinalProofs} from './courseFinalProofs.js'
import {loadCoursePack, type CoursePackQuestion} from './importCoursePackV3.js'
const ids = ['V3-261012-A02','V3-261012-D02','V3-261012-A09','V3-261012-D09']
type Phase='baseline'|'opponent'
function canonical(v:any):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v)}
const digest=(v:any)=>crypto.createHash('sha256').update(canonical(v)).digest('hex')
function check(v:any, reason:string):asserts v {if(!v)throw Error(reason)}
/** Admin ordering has ties. Identity is by ID, never database row position. */
export function questionInventoryDigest(rows:any[]):string {
 check(Array.isArray(rows)&&rows.every(q=>typeof q?.id==='string')&&new Set(rows.map(q=>q.id)).size===rows.length,'upgrade_inventory_invalid')
 return digest([...rows].sort((a,b)=>a.id.localeCompare(b.id)))
}
export function bindOtherQuestionInventory(state:any,rows:any[]):boolean {
 if(state.inventoryDigestVersion===undefined){
  check(state.otherQuestionsDigest===digest(rows),'upgrade_other_questions_changed')
  state.otherQuestionsDigest=questionInventoryDigest(rows);state.inventoryDigestVersion=1;return true
 }
 check(state.inventoryDigestVersion===1,'upgrade_inventory_digest_version_invalid')
 check(state.otherQuestionsDigest===questionInventoryDigest(rows),'upgrade_other_questions_changed');return false
}
export interface UpgradePlan {id:string; definition:QuestionDefinition; packageId:string; packageDigest:string; configurationKey:string; role:string; category:string; beforeQuestionDigest:string; reference:CoursePackQuestion['selfTest']; beforeRevision:number; beforeStatus:string; retainedQuestionFields:Record<string,unknown>; digest:string}
function retainedQuestion(row:any){return Object.fromEntries(Object.entries(row).filter(([key])=>!['definition','status','revision','updatedAt','evaluationVersion'].includes(key)))}
function stableContract(d:QuestionDefinition) {
 const value=structuredClone(d);const e:any=value.evaluation
 for(const k of ['version','baselineThreshold','successThreshold','packageId','packageDigest'])delete e[k]
 if(e.parameters)for(const k of ['successThreshold','responseSnapshotPolicy','responseSnapshotScope'])delete e.parameters[k]
 if(e.parameters&&Object.keys(e.parameters).length===0)delete e.parameters
 return value
}
export function buildUpgradePlan(q:CoursePackQuestion,current:any,pkg:{id:string;digest:string},pool:PoolBinding):UpgradePlan {
 check(ids.includes(q.id)&&q.id===current.id,'upgrade_scope_invalid')
 check(q.deploymentReady===true&&q.requiresCalibration===false,'upgrade_candidate_not_ready')
 check(['draft','published'].includes(current.status)&&Number.isSafeInteger(current.revision)&&current.revision>0,'upgrade_current_status_invalid')
 for(const k of ['title','content','answerTemplate','category','role','scenarioId','moduleCode','number','difficulty']as const)check(q[k]===current[k],'upgrade_question_metadata_changed')
 const definition=normalizeDefinition(q.definition), before=normalizeDefinition(current.definition)
 const e=definition.evaluation, params:any=e.parameters
 check(e.version==='v3-261012-response-snapshot4-v11'&&params?.responseSnapshotPolicy==='first-valid-response-v1'&&params.responseSnapshotScope===q.id,'upgrade_policy_invalid')
 check(!e.calibrationMode&&!params.calibrationMode&&!params.calibrationReferenceBinding,'upgrade_calibration_mode_forbidden')
 check(definition.llm.enabled&&before.llm.enabled&&definition.llm.poolId===pool.poolId&&before.llm.poolId===pool.poolId&&pool.kind==='llm'&&pool.model==='Qwen/Qwen3-8B','upgrade_model_changed')
 check(canonical(stableContract(definition))===canonical(stableContract(before)),'upgrade_unapproved_contract_change')
 check(/^[a-f0-9]{64}$/.test(pkg.digest)&&/^[A-Za-z0-9_-]{1,80}$/.test(pkg.id),'upgrade_package_invalid')
 definition.evaluation.packageId=pkg.id;definition.evaluation.packageDigest=pkg.digest
 const body={id:q.id,definition,packageId:pkg.id,packageDigest:pkg.digest,configurationKey:selfTestConfigurationKey(definition,q.role!,q.category,pool),role:q.role!,category:q.category,beforeQuestionDigest:questionUpdateDigest(current),reference:q.selfTest,beforeRevision:current.revision,beforeStatus:current.status,retainedQuestionFields:retainedQuestion(current)}
 return {...body,digest:digest(body)}
}
export function checkUpgradeProof(plan:UpgradePlan,phase:Phase,r:any) {
 check(r&&/^[0-9a-f-]{36}$/.test(r.id)&&r.packageId===plan.packageId&&r.packageDigest===plan.packageDigest&&r.configurationKey===plan.configurationKey&&r.phase===phase,'upgrade_proof_identity_mismatch')
 check(r.status==='completed'&&r.result?.status==='completed'&&r.result.cleanupStatus==='cleaned','upgrade_proof_failed_or_uncleaned')
 snapshotCallEvidence(r)
 const e=plan.definition.evaluation, metric=r.result.metrics?.[phase==='baseline'?e.baselineMetric:e.successMetric]
 check(typeof metric==='number'&&Number.isFinite(metric),'upgrade_proof_metric_invalid')
 if(phase==='baseline')check(metric>=e.baselineThreshold,'upgrade_baseline_rejected')
 return {id:r.id,phase,configurationKey:r.configurationKey,metric,...snapshotCallEvidence(r),calls:r.calls,status:'completed',cleanupStatus:'cleaned'}
}
type Request=(route:string,method?:string,body?:any)=>Promise<any>
export async function runUpgradeProofs(plans:UpgradePlan[],state:any,request:Request,save:()=>void,material:(plan:UpgradePlan,phase:Phase)=>any,pollMs=10000) {
 return runBoundFinalProofs(plans,state,request,save,material,checkUpgradeProof,pollMs)
}
async function main() {
 const {values:v}=parseArgs({options:{manifest:{type:'string'},'calibration-state':{type:'string'},state:{type:'string'},api:{type:'string'},'token-file':{type:'string'},stage:{type:'string',default:'plan'},'acceptance-report':{type:'string'},'backup-report':{type:'string'}}})
 for(const k of ['manifest','calibration-state','state','api','token-file']as const)check(v[k],'upgrade_required_argument_missing')
 check(['plan','self-test','verify','publish'].includes(v.stage!),'upgrade_stage_invalid')
 const input=loadCoursePack(path.resolve(v.manifest!)), calBytes=fs.readFileSync(v['calibration-state']!), cal=JSON.parse(calBytes.toString('utf8'))
 check(input.manifest.deploymentReady===true&&!input.manifest.requiresCalibration&&cal.api===v.api,'upgrade_inputs_not_ready')
 const rawInput=loadCoursePack(path.join(input.root,'manifest.json')),evidenceBytes=fs.readFileSync(path.join(input.root,'build-evidence.json')),evidence=JSON.parse(evidenceBytes.toString('utf8'))
 check(cal.manifestDigest===rawInput.manifestDigest&&cal.evidenceDigest===crypto.createHash('sha256').update(evidenceBytes).digest('hex')&&canonical(rawInput.manifest.packages)===canonical(input.manifest.packages),'upgrade_calibration_source_changed')
 const url=new URL(v.api!);check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&!url.search&&/\/api\/?$/.test(url.pathname),'upgrade_api_invalid')
 const token=fs.readFileSync(v['token-file']!,'utf8').trim();check(token.length>=16&&!/\s/.test(token),'upgrade_token_invalid')
 const request:Request=async(route,method='GET',body)=>{
  let r:Response
  try{r=await fetch(v.api!.replace(/\/$/,'')+route,{method,headers:{Authorization:'Bearer '+token,Connection:'close',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)})}catch{throw Error('upgrade_http_outcome_unknown')}
  check(r.ok,'upgrade_http_rejected');const data=await r.json();check(data.code===0,'upgrade_api_rejected');return data.data
 }
 const pools=await request('/admin/api-pool'), questions=await request('/admin/questions');check(Array.isArray(pools)&&Array.isArray(questions),'upgrade_inventory_invalid')
 const statePath=path.resolve(v.state!);check(![v.manifest,v['calibration-state'],v['token-file'],v['acceptance-report'],v['backup-report']].filter(Boolean).some(f=>path.resolve(f!)===statePath),'upgrade_state_path_conflict')
 const initialState=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):undefined
 const originalQuestions=initialState?.originalQuestions??questions.filter((q:any)=>ids.includes(q.id))
 check(Array.isArray(originalQuestions)&&canonical(originalQuestions.map((q:any)=>q.id).sort())===canonical([...ids].sort()),'upgrade_original_inventory_invalid')
 const plans:UpgradePlan[]=[]
 for(const id of ids) {
  const q=input.manifest.questions.find(q=>q.id===id)!,current=originalQuestions.find((q:any)=>q.id===id),pkg=cal.packages?.[q.packageKey],saved=cal.pools?.[id]
  check(current&&pkg&&saved,'upgrade_original_missing');const pool=pools.find((p:any)=>p.id===saved.id&&p.enabled&&p.revision===saved.revision)
  check(pool,'upgrade_pool_missing');const binding={poolId:pool.id,revision:pool.revision,name:pool.name,kind:pool.kind,model:pool.model,modelVersion:pool.modelVersion,baseUrl:pool.baseUrl,credentialEnv:pool.credentialEnv,parameters:pool.parameters}
  const selected={id:pool.id,revision:pool.revision,model:pool.model,modelVersion:pool.modelVersion,baseUrl:pool.baseUrl,credentialEnv:pool.credentialEnv,parameters:pool.parameters}
  check(crypto.createHash('sha256').update(JSON.stringify(selected)).digest('hex')===saved.fingerprint,'upgrade_pool_changed')
  const raw=rawInput.manifest.questions.find(q=>q.id===id)!,metadata=evidence.questions?.find((r:any)=>r.sourceId===id.replace('V3-261012-',''))
  const calibrationRecords=verifyMeasuredUpgrade(q,raw,pkg,binding,cal,metadata,rawInput.manifest.packages.find(p=>p.key===q.packageKey)!.files)
  for(const record of calibrationRecords){
   const actual=await request(`/admin/evaluation-packages/${pkg.id}/self-tests/${record.id}`)
   check(actual.id===record.id&&actual.phase===record.phase&&actual.packageDigest===pkg.digest&&actual.configurationKey===record.configurationKey&&actual.status==='completed'&&actual.result?.status==='completed'&&actual.result.cleanupStatus==='cleaned'&&canonical(actual.result.metrics)===canonical(record.result.metrics),'upgrade_actual_calibration_proof_changed')
   check(canonical(snapshotCallEvidence(actual))===canonical(snapshotCallEvidence(record))&&actual.calls===record.calls,'upgrade_actual_calibration_counts_changed')
  }
  const sourcePackage=rawInput.manifest.packages.find(p=>p.key===q.packageKey)!
  const originalPackage=packageArchive(rawInput.root,sourcePackage)
  check(/@sha256:[a-f0-9]{64}$/.test(evidence.image)&&JSON.parse(fs.readFileSync(path.resolve(rawInput.root,sourcePackage.directory,'manifest.json'),'utf8')).image===evidence.image,'upgrade_source_image_changed')
  await verifyUpgradePackage(pkg,request,{digest:originalPackage.digest,inputDigest:crypto.createHash('sha256').update(JSON.stringify(sourcePackage.files)).digest('hex'),image:evidence.image})
  plans.push(buildUpgradePlan(q,current,pkg,binding))
 }
 const identity={manifestDigest:input.manifestDigest,calibrationStateDigest:crypto.createHash('sha256').update(calBytes).digest('hex'),api:v.api,plansDigest:digest(plans)}
 if(v.stage==='plan'){console.log(JSON.stringify({status:'planned',questions:plans.map(p=>({id:p.id,configurationKey:p.configurationKey})),...identity,contractsDigest:upgradeContractsDigest(plans),questionWrites:0,modelCalls:0}));return}
 fs.mkdirSync(path.dirname(statePath),{recursive:true});const lock=fs.openSync(statePath+'.lock','wx',0o600)
 try {
  const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{...identity,originalQuestions,inventoryDigestVersion:1,otherQuestionsDigest:questionInventoryDigest(questions.filter((q:any)=>!ids.includes(q.id))),tests:{}}
  for(const[k,value]of Object.entries(identity))check(state[k]===value,'upgrade_state_inputs_changed')
  const migratedInventory=bindOtherQuestionInventory(state,questions.filter((q:any)=>!ids.includes(q.id)))
  const save=()=>{fs.writeFileSync(statePath+'.tmp',JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(statePath+'.tmp',statePath)}
  if(migratedInventory)save()
  const material=(plan:UpgradePlan,phase:Phase)=>{
   const read=(m:CoursePackQuestion['selfTest'])=>{const bytes=fs.readFileSync(path.resolve(input.root,m.codePath));check(crypto.createHash('sha256').update(bytes).digest('hex')===m.codeSha256,'upgrade_reference_changed');return {code:bytes.toString('utf8'),...(m.weightFixture?{weightFixture:m.weightFixture}:{})}}
   return {...read(plan.reference),...(phase==='opponent'?{opponent:read(plan.reference.opponent!)}:{})}
  }
  if(v.stage==='self-test')await runUpgradeProofs(plans,state,request,save,material)
  else if(v.stage==='verify')for(const plan of plans)for(const phase of ['baseline','opponent']as const){const proof=state.tests[plan.id]?.[phase];check(proof?.id,'upgrade_proof_missing');checkUpgradeProof(plan,phase,await request(`/admin/evaluation-packages/${plan.packageId}/self-tests/${proof.id}`))}
  if(v.stage==='publish') {
   check(v['acceptance-report']&&v['backup-report']&&initialState,'upgrade_publication_evidence_required')
   const acceptance=JSON.parse(fs.readFileSync(v['acceptance-report'],'utf8')),backup=JSON.parse(fs.readFileSync(v['backup-report'],'utf8'))
   check(backup.status==='ready'&&backup.api===v.api&&backup.manifestDigest===identity.manifestDigest&&backup.plansDigest===identity.plansDigest&&backup.otherQuestionsDigest===state.otherQuestionsDigest,'upgrade_publication_backup_mismatch')
   check(typeof backup.databaseDumpFile==='string'&&path.isAbsolute(backup.databaseDumpFile)&&/^[a-f0-9]{64}$/.test(backup.databaseDumpSha256),'upgrade_backup_file_invalid')
   const stat=fs.lstatSync(backup.databaseDumpFile);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&(process.platform==='win32'||(stat.mode&0o077)===0),'upgrade_backup_file_not_private')
   check(crypto.createHash('sha256').update(fs.readFileSync(backup.databaseDumpFile)).digest('hex')===backup.databaseDumpSha256,'upgrade_database_backup_changed')
   await publishVerifiedUpgrades(plans,state,request,save,acceptance)
  }
  const after=await request('/admin/questions');check(questionInventoryDigest(after.filter((q:any)=>!ids.includes(q.id)))===state.otherQuestionsDigest,'upgrade_other_questions_changed')
  if(v.stage!=='publish')check(questionInventoryDigest(after)===questionInventoryDigest(questions),'upgrade_question_inventory_changed')
  check(loadCoursePack(path.resolve(v.manifest!)).manifestDigest===input.manifestDigest,'upgrade_manifest_changed')
  console.log(JSON.stringify({status:'passed',stage:v.stage,...identity,questions:4,independentFinalProofs:8,questionWriteScope:v.stage==='publish'?ids:[],otherQuestionsUnchanged:true}))
 }finally{fs.closeSync(lock);fs.unlinkSync(statePath+'.lock')}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'upgrade_failed_private_details_omitted');process.exitCode=1})

export function upgradeContractsDigest(plans:UpgradePlan[]):string {
 return digest(plans.map(({id,definition,packageDigest,configurationKey,role,category,reference})=>({id,definition,packageDigest,configurationKey,role,category,reference})).sort((a,b)=>a.id.localeCompare(b.id)))
}
export async function publishVerifiedUpgrades(plans:UpgradePlan[],state:any,request:Request,save:()=>void,acceptance:any) {
 check(canonical(plans.map(p=>p.id).sort())===canonical([...ids].sort()),'upgrade_publication_scope_invalid')
 check(acceptance?.status==='passed'&&acceptance.kind==='real-student-submit'&&acceptance.api==='http://127.0.0.1:14006/api'&&
  acceptance.contractsDigest===upgradeContractsDigest(plans)&&Array.isArray(acceptance.questionIds)&&canonical([...acceptance.questionIds].sort())===canonical([...ids].sort())&&
  ['baselineAccepted','emptyArena100','normalLossZero','adminPerQuestion'].every(k=>acceptance.checks?.[k]===true),'upgrade_real_student_acceptance_missing')
 // Check every final proof before writing even the first Question. No use of
 // calibration-mode records or the original importer's ownership state.
 for(const plan of plans)for(const phase of ['baseline','opponent']as const) {
  const proof=state.tests[plan.id]?.[phase];check(proof?.id&&proof.configurationKey===plan.configurationKey,'upgrade_final_proof_missing')
  checkUpgradeProof(plan,phase,await request(`/admin/evaluation-packages/${plan.packageId}/self-tests/${proof.id}`))
 }
 state.publications??={}
 const route=(id:string)=>'/admin/questions/'+encodeURIComponent(id)
 const matches=(plan:UpgradePlan,q:any)=>q?.id===plan.id&&q.status==='published'&&
  canonical(normalizeDefinition(q.definition))===canonical(plan.definition)&&canonical(retainedQuestion(q))===canonical(plan.retainedQuestionFields)&&
  (plan.beforeStatus==='published'?q.revision===plan.beforeRevision+1:[plan.beforeRevision,plan.beforeRevision+1].includes(q.revision))
 // Reconcile uncertain outcomes with exact GET evidence. An unchanged row is
 // not authorization to replay an uncertain PUT, including after a restart.
 for(const plan of plans){
  const current=await request(route(plan.id)),publication=state.publications[plan.id]
  if(publication?.intent){check(matches(plan,current),'upgrade_publication_outcome_unknown_requires_reconciliation');publication.completed=true;publication.revision=current.revision;save()}
  else check(questionUpdateDigest(current)===plan.beforeQuestionDigest,'upgrade_question_changed_since_final_proofs')
 }
 for(const plan of plans){
  if(state.publications[plan.id]?.completed)continue
  check(questionUpdateDigest(await request(route(plan.id)))===plan.beforeQuestionDigest,'upgrade_question_changed_before_publication')
  state.publications[plan.id]={intent:true,targetDefinitionDigest:digest(plan.definition)};save()
  const updated=await request(route(plan.id),'PUT',{definition:plan.definition,status:'published',expectedQuestionDigest:plan.beforeQuestionDigest})
  check(matches(plan,updated),'upgrade_published_contract_mismatch')
  const actual=await request(route(plan.id));check(matches(plan,actual),'upgrade_published_get_mismatch')
  state.publications[plan.id].completed=true;state.publications[plan.id].revision=actual.revision;save()
 }
 return {status:'passed',published:plans.length,contractsDigest:upgradeContractsDigest(plans)}
}

export async function verifyUpgradePackage(pkg:{id:string;digest:string;inputDigest:string},request:Request,expected:{digest:string;inputDigest:string;image:string}) {
 check(pkg.digest===expected.digest&&pkg.inputDigest===expected.inputDigest,'upgrade_package_source_changed')
 const installed=await request(`/admin/evaluation-packages/${encodeURIComponent(pkg.id)}/validate`,'POST')
 check(installed?.id===pkg.id&&installed.digest===expected.digest&&installed.valid===true&&installed.manifest?.image===expected.image,'upgrade_package_changed')
 return installed
}

export function verifyMeasuredUpgrade(q:CoursePackQuestion,raw:CoursePackQuestion,pkg:{id:string;digest:string},pool:PoolBinding,cal:any,metadata:any,packageFiles:Array<{path:string;sha256:string}>=[]) {
 check(ids.includes(q.id)&&q.id===raw.id,'upgrade_calibration_scope_invalid')
 return verifyMeasuredCourseContract(q,raw,pkg,pool,cal,metadata,snapshotCallEvidence,packageFiles)
}
