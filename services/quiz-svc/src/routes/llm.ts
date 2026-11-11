import { requireAdminMw, requireUser, authPayload } from '../lib/auth.js'
import crypto from 'node:crypto'
import { startModelUsage, finishModelUsage } from '../services/modelUsage.js'
import { modelUsageTokens } from '../lib/modelUsageTokens.js'
import { Router, type Request, type Response } from 'express'
import {
  getGatewayConfig,
  resetGatewayCache,
  saveGatewayConfig,
  effectiveBaseUrl,
  effectiveApiKey,
  effectiveModel,
  LLM_CONFIG_PATH,
  type LlmGatewayConfig,
} from '../lib/llmConfig.js'

/**
 * 统一大模型推理服务网关（OpenAI 兼容）
 *
 * 依据《攻防对抗平台功能扩展开发需求》需求一：在比赛服务器统一部署大模型，
 * 提供 OpenAI API 兼容接口，所有大模型攻防赛题统一通过该 API 调用。
 *
 * 行为：
 * - 配置 baseUrl（vLLM/SGLang 等）且 enabled 时，转发请求到真实推理服务；
 * - 未配置时返回确定性 mock 响应，便于赛题开发与无 GPU 环境联调。
 *
 * 配置：由 admin 通过 /api/llm/admin/config 界面管理（写入 llm-config.json，
 * 运行时生效，无需重启）。未配置时回退环境变量 MODEL_SERVER_URL /
 * COMPETITION_API_KEY / MODEL_NAME。
 *
 * 端点：
 *   GET   /api/v1/models
 *   POST  /api/v1/chat/completions
 *   POST  /api/llm/test-connection
 *   GET   /api/llm/admin/config   （admin 读取配置，apiKey 脱敏）
 *   POST  /api/llm/admin/config   （admin 保存配置，运行时生效）
 */

const router = Router()
router.use(['/v1', '/llm'], (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next() })
// Legacy unscoped gateway is administrator-only. Judged student code uses the
// immutable submission-scoped gateway, never this mutable/global model endpoint.
router.use('/v1', requireAdminMw)
router.use('/llm/test-connection', requireAdminMw)
router.use('/llm/admin', requireAdminMw)

// ── 鉴权（可选）：配置了 apiKey 时校验 Authorization ─────────────────────────
function checkAuth(req: Request): boolean {
  const key = effectiveApiKey()
  if (!key) return true // 未配置则放行
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  return token === key
}

// 校验 admin 请求：与现有 role 参数视角约定一致（仅 admin 可配置/切换网关）
function isAdminReq(req: Request): boolean {
  return req.query.role === 'admin'
}

// ── GET /api/v1/models ───────────────────────────────────────────────────────
router.get('/v1/models', async (req: Request, res: Response) => {
  if (effectiveBaseUrl()) {
    const id = await startModelUsage({ source: 'legacy', kind: 'health', actorId: authPayload(req)!.uid, model: effectiveModel() })
    const started = Date.now()
    try {
      const upstream = await fetch(`${effectiveBaseUrl()}/models`, {
        headers: effectiveApiKey() ? { Authorization: `Bearer ${effectiveApiKey()}` } : {},
        signal: AbortSignal.timeout(10000),
      })
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        await finishModelUsage(id, { outcome: 'http_error', httpStatus: upstream.status, elapsedMs: Date.now() - started })
        res.status(upstream.status).json({ error: { message: `模型服务返回 HTTP ${upstream.status}` } })
        return
      }
      const text = await upstream.text()
      await finishModelUsage(id, { outcome: 'success', httpStatus: upstream.status, elapsedMs: Date.now() - started })
      res.status(upstream.status).type('json').send(text)
      return
    } catch (e) {
      await finishModelUsage(id, { outcome: failureKind(e), elapsedMs: Date.now() - started })
      // 上游不可达时回退 mock 列表
    }
  }
  res.json({
    object: 'list',
    data: [{ id: effectiveModel(), object: 'model', created: 0, owned_by: 'platform' }],
  })
})

