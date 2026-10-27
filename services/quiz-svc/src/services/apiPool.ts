import { prisma } from '../lib/db.js'
import { parseJson, RequestError, type PoolBinding, type SubmissionSnapshot } from '../lib/prdContract.js'
import { signScopedToken } from '../lib/auth.js'
import { transaction } from '../lib/transaction.js'
import crypto from 'node:crypto'
import {waitForColdRequest, waitForBackgroundColdRequest} from './modelRequestPacing.js'
import { withResponseSnapshot, type ResponseSnapshotContext } from './modelResponseSnapshot.js'

export async function callPoolWithResponseSnapshot(
  binding: PoolBinding,
  input: any,
  context: ResponseSnapshotContext | null | undefined,
  observe: (source: 'upstream' | 'snapshot') => Promise<void>,
) {
  if (!context) return callPool(binding, input)
  const started=Date.now()
  const boundedD02 = context.policy === 'first-valid-response-v1' && context.scope === 'V3-261012-D02' &&
    context.evaluationVersion === 'v3-261012-d02-original300-v12' && binding.model === 'Qwen/Qwen3-8B' &&
    binding.parameters.transportPolicy === 'd02-original300-tail-v1'
  const totalBudgetMs = boundedD02 ? 290000 : 80000
  return withResponseSnapshot({
    root: process.env.EVALUATION_RESPONSE_SNAPSHOT_ROOT || '',
    context, binding, payload: fixedModelPayload(binding, input),
    beforeCall: () => {
      const key = JSON.stringify([binding.baseUrl,binding.credentialEnv,binding.model])
      const intervalMs = Number(process.env.EVALUATION_SNAPSHOT_UPSTREAM_INTERVAL_MS ?? 0)
      return boundedD02 ? waitForBackgroundColdRequest(key, intervalMs, started + totalBudgetMs)
        : waitForColdRequest(key, intervalMs)
    },
    call: async () => {
      try { return await callPool(binding, input, false, true, started+totalBudgetMs,
        boundedD02 ? { startedAtMs: started, totalBudgetMs } : undefined) }
      catch (error) {
        // These four new-policy tasks must not translate an unknown provider
        // outcome into the legacy runtime's retryable 503 response.
        if (error instanceof RequestError && error.status === 503)
          throw new RequestError('模型服务调用结果未知，本次不产生正式成绩', 502)
        throw error
      }
    }, observe,
  })
}

export async function freezePoolBinding(id: string, kind: string): Promise<PoolBinding> {
  const pool = await prisma.apiPool.findUnique({ where: { id } })
  if (!pool || !pool.enabled || pool.kind !== kind) throw new RequestError('所选 API 不可用或类型不匹配')
  return {
    poolId: pool.id,
    revision: pool.revision,
    name: pool.name,
    kind: pool.kind,
    model: pool.model,
    modelVersion: pool.modelVersion,
    baseUrl: pool.baseUrl,
    credentialEnv: pool.credentialEnv,
    parameters: parseJson(pool.parameters, {}),
  }
}

export function publicPool(row: any) {
  return { ...row, parameters: parseJson(row.parameters, {}) }
}

export function poolRequestTimeoutMs(parameters: PoolBinding['parameters']): number {
  const value = parameters.requestTimeoutMs
  if (value === undefined) return 60000
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 300000)
    throw new RequestError('模型请求超时必须为 1 至 300000 毫秒的正整数')
  return value
}

