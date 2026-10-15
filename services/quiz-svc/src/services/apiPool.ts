import { prisma } from '../lib/db.js'
import { parseJson, RequestError, type PoolBinding, type SubmissionSnapshot } from '../lib/prdContract.js'
import { signScopedToken } from '../lib/auth.js'
import { transaction } from '../lib/transaction.js'
import crypto from 'node:crypto'

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

function logUpstreamFailure(binding: PoolBinding, reason: UpstreamFailureReason, status: number | null) {
  // Keep this allowlist independent of requests, response bodies and exception details.
  console.warn(
    JSON.stringify({
      event: 'model_upstream_failure',
      poolId: binding.poolId,
      revision: binding.revision,
      status,
      reason,
    }),
  )
}

function transportFailureReason(error: unknown, signal: AbortSignal): 'timeout' | 'transport' {
  return signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    ? 'timeout'
    : 'transport'
}

export async function callPool(binding: PoolBinding, body: any, teacher = false) {
  const suffix = teacher ? String(binding.parameters.queryPath || '/predict') : '/chat/completions'
  if (!suffix.startsWith('/') || suffix.startsWith('//') || suffix.includes('..'))
    throw new RequestError('上游路径配置不合法')
  const headers = poolHeaders(binding)
  const payload = JSON.stringify(teacher ? body : fixedModelPayload(binding, body))
  const signal = AbortSignal.timeout(60000)
  let response: Response
  try {
    response = await fetch(`${binding.baseUrl}${suffix}`, {
      method: 'POST',
      headers,
      body: payload,
      signal,
    })
  } catch (error) {
    logUpstreamFailure(binding, transportFailureReason(error, signal), null)
    throw new RequestError('模型服务暂不可用，本次不产生正式成绩', 503)
  }
  if (!response.ok) {
    logUpstreamFailure(binding, 'http', response.status)
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
