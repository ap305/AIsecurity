import { normalizeDefinition, type QuestionDefinition } from './prdContract.js'
import { SCENARIO_PAIR_BY_QUESTION_ID } from './scenarioQuestions.js'

export const LEGACY_QUESTION_IDS = [
  'AGENDABOT-AD-ATK',
  'AGENDABOT-AD-DEF',
  'CHATOPS-AD-ATK',
  'CHATOPS-AD-DEF',
  'SUPPORTBOT-AD-ATK',
  'SUPPORTBOT-AD-DEF',
  'WEBBOT-AD-ATK',
  'WEBBOT-AD-DEF',
  'DEEPFAKE-AD',
  'DEEPFAKE-AD-DEF',
  'DEEPFAKE-IMG',
  'DEEPFAKE-IMG-DEF',
  'MNIST-BD',
  'MNIST-BD-DEF',
  'MNIST-POISON',
  'MNIST-POISON-DEF',
  'PATCH-AD',
  'PATCH-AD-DEF',
  'WATERMARK-AD',
  'WATERMARK-AD-DEF',
] as const

export interface LegacyConversionRecord {
  questionId: string
  scenarioId: string
  role: 'attack' | 'defense'
  title: string
  content: string
  answerTemplate: string
  solution: string
  definition: any
  packageDirectory: string
  referenceCodePath: string
  calibrationRequired: boolean
  calibration: {
    baseline: 'reference' | 'fixed'
    baselineThreshold?: number
    opponent: 'reference' | 'fixed'
    successThreshold?: number
  }
  poolSpec?: { id: string; kind: string; name: string; parameters: Record<string, unknown> }
  provenance: Record<string, unknown>
  metrics?: { qualification: string; success: string }
  thresholdContentPlaceholder?: string
}

export function validateLegacyRecords(input: unknown): LegacyConversionRecord[] {
  if (!Array.isArray(input) || !input.length) throw new Error('转换清单为空')
  const ids = new Set<string>()
  for (const row of input) {
    if (!row || !LEGACY_QUESTION_IDS.includes(row.questionId) || ids.has(row.questionId))
      throw new Error('转换清单包含未授权或重复的题目ID')
    ids.add(row.questionId)
    const pair = SCENARIO_PAIR_BY_QUESTION_ID.get(row.questionId)
    if (
      !pair ||
      row.scenarioId !== pair.key ||
      row.role !== (pair.attackId === row.questionId ? 'attack' : 'defense')
    )
      throw new Error('转换清单场景或固定角色与原题目ID不一致')
    for (const key of [
      'title',
      'content',
      'answerTemplate',
      'solution',
      'packageDirectory',
      'referenceCodePath',
    ])
      if (typeof row[key] !== 'string' || !row[key].trim()) throw new Error(`转换清单缺少${key}`)
    if (
      !row.provenance ||
      !row.calibration ||
      !['reference', 'fixed'].includes(row.calibration.baseline) ||
      !['reference', 'fixed'].includes(row.calibration.opponent)
    )
      throw new Error('缺少可审计的校准政策')
    for (const [mode, threshold] of [
      ['baseline', 'baselineThreshold'],
      ['opponent', 'successThreshold'],
    ]) {
      if (row.calibration[mode] === 'fixed' && !Number.isFinite(row.calibration[threshold]))
        throw new Error('固定门槛必须明确声明，不能用默认值替代')
    }
    const evaluation = row.definition?.evaluation
    if (
      !evaluation ||
      !['baselineMetric', 'successMetric'].every(
        (key) => typeof evaluation[key] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(evaluation[key]),
      )
    )
      throw new Error('转换清单必须明确声明基线与对抗指标')
    if (row.definition.llm?.enabled === true && (!row.poolSpec || row.poolSpec.kind !== 'llm'))
      throw new Error('真实模型课程缺少固定模型池声明')
  }
  return input
}

export function validateLegacyMetrics(metrics: unknown, name: string): number {
  const value =
    metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>)[name] : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('官方参考实测缺少有限的声明指标')
  return value
}

