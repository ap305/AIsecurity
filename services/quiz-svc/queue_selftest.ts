/** 判题并发闸门自测（本地一次性脚本，跑完可删） */
import { JudgeQueue, JudgeQueueFullError, JudgeQueueTimeoutError } from './src/lib/judgeQueue.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) 容量 2 / 排队上限 2：第 5 个应被拒绝
  const q = new JudgeQueue(2, 2, 5000)
  const hold = () => sleep(600)
  const ps = [q.run('a', hold), q.run('b', hold), q.run('c', hold), q.run('d', hold)]
  await sleep(50)
  const mid = q.stats()
  let rejected = ''
  try {
    await q.run('e', hold)
  } catch (e) {
    rejected = e instanceof JudgeQueueFullError ? 'JudgeQueueFullError' : String(e)
  }
  await Promise.allSettled(ps)
  console.log('[1] mid stats =', JSON.stringify(mid))
  console.log('[1] 5th rejected =', rejected, '| after =', JSON.stringify(q.stats()))

  // 2) 排队超时：容量 1，排队 300ms 上限
  const q2 = new JudgeQueue(1, 5, 300)
  const blocker = q2.run('h', () => sleep(1000))
  let timeoutErr = ''
  try {
    await q2.run('w', hold)
  } catch (e) {
    timeoutErr = e instanceof JudgeQueueTimeoutError ? 'JudgeQueueTimeoutError' : String(e)
  }
  await blocker
  console.log('[2] queued-then-timeout =', timeoutErr, '| after =', JSON.stringify(q2.stats()))

  // 3) 释放后名额能继续被使用（无泄漏）
  const q3 = new JudgeQueue(1, 0, 5000)
  let fullErr = ''
  const r1 = q3.run('x', hold)
  await sleep(20)
  try {
    await q3.run('y', hold)
  } catch (e) {
    fullErr = e instanceof JudgeQueueFullError ? 'JudgeQueueFullError' : String(e)
  }
  await r1
  await q3.run('z', hold)
  console.log('[3] queueLimit=0 rejects immediately =', fullErr, '| after =', JSON.stringify(q3.stats()))
}

void main()
