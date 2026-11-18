import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import type { Classroom, Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { hasValidSession, type TokenPayload } from '../lib/auth.js'
import { AuthError } from '../lib/authPassword.js'
import { normalizeCategory, pageNumber, parseJson, RequestError } from '../lib/prdContract.js'
import { transaction } from '../lib/transaction.js'
import { questionScoresForStudents, type AdminStudentQuestionScore } from './adminStudentScores.js'

type Db = Prisma.TransactionClient
type Session = TokenPayload | null
const identitySelect = { id: true, role: true, accountStatus: true, sessionVersion: true } as const
const memberSelect = {
  id: true,
  username: true,
  displayName: true,
  studentId: true,
  isTestAccount: true,
} as const
const inviteCode = () => crypto.randomBytes(10).toString('hex').toUpperCase()

export async function canTeach(userId: string, db: Db = prisma): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: identitySelect })
  return (
    !!user &&
    user.accountStatus === 'active' &&
    (user.role === 'admin' || !!(await db.teacherGrant.findUnique({ where: { userId } })))
  )
}

async function actor(db: Db, payload: Session, write = false) {
  if (!payload) throw new AuthError('请先登录', 401, 40100)
  // Grant changes acquire this same user lock, so revocation cannot race an authorized write.
  if (write) await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${payload.uid} FOR UPDATE`
  const user = await db.user.findUnique({ where: { id: payload.uid }, select: identitySelect })
  if (!(await hasValidSession(payload, user, db)) || user?.role !== payload.r)
    throw new AuthError('登录已失效，请重新登录', 401, 40100)
  return user!
}

function read<T>(work: (db: Db) => Promise<T>) {
  return prisma.$transaction(work, { isolationLevel: 'RepeatableRead', timeout: 20000 })
}
function summary(row: Classroom) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  }
}
async function managed(db: Db, payload: Session, id: string, write = false) {
  const user = await actor(db, payload, write)
  if (!(await canTeach(user.id, db))) throw new RequestError('需要教师或管理员权限', 403)
  const classroom = await db.classroom.findUnique({ where: { id } })
  if (!classroom) throw new RequestError('班级不存在', 404)
  if (user.role !== 'admin' && classroom.ownerId !== user.id) throw new RequestError('无权管理该班级', 403)
  return classroom
}
function fields(input: any, creating = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('班级资料无效')
  const data: { name?: string; description?: string; archivedAt?: Date | null } = {}
  if (creating || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name.trim()).length > 80)
      throw new RequestError('班级名称需要 1～80 个字符')
    data.name = input.name.trim()
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || Array.from(input.description).length > 1000)
      throw new RequestError('班级说明最多 1000 个字符')
    data.description = input.description
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') throw new RequestError('归档状态无效')
    data.archivedAt = input.archived ? new Date() : null
  }
  return data
}

export async function listClassrooms(payload: Session) {
  return read(async (db) => {
    const user = await actor(db, payload)
    const teaching = await canTeach(user.id, db)
    const memberships = await db.classMembership.findMany({ where: { userId: user.id } })
    const [owned, joined] = await Promise.all([
      teaching
        ? db.classroom.findMany({
            where: user.role === 'admin' ? {} : { ownerId: user.id },
            orderBy: { createdAt: 'desc' },
          })
        : [],
      db.classroom.findMany({
        where: { id: { in: memberships.map((m) => m.classroomId) } },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    return { canTeach: teaching, owned, joined: joined.map(summary) }
  })
}
export async function classroomCapabilities(payload: Session) {
  return read(async (db) => {
    const user = await actor(db, payload)
    return { canTeach: await canTeach(user.id, db) }
  })
}
export async function createClassroom(payload: Session, input: unknown) {
  const data = fields(input, true)
  return transaction(async (db) => {
    const user = await actor(db, payload, true)
    if (!(await canTeach(user.id, db))) throw new RequestError('需要教师或管理员权限', 403)
    return db.classroom.create({
      data: { ...data, name: data.name!, ownerId: user.id, inviteCode: inviteCode() },
    })
  })
}
export async function joinClassroom(payload: Session, code: unknown) {
  if (typeof code !== 'string' || !/^[a-f0-9]{20}$/i.test(code.trim())) {
    // Invalid guesses still consume the per-account budget below.
    if (typeof code !== 'string' || code.length > 100) throw new RequestError('邀请码无效')
  }
  const outcome = await transaction(async (db) => {
    const user = await actor(db, payload, true)
    const now = new Date()
    const limit = await db.classJoinThrottle.findUnique({ where: { userId: user.id } })
    const fresh = !limit || now.getTime() - limit.windowStartedAt.getTime() >= 15 * 60 * 1000
    if (!fresh && limit.attempts >= 10) return { denied: true } as const
    await db.classJoinThrottle.upsert({
      where: { userId: user.id },
      create: { userId: user.id, attempts: 1, windowStartedAt: now },
      update: fresh ? { attempts: 1, windowStartedAt: now } : { attempts: { increment: 1 } },
    })
    const classroom = await db.classroom.findFirst({
      where: { inviteCode: (code as string).trim().toUpperCase(), archivedAt: null },
    })
    if (!classroom) return { missing: true } as const
    await db.classMembership.upsert({
      where: { classroomId_userId: { classroomId: classroom.id, userId: user.id } },
      create: { classroomId: classroom.id, userId: user.id },
      update: {},
    })
    return { classroom: summary(classroom) } as const
  })
  // Failed guesses must commit their counter rather than roll back with the response error.
  if ('denied' in outcome) throw new RequestError('加入尝试过多，请 15 分钟后重试', 429)
  if ('missing' in outcome) throw new RequestError('邀请码无效或班级已归档', 404)
  return outcome.classroom
}
export async function getClassroom(payload: Session, id: string) {
  return read(async (db) => {
    const user = await actor(db, payload)
    const classroom = await db.classroom.findUnique({ where: { id } })
    if (!classroom) throw new RequestError('班级不存在', 404)
    const canManage =
      (user.role === 'admin' || classroom.ownerId === user.id) && (await canTeach(user.id, db))
    const member = await db.classMembership.findUnique({
      where: { classroomId_userId: { classroomId: id, userId: user.id } },
    })
    if (!canManage && !member) throw new RequestError('无权查看该班级', 403)
    if (!canManage) return { ...summary(classroom), canManage: false, isMember: true }
    const memberships = await db.classMembership.findMany({
      where: { classroomId: id },
      orderBy: { joinedAt: 'asc' },
    })
    const users = new Map(
      (
        await db.user.findMany({
          where: { id: { in: memberships.map((m) => m.userId) }, accountStatus: { not: 'deleted' } },
          select: memberSelect,
        })
      ).map((u) => [u.id, u]),
    )
    return {
      ...classroom,
      canManage: true,
      isMember: !!member,
      members: memberships.flatMap((m) => {
        const user = users.get(m.userId)
        return user
          ? [
              {
                userId: user.id,
                username: user.username,
                displayName: user.displayName,
                studentId: user.studentId,
                isTestAccount: user.isTestAccount,
                joinedAt: m.joinedAt,
              },
            ]
          : []
      }),
    }
  })
}
export async function updateClassroom(payload: Session, id: string, input: unknown) {
  const data = fields(input)
  return transaction(async (db) => {
    await managed(db, payload, id, true)
    return db.classroom.update({ where: { id }, data })
  })
}
export async function rotateClassroomInvite(payload: Session, id: string) {
  return transaction(async (db) => {
    await managed(db, payload, id, true)
    return db.classroom.update({ where: { id }, data: { inviteCode: inviteCode() } })
  })
}
export async function leaveClassroom(payload: Session, id: string) {
  return transaction(async (db) => {
    const user = await actor(db, payload, true)
    await db.classMembership.deleteMany({ where: { classroomId: id, userId: user.id } })
    return { ok: true }
  })
}
export async function removeClassMember(payload: Session, id: string, userId: string) {
  return transaction(async (db) => {
    await managed(db, payload, id, true)
    await db.classMembership.deleteMany({ where: { classroomId: id, userId } })
    return { ok: true }
  })
}
export async function getTeachingGrant(payload: Session, userId: string) {
  return read(async (db) => {
    const admin = await actor(db, payload)
    if (admin.role !== 'admin') throw new RequestError('需要管理员权限', 403)
    if (!(await db.user.findFirst({ where: { id: userId, accountStatus: { not: 'deleted' } } })))
      throw new RequestError('用户不存在', 404)
    return { userId, enabled: !!(await db.teacherGrant.findUnique({ where: { userId } })) }
  })
}
export async function setTeachingGrant(payload: Session, userId: string, enabled: unknown) {
  if (typeof enabled !== 'boolean') throw new RequestError('教师授权状态无效')
  return transaction(async (db) => {
    const admin = await actor(db, payload, true)
    if (admin.role !== 'admin') throw new RequestError('需要管理员权限', 403)
    await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`
    const target = await db.user.findFirst({
      where: { id: userId, accountStatus: { not: 'deleted' } },
      select: identitySelect,
    })
    if (!target) throw new RequestError('用户不存在', 404)
    if (target.role === 'admin') throw new RequestError('管理员已具备班级管理权限')
    if (enabled && target.accountStatus !== 'active') throw new RequestError('请先启用账号')
    if (enabled)
      await db.teacherGrant.upsert({
        where: { userId },
        create: { userId, grantedBy: admin.id },
        update: { grantedBy: admin.id },
      })
    else await db.teacherGrant.deleteMany({ where: { userId } })
    await db.auditEvent.create({
      data: {
        actorId: admin.id,
        action: enabled ? 'classroom.teaching.grant' : 'classroom.teaching.revoke',
        targetId: userId,
        detail: '{}',
      },
    })
    return { userId, enabled }
  })
}

