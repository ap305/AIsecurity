import type { Prisma, Question, QuestionSolution } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { transaction } from '../lib/transaction.js'
import { normalizeCategory, pageNumber, parseJson, RequestError } from '../lib/prdContract.js'
import { hasValidSession, type TokenPayload } from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { canTeach } from './classrooms.js'
import { publishedReference } from './publishedReferences.js'

const MAX_TEXT_BYTES = 256 * 1024
const referenceKinds = new Set(['same_role', 'opponent', 'qualification'])
const runningStatuses = ['pending', 'queued', 'judging', 'baseline', 'opponents']
type Db = Prisma.TransactionClient
type Actor = TokenPayload
const submissionSelect = {
  id: true,
  userId: true,
  questionId: true,
  questionVersion: true,
  evaluationVersion: true,
  category: true,
  role: true,
  scenarioId: true,
  status: true,
  score: true,
  code: true,
  configSnapshot: true,
  createdAt: true,
} as const
type Submission = Prisma.SubmissionGetPayload<{ select: typeof submissionSelect }>
const { code: _code, ...sourceMetadataSelect } = submissionSelect
type SourceMetadata = Prisma.SubmissionGetPayload<{ select: typeof sourceMetadataSelect }>
const solutionMetadataSelect = {
  id: true,
  authorId: true,
  kind: true,
  sourceSubmissionId: true,
  createdAt: true,
} as const
type SolutionMetadata = Prisma.QuestionSolutionGetPayload<{ select: typeof solutionMetadataSelect }>
type Scoring = { score: number | null; updating: boolean; emptyPool: boolean; notice: string }

