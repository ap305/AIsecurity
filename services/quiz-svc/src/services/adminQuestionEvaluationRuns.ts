import { Prisma, type ArenaEvaluation } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { pageNumber, parseJson, RequestError } from '../lib/prdContract.js'
import { studentFailureMessage } from './studentFailureMessage.js'

const evaluationStatuses = new Set(['completed', 'student_error', 'timeout', 'system_error'])
const evaluationPhases = new Set(['basic', 'baseline', 'opponent'])
// Only known server messages and sanitized student guidance may cross this boundary.
const publicMessages = new Set([
  '攻防评测未正常完成，旧有效算法和成绩已保留，请查看任务状态或联系管理员',
  '评测超时，本次不计分，原有效成绩保留',
  '评测环境异常，本次不计分，原有效成绩保留；请联系管理员查看任务状态',
  '评测结果无效，本次不计分，原有效成绩保留',
  '题目版本已变更，本次提交不再计分',
  '基线资格未通过，本次不入池不计分',
  '算法已被替换，不再更新旧版本成绩',
  '测试评测已完成，成绩仅供测试，不进入正式排行榜或他人对手池',
  '暂无有效对手，按规则计100%',
  '本次完整对抗评测已完成',
  '已有更新版本，本次旧结果不覆盖有效成绩',
  '攻防评测未完成，已按有限重试规则处理；原有效成绩保留',
  '评测服务异常，本次未计分，将按有限重试规则处理',
  '评测环境准备失败',
  '评测环境或入口运行失败，本次不计分',
  '评测超时，本次不计分',
  '评测配置、材料或结果校验失败，本次不计分',
])

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function resultSummary(raw: string | null, source: 'submission' | 'arena') {
  const result = parseJson<Record<string, unknown> | null>(raw, null)
  if (!result) return null
  const {
    evaluationStatus,
    failedPhase,
    publicMessage,
    score,
    qualified,
    counted,
    successCount,
    opponentCount,
  } = result
  const message =
    source === 'submission' && typeof publicMessage === 'string'
      ? evaluationStatus === 'student_error'
        ? studentFailureMessage(publicMessage)
        : publicMessages.has(publicMessage)
          ? publicMessage
          : undefined
      : undefined
  const summary = {
    ...(typeof evaluationStatus === 'string' && evaluationStatuses.has(evaluationStatus)
      ? { evaluationStatus }
      : {}),
    ...(typeof failedPhase === 'string' && evaluationPhases.has(failedPhase) ? { failedPhase } : {}),
    ...(message ? { publicMessage: message } : {}),
    ...(source === 'arena' && typeof score === 'number' && Number.isFinite(score) ? { score } : {}),
    ...(typeof qualified === 'boolean' ? { qualified } : {}),
    ...(typeof counted === 'boolean' ? { counted } : {}),
    ...(isCount(successCount) ? { successCount } : {}),
    ...(isCount(opponentCount) ? { opponentCount } : {}),
  }
  return Object.keys(summary).length ? summary : null
}

type ArenaRunRow = Pick<
  ArenaEvaluation,
  | 'id'
  | 'submissionId'
  | 'kind'
  | 'status'
  | 'attempts'
  | 'snapshotRevision'
  | 'createdAt'
  | 'updatedAt'
  | 'result'
> & { total: number }

export async function listQuestionEvaluationRuns(id: string, input: { page?: unknown; pageSize?: unknown }) {
  const page = pageNumber(input.page, 1, '页码')
  const pageSize = Math.min(pageNumber(input.pageSize, 20, '每页数量'), 50)
  const skip = (page - 1) * pageSize
  if (!Number.isSafeInteger(skip) || skip > 2147483647) throw new RequestError('页码超出支持范围')

  return prisma.$transaction(
    async (db) => {
      const question = await db.question.findUnique({
        where: { id },
        select: { id: true, title: true, revision: true },
      })
      if (!question) throw new RequestError('题目不存在', 404)

      const where = { questionId: id }
      const [total, submissions] = await Promise.all([
        db.submission.count({ where }),
        db.submission.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            userId: true,
            questionVersion: true,
            evaluationVersion: true,
            status: true,
            score: true,
            createdAt: true,
            updatedAt: true,
            result: true,
          },
        }),
      ])
      if (!submissions.length) return { question, page, pageSize, total, rows: [] }

      const ids = submissions.map((submission) => submission.id)
      const [users, tasks, arenaRuns] = await Promise.all([
        db.user.findMany({
          where: { id: { in: [...new Set(submissions.map((submission) => submission.userId))] } },
          select: { id: true, username: true, displayName: true, isTestAccount: true },
        }),
        db.evaluationTask.findMany({
          where: { submissionId: { in: ids } },
          select: { submissionId: true, state: true, attempts: true, cleanupStatus: true, updatedAt: true },
        }),
        db.$queryRaw<ArenaRunRow[]>`
        SELECT "id", "submissionId", "kind", "status", "attempts", "snapshotRevision", "createdAt", "updatedAt", "result", total
        FROM (
          SELECT "id", "submissionId", "kind", "status", "attempts", "snapshotRevision", "createdAt", "updatedAt", "result",
                 COUNT(*) OVER (PARTITION BY "submissionId")::int AS total,
                 ROW_NUMBER() OVER (PARTITION BY "submissionId" ORDER BY "createdAt" DESC, "id" DESC) AS position
          FROM "ArenaEvaluation"
          WHERE "submissionId" IN (${Prisma.join(ids)})
        ) AS ranked
        WHERE position <= 10
        ORDER BY "submissionId", position
      `,
      ])
      const byUser = new Map(users.map((user) => [user.id, user]))
      const byTask = new Map(tasks.map(({ submissionId, ...task }) => [submissionId, task]))
      const byRun = new Map<string, ArenaRunRow[]>()
      for (const run of arenaRuns) {
        const group = byRun.get(run.submissionId)
        if (group) group.push(run)
        else byRun.set(run.submissionId, [run])
      }

      const rows = submissions.map(({ result, ...submission }) => {
        const user = byUser.get(submission.userId)
        const runs = byRun.get(submission.id) ?? []
        return {
          ...submission,
          username: user?.username ?? null,
          displayName: user?.displayName ?? null,
          isTestAccount: user?.isTestAccount ?? null,
          task: byTask.get(submission.id) ?? null,
          arenaRuns: runs.map(({ total, submissionId, result, ...run }) => ({
            ...run,
            result: resultSummary(result, 'arena'),
          })),
          arenaRunCount: runs[0]?.total ?? 0,
          result: resultSummary(result, 'submission'),
        }
      })
      return { question, page, pageSize, total, rows }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  )
}
