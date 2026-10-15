import express from 'express'
import cors from 'cors'
import questionsRouter from './routes/questions.js'
import submissionsRouter from './routes/submissions.js'
import matchesRouter from './routes/matches.js'
import leaderboardRouter from './routes/leaderboard.js'
import resourcesRouter from './routes/resources.js'
import llmRouter from './routes/llm.js'
import githubArchiveAdminRouter from './routes/githubArchiveAdmin.js'
import authRouter from './routes/auth.js'
import apiPoolRouter from './routes/apiPool.js'
import teacherLeasesRouter from './routes/teacherLeases.js'
import arenaRouter from './routes/arena.js'
import evaluationPackagesRouter from './routes/evaluationPackages.js'
import adminStudentScoresRouter from './routes/adminStudentScores.js'

export const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.get('/api/health', (_req, res) =>
  res.json({ code: 0, message: 'ok', data: { service: 'quiz-svc', status: 'healthy' } }),
)
for (const router of [
  questionsRouter,
  submissionsRouter,
  arenaRouter,
  evaluationPackagesRouter,
  apiPoolRouter,
  teacherLeasesRouter,
  matchesRouter,
  leaderboardRouter,
  resourcesRouter,
  llmRouter,
  githubArchiveAdminRouter,
  authRouter,
  adminStudentScoresRouter,
])
  app.use('/api', router)
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const inputError =
    error?.name === 'MulterError' || error?.type === 'entity.too.large' || error instanceof SyntaxError
  res.status(inputError ? 400 : 500).json({
    code: inputError ? 40001 : 50000,
    message: inputError ? '请求格式、文件数量或大小不符合要求' : '服务暂不可用，请稍后重试',
    data: null,
  })
})
