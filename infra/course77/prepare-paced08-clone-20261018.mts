/** Isolated clone preparation, after all four genuine final proofs. */
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import {upgradeContractsDigest} from '/app/services/quiz-svc/scripts/upgradeSnapshotQuestions.ts'
import {buildPaced08Plan,checkPaced08Proof} from '/app/services/quiz-svc/scripts/finalizePaced08Questions.ts'
import {questionUpdateDigest} from '/app/services/quiz-svc/src/lib/questionUpdatePrecondition.ts'
const B='/opt/example-platform',T='/home/zl/ai-security-v3-prd-rehearsal-20261018',api='http://127.0.0.1:14006/api'
const ids=['V3-261012-A08','V3-261012-D08']
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'))
const hash=(b:any)=>crypto.createHash('sha256').update(b).digest('hex')
function canonical(v:any):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v)}
const jsonHash=(v:any)=>hash(canonical(v))
const token=fs.readFileSync(B+'/state/admin-calibration.token','utf8').trim()
async function req(base:string,route:string,method='GET',body?:any){const r=await fetch(base+route,{method,redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});assert(r.ok,'clone_http_rejected');const d=await r.json();assert.equal(d.code,0);return d.data}
function write(p:string,v:any){fs.writeFileSync(p+'.pending',JSON.stringify(v,null,2),{mode:0o600,flag:'wx'});fs.renameSync(p+'.pending',p)}
assert.equal(fs.readFileSync(B+'/logs/paced08-v12-final4-20261018.exit','utf8').trim(),'0')
assert.equal(read(T+'/state/reports/backend29-clone-smoke-20261018.json').status,'passed')
const file=B+'/state/production-paced08-v12-final-proofs.json';assert(!fs.existsSync(file+'.lock'))
const state=read(file),cal=read(B+'/state/production-calibration-state-paced08-v12.json'),m=read(B+'/build/full-build-production-paced08-v12-on-snapshot4/manifest-calibrated.json')
assert.equal(m.deploymentReady,true);assert.equal(m.questions.length,77)
const prior=read(B+'/state/production-calibration-state-snapshot4-v11.json')
const prodApi='http://127.0.0.1:14004/api',prodPools=await req(prodApi,'/admin/api-pool'),clonePools=await req(api,'/admin/api-pool'),before=await req(api,'/admin/questions')
const ledgerPath=T+'/state/reports/paced08-v12-clone-preparation-private-20261018.json'
const existingLedger=fs.existsSync(ledgerPath)?read(ledgerPath):undefined,cloneBefore=existingLedger?.beforeQuestions??before
const copiedPackages=new Map<string,string>()
const plans:any[]=[],clonePlans:any[]=[],proofs:any[]=[]
for(const id of ids){const q=m.questions.find((q:any)=>q.id===id),pkg=cal.packages[q.packageKey],p=prodPools.find((p:any)=>p.id===cal.pools[id].id),c=clonePools.find((c:any)=>c.id===p.id);assert(p.enabled&&c?.enabled);for(const key of ['id','revision','name','kind','model','modelVersion','baseUrl','credentialEnv','parameters'])assert.deepEqual(c[key],p[key])
 const binding={poolId:p.id,revision:p.revision,name:p.name,kind:p.kind,model:p.model,modelVersion:p.modelVersion,baseUrl:p.baseUrl,credentialEnv:p.credentialEnv,parameters:p.parameters}
 const old=prodPools.find((p:any)=>p.id===prior.pools[id].id);assert(old?.enabled&&old.revision===prior.pools[id].revision);const oldBinding={poolId:old.id,revision:old.revision,name:old.name,kind:old.kind,model:old.model,modelVersion:old.modelVersion,baseUrl:old.baseUrl,credentialEnv:old.credentialEnv,parameters:old.parameters}
 const plan=buildPaced08Plan(q,state.originalQuestions.find((q:any)=>q.id===id),pkg,oldBinding,binding);plans.push(plan)
 const current=cloneBefore.find((q:any)=>q.id===id);clonePlans.push(buildPaced08Plan(q,current,pkg,oldBinding,binding))
 const metadataSha=copyImmutablePackage(pkg,m.packages.find((p:any)=>p.key===q.packageKey).files);if(copiedPackages.has(pkg.id))assert.equal(copiedPackages.get(pkg.id),metadataSha);copiedPackages.set(pkg.id,metadataSha)
 const installed=await req(api,`/admin/evaluation-packages/${pkg.id}/validate`,'POST');assert.equal(installed.digest,pkg.digest);assert.equal(installed.valid,true)
 for(const phase of ['baseline','opponent']as const){const proof=state.tests[id][phase];assert(proof?.id);const actual=await req(prodApi,`/admin/evaluation-packages/${pkg.id}/self-tests/${proof.id}`);checkPaced08Proof(plan,phase,actual);proofs.push({plan,phase,proof:actual})}
}
assert.equal(jsonHash(plans),state.plansDigest);assert.equal(upgradeContractsDigest(plans),upgradeContractsDigest(clonePlans))
const ledger=existingLedger??{contractsDigest:upgradeContractsDigest(plans),beforeQuestions:before,publications:{},copiedProofs:[]}
assert.equal(ledger.contractsDigest,upgradeContractsDigest(plans))
const save=()=>write(ledgerPath,ledger)
function safePart(part:string){return Boolean(part&&!['.','..'].includes(part)&&!/[\\/\0:]/.test(part))}
function checkedDirectory(root:string,parts:string[],create:boolean){
 const absolute=path.resolve(root),filesystemRoot=path.parse(absolute).root;let directory=filesystemRoot
 let stat=fs.lstatSync(directory);assert(stat.isDirectory()&&!stat.isSymbolicLink())
 // Inspect the entire ancestor chain before creating even a child directory.
 for(const part of [...path.relative(filesystemRoot,absolute).split(path.sep).filter(Boolean),...parts]){assert(safePart(part));directory=path.join(directory,part);if(!fs.existsSync(directory)){assert(create);fs.mkdirSync(directory,{mode:0o700})}stat=fs.lstatSync(directory);assert(stat.isDirectory()&&!stat.isSymbolicLink())}return directory
}
function packageFile(file:string,root:string,create:boolean){const relative=path.relative(path.resolve(root),path.resolve(file)),parts=relative.split(path.sep);assert(relative&&!path.isAbsolute(relative)&&parts.every(safePart));const leaf=parts.pop()!;return path.join(checkedDirectory(root,parts,create),leaf)}
function sourceBytes(file:string){const source=packageFile(file,B+'/state/packages',false),stat=fs.lstatSync(source);assert(stat.isFile()&&!stat.isSymbolicLink());return fs.readFileSync(source)}
function copyExact(src:string,dest:string,expectedDigest?:string){const bytes=sourceBytes(src),digest=hash(bytes);if(expectedDigest)assert.equal(digest,expectedDigest);const target=packageFile(dest,T+'/state/packages',true);if(fs.existsSync(target)){const stat=fs.lstatSync(target);assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(hash(fs.readFileSync(target)),digest)}else fs.writeFileSync(target,bytes,{mode:0o600,flag:'wx'});assert.equal(fs.statSync(dest).mode&0o077,0);return digest}
function copyImmutablePackage(pkg:any,files:Array<{path:string;sha256:string}>){
 assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(pkg.id));assert.equal(hash(JSON.stringify(files)),pkg.inputDigest)
 const source=checkedDirectory(B+'/state/packages',[pkg.id],false),dest=checkedDirectory(T+'/state/packages',[pkg.id],true),metadataBytes=sourceBytes(source+'/_metadata.json'),metadata=JSON.parse(metadataBytes.toString('utf8'));assert.equal(metadata.id,pkg.id);assert.equal(metadata.digest,pkg.digest);assert.equal(hash(JSON.stringify(metadata.files)),pkg.digest);assert.equal(jsonHash(metadata.files),jsonHash(Object.fromEntries(files.map(f=>[f.path,f.sha256]))))
 for(const [name,digest]of Object.entries(metadata.files)){assert(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest));const parts=name.split('/'),leaf=parts.pop()!;assert(leaf&&!['.','..','_metadata.json'].includes(leaf)&&!/[\\\0:]/.test(leaf)&&parts[0]!=='_self-tests');const sourceParent=checkedDirectory(source,parts,false),destParent=checkedDirectory(dest,parts,true);assert.equal(copyExact(sourceParent+'/'+leaf,destParent+'/'+leaf,digest),digest)}
 // Preserve the genuine server-assigned ID and descriptor bytes. Copy only
 // immutable source files here; genuine final proofs are copied separately.
 return copyExact(source+'/_metadata.json',dest+'/_metadata.json',hash(metadataBytes))
}
const packageCopies=[...copiedPackages].map(([id,metadataSha256])=>({id,metadataSha256}));if(ledger.copiedImmutablePackages)assert.deepEqual(ledger.copiedImmutablePackages,packageCopies);ledger.copiedImmutablePackages=packageCopies;save()
for(const {plan,phase,proof}of proofs){const relative=`packages/${plan.packageId}/_self-tests/${proof.id}.json`,source=B+'/state/'+relative,dest=T+'/state/'+relative,bytes=sourceBytes(source),raw=JSON.parse(bytes.toString('utf8'));checkPaced08Proof(plan,phase,raw);assert.deepEqual(Object.fromEntries(Object.entries(raw).filter(([k])=>!['poolBinding','responseSnapshot'].includes(k))),proof);const sha=copyExact(source,dest,hash(bytes));ledger.copiedProofs.push({questionId:plan.id,phase,id:proof.id,sha256:sha,origin:'production genuine completed non-calibration self-test; copied unchanged, not rerun in clone'});save()}
assert.equal(proofs.length,4)
const retained=(q:any)=>Object.fromEntries(Object.entries(q).filter(([key])=>!['definition','status','revision','updatedAt','evaluationVersion'].includes(key)))
function verifyApplied(plan:any,current:any){assert.equal(current.status,'published');assert.deepEqual(current.definition,plan.definition);assert.deepEqual(retained(current),plan.retainedQuestionFields);assert(plan.beforeStatus==='published'?current.revision===plan.beforeRevision+1:[plan.beforeRevision,plan.beforeRevision+1].includes(current.revision))}
for(const plan of clonePlans){const original=ledger.beforeQuestions.find((q:any)=>q.id===plan.id),current=await req(api,'/admin/questions/'+plan.id),done=ledger.publications[plan.id]
 if(done){verifyApplied(plan,current);ledger.publications[plan.id]={completed:true,revision:current.revision};save();continue}
 assert.equal(questionUpdateDigest(current),questionUpdateDigest(original))
 ledger.publications[plan.id]={intent:true};save()
 const changed=await req(api,'/admin/questions/'+plan.id,'PUT',{definition:plan.definition,status:'published',expectedQuestionDigest:questionUpdateDigest(current)})
 verifyApplied(plan,changed);verifyApplied(plan,await req(api,'/admin/questions/'+plan.id));ledger.publications[plan.id]={completed:true,revision:changed.revision};save()
}
const after=await req(api,'/admin/questions'),others=(qs:any[])=>Object.fromEntries(qs.filter(q=>!ids.includes(q.id)).map(q=>[q.id,q]));assert.deepEqual(others(after),others(ledger.beforeQuestions))
const report={status:'passed',kind:'isolated-clone-contract-preparation',checkedAt:new Date().toISOString(),api,questionIds:ids,contractsDigest:upgradeContractsDigest(plans),plansDigest:state.plansDigest,copiedGenuineProofs:4,copiedImmutablePackages:copiedPackages.size,responseSnapshotsOn08:false,productionQuestionWrites:0,studentScoresCopied:0,otherCloneQuestionsUnchanged:true}
write(T+'/state/reports/paced08-v12-clone-preparation-20261018.json',report)
write(B+'/state/paced08-v12-upgrade-plans-private.json',{plans,contractsDigest:upgradeContractsDigest(plans),plansDigest:state.plansDigest})
for(const pair of ['08'])write(T+'/state/reports/paced08-v12-pair'+pair+'-plan-20261018.json',{attackId:'V3-261012-A'+pair,defenseId:'V3-261012-D'+pair})
console.log(JSON.stringify(report))