async function actor(db: Db, identity: Actor, write = false) {
  if (!identity) throw new AuthError('请先登录', 401, 40100)
  if (write) await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${identity.uid} FOR UPDATE`
  const row = await db.user.findUnique({
    where: { id: identity.uid },
    select: { id: true, role: true, accountStatus: true, sessionVersion: true },
  })
  if (!(await hasValidSession(identity, row, db)) || row?.role !== identity.r)
    throw new AuthError('账号不可用或登录已过期，请重新登录', 401, 40100)
  return row!
}
async function publishedQuestion(db: Db, id: string) {
  const row = await db.question.findFirst({ where: { id, status: 'published' } })
  if (!row) throw new RequestError('题目不存在或尚未发布', 404)
  return row
}
function definition(q: Question) {
  return (
    parseJson<{
      evaluation?: { packageId?: string }
      weights?: { enabled?: boolean; required?: boolean }
      kind?: string
    }>(q.definition, {}) || {}
  )
}
function currentSubmission(s: SourceMetadata, q: Question) {
  const frozen = parseJson<{
    questionId?: string
    questionVersion?: number
    definition?: { evaluation?: { packageId?: string } }
  }>(s.configSnapshot, {})
  const packageId = definition(q).evaluation?.packageId
  return (
    s.questionId === q.id &&
    s.questionVersion === q.revision &&
    s.evaluationVersion === q.evaluationVersion &&
    normalizeCategory(s.category) === normalizeCategory(q.category) &&
    (normalizeCategory(q.category) === 'basic' || (s.role === q.role && s.scenarioId === q.scenarioId)) &&
    !!packageId &&
    frozen?.questionId === q.id &&
    frozen.questionVersion === q.revision &&
    frozen.definition?.evaluation?.packageId === packageId
  )
}
function eligibleSource(s: Submission, q: Question) {
  return (
    currentSubmission(s, q) &&
    s.status === 'completed' &&
    s.code.trim().length > 0 &&
    !s.code.includes('\0') &&
    Buffer.byteLength(s.code, 'utf8') <= MAX_TEXT_BYTES
  )
}
function finiteScore(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100
}
function text(value: unknown, name: string, maxChars?: number) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES ||
    (maxChars && value.length > maxChars)
  )
    throw new RequestError(`${name}须为有效文本，最多 ${maxChars ? `${maxChars} 字` : '256 KiB'}`)
  return value
}
function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('题解内容无效')
  return value as Record<string, unknown>
}
function validateContent(title: string, explanation: string, code: string) {
  if (!title.trim()) throw new RequestError('请填写题解标题')
  if (!explanation.trim() && !code.trim()) throw new RequestError('请填写说明或代码')
  if (Buffer.byteLength(title + explanation + code, 'utf8') > MAX_TEXT_BYTES)
    throw new RequestError('题解文本合计不能超过 256 KiB')
}
async function ownSource(db: Db, id: unknown, identity: Actor, q: Question) {
  if (typeof id !== 'string' || !id || id.length > 100) throw new RequestError('提交引用无效')
  const row = await db.submission.findUnique({ where: { id }, select: submissionSelect })
  if (!row || row.userId !== identity.uid || !eligibleSource(row, q))
    throw new RequestError('只能公开自己在本题当前版本已完成的有效代码提交')
  return row
}

async function sourceScores(db: Db, q: Question, sources: SourceMetadata[]) {
  const result = new Map<string, Scoring>()
  const userIds = [...new Set(sources.map((s) => s.userId))]
  if (!sources.length) return result
  if (normalizeCategory(q.category) === 'basic') {
    const ledgers = await db.basicScore.findMany({
      where: { questionId: q.id, questionVersion: q.revision, userId: { in: userIds } },
    })
    const byUser = new Map(ledgers.map((row) => [row.userId, row]))
    for (const s of sources) {
      const ledger = byUser.get(s.userId)
      // Published submission scores are bounded by the existing ledger; never reconstruct or write it.
      const score =
        finiteScore(s.score) &&
        (ledger ? finiteScore(ledger.score) && s.score <= ledger.score : s.score === 0)
          ? s.score
          : null
      result.set(s.id, { score, updating: false, emptyPool: false, notice: '' })
    }
    return result
  }
  const slots = await db.arenaSlot.findMany({
    where: {
      userId: { in: userIds },
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: q.evaluationVersion,
    },
  })
  const algorithms = await db.arenaAlgorithm.findMany({
    where: {
      id: { in: slots.map((s) => s.algorithmId) },
      submissionId: { in: sources.map((s) => s.id) },
      questionId: q.id,
      scenarioId: q.scenarioId!,
      role: q.role!,
      evaluationVersion: q.evaluationVersion,
      status: 'active',
    },
  })
  const [scores, jobs, pending] = await Promise.all([
    db.arenaScore.findMany({
      where: {
        algorithmId: { in: algorithms.map((a) => a.id) },
        questionId: q.id,
        scenarioId: q.scenarioId!,
        role: q.role!,
        evaluationVersion: q.evaluationVersion,
      },
    }),
    db.arenaEvaluation.findMany({
      where: { algorithmId: { in: algorithms.map((a) => a.id) }, kind: 'recompute' },
      select: { algorithmId: true, status: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.submission.findMany({
      where: {
        questionId: q.id,
        userId: { in: userIds },
        questionVersion: q.revision,
        evaluationVersion: q.evaluationVersion,
        status: { in: runningStatuses },
      },
      select: { userId: true },
    }),
  ])
  for (const algorithm of algorithms) {
    const source = sources.find((s) => s.id === algorithm.submissionId)
    if (
      !source ||
      source.userId !== algorithm.userId ||
      !slots.some((slot) => slot.algorithmId === algorithm.id && slot.userId === source.userId)
    )
      continue
    const row = scores.find((r) => r.algorithmId === algorithm.id && r.userId === source.userId)
    if (!row || !finiteScore(row.score)) continue
    const job = jobs.find((j) => j.algorithmId === algorithm.id)
    const updating =
      (!!job && ['queued', 'running', 'error'].includes(job.status)) ||
      pending.some((s) => s.userId === source.userId)
    const notices = [
      row.opponentCount === 0 ? '暂无有效对手，按规则计100%' : '',
      updating
        ? job?.status === 'error'
          ? '成绩更新暂未完成，保留上次有效成绩'
          : '成绩更新中，显示上次有效成绩'
        : '',
    ]
    result.set(source.id, {
      score: row.score,
      updating,
      emptyPool: row.opponentCount === 0,
      notice: notices.filter(Boolean).join('；'),
    })
  }
  return result
}

function publicItem(
  row: QuestionSolution,
  author: { displayName: string },
  identity: Actor,
  q: Question,
  score?: Scoring,
  source?: SourceMetadata,
) {
  const manualStandard = row.kind === 'standard'
  return {
    id: row.id,
    title: row.title,
    explanation: row.explanation,
    code: row.code,
    kind: row.kind,
    author: author.displayName,
    questionVersion: row.questionVersion,
    source: row.sourceSubmissionId ? 'submission' : 'manual',
    referenceKind: row.referenceKind,
    actualEvaluationReference: false,
    score: score?.score ?? null,
    updating: score?.updating ?? false,
    emptyPool: score?.emptyPool ?? false,
    notice: manualStandard
      ? '教师手工发布的学习参考，不代表当前线上实际评测实现或资格基线。'
      : (score?.notice ?? ''),
    needsModelAttachment:
      !!(definition(q).weights?.enabled || definition(q).weights?.required) ||
      ['model', 'distillation'].includes(definition(q).kind || ''),
    canWithdraw: row.authorId === identity.uid,
    createdAt: row.createdAt.toISOString(),
    sourceCreatedAt: source?.createdAt.toISOString() ?? null,
  }
}

export async function listQuestionSolutions(
  questionId: string,
  identity: Actor,
  input: { page?: unknown; pageSize?: unknown } = {},
) {
  const page = pageNumber(input.page, 1, '页码')
  const pageSize = Math.min(pageNumber(input.pageSize, 20, '每页数量'), 50)
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw new RequestError('页码超出支持范围')
  return prisma.$transaction(
    async (db) => {
      const viewer = await actor(db, identity)
      const q = await publishedQuestion(db, questionId)
      // Rank metadata across all public candidates; load large code fields only after pagination/top selection.
      const rows = await db.questionSolution.findMany({
        where: { questionId, questionVersion: q.revision, published: true },
        select: solutionMetadataSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const [users, sources] = await Promise.all([
        db.user.findMany({
          where: { id: { in: rows.map((r) => r.authorId) }, accountStatus: 'active' },
          select: { id: true, displayName: true, role: true, isTestAccount: true },
        }),
        db.submission.findMany({
          where: { id: { in: rows.flatMap((r) => (r.sourceSubmissionId ? [r.sourceSubmissionId] : [])) } },
          select: sourceMetadataSelect,
        }),
      ])
      const validSources = sources.filter((s) => currentSubmission(s, q) && s.status === 'completed')
      const bySource = new Map(validSources.map((s) => [s.id, s]))
      const byUser = new Map(users.map((u) => [u.id, u]))
      const valid = rows.filter(
        (r) =>
          byUser.has(r.authorId) &&
          (!r.sourceSubmissionId || bySource.get(r.sourceSubmissionId)?.userId === r.authorId),
      )
      const scoring = await sourceScores(db, q, validSources)
      const ranked = valid
        .filter((r) => {
          const owner = byUser.get(r.authorId)!
          return (
            r.kind === 'user' &&
            owner.role === 'student' &&
            !owner.isTestAccount &&
            scoring.get(r.sourceSubmissionId || '')?.score != null
          )
        })
        .sort((a, b) => {
          const sa = bySource.get(a.sourceSubmissionId!)!,
            sb = bySource.get(b.sourceSubmissionId!)!
          return (
            scoring.get(sb.id)!.score! - scoring.get(sa.id)!.score! ||
            sb.createdAt.getTime() - sa.createdAt.getTime() ||
            sb.id.localeCompare(sa.id) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id)
          )
        })
      const submissions = new Set<string>()
      const best = ranked.filter((r) => {
        if (submissions.has(r.sourceSubmissionId!)) return false
        submissions.add(r.sourceSubmissionId!)
        return true
      })
      const maximum = best.length ? scoring.get(best[0].sourceSubmissionId!)!.score : null
      const userRows = valid.filter((r) => r.kind === 'user')
      const selectedUsers = userRows.slice((page - 1) * pageSize, page * pageSize)
      const selectedStandard = valid.filter((r) => r.kind === 'standard').slice(0, 20)
      const selectedTop = best
        .filter((r) => scoring.get(r.sourceSubmissionId!)!.score === maximum)
        .slice(0, 2)
      const selected = await db.questionSolution.findMany({
        where: { id: { in: [...selectedUsers, ...selectedStandard, ...selectedTop].map((r) => r.id) } },
      })
      const byId = new Map(selected.map((r) => [r.id, r]))
      const render = (metadata: SolutionMetadata) => {
        const r = byId.get(metadata.id)!
        return {
          ...publicItem(
            r,
            byUser.get(r.authorId)!,
            identity,
            q,
            scoring.get(r.sourceSubmissionId || ''),
            bySource.get(r.sourceSubmissionId || ''),
          ),
          canWithdraw: viewer.role === 'admin' || r.authorId === identity.uid,
        }
      }
      const reference = normalizeCategory(q.category) === 'adversarial' ? await publishedReference(q) : null
      return {
        question: {
          id: q.id,
          title: q.title,
          revision: q.revision,
          category: normalizeCategory(q.category),
          role: q.role,
        },
        canPublishStandard: await canTeach(identity.uid, db),
        standard: [...(reference?.item ? [reference.item] : []), ...selectedStandard.map(render)],
        standardNotice: reference?.notice ?? '',
        user: selectedUsers.map(render),
        top: selectedTop.map(render),
        pagination: {
          page,
          pageSize,
          total: userRows.length,
          totalPages: Math.ceil(userRows.length / pageSize),
        },
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  )
}

export async function listSolutionCandidates(questionId: string, identity: Actor) {
  return prisma.$transaction(
    async (db) => {
      await actor(db, identity)
      const q = await publishedQuestion(db, questionId)
      const rows = await db.submission.findMany({
        where: {
          questionId,
          userId: identity.uid,
          questionVersion: q.revision,
          evaluationVersion: q.evaluationVersion,
          status: 'completed',
        },
        select: submissionSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      })
      return rows
        .filter((s) => eligibleSource(s, q))
        .map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          score: normalizeCategory(q.category) === 'basic' && finiteScore(s.score) ? s.score : null,
        }))
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  )
}

async function assertPublicationCapacity(db: Db, q: Question, authorId: string, kind: string) {
  const where = { questionId: q.id, questionVersion: q.revision, published: true }
  if ((await db.questionSolution.count({ where: { ...where, authorId } })) >= 20)
    throw new RequestError('每人每题当前版本最多公开 20 篇题解，请先撤回不再需要的题解', 409)
  if (kind === 'standard' && (await db.questionSolution.count({ where: { ...where, kind } })) >= 20)
    throw new RequestError('当前版本最多发布 20 篇标准题解，请先撤回不再需要的题解', 409)
}

export async function createQuestionSolution(questionId: string, identity: Actor, raw: unknown) {
  const input = inputObject(raw)
  const kind = input.kind
  if (kind !== 'standard' && kind !== 'user') throw new RequestError('题解来源无效')
  if (
    input.referenceKind != null &&
    (kind !== 'standard' || !referenceKinds.has(String(input.referenceKind)))
  )
    throw new RequestError('参考类型仅支持同角色、对手参考或资格基线学习说明')
  return transaction(async (db) => {
    await actor(db, identity, true)
    const q = await publishedQuestion(db, questionId)
    if (kind === 'standard' && !(await canTeach(identity.uid, db)))
      throw new RequestError('仅教师或管理员可发布标准题解', 403)
    if (kind === 'standard' && input.sourceSubmissionId != null)
      throw new RequestError('标准题解须手工发布并注明参考用途')
    const source =
      input.sourceSubmissionId == null ? null : await ownSource(db, input.sourceSubmissionId, identity, q)
    const title = text(input.title, '标题', 120).trim()
    const explanation = text(input.explanation ?? '', '说明')
    const code = source?.code ?? text(input.code ?? '', '代码')
    validateContent(title, explanation, code)
    await assertPublicationCapacity(db, q, identity.uid, kind)
    const row = await db.questionSolution.create({
      data: {
        questionId,
        questionVersion: q.revision,
        authorId: identity.uid,
        kind,
        title,
        explanation,
        code,
        sourceSubmissionId: source?.id ?? null,
        referenceKind: kind === 'standard' ? String(input.referenceKind ?? 'same_role') : null,
      },
    })
    return { id: row.id, questionVersion: row.questionVersion, published: row.published }
  })
}

export async function updateQuestionSolution(id: string, identity: Actor, raw: unknown) {
  const input = inputObject(raw)
  if (Object.keys(input).some((key) => !['title', 'explanation', 'code', 'published'].includes(key)))
    throw new RequestError('不支持修改题解来源或版本')
  return transaction(async (db) => {
    const viewer = await actor(db, identity, true)
    const row = await db.questionSolution.findUnique({ where: { id } })
    if (!row) throw new RequestError('题解不存在', 404)
    if (row.authorId !== identity.uid && viewer.role !== 'admin')
      throw new RequestError('不能修改他人的题解', 403)
    if (row.kind === 'standard' && !(await canTeach(identity.uid, db)))
      throw new RequestError('教师权限已撤销', 403)
    const q = await publishedQuestion(db, row.questionId)
    if (q.revision !== row.questionVersion)
      throw new RequestError('题解属于旧版本，请在当前版本重新发布', 409)
    if (input.published !== undefined && typeof input.published !== 'boolean')
      throw new RequestError('发布状态无效')
    if (row.sourceSubmissionId) {
      if (input.code !== undefined && input.code !== row.code)
        throw new RequestError('公开提交的代码快照不能修改；请另发文字代码题解')
      await ownSource(db, row.sourceSubmissionId, { ...identity, uid: row.authorId }, q)
    }
    const title = text(input.title ?? row.title, '标题', 120).trim()
    const explanation = text(input.explanation ?? row.explanation, '说明')
    const code = text(input.code ?? row.code, '代码')
    validateContent(title, explanation, code)
    if (!row.published && input.published === true)
      await assertPublicationCapacity(db, q, row.authorId, row.kind)
    await db.questionSolution.update({
      where: { id },
      data: { title, explanation, code, published: input.published as boolean | undefined },
    })
    return { id, published: input.published ?? row.published }
  })
}

export async function withdrawQuestionSolution(id: string, identity: Actor) {
  return transaction(async (db) => {
    const viewer = await actor(db, identity, true)
    const row = await db.questionSolution.findUnique({ where: { id } })
    if (!row) throw new RequestError('题解不存在', 404)
    if (row.authorId !== identity.uid && viewer.role !== 'admin')
      throw new RequestError('不能撤回他人的题解', 403)
    await db.questionSolution.update({ where: { id }, data: { published: false } })
    return { id, published: false }
  })
}
