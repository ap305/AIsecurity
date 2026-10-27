import { prisma } from './lib/db.js'
import { evaluationWorkerLane } from './services/evaluationLane.js'
import { startEvaluationWorker, stopEvaluationWorker, waitForEvaluationWorkerIdle } from './services/evaluationWorker.js'

async function start() {
  if (evaluationWorkerLane() !== 'd02-original300') throw Error('Dedicated worker requires d02-original300 lane')
  const keepAlive = setInterval(() => {}, 60000)
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    if (stopping) return
    stopping = true
    stopEvaluationWorker()
    void waitForEvaluationWorkerIdle().then(() => prisma.$disconnect()).then(() => {
      clearInterval(keepAlive)
      process.exit(0)
    }).catch(() => { console.error('[heavy-worker] graceful shutdown failed'); clearInterval(keepAlive); process.exit(1) })
  })
  await startEvaluationWorker()
  console.log('[heavy-worker] d02-original300 lane started')
}
start().catch(() => { console.error('[heavy-worker] startup failed'); process.exit(1) })
