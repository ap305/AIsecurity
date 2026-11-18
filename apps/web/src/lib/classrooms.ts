import { apiGet, apiPost, apiPut, ApiError, assertCurrentToken, getAuthToken, reportAuthFailure } from './api'

export interface ClassroomSummary {
  id: string
  name: string
  description: string
  archivedAt: string | null
  createdAt: string
}
export interface ManagedClassroom extends ClassroomSummary {
  ownerId: string
  inviteCode: string
}
export interface ClassMember {
  userId: string
  username: string
  displayName: string
  studentId: string | null
  isTestAccount: boolean
  joinedAt: string
}
export interface ClassroomDetail extends ClassroomSummary {
  canManage: boolean
  isMember: boolean
  ownerId?: string
  inviteCode?: string
  members?: ClassMember[]
}
export interface ClassroomList {
  canTeach: boolean
  owned: ManagedClassroom[]
  joined: ClassroomSummary[]
}
export interface TeachingGrant {
  userId: string
  enabled: boolean
}
export interface ClassroomScoreFilters {
  search?: string
  questionId?: string
  category?: '' | 'basic' | 'attack' | 'defense'
}
export interface ClassroomScoreCell {
  questionId: string
  score: number | null
  state: 'scored' | 'pending' | 'no_score' | 'outdated' | 'not_submitted'
  updating: boolean
  latestSubmission: {
    id: string
    status: string
    outcome:
      | 'pending'
      | 'completed'
      | 'baseline_failed'
      | 'student_error'
      | 'timeout'
      | 'system_error'
      | 'error'
      | 'outdated'
      | 'unknown'
    score: number | null
    questionVersion: number
    createdAt: string
  } | null
}
export interface ClassroomScores {
  classroom: { id: string; name: string }
  questions: {
    id: string
    title: string
    moduleCode: string
    number: number
    category: 'basic' | 'adversarial'
    role: string | null
  }[]
  students: {
    userId: string
    username: string
    displayName: string
    studentId: string | null
    basicTotalScore: number
    scores: ClassroomScoreCell[]
  }[]
  total: number
  page: number
  pageSize: number
}
const timeout = 15000
const path = (id: string) => `/classrooms/${encodeURIComponent(id)}`

// Binary downloads and DELETE use the same credential fence and bounded wait as JSON API calls.
async function rawRequest<T>(route: string, options: RequestInit, parse: (response: Response) => Promise<T>) {
  const token = getAuthToken(),
    controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = (async () => {
      const response = await fetch(`/api${route}`, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new ApiError(
          response.status,
          typeof body?.message === 'string' ? body.message : '请求失败，请稍后重试',
          typeof body?.code === 'number' ? body.code : undefined,
        )
      }
      return parse(response)
    })()
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('请求超时，请检查网络后重试'))
        }, timeout)
      }),
    ])
    assertCurrentToken(token)
    return result
  } catch (error) {
    assertCurrentToken(token)
    reportAuthFailure(error, token)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
const remove = (route: string) =>
  rawRequest(route, { method: 'DELETE' }, async (response) => {
    const json = await response.json()
    if (json?.code !== 0 || json?.data?.ok !== true)
      throw new ApiError(
        response.status,
        typeof json?.message === 'string' ? json.message : '操作失败，请刷新后重试',
        json?.code,
      )
    return json.data as { ok: true }
  })
export const classroomsApi = {
  capabilities: () => apiGet<{ canTeach: boolean }>('/classrooms/capabilities', 10000),
  list: () => apiGet<ClassroomList>('/classrooms', timeout),
  get: (id: string) => apiGet<ClassroomDetail>(path(id), timeout),
  scores: (id: string, filters: ClassroomScoreFilters & { page?: number; pageSize?: number } = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined && value !== '') query.set(key, String(value))
    return apiGet<ClassroomScores>(`${path(id)}/scores?${query}`, timeout)
  },
  create: (input: { name: string; description: string }) =>
    apiPost<ManagedClassroom>('/classrooms', input, timeout),
  join: (inviteCode: string) => apiPost<ClassroomSummary>('/classrooms/join', { inviteCode }, timeout),
  update: (id: string, input: { name?: string; description?: string; archived?: boolean }) =>
    apiPut<ManagedClassroom>(path(id), input, timeout),
  rotateInvite: (id: string) => apiPost<ManagedClassroom>(`${path(id)}/invite`, {}, timeout),
  leave: (id: string) => remove(`${path(id)}/membership`),
  removeMember: (id: string, userId: string) => remove(`${path(id)}/members/${encodeURIComponent(userId)}`),
  getTeaching: (userId: string) =>
    apiGet<TeachingGrant>(`/admin/users/${encodeURIComponent(userId)}/teaching`, timeout),
  setTeaching: (userId: string, enabled: boolean) =>
    apiPut<TeachingGrant>(`/admin/users/${encodeURIComponent(userId)}/teaching`, { enabled }, timeout),
  export: (classroomIds: string[], filters?: ClassroomScoreFilters) =>
    rawRequest(
      '/classrooms/export',
      { method: 'POST', body: JSON.stringify({ classroomIds, ...(filters ? { filters } : {}) }) },
      async (response) => {
        const type = response.headers.get('content-type') || ''
        if (!/^(text\/csv|application\/zip)(?:;|$)/i.test(type)) throw new Error('导出文件格式异常，请重试')
        const name = response.headers
          .get('content-disposition')
          ?.match(/filename="([A-Za-z0-9_-]+\.(?:csv|zip))"/)?.[1]
        return {
          filename: name || (type.startsWith('text/csv') ? 'classroom.csv' : 'classrooms.zip'),
          blob: await response.blob(),
        }
      },
    ),
}
