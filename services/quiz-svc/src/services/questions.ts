import type { Prisma, Question } from '@prisma/client'
import { prisma } from '../lib/db.js'
import {
  normalizeCategory,
  normalizeDefinition,
  parseJson,
  RequestError,
  type SubmissionSnapshot,
} from '../lib/prdContract.js'
import { transaction } from '../lib/transaction.js'
import { freezePoolBinding } from './apiPool.js'
import { resetQuestionScores } from './basicScores.js'
import { SCENARIO_PAIR_BY_QUESTION_ID } from '../lib/scenarioQuestions.js'
import { getStudentHint } from '../lib/studentHints.js'
import { invalidateArenaQuestionTx, drainArenaRecomputations } from './arenaScoring.js'
import { selfTestConfigurationKey } from '../lib/selfTestContract.js'

export function questionIdentity(row: Question) {
  const pair = SCENARIO_PAIR_BY_QUESTION_ID.get(row.id)
  return {
    category: normalizeCategory(row.category),
    scenarioId: row.scenarioId || pair?.key || null,
    role: row.role || (pair ? (pair.attackId === row.id ? 'attack' : 'defense') : null),
  }
}
export function questionView(row: Question, admin = false) {
  const { definition: encoded, ...raw } = row
  const definition = normalizeDefinition(encoded)
  if (admin) return { ...raw, ...questionIdentity(row), definition }
  return {
    id: row.id,
    title: row.title,
    moduleCode: row.moduleCode,
    number: row.number,
    type: row.type,
    difficulty: row.difficulty,
    ...questionIdentity(row),
    status: row.status,
    content: row.content,
    answerTemplate:
      row.definition === '{}' ? getStudentHint(row.id) || row.answerTemplate : row.answerTemplate,
    revision: row.revision,
    evaluationVersion: row.evaluationVersion,
    definition: {
      ...definition,
      teacherApi: { ...definition.teacherApi, poolId: undefined },
      llm: { enabled: definition.llm.enabled },
      evaluation: {
        version: definition.evaluation.version,
        maxScore: definition.evaluation.maxScore,
        baselineMetric: definition.evaluation.baselineMetric,
        baselineThreshold: definition.evaluation.baselineThreshold,
        successMetric: definition.evaluation.successMetric,
        successThreshold: definition.evaluation.successThreshold,
        timeoutMs: definition.evaluation.timeoutMs,
        repetitions: definition.evaluation.repetitions,
      },
    },
    updatedAt: row.updatedAt,
  }
}