// ── mock 响应：确定性，便于赛题开发联调 ──────────────────────────────────────
function mockChatCompletion(body: any) {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  const last = messages.length ? messages[messages.length - 1] : { content: '' }
  const userText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  // 简单确定性"模型"：原样回显截断内容，便于赛题自测
  const echo = userText.slice(0, 256)
  const completion = `[mock-llm] ${echo}`
  const promptTokens = Math.ceil(userText.length / 4)
  const completionTokens = Math.ceil(completion.length / 4)
  return {
    id: `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model || effectiveModel(),
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: completion },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

// ── POST /api/v1/chat/completions ────────────────────────────────────────────
router.post('/v1/chat/completions', async (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } })
    return
  }
  const body = req.body ?? {}
  if (!body.messages) {
    res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } })
    return
  }
  // 规范化参数：保留 OpenAI 兼容字段，底层不支持的字段由上游忽略
  const payload: Record<string, unknown> = {
    model: body.model || effectiveModel(),
    messages: body.messages,
  }
  // 注意：必须透传 tools / tool_choice 等字段，否则依赖原生 function calling 的
  // Agent 判题场景（AgendaBot / WebBot / ChatOps）拿不到工具定义，一次工具都不会调。
  for (const k of [
    'temperature',
    'top_p',
    'max_tokens',
    'stop',
    'seed',
    'frequency_penalty',
    'presence_penalty',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'response_format',
    'logit_bias',
    'n',
    'user',
  ]) {
    if (body[k] !== undefined) payload[k] = body[k]
  }
  // 请求未指定时应用 admin 配置的默认模型参数
  const gwCfg = getGatewayConfig()
  if (payload['temperature'] === undefined && gwCfg.temperature != null)
    payload['temperature'] = gwCfg.temperature
  if (payload['max_tokens'] === undefined && gwCfg.maxTokens != null) payload['max_tokens'] = gwCfg.maxTokens
  const stream = body.stream === true

  // ── 转发到真实推理服务 ──
  if (effectiveBaseUrl()) {
    const usageId = await startModelUsage({ source: 'legacy', kind: 'llm', actorId: authPayload(req)!.uid, model: String(payload.model) })
    const started = Date.now()
    try {
      const upstream = await fetch(`${effectiveBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(effectiveApiKey() ? { Authorization: `Bearer ${effectiveApiKey()}` } : {}),
        },
        body: JSON.stringify({ ...payload, stream }),
        signal: AbortSignal.timeout(300000),
      })
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {})
        await finishModelUsage(usageId, { outcome: 'http_error', httpStatus: upstream.status, elapsedMs: Date.now() - started })
        res.status(upstream.status).json({ error: { message: `模型服务返回 HTTP ${upstream.status}` } })
        return
      }
      if (stream) {
        // 透传 SSE 流
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'private, no-store')
        res.setHeader('Connection', 'keep-alive')
        if (upstream.body) {
          const reader = upstream.body.getReader()
          const pump = async () => {
            // @ts-ignore Node web stream
            const decoder = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(decoder.decode(value))
            }
            // Legacy streams do not require usage chunks; unknown tokens remain explicit.
            await finishModelUsage(usageId, { outcome: 'success', httpStatus: upstream.status, elapsedMs: Date.now() - started })
            res.end()
          }
          pump().catch(async error => { await finishModelUsage(usageId, { outcome: failureKind(error), elapsedMs: Date.now() - started }); res.end() })
          return
        }
        await finishModelUsage(usageId, { outcome: 'success', httpStatus: upstream.status, elapsedMs: Date.now() - started })
        res.status(upstream.status).send('')
        return
      }
      const text = await upstream.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { /* Retain compatibility, mark non-JSON telemetry explicitly. */ }
      await finishModelUsage(usageId, { outcome: parsed === undefined ? 'invalid_json' : 'success', httpStatus: upstream.status, elapsedMs: Date.now() - started, ...modelUsageTokens(parsed) })
      res.status(upstream.status).type('json').send(text)
      return
    } catch (e) {
      await finishModelUsage(usageId, { outcome: failureKind(e), elapsedMs: Date.now() - started })
      // 上游不可达 -> 回退 mock（非流式）
    }
  }

  // ── mock 响应 ──
  if (stream) {
    const mock = mockChatCompletion(payload)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Connection', 'keep-alive')
    res.write(
      `data: ${JSON.stringify({ id: mock.id, object: 'chat.completion.chunk', created: mock.created, model: mock.model, choices: [{ index: 0, delta: { role: 'assistant', content: mock.choices[0].message.content }, finish_reason: null }] })}\n\n`,
    )
    res.write(
      `data: ${JSON.stringify({ id: mock.id, object: 'chat.completion.chunk', created: mock.created, model: mock.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.json(mockChatCompletion(payload))
})

// ── POST /api/llm/test-connection ─ 测试任意 OpenAI 兼容 API 连通性 ──────────
// 用途：前端「LLM 连接测试」配置界面，验证调用大模型的 base_url + api_key 是否可用。
// 行为：GET {baseUrl}/models 取模型列表（失败可容忍）→ POST {baseUrl}/chat/completions
//       发最小消息 'ping' 验证生成链路，返回结构化结果。
function failureKind(error: unknown): 'timeout' | 'transport' {
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout' : 'transport'
}

router.post('/llm/test-connection', async (req: Request, res: Response) => {
  const { baseUrl, apiKey, model } = req.body ?? {}
  let base: string
  try {
    const url = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    base = url.toString().replace(/\/+$/, '')
  } catch {
    res.status(400).json({ code: 40001, message: '请输入不含凭证或查询参数的 HTTP(S) 接口地址', data: null })
    return
  }
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {}
  const modelName = typeof model === 'string' && model.trim() ? model.trim() : 'competition-model'
  const actorId = authPayload(req)!.uid
  const started = Date.now()
  let models: string[] = []
  const healthId = await startModelUsage({ source: 'admin_test', kind: 'health', actorId, model: modelName })
  try {
    const mres = await fetch(`${base}/models`, { headers: authHeaders, signal: AbortSignal.timeout(10000) })
    if (mres.ok) {
      const body: any = await mres.json()
      models = Array.isArray(body?.data) ? body.data.map((m: any) => m?.id).filter((id: unknown) => typeof id === 'string').slice(0, 20) : []
    } else await mres.body?.cancel().catch(() => {})
    await finishModelUsage(healthId, { outcome: mres.ok ? 'success' : 'http_error', httpStatus: mres.status, elapsedMs: Date.now() - started })
  } catch (error) {
    await finishModelUsage(healthId, { outcome: error instanceof SyntaxError ? 'invalid_json' : failureKind(error), elapsedMs: Date.now() - started })
  }
  const usageId = await startModelUsage({ source: 'admin_test', kind: 'llm', actorId, model: modelName })
  const chatStarted = Date.now()
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      await finishModelUsage(usageId, { outcome: 'http_error', httpStatus: response.status, elapsedMs: Date.now() - chatStarted })
      res.json({ code: 0, message: 'ok', data: { ok: false, step: 'chat', status: response.status, error: `模型服务返回 HTTP ${response.status}`, models, latencyMs: Date.now() - started } })
      return
    }
    const output: any = await response.json()
    await finishModelUsage(usageId, { outcome: 'success', httpStatus: response.status, elapsedMs: Date.now() - chatStarted, ...modelUsageTokens(output) })
    const content = output?.choices?.[0]?.message?.content
    res.json({ code: 0, message: 'ok', data: { ok: true, models, reply: typeof content === 'string' ? content : '(响应无 content 字段)', latencyMs: Date.now() - started } })
  } catch (error) {
    const outcome = error instanceof SyntaxError ? 'invalid_json' : failureKind(error)
    await finishModelUsage(usageId, { outcome, elapsedMs: Date.now() - chatStarted })
    res.json({ code: 0, message: 'ok', data: { ok: false, step: 'connect', error: outcome === 'timeout' ? '模型服务请求超时' : '模型服务连接或响应异常', models, latencyMs: Date.now() - started } })
  }
})

// One bounded, shared health probe per configuration every 30 seconds. Never cache credentials or provider bodies.
let healthCache: { key: string; expiresAt: number; result: Promise<Record<string, unknown>> } | undefined
router.get('/llm/health', async (req: Request, res: Response) => {
  const user = await requireUser(req, res)
  if (!user) return
  const base = effectiveBaseUrl(), key = effectiveApiKey(), model = effectiveModel()
  if (!base) {
    res.json({ code: 0, message: 'ok', data: { enabled: false, mode: 'mock', ok: true, modelName: model, latencyMs: 0, note: '网关未配置，当前运行在 mock 模式（确定性回显，赛题可正常开发）' } })
    return
  }
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([base, key, model])).digest('hex')
  if (!healthCache || healthCache.key !== cacheKey || healthCache.expiresAt <= Date.now()) {
    const result = (async (): Promise<Record<string, unknown>> => {
      const usageId = await startModelUsage({ source: 'health', kind: 'health', actorId: user.id, model })
      const started = Date.now()
      const common = { enabled: true, mode: 'proxy', modelName: model }
      try {
        const response = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) })
        await response.body?.cancel().catch(() => {})
        await finishModelUsage(usageId, { outcome: response.ok ? 'success' : 'http_error', httpStatus: response.status, elapsedMs: Date.now() - started })
        return { ...common, ok: response.ok, latencyMs: Date.now() - started, ...(response.ok ? {} : { status: response.status, error: `模型服务返回 HTTP ${response.status}` }) }
      } catch (error) {
        const outcome = failureKind(error)
        await finishModelUsage(usageId, { outcome, elapsedMs: Date.now() - started })
        return { ...common, ok: false, latencyMs: Date.now() - started, error: outcome === 'timeout' ? '模型服务请求超时' : '模型服务暂不可用' }
      }
    })()
    healthCache = { key: cacheKey, expiresAt: Date.now() + 30000, result }
  }
  res.json({ code: 0, message: 'ok', data: await healthCache.result })
})

// ── POST /api/llm/admin/mode ─ 一键切换 mock / LLM 网关模式（仅 admin）────────
router.post('/llm/admin/mode', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可切换网关模式', data: null })
    return
  }
  const { mode } = (req.body ?? {}) as { mode?: string }
  if (mode !== 'mock' && mode !== 'proxy') {
    res.status(400).json({ code: 40001, message: 'mode 必须是 mock 或 proxy', data: null })
    return
  }
  const next: LlmGatewayConfig = { ...getGatewayConfig(), enabled: mode === 'proxy' }
  // 切到 proxy 但未配置地址：不生效并提示
  if (mode === 'proxy' && !(next.baseUrl || '').trim()) {
    res.json({
      code: 0,
      message: 'ok',
      data: {
        ok: false,
        mode: 'mock',
        enabled: false,
        note: '未配置网关地址，无法切换到 LLM 网关模式；请先在「LLM 网关」页填写地址',
      },
    })
    return
  }
  saveGatewayConfig(next)
  resetGatewayCache()
  res.json({
    code: 0,
    message: 'ok',
    data: { ok: true, mode, enabled: next.enabled, baseUrl: next.baseUrl || '', modelName: effectiveModel() },
  })
})

// ── 网关配置管理（仅 admin）──────────────────────────────────────────────────
// GET /api/llm/admin/config?role=admin —— 读取当前配置（apiKey 脱敏）
router.get('/llm/admin/config', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查看网关配置', data: null })
    return
  }
  const masked: LlmGatewayConfig = { ...getGatewayConfig() }
  if (masked.apiKey) masked.apiKey = maskKey(masked.apiKey)
  res.json({ code: 0, message: 'ok', data: { ...masked, configPath: LLM_CONFIG_PATH } })
})

// POST /api/llm/admin/config?role=admin —— 保存配置，运行时立即生效（无需重启）
router.post('/llm/admin/config', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可配置网关', data: null })
    return
  }
  const body = (req.body ?? {}) as Partial<LlmGatewayConfig>
  // 部分更新：未传字段保留原值（apiKey 传空串 = 清空密钥）
  const next: LlmGatewayConfig = { ...getGatewayConfig() }
  if (body.enabled !== undefined) next.enabled = body.enabled !== false
  if (body.baseUrl !== undefined) next.baseUrl = String(body.baseUrl).trim()
  if (body.apiKey !== undefined) next.apiKey = String(body.apiKey).trim()
  if (body.modelName !== undefined) next.modelName = String(body.modelName).trim()
  if (body.temperature !== undefined) {
    next.temperature =
      typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined
  }
  if (body.maxTokens !== undefined) {
    next.maxTokens =
      typeof body.maxTokens === 'number' && Number.isFinite(body.maxTokens)
        ? Math.floor(body.maxTokens)
        : undefined
  }
  saveGatewayConfig(next)
  resetGatewayCache()
  res.json({
    code: 0,
    message: 'ok',
    data: { ok: true, ...next, apiKey: next.apiKey ? maskKey(next.apiKey) : '' },
  })
})

function maskKey(key: string): string {
  if (key.length <= 6) return '*'.repeat(key.length)
  return key.slice(0, 3) + '*'.repeat(Math.min(key.length - 6, 8)) + key.slice(-3)
}

export default router
