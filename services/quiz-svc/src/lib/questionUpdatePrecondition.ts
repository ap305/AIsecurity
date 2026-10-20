import crypto from 'node:crypto'
import {RequestError} from './prdContract.js'
function canonical(value:any):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 return JSON.stringify(value)
}
/** Match the serialized admin view, including Prisma Date fields, on both
 * sides of HTTP. Definition and metadata edits are covered even when two
 * saves share the same timestamp or draft revision. */
export function questionUpdateDigest(view:unknown):string {
 const plain=JSON.parse(JSON.stringify(view))
 return crypto.createHash('sha256').update(canonical(plain)).digest('hex')
}
export function assertQuestionUpdatePrecondition(view:unknown,expected:unknown):void {
 if(expected===undefined)return
 if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw new RequestError('题目更新校验值无效',400)
 if(!view||questionUpdateDigest(view)!==expected)throw new RequestError('题目已被其他操作修改，请刷新后重试',409)
}
