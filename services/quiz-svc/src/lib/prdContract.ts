import { isOriginalD02Evaluation, ORIGINAL_D02_TIMEOUT_MS } from './modelCallBudget.js'

export interface QuestionDefinition {
  kind: 'algorithm' | 'model' | 'distillation' | 'agent'
  weights: {
    enabled: boolean
    required: boolean
    extensions: string[]
    maxBytes: number
    description?: string
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
    repetitions: number
    [key: string]: unknown
  }
}

export class RequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

export function normalizeCategory(category: string): 'basic' | 'adversarial' {
  return category === 'security' || category === 'adversarial' ? 'adversarial' : 'basic'
}

export function normalizeDefinition(raw: unknown): QuestionDefinition {
  const value =
    typeof raw === 'string' ? parseJson<Record<string, any>>(raw, {}) : ((raw || {}) as Record<string, any>)
  const w = value.weights || {},
    t = value.teacherApi || {},
    l = value.llm || {},
    e = value.evaluation || {}
  const definition: QuestionDefinition = {
    kind: value.kind || 'algorithm',
    weights: {
      ...w,
      enabled: w.enabled === true,
      required: w.required === true,
      extensions: w.extensions || ['.pt', '.pth'],
      maxBytes: w.maxBytes ?? 100 * 1024 * 1024,
    },
    teacherApi: { ...t, enabled: t.enabled === true, maxCalls: t.maxCalls ?? 1000 },
    llm: { ...l, enabled: l.enabled === true },
    evaluation: {
      ...e,
      version: e.version || 'v1',
      timeoutMs: e.timeoutMs ?? 120000,
      maxScore: e.maxScore ?? 100,
      baselineMetric: e.baselineMetric || 'qualificationMetric',
      baselineThreshold: e.baselineThreshold ?? 0,
      successMetric: e.successMetric || 'successMetric',
      successThreshold: e.successThreshold ?? 0.5,
      repetitions: e.repetitions ?? 1,
    },
  }
  if (!['algorithm', 'model', 'distillation', 'agent'].includes(definition.kind))
    throw new RequestError('未知评测方式')
  if (definition.weights.required && !definition.weights.enabled)
    throw new RequestError('必需参数时必须开启参数上传')
  if (
    !Array.isArray(definition.weights.extensions) ||
    !definition.weights.extensions.length ||
    definition.weights.extensions.some((s: unknown) => typeof s !== 'string' || !/^\.[a-zA-Z0-9]+$/.test(s))
  )
    throw new RequestError('参数扩展名必须是 .pt 等格式')
  if (
    !Number.isSafeInteger(definition.weights.maxBytes) ||
    definition.weights.maxBytes <= 0 ||
    definition.weights.maxBytes > 500 * 1024 * 1024
  )
    throw new RequestError('参数大小上限必须在 1～524288000 字节内')
  if (!Number.isSafeInteger(definition.teacherApi.maxCalls) || definition.teacherApi.maxCalls! < 1)
    throw new RequestError('查询额度必须是正整数')
  if (!Number.isFinite(definition.evaluation.maxScore) || definition.evaluation.maxScore <= 0)
    throw new RequestError('满分必须为正数')
  if (
    !Number.isSafeInteger(definition.evaluation.timeoutMs) ||
    definition.evaluation.timeoutMs < 1000 ||
    definition.evaluation.timeoutMs > (isOriginalD02Evaluation(definition.evaluation) ? ORIGINAL_D02_TIMEOUT_MS : 3600000)
  )
    throw new RequestError(isOriginalD02Evaluation(definition.evaluation)
      ? '原始300样本D02评测超时必须在 1 秒至 24 小时内' : '评测超时必须在 1 秒至 1 小时内')
  if (
    !Number.isFinite(definition.evaluation.baselineThreshold) ||
    !Number.isFinite(definition.evaluation.successThreshold)
  )
    throw new RequestError('基线与对抗阈值必须是有限数值')
  if (!Number.isSafeInteger(definition.evaluation.repetitions) || definition.evaluation.repetitions < 1)
    throw new RequestError('评测重复次数必须为正整数')
  if (definition.teacherApi.enabled && !definition.teacherApi.poolId) throw new RequestError('请选择教师 API')
  if (definition.llm.enabled && !definition.llm.poolId) throw new RequestError('请选择固定评测模型')
  return definition
}

export interface PoolBinding {
  poolId: string
  revision: number
  name: string
  kind: string
  model: string
  modelVersion: string
  baseUrl: string
  credentialEnv: string | null
  parameters: Record<string, unknown>
}
export interface SubmissionSnapshot {
  answerTemplate?: string | null
  questionId: string
  questionVersion: number
  category: string
  role: string | null
  scenarioId: string | null
  evaluationVersion: string
  definition: QuestionDefinition
  modelBinding?: PoolBinding
  teacherBinding?: PoolBinding
}

export function validateOptionalProfile(input: { studentId?: unknown; phone?: unknown }) {
  const studentId = String(input.studentId ?? '').trim(),
    phone = String(input.phone ?? '').trim()
  if (studentId && !/^[A-Za-z0-9_-]{1,64}$/.test(studentId))
    throw new RequestError('学号限 1～64 位字母、数字、下划线或连字符')
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone))
    throw new RequestError('手机号需为 7～15 位数字，可带 + 国际区号')
  return { studentId: studentId || null, phone: phone || null }
}
