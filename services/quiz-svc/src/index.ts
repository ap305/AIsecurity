import { app } from './app.js'
import { ensureAdminUser } from './lib/auth.js'
import { prisma } from './lib/db.js'
import { startEvaluationWorker, stopEvaluationWorker } from './services/evaluationWorker.js'
import { recoverTeacherLeases } from './services/teacherLeases.js'
import { recoverPendingComposeCleanups } from './services/composeJudge.js'

const PORT = Number(process.env.PORT) || 4002
async function start() {
  await ensureAdminUser()
  await prisma.apiPool.upsert({
    where: { id: 'qwen3-8b-default' },
    update: {},
    create: {
      id: 'qwen3-8b-default',
      name: 'Qwen3-8B（配置服务后启用）',
      kind: 'llm',
      model: 'qwen3-8b',
      modelVersion: 'configure-before-publish',
      baseUrl: 'http://127.0.0.1:8000/v1',
      enabled: false,
      isDefault: true,
      parameters: JSON.stringify({ temperature: 0, max_tokens: 2048, maxCalls: 100 }),
    },
  })
  await recoverTeacherLeases()
  const cleanup = async () => {
    const result = await recoverPendingComposeCleanups()
    if (result.pending) console.error(`[quiz-svc] ${result.pending} 个评测环境待清理，将自动重试`)
  }
  await cleanup()
  const server = app.listen(PORT, () => {
    console.log(`[quiz-svc] Running on http://localhost:${PORT}`)
    // Evaluation recovery may immediately call the gateway, so listen before dispatching work.
    void startEvaluationWorker().catch(() =>
      console.error('[quiz-svc] 任务恢复失败，请检查数据库与评测运行配置'),
    )
  })
  const maintenance = setInterval(() => {
    void recoverTeacherLeases().catch(() => console.error('[quiz-svc] 租约恢复失败'))
    void cleanup().catch(() => console.error('[quiz-svc] 评测环境清理恢复失败'))
  }, 30000)
  maintenance.unref()
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopEvaluationWorker()
      clearInterval(maintenance)
      server.close(() => {
        void prisma.$disconnect().finally(() => process.exit(0))
      })
    })
}
start().catch(() => {
  console.error('[quiz-svc] 启动失败，请检查数据库迁移和管理员配置')
  process.exit(1)
})
