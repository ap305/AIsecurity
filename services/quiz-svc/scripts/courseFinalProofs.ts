import type {QuestionDefinition} from '../src/lib/prdContract.js'
interface FinalPlan {id:string;definition:QuestionDefinition;packageId:string;packageDigest:string;configurationKey:string;category:string;role:string}
type Request=(route:string,method?:string,body?:any)=>Promise<any>
function check(value:any,reason:string):asserts value {if(!value)throw Error(reason)}
/** One POST intent per phase, same-ID polling, no inference or score retry. */
export async function runBoundFinalProofs<T extends FinalPlan>(plans:T[],state:any,request:Request,save:()=>void,material:(plan:T,phase:'baseline'|'opponent')=>any,validateResult:(plan:T,phase:'baseline'|'opponent',record:any)=>any,pollMs=10000) {
 for(const plan of plans) {
  state.tests[plan.id]??={}
  for(const phase of ['baseline','opponent']as const) {
   let proof=state.tests[plan.id][phase]
   if(proof)check(proof.configurationKey===plan.configurationKey,'upgrade_saved_proof_changed')
   if(!proof?.id) {
    check(!proof?.intent,'upgrade_self_test_post_outcome_unknown')
    const body={...material(plan,phase),definition:plan.definition,category:plan.category,role:plan.role,phase}
    proof=state.tests[plan.id][phase]={intent:true,configurationKey:plan.configurationKey};save()
    const created=await request(`/admin/evaluation-packages/${plan.packageId}/self-tests`,'POST',body)
    check(typeof created?.id==='string'&&/^[0-9a-f-]{36}$/.test(created.id),'upgrade_created_proof_invalid');proof.id=created.id;save()
   }
   const deadline=Date.now()+plan.definition.evaluation.timeoutMs+300000
   while(true) {
    const r=await request(`/admin/evaluation-packages/${plan.packageId}/self-tests/${proof.id}`)
    check(r.id===proof.id&&r.packageId===plan.packageId&&r.packageDigest===plan.packageDigest&&r.configurationKey===plan.configurationKey&&r.phase===phase,'upgrade_proof_identity_mismatch')
    if(r.status==='completed'){proof.record=validateResult(plan,phase,r);save();break}
    check(['queued','running'].includes(r.status)&&Date.now()<deadline,'upgrade_proof_not_completed')
    await new Promise(resolve=>setTimeout(resolve,pollMs))
   }
  }
 }
}
