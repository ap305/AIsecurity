import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { normalizeCategory, parseJson, RequestError } from '../lib/prdContract.js'
import { isCurrentArenaSubmission } from './arenaRules.js'

const studentSelect = {
  id: true,
  username: true,
  displayName: true,
  studentId: true,
  school: true,
} as const
type Student = Prisma.UserGetPayload<{ select: typeof studentSelect }>
const runningStatuses = new Set(['pending', 'queued', 'judging', 'baseline', 'opponents'])
type ScoreState = 'scored' | 'pending' | 'no_score' | 'outdated'

export interface AdminStudentQuestionScore {
  questionId: string
  title: string
  number: number
  moduleCode: string
  category: 'basic' | 'adversarial'
  role: string | null
  questionVersion: number
  evaluationVersion: string
  questionStatus: string
  submissionCount: number
  currentSubmissionCount: number
  lastSubmittedAt: string
  score: number | null
  scoreKind: 'best' | 'current'
  state: ScoreState
  scoreReachedAt: string | null
  scoringSubmissionId: string | null
  updating: boolean
  latestSubmission: {
    id: string
    status: string
    score: number | null
    questionVersion: number
    createdAt: string
  } | null
}
export interface AdminStudentScoreSummary {
  userId: string
  username: string
  displayName: string
  studentId: string | null
  school: string
  basicTotalScore: number
  basicScoredQuestionCount: number
  submittedQuestionCount: number
  lastSubmittedAt: string | null
}

