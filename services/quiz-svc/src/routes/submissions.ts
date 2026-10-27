import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { prisma } from '../lib/db.js'
import { requireUser, requireAdminMw, authPayload, hasCurrentSession } from '../lib/auth.js'
import { parseJson, RequestError, type SubmissionSnapshot } from '../lib/prdContract.js'
import { transaction } from '../lib/transaction.js'
import { wakeEvaluationWorker } from '../services/evaluationWorker.js'
import { validateCodeBlanks } from '../lib/codeBlanks.js'
import { submissionDiagnostics, type SubmissionDiagnostics } from '../services/submissionDiagnostics.js'
import type { Submission } from '@prisma/client'

const router = Router()
const UPLOADS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads/submissions')
fs.mkdirSync(UPLOADS_DIR, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024, fields: 8, fieldSize: 1024 * 1024, files: 1 },
})
const ok = (res: any, data: any) => res.json({ code: 0, message: 'ok', data })
const fail = (res: any, e: any) =>
  res
    .status(e instanceof RequestError ? e.status : 500)
    .json({ code: 40001, message: e instanceof RequestError ? e.message : '提交操作失败', data: null })
export function submissionView(row: any, diagnostics: SubmissionDiagnostics | null = null) {
  const result = parseJson<Record<string, unknown>>(row.result, {})
  return {
    id: row.id,
    questionId: row.questionId,
    questionVersion: row.questionVersion,
    userId: row.userId,
    category: row.category,
    role: row.role,
    status: row.status,
    score: row.score,
    result: row.result ? result : null,
    code: row.code,
    hasWeights: Boolean(row.filePath),
    materialHash: row.materialHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    diagnostics,
  }
}

async function submissionViews(rows: Submission[]) {
  const diagnostics = await submissionDiagnostics(rows)
  return rows.map((row) => submissionView(row, diagnostics.get(row.id) ?? null))
}

export async function submissionMaterialHash(code: string, filePath?: string | null): Promise<string> {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  let weightsHash: string | null = null
  if (filePath) {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
    weightsHash = hash.digest('hex')
  }
  return crypto.createHash('sha256').update(JSON.stringify({ codeHash, weightsHash })).digest('hex')
}