export function validateLegacyAcceptance(
  input: unknown,
  records: LegacyConversionRecord[],
): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('验收材料必须为题目ID到代码路径的JSON映射')
  const allowed = new Set(records.map((row) => row.questionId))
  const entries = Object.entries(input)
  for (const [questionId, codePath] of entries) {
    if (!allowed.has(questionId) || !LEGACY_QUESTION_IDS.includes(questionId as any))
      throw new Error('验收材料包含未授权的题目ID')
    if (typeof codePath !== 'string' || !codePath.trim() || codePath.includes('\0'))
      throw new Error('验收材料只允许代码路径，不能覆盖门槛或题目配置')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

export function legacyCalibrationDiagnostic(
  row: LegacyConversionRecord,
  definition: QuestionDefinition,
  baselineMetrics: unknown,
) {
  const observed = validateLegacyMetrics(baselineMetrics, definition.evaluation.baselineMetric)
  const threshold = definition.evaluation.baselineThreshold
  const qualified = observed >= threshold
  return {
    policy: row.calibration.baseline,
    metric: definition.evaluation.baselineMetric,
    observed,
    threshold,
    qualified,
    status: qualified ? 'reference_qualified' : 'requires_acceptance',
    readyToPublish: false,
  }
}

/** Publication requires completed tests for the exact selected verification material and definition. */
export function assertLegacyVerification(
  definition: QuestionDefinition,
  proof: any,
  expected: { baseline: string; opponent: string },
  codeDigest: string,
): void {
  for (const phase of ['baseline', 'opponent'] as const) {
    const phaseProof = proof?.[phase]
    const record = phaseProof?.record
    if (!phaseProof || phaseProof.configuration !== expected[phase] || phaseProof.codeDigest !== codeDigest)
      throw new Error('正式验收代码或评测配置与已验证材料不一致，必须重新自测')
    if (
      record?.status !== 'completed' ||
      record.result?.status !== 'completed' ||
      record.result.cleanupStatus !== 'cleaned'
    )
      throw new Error('正式验收尚未完成或未清理，不能发布')
    const metric =
      phase === 'baseline' ? definition.evaluation.baselineMetric : definition.evaluation.successMetric
    const observed = validateLegacyMetrics(record.result.metrics, metric)
    if (phase === 'baseline' && observed < definition.evaluation.baselineThreshold)
      throw new Error('正式验收未通过原固定基线门槛，不能发布')
  }
}

const BOT_SCENARIOS = ['chatops', 'agendabot', 'supportbot', 'webbot']
export const BOT_ZERO_REFERENCE_POLICY = 'user_approved_bot_zero_reference_one_win'

function botSamples(row: LegacyConversionRecord, metrics?: unknown): number {
  const samples = row.definition?.evaluation?.samples
  if (
    !Number.isSafeInteger(samples) ||
    samples <= 0 ||
    samples > 100 ||
    row.provenance.samples !== samples ||
    (row.definition.evaluation.parameters?.samples !== undefined &&
      row.definition.evaluation.parameters.samples !== samples) ||
    (metrics !== undefined && (metrics as Record<string, unknown>)?.samples !== samples)
  )
    throw new Error('Bot 固定样本数必须为一致的正整数：评测参数、来源与实际测量不一致')
  return samples
}

/** The approved one-win exception applies only to an exactly-zero Bot reference rate. */
export function legacyOpponentThresholdDiagnostic(row: LegacyConversionRecord, metrics: unknown) {
  const metric = row.definition.evaluation.successMetric
  const observed = validateLegacyMetrics(metrics, metric)
  const isBot = BOT_SCENARIOS.includes(row.scenarioId)
  const samples = isBot ? botSamples(row, metrics) : undefined
  if (isBot && (observed < 0 || observed > 1)) throw new Error('Bot 对抗实测胜率必须在 0 到 1 之间')
  const oneWin = isBot && row.calibration.opponent === 'reference' && observed === 0
  return {
    policy: oneWin ? BOT_ZERO_REFERENCE_POLICY : row.calibration.opponent,
    metric,
    observed,
    threshold: oneWin
      ? 1 / samples!
      : row.calibration.opponent === 'fixed'
        ? row.calibration.successThreshold!
        : observed,
    ...(samples !== undefined ? { samples } : {}),
    ...(oneWin
      ? { decision: '用户批准：仅参考对抗胜率为0的Bot题，至少成功1个固定样本；非0原值和基线不变' }
      : {}),
  }
}

/** Bot successMetric is a nonnegative own-role win rate, not an ML margin. */
export function assertLegacySuccessPolicy(row: LegacyConversionRecord, definition: QuestionDefinition): void {
  if (
    BOT_SCENARIOS.includes(row.scenarioId) &&
    (!Number.isFinite(definition.evaluation.successThreshold) ||
      definition.evaluation.successThreshold <= 0 ||
      definition.evaluation.successThreshold > 1)
  )
    throw new Error(
      'Bot 对抗胜率门槛必须大于 0 且不超过 1，不能将正常失败判胜；零参考应按已批准的 1/固定样本数政策重新校准',
    )
}

export function legacyQuestionUpdate(row: LegacyConversionRecord, definition: QuestionDefinition) {
  // Recheck saved checkpoints too: a previously calibrated zero threshold is unsafe to publish.
  assertLegacySuccessPolicy(row, definition)
  const evaluation = definition.evaluation
  let thresholdText =
    `## 本版本冻结门槛\n\n基线指标 \`${row.metrics?.qualification || evaluation.baselineMetric}\` ≥ ${evaluation.baselineThreshold}；` +
    `对抗指标 \`${row.metrics?.success || evaluation.successMetric}\` ≥ ${evaluation.successThreshold}。等于门槛也通过；原课程硬约束继续适用。`
  if (BOT_SCENARIOS.includes(row.scenarioId)) {
    const samples = botSamples(row)
    thresholdText += `\n\n本题每个对阵固定 ${samples} 个样本。对抗门槛通常取官方参考实测胜率；仅当该实测值恰为 0 时，按已确认规则取 1/${samples} = ${1 / samples}（至少成功 1 个样本）。非零实测值及基线门槛不调整；0/${samples} 的正常对抗失败仍计入分母，判为失败。`
  }
  const source = row.content
    .replace(/\n*本题处于迁移校准阶段，未完成官方参考实测门槛前不得发布。/g, '')
    .trimEnd()
  const marker = row.thresholdContentPlaceholder || '<!-- FROZEN_COURSE_THRESHOLDS -->'
  const content = source.includes(marker)
    ? source.split(marker).join(thresholdText)
    : source + '\n\n' + thresholdText
  return {
    title: row.title,
    content,
    answerTemplate: row.answerTemplate,
    solution: row.solution,
    category: 'adversarial',
    role: row.role,
    scenarioId: row.scenarioId,
    definition,
    status: 'published',
  }
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',')}}`
  return JSON.stringify(value)
}

/** Local locations may move; every course/content/policy field remains part of the identity. */
export function legacyRecordsMatchForRefresh(
  previous: LegacyConversionRecord,
  current: LegacyConversionRecord,
): boolean {
  const {
    packageDirectory: _previousPackage,
    referenceCodePath: _previousCode,
    ...previousContract
  } = previous
  const { packageDirectory: _currentPackage, referenceCodePath: _currentCode, ...currentContract } = current
  return canonical(previousContract) === canonical(currentContract)
}

export function legacyFrozenPoolMatchesForRefresh(
  pool: any,
  frozen: { poolId?: string; poolRevision?: number },
  desired: Record<string, unknown>,
): boolean {
  return (
    !!pool &&
    pool.id === frozen.poolId &&
    pool.revision === frozen.poolRevision &&
    ['name', 'kind', 'model', 'modelVersion', 'baseUrl', 'credentialEnv', 'enabled', 'parameters'].every(
      (key) => canonical(pool[key]) === canonical(desired[key]),
    )
  )
}

/** Recover an acknowledged-or-not publish only when the exact intended version is now present. */
export function matchesPublishedLegacyConversion(
  current: any,
  before: any,
  update: ReturnType<typeof legacyQuestionUpdate>,
  packageDigest: string,
): boolean {
  if (
    !current ||
    !before ||
    !Number.isSafeInteger(before.revision) ||
    current.revision !== before.revision + 1 ||
    current.status !== 'published'
  )
    return false
  const definition = normalizeDefinition(update.definition)
  definition.evaluation.packageDigest = packageDigest
  try {
    return Object.entries(update).every(([key, value]) =>
      key === 'definition'
        ? canonical(normalizeDefinition(current.definition)) === canonical(definition)
        : canonical(current[key]) === canonical(value),
    )
  } catch {
    return false
  }
}

export function calibratedLegacyDefinition(
  row: LegacyConversionRecord,
  packageId: string,
  metrics: { baseline: Record<string, number>; opponent: Record<string, number> },
  poolId?: string,
): QuestionDefinition {
  const definition = structuredClone(row.definition)
  const evaluation = definition.evaluation
  const baseValue = validateLegacyMetrics(metrics.baseline, evaluation.baselineMetric)
  const opponentThreshold = legacyOpponentThresholdDiagnostic(row, metrics.opponent)
  if (BOT_SCENARIOS.includes(row.scenarioId)) {
    botSamples(row, metrics.baseline)
    if (baseValue < 0) throw new Error('官方参考未通过原课程误伤硬门槛，不能降低准入线')
  }
  evaluation.baselineThreshold =
    row.calibration.baseline === 'fixed' ? row.calibration.baselineThreshold : baseValue
  evaluation.successThreshold = opponentThreshold.threshold
  // Fixed course thresholds stay authoritative even when the historical reference
  // cannot pass them. This definition is only a candidate; verification gates publication.
  evaluation.packageId = packageId
  delete evaluation.calibrationMode
  if (definition.llm.enabled) {
    if (!poolId) throw new Error('缺少冻结评测模型池')
    definition.llm.poolId = poolId
  }
  const normalized = normalizeDefinition(definition)
  assertLegacySuccessPolicy(row, normalized)
  return normalized
}

/** Recompute thresholds from original completed measurements, never from a saved candidate alone. */
export function assertLegacyCalibrationEvidence(
  row: LegacyConversionRecord,
  definition: QuestionDefinition,
  metrics: { baseline: Record<string, number>; opponent: Record<string, number> },
  evidence: any,
  binding: { packageId: string; poolId?: string },
): void {
  if (
    !evidence ||
    canonical(evidence.baseline) !== canonical(metrics.baseline) ||
    canonical(evidence.opponent) !== canonical(metrics.opponent) ||
    canonical(evidence.provenance) !== canonical(row.provenance) ||
    canonical(evidence.policy) !== canonical(row.calibration)
  )
    throw new Error('校准证据与原始参考测量或课程政策不一致，必须重新校准')
  if (
    !binding.packageId ||
    definition.evaluation.packageId !== binding.packageId ||
    (row.definition.llm.enabled && (!binding.poolId || definition.llm.poolId !== binding.poolId))
  )
    throw new Error('冻结评测包或模型池与原始校准绑定不一致，必须重新校准和验收')
  const expected = calibratedLegacyDefinition(row, binding.packageId, metrics, binding.poolId)
  if (canonical(normalizeDefinition(definition)) !== canonical(expected))
    throw new Error('冻结门槛或完整评测定义与原始参考校准政策不一致，必须重新校准和验收')
  const opponentThreshold = legacyOpponentThresholdDiagnostic(row, metrics.opponent)
  if (
    (opponentThreshold.policy === BOT_ZERO_REFERENCE_POLICY || evidence.opponentThreshold !== undefined) &&
    canonical(evidence.opponentThreshold) !== canonical(opponentThreshold)
  )
    throw new Error('缺少或不一致的对抗门槛决议证据，必须重新校准')
}
