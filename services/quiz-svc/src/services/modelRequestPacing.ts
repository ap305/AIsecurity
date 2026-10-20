import {RequestError} from '../lib/prdContract.js'
/** Process-local admission pacing, not a model response cache or retry mechanism.
 * A single API process owns production gateway traffic. Other existing policies
 * deliberately keep their old scheduling. Never queue beyond one interval.
 */
export function createColdRequestGate(now=Date.now, sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))) {
 const next=new Map<string,number>()
 return async(key:string,intervalMs:number)=>{
  if(!Number.isSafeInteger(intervalMs)||intervalMs<0||intervalMs>65000)throw new RequestError('模型请求节奏配置无效',502)
  if(intervalMs===0)return
  const at=now(), start=Math.max(at,next.get(key)??at),wait=start-at
  if(wait>intervalMs)throw new RequestError('模型调用繁忙，本次不产生正式成绩',502)
  next.set(key,start+intervalMs)
  if(wait>0)await sleep(wait)
 }
}
export const waitForColdRequest=createColdRequestGate()