function csvCell(value: unknown) {
  let text = String(value ?? '')
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
function csvLine(values: unknown[]) {
  return values.map(csvCell).join(',')
}

function scoreFilters(input: unknown = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('成绩筛选条件无效')
  const { search, questionId, category } = input as Record<string, unknown>
  if (search !== undefined && (typeof search !== 'string' || search.length > 100))
    throw new RequestError('学生搜索关键词最多 100 个字符')
  if (questionId !== undefined && (typeof questionId !== 'string' || questionId.length > 100))
    throw new RequestError('题目筛选无效')
  if (
    category !== undefined &&
    (typeof category !== 'string' || !['', 'basic', 'attack', 'defense'].includes(category))
  )
    throw new RequestError('题型筛选无效')
  return {
    search: String(search || '').trim(),
    questionId: String(questionId || ''),
    category: String(category || ''),
  }
}
function scoreStudentWhere(userIds: string[], search: string): Prisma.UserWhereInput {
  return {
    id: { in: userIds },
    role: 'student',
    isTestAccount: false,
    accountStatus: { not: 'deleted' },
    ...(search
      ? {
          OR: ['username', 'displayName', 'studentId'].map((field) => ({
            [field]: { contains: search, mode: 'insensitive' },
          })),
        }
      : {}),
  }
}
function scoreQuestionWhere(filters: ReturnType<typeof scoreFilters>): Prisma.QuestionWhereInput {
  return {
    status: 'published',
    ...(filters.questionId ? { id: filters.questionId } : {}),
    ...(filters.category === 'basic'
      ? { category: { notIn: ['security', 'adversarial'] } }
      : filters.category
        ? { category: { in: ['security', 'adversarial'] }, role: filters.category }
        : {}),
  }
}
const scoreQuestionSelect = {
  id: true,
  title: true,
  moduleCode: true,
  number: true,
  category: true,
  role: true,
} as const
const questionOrder = [
  { moduleCode: 'asc' },
  { number: 'asc' },
  { id: 'asc' },
] as Prisma.QuestionOrderByWithRelationInput[]
function basicTotal(rows: AdminStudentQuestionScore[]) {
  return rows
    .filter((row) => row.category === 'basic' && row.score !== null)
    .reduce((sum, row) => sum + row.score!, 0)
}
function submissionOutcome(status: string, rawResult: string | null) {
  if (['pending', 'queued', 'judging', 'baseline', 'opponents', 'running'].includes(status)) return 'pending'
  if (['stale', 'outdated'].includes(status)) return 'outdated'
  const result = parseJson<Record<string, unknown> | null>(rawResult, null)
  const baseline = result?.baseline
  if (
    status === 'baseline_failed' ||
    result?.qualified === false ||
    result?.baselinePassed === false ||
    (baseline && typeof baseline === 'object' && 'passed' in baseline && baseline.passed === false)
  )
    return 'baseline_failed'
  const failure = result?.evaluationStatus
  if (failure === 'student_error' || failure === 'timeout' || failure === 'system_error') return failure
  if (status === 'student_error' || status === 'timeout' || status === 'system_error') return status
  if (['failed', 'error'].includes(status)) return 'error'
  return status === 'completed' ? 'completed' : 'unknown'
}
export async function getClassroomScores(payload: Session, id: string, input: Record<string, unknown> = {}) {
  const filters = scoreFilters(input)
  const page = pageNumber(input.page, 1, '页码')
  const pageSize = Math.min(pageNumber(input.pageSize, 20, '每页数量'), 100)
  const skip = (page - 1) * pageSize
  if (!Number.isSafeInteger(skip) || skip > 2147483647) throw new RequestError('页码超出支持范围')
  return read(async (db) => {
    const classroom = await managed(db, payload, id)
    const memberships = await db.classMembership.findMany({
      where: { classroomId: id },
      select: { userId: true },
    })
    const where = scoreStudentWhere(
      memberships.map((m) => m.userId),
      filters.search,
    )
    const [students, total, questions] = await Promise.all([
      db.user.findMany({
        where,
        select: memberSelect,
        orderBy: [{ username: 'asc' }, { id: 'asc' }],
        skip,
        take: pageSize,
      }),
      db.user.count({ where }),
      db.question.findMany({
        where: scoreQuestionWhere(filters),
        select: scoreQuestionSelect,
        orderBy: questionOrder,
      }),
    ])
    const scores = await questionScoresForStudents(
      db,
      students.map((s) => s.id),
    )
    const questionIds = new Set(questions.map((q) => q.id))
    const latestIds = [...scores.values()].flatMap((rows) =>
      rows.flatMap((row) =>
        questionIds.has(row.questionId) && row.latestSubmission ? [row.latestSubmission.id] : [],
      ),
    )
    // Read result only for displayed latest submissions and publish an allowlisted outcome, never raw diagnostics.
    const latestOutcomes = new Map(
      (
        await db.submission.findMany({
          where: { id: { in: latestIds } },
          select: { id: true, status: true, result: true },
        })
      ).map((s) => [s.id, submissionOutcome(s.status, s.result)]),
    )
    return {
      classroom: { id: classroom.id, name: classroom.name },
      questions: questions.map((q) => ({ ...q, category: normalizeCategory(q.category) })),
      students: students.map((student) => {
        const rows = scores.get(student.id)!
        const byQuestion = new Map(rows.map((row) => [row.questionId, row]))
        return {
          userId: student.id,
          username: student.username,
          displayName: student.displayName,
          studentId: student.studentId,
          basicTotalScore: basicTotal(rows),
          scores: questions.map((q) => {
            const row = byQuestion.get(q.id)
            return {
              questionId: q.id,
              score: row?.score ?? null,
              state: row?.state ?? 'not_submitted',
              updating: row?.updating ?? false,
              latestSubmission: row?.latestSubmission
                ? {
                    ...row.latestSubmission,
                    outcome: latestOutcomes.get(row.latestSubmission.id) || 'unknown',
                  }
                : null,
            }
          }),
        }
      }),
      total,
      page,
      pageSize,
    }
  })
}

export async function exportClassrooms(payload: Session, ids: unknown, input?: unknown) {
  const filters = scoreFilters(input)
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 100)
  )
    throw new RequestError('请选择 1～50 个班级')
  const classroomIds = [...new Set(ids)] as string[]
  const files = await read(async (db) => {
    const user = await actor(db, payload)
    if (!(await canTeach(user.id, db))) throw new RequestError('需要教师或管理员权限', 403)
    const classrooms = await db.classroom.findMany({
      where: { id: { in: classroomIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (
      classrooms.length !== classroomIds.length ||
      classrooms.some((c) => user.role !== 'admin' && c.ownerId !== user.id)
    )
      throw new RequestError('无权导出所选班级', 403)
    const memberships = await db.classMembership.findMany({ where: { classroomId: { in: classroomIds } } })
    const students = await db.user.findMany({
      where: scoreStudentWhere(
        memberships.map((m) => m.userId),
        filters.search,
      ),
      select: memberSelect,
      orderBy: [{ username: 'asc' }, { id: 'asc' }],
    })
    const questions = await db.question.findMany({
      where: scoreQuestionWhere(filters),
      select: scoreQuestionSelect,
      orderBy: questionOrder,
    })
    const scores = await questionScoresForStudents(
      db,
      students.map((s) => s.id),
    )
    const states = { pending: '评测中', no_score: '无有效成绩', outdated: '旧版本已失效', scored: '已计分' }
    return classrooms.map((classroom) => {
      const members = new Set(memberships.filter((m) => m.classroomId === classroom.id).map((m) => m.userId))
      const lines = [
        csvLine([
          '班级',
          '账号',
          '姓名',
          '学号',
          ...questions.map((q) => `${q.moduleCode}-${q.number} ${q.title}`),
          '基础总分',
        ]),
      ]
      for (const student of students.filter((s) => members.has(s.id))) {
        const rows = scores.get(student.id)!
        const byQuestion = new Map(rows.map((r) => [r.questionId, r]))
        lines.push(
          csvLine([
            classroom.name,
            student.username,
            student.displayName,
            student.studentId,
            ...questions.map((q) => {
              const row = byQuestion.get(q.id)
              return row ? (row.score ?? states[row.state]) : '未提交'
            }),
            basicTotal(rows),
          ]),
        )
      }
      // IDs, rather than user-controlled names, keep ZIP paths safe and unambiguous.
      return {
        filename: `classroom-${classroom.id}.csv`,
        data: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'),
      }
    })
  })
  if (files.length === 1)
    return { filename: files[0].filename, contentType: 'text/csv; charset=utf-8', data: files[0].data }
  const zip = new AdmZip()
  for (const file of files) zip.addFile(file.filename, file.data)
  return { filename: 'classrooms.zip', contentType: 'application/zip', data: zip.toBuffer() }
}