function assertSameSubmission(
  prior: any,
  input: { questionId: string; code: string; questionVersion: number; materialHash: string },
) {
  if (
    prior.questionId !== input.questionId ||
    prior.code !== input.code ||
    prior.questionVersion !== input.questionVersion ||
    prior.materialHash !== input.materialHash
  ) {
    throw new RequestError('同一提交标识不能用于不同题目版本、代码或模型参数', 409)
  }
}
router.post(
  '/submissions',
  async (req, res, next) => {
    try {
      const user = await requireUser(req, res)
      if (user) {
        res.locals.user = user
        next()
      }
    } catch (e) {
      fail(res, e)
    }
  },
  upload.single('file'),
  async (req, res) => {
    let retained = false
    try {
      const user = res.locals.user
      const { questionId, code, idempotencyKey } = req.body
      if (typeof questionId !== 'string' || typeof code !== 'string' || !code.trim())
        throw new RequestError('题目与代码不能为空')
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))
        throw new RequestError('请提供有效的幂等提交标识')
      const requestedVersion = Number(req.body.questionVersion)
      if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)
        throw new RequestError('请提供有效的题目版本')
      const materialHash = await submissionMaterialHash(code, req.file?.path)
      const prior = await prisma.submission.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      })
      if (prior) {
        assertSameSubmission(prior, { questionId, code, questionVersion: requestedVersion, materialHash })
        ok(res, (await submissionViews([prior]))[0])
        return
      }
      const question = await prisma.question.findUnique({ where: { id: questionId } })
      if (!question || question.status !== 'published') throw new RequestError('题目不存在或未发布', 404)
      if (requestedVersion !== question.revision)
        throw new RequestError('题目版本已变化，请刷新后重新提交', 409)
      const version = await prisma.questionRevision.findUnique({
        where: { questionId_revision: { questionId, revision: question.revision } },
      })
      const snapshot = parseJson<SubmissionSnapshot>(version?.snapshot, {} as SubmissionSnapshot)
      if (!snapshot.definition?.evaluation.packageId)
        throw new RequestError('题目尚未完成新评测环境配置，请联系出题人', 409)
      validateCodeBlanks(
        (snapshot as SubmissionSnapshot & { answerTemplate?: string }).answerTemplate || null,
        code,
      )
      const weights = snapshot.definition.weights
      if (req.file && !weights.enabled) throw new RequestError('本题未开启模型参数上传')
      if (!req.file && weights.required) throw new RequestError('本题必须上传模型参数')
      if (
        req.file &&
        (req.file.size > weights.maxBytes ||
          !weights.extensions.includes(path.extname(req.file.originalname).toLowerCase()))
      )
        throw new RequestError('参数文件不符合本题格式或大小要求')
      const submission = await transaction(async (tx) => {
        // Uploading/hash calculation may outlive a disable, deletion, or session revocation.
        const freshUser = await tx.user.findUnique({ where: { id: user.id } })
        if (!hasCurrentSession(authPayload(req), freshUser))
          throw new RequestError('账号不可用或登录已过期，请重新登录', 401)
        const fresh = await tx.question.findUniqueOrThrow({ where: { id: questionId } })
        if (fresh.revision !== question.revision || fresh.status !== 'published')
          throw new RequestError('题目已变化，请刷新后重试', 409)
        const found = await tx.submission.findUnique({
          where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
        })
        if (found) {
          assertSameSubmission(found, { questionId, code, questionVersion: requestedVersion, materialHash })
          return found
        }
        const row = await tx.submission.create({
          data: {
            questionId,
            userId: user.id,
            code,
            filePath: req.file?.path || null,
            questionVersion: question.revision,
            category: snapshot.category,
            role: snapshot.role,
            scenarioId: snapshot.scenarioId,
            evaluationVersion: snapshot.evaluationVersion,
            configSnapshot: version!.snapshot,
            materialHash,
            idempotencyKey,
            status: 'queued',
          },
        })
        await tx.evaluationTask.create({ data: { submissionId: row.id } })
        return row
      })
      retained = submission.filePath === req.file?.path
      wakeEvaluationWorker()
      ok(res, (await submissionViews([submission]))[0])
    } catch (e) {
      fail(res, e)
    } finally {
      if (req.file && !retained) fs.rmSync(req.file.path, { force: true })
    }
  },
)
router.get('/submissions/:id', async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    const row = await prisma.submission.findUnique({ where: { id: req.params.id } })
    if (!row || (row.userId !== user.id && user.role !== 'admin')) throw new RequestError('提交不存在', 404)
    ok(res, (await submissionViews([row]))[0])
  } catch (e) {
    fail(res, e)
  }
})
router.get('/questions/:id/submissions', async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    ok(
      res,
      await submissionViews(
        await prisma.submission.findMany({
          where: { questionId: req.params.id, userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ),
    )
  } catch (e) {
    fail(res, e)
  }
})
router.get('/admin/evaluation-tasks', requireAdminMw, async (_req, res) => {
  try {
    ok(res, await prisma.evaluationTask.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }))
  } catch (e) {
    fail(res, e)
  }
})
router.post('/admin/evaluation-tasks/:id/retry', requireAdminMw, async (req, res) => {
  try {
    const task = await prisma.evaluationTask.findUniqueOrThrow({ where: { id: req.params.id } })
    if (task.state !== 'error') throw new RequestError('仅异常任务可重试')
    await transaction(async (tx) => {
      const fresh = await tx.evaluationTask.findUniqueOrThrow({ where: { id: task.id } })
      if (fresh.state !== 'error') throw new RequestError('任务状态已变化，请刷新', 409)
      const submission = await tx.submission.findUniqueOrThrow({ where: { id: fresh.submissionId } })
      const question = await tx.question.findUniqueOrThrow({ where: { id: submission.questionId } })
      if (question.status !== 'published' || question.revision !== submission.questionVersion)
        throw new RequestError('题目版本已失效，请提交当前版本', 409)
      await tx.evaluationTask.update({
        where: { id: fresh.id },
        data: { state: 'queued', attempts: 0, lockedAt: null, error: null },
      })
      await tx.arenaEvaluation.updateMany({
        where: { submissionId: submission.id, kind: 'candidate', status: 'error' },
        data: { status: 'queued', error: null },
      })
      await tx.arenaAlgorithm.updateMany({
        where: { submissionId: submission.id, status: 'error' },
        data: { status: 'candidate' },
      })
      await tx.submission.update({ where: { id: submission.id }, data: { status: 'queued' } })
      await tx.auditEvent.create({
        data: {
          actorId: authPayload(req)!.uid,
          action: 'evaluation.retry',
          targetId: fresh.id,
          detail: JSON.stringify({ previousAttempts: fresh.attempts }),
        },
      })
    })
    wakeEvaluationWorker()
    ok(res, { queued: true })
  } catch (e) {
    fail(res, e)
  }
})
export default router
