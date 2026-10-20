import { apiGet, apiPost, apiPut, apiPostMultipart, getAuthToken } from './api'

export type HallCategory = 'basic' | 'adversarial'
export type ProblemRole = 'attack' | 'defense'
export interface QuestionDefinition {
  kind: 'algorithm' | 'model' | 'distillation' | 'agent'
  role?: ProblemRole
  scenarioId?: string
  weights: {
    enabled: boolean
    required: boolean
    extensions: string[]
    maxBytes: number
    description: string
    modelStructure?: string
    weightType?: string
    loadInterface?: string
    device?: string
    requiredKeys?: string[]
  }
  teacherApi: {
    enabled: boolean
    poolId?: string
    maxCalls?: number
    inputSchema?: string
    outputSchema?: string
    example?: string
    batchSize?: number
  }
  llm: { enabled: boolean; poolId?: string }
  evaluation: {
    packageId?: string
    version: string
    timeoutMs: number
    maxScore: number
    baselineMetric: string
    baselineThreshold: number
    successMetric: string
    successThreshold: number
    baselineCode?: string
    baselineWeightFixture?: string
    repetitions?: number
    parameters?: Record<string, unknown>
  }
}
export interface QuestionRecord {
  id: string
  title: string
  category: HallCategory | 'security'
  difficulty: string
  status?: string
  moduleCode?: string
  number?: number
  type?: string
  content?: string
  answerTemplate?: string | null
  solution?: string | null
  testConfig?: string | null
  revision: number
  definition: QuestionDefinition
  role?: ProblemRole
  scenarioId?: string
  myScore?: number | null
  myStatus?: string
  latestSubmissionStatus?: string | null
  attempted?: boolean
  hasHistoricalAttempts?: boolean
  scoreUpdatedAt?: string
  tags?: string[]
  dynamicScore?: DynamicSummary | null
}
export interface DynamicSummary {
  baselinePassed?: boolean
  qualified?: boolean | null
  successCount?: number | null
  opponentCount?: number | null
  snapshotId?: string | null
  scoringState?: string
  emptyPool?: boolean
  updating?: boolean
  updatedAt?: string
}
export interface CurrentDynamicScore extends DynamicSummary {
  score: number | null
  counted: boolean
  status: string
  scoreReachedAt?: string
  latestSubmissionStatus?: string
  publicMessage?: string
}
export interface SubmissionRecord {
  id: string
  questionId: string
  questionVersion?: number
  status: string
  phase?: string
  score: number | null
  maxScore?: number
  code?: string
  filename?: string
  createdAt: string
  updatedAt?: string
  result?: unknown
  dynamicScore?: DynamicSummary
  publicMessage?: string
  diagnostics?: SubmissionDiagnostics | null
}
export interface SubmissionDiagnostics {
  role: 'attack' | 'defense' | null
  questionVersion: number
  evaluationVersion: string
  historicalVersion: boolean
  phase: 'basic' | 'baseline' | 'opponents'
  state: string
  metrics: Record<string, number>
  baseline: {
    metric: string
    value: number | null
    threshold: number
    comparator: '>='
    passed: boolean | null
  } | null
  evaluation: {
    state: string
    snapshotRevision: number | null
    counted: boolean
    successCount: number | null
    opponentCount: number | null
    emptyPool: boolean
    pairs: {
      ordinal: number
      state: string
      success: boolean | null
      metric: string
      value: number | null
      threshold: number
    }[]
  } | null
  progress: { state: string; completedOpponents: number; totalOpponents: number | null } | null
}
export interface ApiPoolItem {
  id: string
  name: string
  kind: 'llm' | 'teacher'
  model: string
  modelVersion: string
  baseUrl: string
  credentialEnv: string
  parameters: Record<string, unknown>
  enabled: boolean
  isDefault: boolean
  revision: number
}
export interface TeacherLease {
  id: string
  state: string
  startsAt?: string | null
  expiresAt?: string | null
  serverTime: string
  endpoint?: string | null
  token?: string
  calls: number
  maxCalls?: number | null
  scope: string
  reason?: string
  userId?: string
  questionId?: string
  username?: string
  questionTitle?: string
}
export interface EvaluationPackage {
  id: string
  name: string
  digest: string
  createdAt: string
  manifest: Record<string, unknown>
  valid: boolean
}
export interface PackageValidation {
  valid: boolean
  manifest: Record<string, unknown>
  digest: string
  checks: unknown
}
export interface SelfTest {
  id: string
  packageId: string
  status: 'queued' | 'running' | 'completed'
  result?: {
    status: string
    score?: number
    maxScore?: number
    metrics?: Record<string, unknown>
    success?: boolean
    publicMessage?: string
    cleanupStatus?: string
  }
}
export interface BasicRank {
  rank: number
  userId: string
  displayName: string
  totalScore: number
  basicScore?: number
  tasksCompleted?: number
  scoreReachedAt?: string | null
}