const fields = [
  'moduleCode',
  'number',
  'title',
  'content',
  'answerTemplate',
  'type',
  'difficulty',
  'category',
  'status',
  'solution',
  'githubRepo',
  'githubBranch',
  'autoBranch',
  'branchPrefix',
  'uploadMinScoreAttack',
  'uploadMinScoreDefense',
  'scenarioId',
  'role',
] as const
function editableBody(body: any) {
  const data: Record<string, any> = {}
  for (const field of fields) if (body[field] !== undefined) data[field] = body[field]
  if (body.testConfig !== undefined)
    data.testConfig = typeof body.testConfig === 'string' ? body.testConfig : JSON.stringify(body.testConfig)
  if (body.definition !== undefined) data.definition = JSON.stringify(normalizeDefinition(body.definition))
  if (data.category) data.category = normalizeCategory(data.category)
  return data
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

const LEGACY_REVISION_ACTION = 'question.legacy_revision'
function hasStoredConfiguration(raw: string | null): boolean {
  if (!raw?.trim()) return false
  const value = parseJson<unknown>(raw, raw.trim())
  if (value === null || value === '') return false
  return typeof value !== 'object' || Object.keys(value).length > 0
}

// Preserve the old revision's provenance before a draft edit overwrites its only evidence.
// judgeMode's default "legacy" and aggregate UserScore cannot establish a question's history.
async function retainLegacyRevision(tx: Prisma.TransactionClient, current: Question, actorId: string) {
  const history = await tx.auditEvent.findMany({
    where: {
      targetId: current.id,
      action: { in: [LEGACY_REVISION_ACTION, 'question.publish', 'question.save'] },
    },
    select: { action: true, detail: true },
  })
  const events = history.map((event) => ({
    action: event.action,
    detail: parseJson<Record<string, unknown> | null>(event.detail, null),
  }))
  if (
    events.some(
      (event) => event.action === LEGACY_REVISION_ACTION && event.detail?.revision === current.revision,
    )
  )
    return true
  // Earlier saveQuestion releases omitted previousRevision on creation; recognize that
  // server-written creation record as well as the explicit marker added here.
  const createdAsDraft = events.some(
    (event) =>
      event.action === 'question.save' &&
      event.detail?.revision === 1 &&
      (event.detail.created === true || !Object.hasOwn(event.detail, 'previousRevision')),
  )
  const reasons: string[] = []
  if (current.status === 'published') reasons.push('published_status')
  if (hasStoredConfiguration(current.testConfig)) reasons.push('legacy_test_config')
  if (current.judgeVersion?.trim()) reasons.push('legacy_judge_version')
  if (!createdAsDraft && hasStoredConfiguration(current.definition)) reasons.push('existing_definition')
  if (
    events.some((event) => event.action === 'question.publish' && event.detail?.revision === current.revision)
  )
    reasons.push('published_history')
  if (
    await tx.submission.findFirst({
      where: { questionId: current.id, questionVersion: current.revision },
      select: { id: true },
    })
  )
    reasons.push('submission_history')
  if (
    await tx.basicScore.findFirst({
      where: { questionId: current.id, questionVersion: current.revision },
      select: { id: true },
    })
  )
    reasons.push('score_history')
  if (await tx.testCase.findFirst({ where: { questionId: current.id }, select: { id: true } }))
    reasons.push('legacy_test_cases')
  if (!reasons.length) return false
  await tx.auditEvent.create({
    data: {
      actorId,
      action: LEGACY_REVISION_ACTION,
      targetId: current.id,
      detail: JSON.stringify({ revision: current.revision, reasons }),
    },
  })
  return true
}

export async function saveQuestion(id: string, body: any, actorId: string, create = false) {
  const existing = await prisma.question.findUnique({ where: { id } })
  if (create && existing) throw new RequestError('题目 ID 已存在', 409)
  if (!create && !existing) throw new RequestError('题目不存在', 404)
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new RequestError('题目 ID 仅支持字母、数字、下划线与连字符')
  const updates = editableBody(body)
  const combined = {
    moduleCode: 'GENERAL',
    number: 1,
    title: '',
    content: '',
    answerTemplate: '',
    type: 'code',
    difficulty: 'L1',
    category: 'basic',
    status: 'draft',
    definition: '{}',
    scenarioId: null,
    role: null,
    ...existing,
    ...updates,
  }
  if (!combined.title.trim() || !combined.content.trim())
    throw new RequestError('标题与 Markdown 题面不能为空')
  if (!['draft', 'review', 'published', 'archived', 'pending'].includes(combined.status))
    throw new RequestError('题目状态不合法')
  if (!Number.isSafeInteger(combined.number) || combined.number < 1)
    throw new RequestError('题号必须是正整数')
  const definition = normalizeDefinition(combined.definition)
  const identity = questionIdentity(combined as Question)
  if (
    identity.category === 'adversarial' &&
    (!identity.scenarioId || !['attack', 'defense'].includes(identity.role || ''))
  )
    throw new RequestError('攻防题需要共同场景标识和固定角色')
  let snapshot: SubmissionSnapshot | null = null
  if (combined.status === 'published') {
    if (!definition.evaluation.packageId) throw new RequestError('发布前请上传并选择可用评测环境包')
    const { getEvaluationPackage } = await import('../lib/evaluationPackage.js')
    const descriptor = await getEvaluationPackage(definition.evaluation.packageId)
    if (descriptor.manifest.network === 'gateway' && !definition.llm.enabled)
      throw new RequestError('受控网关环境包必须选择固定评测模型')
    if (definition.llm.enabled && descriptor.manifest.network !== 'gateway')
      throw new RequestError('模型评测需要启用受控网关的环境包')
    snapshot = {
      questionId: id,
      questionVersion: existing?.revision ?? 1,
      ...identity,
      evaluationVersion: definition.evaluation.version,
      definition,
    }
    if (definition.llm.enabled) snapshot.modelBinding = await freezePoolBinding(definition.llm.poolId!, 'llm')
    if (definition.teacherApi.enabled)
      snapshot.teacherBinding = await freezePoolBinding(definition.teacherApi.poolId!, 'teacher')
    const configurationKey = selfTestConfigurationKey(
      definition,
      identity.role,
      identity.category,
      snapshot.modelBinding,
    )
    const { getSuccessfulPackageSelfTest } = await import('../routes/evaluationPackages.js')
    const phases =
      identity.category === 'adversarial' ? (['baseline', 'opponent'] as const) : (['basic'] as const)
    for (const phase of phases) {
      if (!descriptor.manifest.phases.includes(phase))
        throw new RequestError(`评测环境包不支持 ${phase} 阶段`)
      const proof = await getSuccessfulPackageSelfTest(descriptor.id, phase, undefined, configurationKey)
      if (!proof)
        throw new RequestError(
          `发布前请使用当前角色、题目配置及模型版本完成 ${phase} 阶段自测，并确认环境清理成功`,
        )
      if (phase === 'baseline') {
        const metric = proof.result?.metrics?.[definition.evaluation.baselineMetric]
        if (
          typeof metric !== 'number' ||
          !Number.isFinite(metric) ||
          metric < definition.evaluation.baselineThreshold
        )
          throw new RequestError('基线自测必须返回配置的资格指标，且大于等于基线阈值')
      } else if (phase === 'opponent') {
        const metric = proof.result?.metrics?.[definition.evaluation.successMetric]
        if (typeof metric !== 'number' || !Number.isFinite(metric))
          throw new RequestError('对抗自测必须返回配置的胜负指标')
      } else if (
        typeof proof.result?.score !== 'number' ||
        !Number.isFinite(proof.result.score) ||
        proof.result.score < 0 ||
        proof.result.score > definition.evaluation.maxScore
      )
        throw new RequestError('基础自测分数须在题目声明的满分范围内')
    }
    if (descriptor.manifest.materials.requiresWeights && !definition.weights.required)
      throw new RequestError('评测包要求参数，请将题目参数上传设为必需')
    if (
      definition.weights.enabled &&
      definition.weights.maxBytes > descriptor.manifest.materials.maxWeightBytes
    )
      throw new RequestError('题目参数大小上限不能超过评测包声明')
    if (['model', 'distillation'].includes(definition.kind) && !definition.weights.required)
      throw new RequestError('模型与蒸馏题需要声明必需的训练参数')
    if (definition.kind === 'distillation' && !definition.teacherApi.enabled)
      throw new RequestError('蒸馏题需要教师 API')
    if (definition.kind === 'agent' && !definition.llm.enabled)
      throw new RequestError('Agent 题需要固定评测模型')
    definition.evaluation.packageDigest = descriptor.digest
  }
  const saved = await transaction(async (tx) => {
    const current = await tx.question.findUnique({ where: { id } })
    if (existing && current?.updatedAt.getTime() !== existing.updatedAt.getTime())
      throw new RequestError('题目刚被其他操作修改，请刷新后重试', 409)
    let revision = current?.revision ?? 1
    const previous = current
      ? await tx.questionRevision.findUnique({ where: { questionId_revision: { questionId: id, revision } } })
      : null
    const legacyRevision = current && !previous ? await retainLegacyRevision(tx, current, actorId) : false
    const publishedContent = {
      title: combined.title,
      content: combined.content,
      answerTemplate: combined.answerTemplate,
      type: combined.type,
      difficulty: combined.difficulty,
      ...snapshot,
    }
    if (snapshot && (previous || legacyRevision)) {
      const before = previous ? parseJson<any>(previous.snapshot, {}) : null
      if (
        before &&
        identity.category === 'adversarial' &&
        before.evaluationVersion === snapshot.evaluationVersion &&
        canonical({ definition: before.definition, modelBinding: before.modelBinding }) !==
          canonical({ definition: snapshot.definition, modelBinding: snapshot.modelBinding })
      )
        throw new RequestError('修改攻防评测规则或模型时，请升级评测版本；相反角色题目须使用兼容版本')
      if (
        !before ||
        canonical({ ...before, questionVersion: 0 }) !==
          canonical({ ...publishedContent, questionVersion: 0 })
      ) {
        revision++
        await resetQuestionScores(tx, id)
        await tx.teacherLease.updateMany({
          where: { questionId: id },
          data: { state: 'revoked', reason: '题目已发布变化版本' },
        })
      }
    }
    const data = {
      ...updates,
      category: identity.category,
      scenarioId: identity.scenarioId,
      role: identity.role,
      definition: JSON.stringify(definition),
      revision,
      evaluationVersion: definition.evaluation.version,
    }
    const row = current
      ? await tx.question.update({ where: { id }, data })
      : await tx.question.create({
          data: {
            id,
            moduleCode: combined.moduleCode,
            number: combined.number,
            title: combined.title,
            content: combined.content,
            answerTemplate: combined.answerTemplate,
            type: combined.type,
            difficulty: combined.difficulty,
            status: combined.status,
            ...data,
          },
        })
    await invalidateArenaQuestionTx(tx, id)
    if (snapshot) {
      const frozen = { ...publishedContent, questionVersion: revision }
      await tx.questionRevision.upsert({
        where: { questionId_revision: { questionId: id, revision } },
        create: { questionId: id, revision, snapshot: JSON.stringify(frozen) },
        update: {},
      })
    }
    await tx.auditEvent.create({
      data: {
        actorId,
        action: combined.status === 'published' ? 'question.publish' : 'question.save',
        targetId: id,
        detail: JSON.stringify({
          created: !current,
          previousRevision: current?.revision,
          revision,
          status: row.status,
        }),
      },
    })
    return questionView(row, true)
  })
  void drainArenaRecomputations()
  return saved
}