/** Read only the selected page's students; no source code, upload paths or result payloads are selected. */
async function questionScoresForStudents(db: Prisma.TransactionClient, userIds: string[]) {
  const byStudent = new Map(userIds.map((id) => [id, [] as AdminStudentQuestionScore[]]))
  if (!userIds.length) return byStudent
  const [submissions, basicScores, slots] = await Promise.all([
    db.submission.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true,
        userId: true,
        questionId: true,
        questionVersion: true,
        category: true,
        scenarioId: true,
        role: true,
        evaluationVersion: true,
        configSnapshot: true,
        status: true,
        score: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.basicScore.findMany({ where: { userId: { in: userIds } } }),
    db.arenaSlot.findMany({ where: { userId: { in: userIds } } }),
  ])
  if (!submissions.length) return byStudent
  const [questions, algorithms] = await Promise.all([
    db.question.findMany({
      where: { id: { in: [...new Set(submissions.map((s) => s.questionId))] } },
      select: {
        id: true,
        title: true,
        number: true,
        moduleCode: true,
        category: true,
        role: true,
        scenarioId: true,
        revision: true,
        evaluationVersion: true,
        status: true,
        definition: true,
      },
      orderBy: [{ moduleCode: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    }),
    db.arenaAlgorithm.findMany({ where: { id: { in: slots.map((s) => s.algorithmId) } } }),
  ])
  const algorithmIds = algorithms.map((a) => a.id)
  const [arenaScores, recomputations, revisions] = await Promise.all([
    db.arenaScore.findMany({ where: { algorithmId: { in: algorithmIds } } }),
    db.arenaEvaluation.findMany({
      where: { algorithmId: { in: algorithmIds }, kind: 'recompute' },
      select: { algorithmId: true, status: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    db.questionRevision.findMany({
      where: { OR: questions.map((q) => ({ questionId: q.id, revision: q.revision })) },
      select: { questionId: true, snapshot: true },
    }),
  ])
  const revisionByQuestion = new Map(
    revisions.map((r) => [
      r.questionId,
      parseJson<{
        category?: string
        role?: string | null
        scenarioId?: string | null
        evaluationVersion?: string
      } | null>(r.snapshot, null),
    ]),
  )
  const submissionById = new Map(submissions.map((s) => [s.id, s]))
  const algorithmById = new Map(algorithms.map((a) => [a.id, a]))
  const scoreByAlgorithm = new Map(arenaScores.map((s) => [s.algorithmId, s]))
  const latestRecomputation = new Map<string, string>()
  for (const job of recomputations)
    if (!latestRecomputation.has(job.algorithmId)) latestRecomputation.set(job.algorithmId, job.status)
  const identity = (userId: string, questionId: string) => JSON.stringify([userId, questionId])
  const basicByQuestion = new Map(basicScores.map((s) => [identity(s.userId, s.questionId), s]))
  const grouped = new Map<string, typeof submissions>()
  for (const submission of submissions) {
    const key = identity(submission.userId, submission.questionId)
    const records = grouped.get(key) || []
    records.push(submission)
    grouped.set(key, records)
  }
  for (const userId of userIds) {
    for (const draft of questions) {
      // Draft edits may change category or role without publishing a new revision. Preserve the
      // published scoring identity, just as BasicScore/BasicTotal continue to preserve its points.
      const frozenIdentity = revisionByQuestion.get(draft.id)
      const category = frozenIdentity?.category
        ? normalizeCategory(frozenIdentity.category)
        : draft.status !== 'published' &&
            basicScores.some((s) => s.questionId === draft.id && s.questionVersion === draft.revision)
          ? 'basic'
          : normalizeCategory(draft.category)
      const question = {
        ...draft,
        category,
        role: category === 'basic' ? null : (frozenIdentity?.role ?? draft.role),
        scenarioId: category === 'basic' ? null : (frozenIdentity?.scenarioId ?? draft.scenarioId),
        evaluationVersion: frozenIdentity?.evaluationVersion || draft.evaluationVersion,
      }
      const records = grouped.get(identity(userId, question.id))
      if (!records?.length) continue
      const latest = records[0]
      const current = records.filter(
        (s) =>
          s.questionVersion === question.revision &&
          normalizeCategory(s.category) === category &&
          (category === 'basic' ||
            (s.evaluationVersion === question.evaluationVersion &&
              s.role === question.role &&
              s.scenarioId === question.scenarioId)),
      )
      const definition = parseJson<{ evaluation?: { packageId?: string } }>(question.definition, {})
      const modern = current.filter((s) => {
        const frozen = parseJson<{
          questionId?: string
          questionVersion?: number
          definition?: { evaluation?: { packageId?: string } }
        }>(s.configSnapshot, {})
        return (
          Boolean(frozen?.definition?.evaluation?.packageId) &&
          frozen?.questionId === question.id &&
          frozen?.questionVersion === question.revision &&
          // Unpublished draft edits do not advance the basic question revision. Its frozen
          // submission contract remains authoritative until a changed version is published.
          (category === 'basic' ||
            frozen?.definition?.evaluation?.packageId === definition?.evaluation?.packageId)
        )
      })
      let score: number | null = null
      let scoreReachedAt: string | null = null
      let scoringSubmissionId: string | null = null
      let updating = modern.some((s) => runningStatuses.has(s.status))
      let eligible = modern.length > 0
      if (category === 'basic') {
        // The current-version ledger is authoritative, including archived/basic legacy migration scores.
        // Never reconstruct a positive best score from historical Submission.score or UserScore.
        const best = basicByQuestion.get(identity(userId, question.id))
        if (best?.questionVersion === question.revision && Number.isFinite(best.score) && best.score >= 0) {
          score = best.score
          scoreReachedAt = best.scoreReachedAt.toISOString()
          scoringSubmissionId = best.submissionId
          eligible = true
        } else {
          // recordBasicResult does not create a ledger row for an initial zero. Show that valid result as zero.
          const zero = modern
            .filter((s) => s.status === 'completed' && s.score === 0)
            .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))[0]
          if (zero) {
            score = 0
            scoreReachedAt = zero.updatedAt.toISOString()
            scoringSubmissionId = zero.id
          }
        }
      } else {
        eligible = question.status === 'published' && modern.length > 0
        updating = eligible && updating
        const slot = slots.find(
          (s) =>
            s.userId === userId &&
            s.scenarioId === question.scenarioId &&
            s.role === question.role &&
            s.evaluationVersion === question.evaluationVersion,
        )
        const algorithm = slot && algorithmById.get(slot.algorithmId)
        const active = algorithm && submissionById.get(algorithm.submissionId)
        // Same current-slot/current-question rules as arenaQuestionScore, without historical MAX.
        if (
          algorithm?.status === 'active' &&
          algorithm.userId === userId &&
          active?.questionId === question.id &&
          isCurrentArenaSubmission(active, question)
        ) {
          const row = scoreByAlgorithm.get(algorithm.id)
          if (row && row.userId === userId && row.questionId === question.id) {
            score = row.score
            scoreReachedAt = row.achievedAt.toISOString()
            scoringSubmissionId = algorithm.submissionId
            eligible = true
          }
          updating ||= ['queued', 'running', 'error'].includes(latestRecomputation.get(algorithm.id) || '')
        }
      }
      const state: ScoreState =
        score !== null ? 'scored' : !eligible ? 'outdated' : updating ? 'pending' : 'no_score'
      byStudent.get(userId)!.push({
        questionId: question.id,
        title: question.title,
        number: question.number,
        moduleCode: question.moduleCode,
        category,
        role: question.role,
        questionVersion: question.revision,
        evaluationVersion: question.evaluationVersion,
        questionStatus: question.status,
        submissionCount: records.length,
        currentSubmissionCount: current.length,
        lastSubmittedAt: latest.createdAt.toISOString(),
        score,
        scoreKind: category === 'basic' ? 'best' : 'current',
        state,
        scoreReachedAt,
        scoringSubmissionId,
        updating,
        latestSubmission: {
          id: latest.id,
          status: latest.status,
          score: latest.score,
          questionVersion: latest.questionVersion,
          createdAt: latest.createdAt.toISOString(),
        },
      })
    }
  }
  return byStudent
}

function summary(student: Student, rows: AdminStudentQuestionScore[]): AdminStudentScoreSummary {
  const basic = rows.filter((r) => r.category === 'basic' && r.score !== null)
  return {
    userId: student.id,
    username: student.username,
    displayName: student.displayName,
    studentId: student.studentId,
    school: student.school,
    basicTotalScore: basic.reduce((sum, row) => sum + row.score!, 0),
    basicScoredQuestionCount: basic.length,
    submittedQuestionCount: rows.length,
    lastSubmittedAt:
      rows
        .map((r) => r.lastSubmittedAt)
        .sort()
        .at(-1) ?? null,
  }
}
function pageNumber(value: unknown, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new RequestError(`${name}必须是正整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RequestError(`${name}超出支持范围`)
  return parsed
}
export async function listAdminStudentScores(input: {
  search?: unknown
  page?: unknown
  pageSize?: unknown
}) {
  if (input.search !== undefined && typeof input.search !== 'string') throw new RequestError('搜索关键词无效')
  const search = String(input.search || '')
    .trim()
    .slice(0, 100)
  const page = pageNumber(input.page, 1, '页码')
  const pageSize = Math.min(pageNumber(input.pageSize, 20, '每页数量'), 100)
  const skip = (page - 1) * pageSize
  if (!Number.isSafeInteger(skip) || skip > 2147483647) throw new RequestError('页码超出支持范围')
  const where: Prisma.UserWhereInput = {
    role: 'student',
    ...(search
      ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { displayName: { contains: search, mode: 'insensitive' } },
            { studentId: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
  return prisma.$transaction(
    async (db) => {
      const [students, total] = await Promise.all([
        db.user.findMany({
          where,
          select: studentSelect,
          orderBy: [{ username: 'asc' }, { id: 'asc' }],
          skip,
          take: pageSize,
        }),
        db.user.count({ where }),
      ])
      const details = await questionScoresForStudents(
        db,
        students.map((s) => s.id),
      )
      return { students: students.map((s) => summary(s, details.get(s.id)!)), total, page, pageSize }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  )
}
export async function getAdminStudentScores(userId: string) {
  return prisma.$transaction(
    async (db) => {
      const student = await db.user.findFirst({
        where: { id: userId, role: 'student' },
        select: studentSelect,
      })
      if (!student) throw new RequestError('学生不存在', 404)
      const questions = (await questionScoresForStudents(db, [userId])).get(userId)!
      return { student: summary(student, questions), questions }
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  )
}