export function defaultDefinition(): QuestionDefinition {
  return {
    kind: 'algorithm',
    weights: {
      enabled: false,
      required: false,
      extensions: ['.pt', '.pth'],
      maxBytes: 100 * 1024 * 1024,
      description: '',
    },
    teacherApi: { enabled: false },
    llm: { enabled: false },
    evaluation: {
      version: 'v1',
      timeoutMs: 60000,
      maxScore: 100,
      baselineMetric: 'qualificationMetric',
      baselineThreshold: 0,
      successMetric: 'successMetric',
      successThreshold: 0.5,
      repetitions: 1,
    },
  }
}
export function normalizeQuestion(raw: QuestionRecord): QuestionRecord {
  const fallback = defaultDefinition()
  let legacy: Record<string, unknown> = {}
  try {
    legacy = JSON.parse(raw.testConfig || '{}')
  } catch {
    /* obsolete configuration stays unavailable */
  }
  if (!raw.definition) {
    if (legacy.type === 'model_eval') {
      fallback.kind = 'model'
      fallback.weights.enabled = true
      fallback.weights.required = true
    }
    if (legacy.type === 'agent_attack_defense') {
      fallback.kind = 'agent'
      fallback.role = legacy.mode === 'defense' ? 'defense' : 'attack'
      fallback.scenarioId = typeof legacy.scenario === 'string' ? legacy.scenario : undefined
      fallback.llm.enabled = true
    }
  }
  return {
    ...raw,
    category: raw.category === 'security' ? 'adversarial' : raw.category,
    revision: raw.revision ?? 1,
    definition: {
      ...fallback,
      ...raw.definition,
      role: raw.role ?? raw.definition?.role ?? fallback.role,
      scenarioId: raw.scenarioId ?? raw.definition?.scenarioId ?? fallback.scenarioId,
      weights: { ...fallback.weights, ...raw.definition?.weights },
      teacherApi: { ...fallback.teacherApi, ...raw.definition?.teacherApi },
      llm: { ...fallback.llm, ...raw.definition?.llm },
      evaluation: { ...fallback.evaluation, ...raw.definition?.evaluation },
    },
  }
}
export function isTerminal(status: string): boolean {
  return ['passed', 'failed', 'error', 'completed', 'cancelled', 'timeout'].includes(status)
}
export function statusLabel(status?: string): string {
  const labels: Record<string, string> = {
    not_submitted: '未提交',
    queued: '排队中',
    pending: '排队中',
    running: '评测中',
    judging: '评测中',
    baseline: '基线评测中',
    opponents: '对手评测中',
    completed: '评测完成',
    passed: '评测完成',
    failed: '评测完成',
    error: '运行异常',
    timeout: '评测超时',
    cancelled: '已取消',
    updating: '重评中',
    qualified: '通过基线',
    unqualified: '未过基线',
    baseline_failed: '未过基线',
    uncounted: '本次不计分',
    not_counted: '本次不计分',
    incomplete: '评测未完成',
    scored: '已有正式成绩',
    active: '有效',
    draft: '草稿',
    review: '审核中',
    published: '已发布',
    archived: '已下架',
    preparing: '服务准备中',
    expired: '已到期',
    revoked: '已撤销',
    stale: '旧版本已失效',
  }
  return status ? (labels[status] ?? '等待状态更新') : '未提交'
}
export function parsedResult(submission: SubmissionRecord): Record<string, unknown> {
  try {
    const value = typeof submission.result === 'string' ? JSON.parse(submission.result) : submission.result
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
export function dynamicSummary(submission: SubmissionRecord): DynamicSummary {
  const result = parsedResult(submission)
  const details =
    result.details && typeof result.details === 'object' ? (result.details as Record<string, unknown>) : {}
  return { ...details, ...result, ...submission.dynamicScore } as DynamicSummary
}
export function validateMaterial(
  definition: QuestionDefinition,
  code: string,
  file: File | null,
): string | null {
  if (!code.trim()) return '请先完成代码填空。'
  if (!definition.weights.enabled && file) return '这道题不接受参数文件。'
  if (definition.weights.enabled && definition.weights.required && !file) return '请上传题目要求的参数文件。'
  if (file) {
    const suffix = '.' + file.name.split('.').pop()?.toLowerCase()
    const allowed = definition.weights.extensions.map((ext) =>
      ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase(),
    )
    if (allowed.length && !allowed.includes(suffix)) return `参数格式须为 ${allowed.join('、')}。`
    if (definition.weights.maxBytes > 0 && file.size > definition.weights.maxBytes)
      return `参数文件超过 ${(definition.weights.maxBytes / 1024 / 1024).toFixed(1)} MB 上限。`
  }
  return null
}
export function questionDefinitionErrors(definition: QuestionDefinition, category: HallCategory): string[] {
  const errors: string[] = []
  if (category === 'adversarial' && (!definition.role || !definition.scenarioId?.trim()))
    errors.push('对抗题须配置固定角色和共同攻防关联标识。')
  if (!definition.evaluation.packageId) errors.push('请绑定通过校验的 Docker Compose 环境包。')
  if (!(definition.evaluation.timeoutMs > 0) || !(definition.evaluation.maxScore > 0))
    errors.push('超时和满分必须大于 0。')
  if (
    ![definition.evaluation.baselineThreshold, definition.evaluation.successThreshold].every(Number.isFinite)
  )
    errors.push('评分阈值必须为有效数字。')
  if (definition.weights.required && !definition.weights.enabled)
    errors.push('必需参数须先开启参数上传能力。')
  if (
    definition.weights.enabled &&
    (!(definition.weights.maxBytes > 0) || !definition.weights.extensions.length)
  )
    errors.push('参数上传须配置格式与大小上限。')
  if (definition.teacherApi.enabled && !definition.teacherApi.poolId)
    errors.push('教师 API 须绑定平台教师服务配置。')
  if (definition.llm.enabled && !definition.llm.poolId) errors.push('大模型评测须绑定平台模型配置。')
  if (
    ['model', 'distillation'].includes(definition.kind) &&
    (!definition.weights.enabled || !definition.weights.required)
  )
    errors.push('模型与蒸馏题必须启用必需参数上传。')
  if (definition.kind === 'distillation' && !definition.teacherApi.enabled)
    errors.push('蒸馏题必须启用教师 API。')
  if (definition.kind === 'agent' && !definition.llm.enabled) errors.push('Agent 题必须绑定平台大模型评测。')
  if (
    category === 'adversarial' &&
    !definition.evaluation.baselineCode?.trim() &&
    !definition.evaluation.packageId
  )
    errors.push('对抗题须在环境包或配置中提供相反角色基线。')
  return errors
}

export const prdApi = {
  questions: async (category: HallCategory) => {
    return (await apiGet<QuestionRecord[]>(`/questions?category=${category}`)).map(normalizeQuestion)
  },
  arenaScore: (id: string) => apiGet<CurrentDynamicScore>(`/arena/questions/${encodeURIComponent(id)}/score`),
  question: async (id: string) =>
    normalizeQuestion(await apiGet<QuestionRecord>(`/questions/${encodeURIComponent(id)}`)),
  history: (id: string) => apiGet<SubmissionRecord[]>(`/questions/${encodeURIComponent(id)}/submissions`),
  submission: (id: string) => apiGet<SubmissionRecord>(`/submissions/${encodeURIComponent(id)}`),
  pool: () => apiGet<ApiPoolItem[]>('/admin/api-pool'),
  savePool: (body: Partial<ApiPoolItem>, id?: string) =>
    id
      ? apiPut<ApiPoolItem>(`/admin/api-pool/${encodeURIComponent(id)}`, body)
      : apiPost<ApiPoolItem>('/admin/api-pool', body),
  lease: (id: string) => apiGet<TeacherLease | null>(`/questions/${encodeURIComponent(id)}/teacher-lease`),
  startLease: (id: string) =>
    apiPost<TeacherLease>(`/questions/${encodeURIComponent(id)}/teacher-lease/start`, {}),
  renewLease: (id: string) =>
    apiPost<TeacherLease>(`/questions/${encodeURIComponent(id)}/teacher-lease/renew`, {}),
  leases: () => apiGet<TeacherLease[]>('/admin/teacher-leases'),
  revokeLease: (id: string) =>
    apiPost<TeacherLease>(`/admin/teacher-leases/${encodeURIComponent(id)}/revoke`, {}),
  packages: () => apiGet<EvaluationPackage[]>('/admin/evaluation-packages'),
  uploadPackage: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return apiPostMultipart<EvaluationPackage>('/admin/evaluation-packages', body)
  },
  validatePackage: (id: string) =>
    apiPost<PackageValidation>(`/admin/evaluation-packages/${encodeURIComponent(id)}/validate`, {}),
  selfTest: (
    id: string,
    body: {
      code: string
      role?: ProblemRole | null
      category: HallCategory
      definition: QuestionDefinition
      modelPoolId?: string
      phase: 'basic' | 'baseline' | 'opponent'
      parameters?: Record<string, unknown>
      opponent?: { code: string; weightFixture?: string }
      weightFixture?: string
    },
  ) => apiPost<SelfTest>(`/admin/evaluation-packages/${encodeURIComponent(id)}/self-tests`, body),
  selfTestStatus: (packageId: string, id: string) =>
    apiGet<SelfTest>(
      `/admin/evaluation-packages/${encodeURIComponent(packageId)}/self-tests/${encodeURIComponent(id)}`,
    ),
  ranks: () => apiGet<BasicRank[]>('/leaderboard?limit=100'),
}

/** Send the frozen submission materials; no student model/API selection is sent. */
export function submitMaterials(
  body: FormData,
  onProgress: (percent: number) => void,
): Promise<SubmissionRecord> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/submissions')
    request.timeout = 600000
    const token = getAuthToken()
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onerror = () => reject(new Error('提交连接中断，可重新点击提交重试；系统会避免重复受理。'))
    request.ontimeout = () =>
      reject(new Error('上传或受理等待超时，请先检查提交记录，再使用同一份材料重试。'))
    request.onload = () => {
      try {
        const response = JSON.parse(request.responseText)
        if (request.status < 200 || request.status >= 300 || response.code !== 0)
          throw new Error(response.message || '提交失败')
        if (!response.data || typeof response.data.id !== 'string' || !response.data.id.trim())
          throw new Error('提交响应缺少受理编号，请检查提交记录后重试。')
        resolve(response.data as SubmissionRecord)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('提交响应无法解析。'))
      }
    }
    request.send(body)
  })
}