export async function savePool(id: string | null, body: any, actorId: string) {
  return transaction(async (tx) => {
    const current = id ? await tx.apiPool.findUnique({ where: { id } }) : null
    if (id && !current) throw new RequestError('API 配置不存在', 404)
    const merged = { ...(current ? publicPool(current) : {}), ...body }
    const { name, kind, model, modelVersion, baseUrl } = merged
    if (
      ![name, model, modelVersion].every((x) => typeof x === 'string' && x.trim()) ||
      !['llm', 'teacher'].includes(kind)
    )
      throw new RequestError('请填写名称、服务类型、精确模型与版本')
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new RequestError('请输入有效的服务 URL')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new RequestError('服务 URL 仅支持 HTTP(S)，不能包含凭证或查询参数')
    const credentialEnv = merged.credentialEnv ? String(merged.credentialEnv) : null
    if (credentialEnv && !/^[A-Z][A-Z0-9_]{2,100}$/.test(credentialEnv))
      throw new RequestError('密钥环境变量名称不合法')
    if (!merged.parameters || typeof merged.parameters !== 'object' || Array.isArray(merged.parameters))
      merged.parameters = {}
    const params = merged.parameters
    poolRequestTimeoutMs(params)
    if (params.maxCalls !== undefined && (!Number.isSafeInteger(params.maxCalls) || params.maxCalls < 1))
      throw new RequestError('模型调用预算必须是正整数')
    if (params.enable_thinking !== undefined && typeof params.enable_thinking !== 'boolean')
      throw new RequestError('enable_thinking必须为布尔值')
    const data = {
      name,
      kind,
      model,
      modelVersion,
      baseUrl: url.toString().replace(/\/$/, ''),
      credentialEnv,
      parameters: JSON.stringify(params),
      enabled: merged.enabled === true,
      isDefault: merged.isDefault === true,
      revision: (current?.revision ?? 0) + 1,
    }
    if (data.isDefault) await tx.apiPool.updateMany({ where: { kind }, data: { isDefault: false } })
    const row = id ? await tx.apiPool.update({ where: { id }, data }) : await tx.apiPool.create({ data })
    await tx.apiPoolRevision.create({
      data: { poolId: row.id, revision: row.revision, snapshot: JSON.stringify(publicPool(row)) },
    })
    await tx.auditEvent.create({
      data: {
        actorId,
        action: 'api_pool.save',
        targetId: row.id,
        detail: JSON.stringify({ revision: row.revision }),
      },
    })
    return publicPool(row)
  })
}

export async function poolHealthy(binding: PoolBinding): Promise<boolean> {
  const healthPath = binding.kind === 'llm' ? '/models' : String(binding.parameters.healthPath || '/health')
  if (!healthPath.startsWith('/') || healthPath.startsWith('//')) return false
  try {
    const response = await fetch(`${binding.baseUrl}${healthPath}`, {
      headers: poolHeaders(binding),
      signal: AbortSignal.timeout(10000),
    })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

function poolHeaders(binding: PoolBinding): Record<string, string> {
  const key = binding.credentialEnv ? process.env[binding.credentialEnv] : null
  if (binding.credentialEnv && !key) throw new RequestError('服务凭证尚未配置', 503)
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

export function fixedModelPayload(binding: PoolBinding, input: any) {
  if (!Array.isArray(input?.messages) || !input.messages.length)
    throw new RequestError('messages 必须是非空数组')
  const parameters = binding.parameters
  if (
    typeof parameters.systemPrompt === 'string' &&
    input.messages.some((message: any) => message?.role === 'system' || message?.role === 'developer')
  ) {
    throw new RequestError('题目系统提示词已固定，调用方不能追加系统或开发者指令')
  }
  const payload: Record<string, unknown> = { messages: input.messages, model: binding.model, stream: false }
  for (const key of [
    'temperature',
    'top_p',
    'max_tokens',
    'seed',
    'stop',
    'frequency_penalty',
    'presence_penalty',
    'tools',
    'tool_choice',
    'response_format',
    'enable_thinking',
  ]) {
    if (parameters[key] !== undefined) payload[key] = parameters[key]
  }
  if (typeof parameters.systemPrompt === 'string')
    payload.messages = [{ role: 'system', content: parameters.systemPrompt }, ...input.messages]
  return payload
}

type UpstreamFailureReason = 'timeout' | 'transport' | 'http' | 'invalid_json'
interface UpstreamTiming {
  totalBudgetMs: number; elapsedBeforeUpstreamMs: number; configuredTimeoutMs: number
  upstreamTimeoutMs: number; upstreamElapsedMs: number
}

function logUpstreamFailure(binding: PoolBinding, reason: UpstreamFailureReason, status: number | null, timing?: UpstreamTiming) {
  // Keep this allowlist independent of requests, response bodies and exception details.
  console.warn(
    JSON.stringify({
      event: 'model_upstream_failure',
      poolId: binding.poolId,
      revision: binding.revision,
      status,
      reason,
      ...(timing ? { timing } : {}),
    }),
  )
}

function transportFailureReason(error: unknown, signal: AbortSignal): 'timeout' | 'transport' {
  return signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ? 'timeout'
    : 'transport'
}

async function logRateLimitDiagnostic(binding: PoolBinding, response: Response) {
  // Opt-in snapshot scopes only. Parse at most 8 KiB transiently; never log
  // provider messages, headers containing identifiers, or response text.
  let value: any = {}, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    reader = response.body?.getReader()
    if (reader) {
      const chunks: Uint8Array[] = []; let bytes = 0
      while (true) {
        const part = await reader.read(); if (part.done) break
        bytes += part.value.byteLength; if (bytes > 8192) break
        chunks.push(part.value)
      }
      if (bytes <= 8192) value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }
  } catch { /* Diagnostics must not replace the original HTTP failure. */ }
  finally { try { await reader?.cancel() } catch {} }
  const message = String(value?.message ?? value?.error?.message ?? '')
  const rateDimension = message.match(/\b(?:RPM|RPH|RPD|TPM|TPH|TPD|IPM|IPD)\b/i)?.[0].toUpperCase() ?? null
  const retry = response.headers.get('retry-after')
  const seconds = retry && /^\d{1,6}$/.test(retry) ? Number(retry) : null
  console.warn(JSON.stringify({event: 'model_rate_limit_diagnostic', poolId: binding.poolId, revision: binding.revision,
    rateDimension, retryAfterSeconds: seconds, numericProviderCode: Number.isSafeInteger(value?.code) ? value.code : null}))
}

export async function callPool(binding: PoolBinding, body: any, teacher = false, diagnoseRateLimit = false,
  deadlineMs?: number, deadlineInfo?: { startedAtMs: number; totalBudgetMs: number }) {
  const configuredTimeoutMs = poolRequestTimeoutMs(binding.parameters)
  const startedAtMs = Date.now()
  const remainingMs = deadlineMs === undefined ? configuredTimeoutMs : deadlineMs - startedAtMs
  const timeoutMs = Math.min(configuredTimeoutMs, Math.max(1, remainingMs))
  const timing = (): UpstreamTiming | undefined => deadlineInfo ? {
    totalBudgetMs: deadlineInfo.totalBudgetMs,
    elapsedBeforeUpstreamMs: Math.max(0, startedAtMs - deadlineInfo.startedAtMs), configuredTimeoutMs,
    upstreamTimeoutMs: remainingMs <= 0 ? 0 : timeoutMs, upstreamElapsedMs: Math.max(0, Date.now() - startedAtMs),
  } : undefined
  if (deadlineInfo && remainingMs <= 0) {
    logUpstreamFailure(binding, 'timeout', null, timing())
    throw new RequestError('模型请求总时限已耗尽，本次不产生正式成绩', 502)
  }
  const suffix = teacher ? String(binding.parameters.queryPath || '/predict') : '/chat/completions'
  if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('..'))
    throw new RequestError('上游路径配置不合法')
  const headers = poolHeaders(binding)
  const payload = JSON.stringify(teacher ? body : fixedModelPayload(binding, body))
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(`${binding.baseUrl}${suffix}`, {
      method: 'POST',
      headers,
      body: payload,
      signal,
    })
  } catch (error) {
    logUpstreamFailure(binding, transportFailureReason(error, signal), null, timing())
    throw new RequestError('模型服务暂不可用，本次不产生正式成绩', 503)
  }
  if (!response.ok) {
    logUpstreamFailure(binding, 'http', response.status, timing())
    if (diagnoseRateLimit && response.status === 429) await logRateLimitDiagnostic(binding, response)
    try {
      await response.body?.cancel()
    } catch {
      // The original HTTP status is the useful evidence; cancellation may also fail.
    }
    throw new RequestError('模型服务返回错误，本次不产生正式成绩', 502)
  }
  try {
    return await response.json()
  } catch (error) {
    logUpstreamFailure(
      binding,
      error instanceof SyntaxError ? 'invalid_json' : transportFailureReason(error, signal),
      response.status,
      timing(),
    )
    throw new RequestError('模型服务返回错误，本次不产生正式成绩', 502)
  }
}

export function submissionGateway(snapshot: SubmissionSnapshot, submissionId: string) {
  if (!snapshot.modelBinding) return undefined
  const base = (process.env.EVALUATION_GATEWAY_URL || 'http://host.docker.internal:4002/api').replace(
    /\/$/,
    '',
  )
  return {
    url: `${base}/evaluation-gateway/${submissionId}`,
    token: signScopedToken({
      purpose: 'evaluation',
      submissionId,
      callId: crypto.randomUUID(),
      questionVersion: snapshot.questionVersion,
      exp: Date.now() + snapshot.definition.evaluation.timeoutMs + 60000,
    }),
  }
}
