import { useState } from 'react'
import { apiPost } from '../lib/api'

/**
 * LLM 连接测试：填写 OpenAI 兼容 API 接口地址与密钥，点击「测试连接」验证可用性。
 * 通过后端 /api/llm/test-connection 代理测试（避免浏览器跨域限制）。
 */

interface TestResult {
  ok: boolean
  models?: string[]
  reply?: string
  error?: string
  status?: number
  step?: string
  latencyMs?: number
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--brand-cyan)',
  marginBottom: 10,
  letterSpacing: 0.5,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
}

export default function LlmConfig() {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleTest = async () => {
    setTesting(true)
    setResult(null)
    setError(null)
    try {
      const data = await apiPost<TestResult>('/llm/test-connection', {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
      })
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '测试请求失败')
    } finally {
      setTesting(false)
    }
  }

  const canTest = baseUrl.trim().length > 0 && !testing

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Page header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, marginTop: 0 }}>
          LLM 连接测试
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          填写 OpenAI 兼容 API 的接口地址与密钥，点击「测试连接」验证大模型网关是否可用
        </p>
      </div>

      {/* 配置表单 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>{'\u{2699}'} 模型服务配置</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>API 接口地址（base_url）<span style={{ color: 'var(--danger)' }}>*</span></label>
            <input
              style={fieldStyle}
              placeholder="http://localhost:8000/v1  （vLLM/SGLang 等 OpenAI 兼容服务的 /v1 地址）"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label style={labelStyle}>API Key</label>
            <input
              style={fieldStyle}
              type="password"
              placeholder="sk-...  （未启用鉴权可留空）"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label style={labelStyle}>模型名称（可选）</label>
            <input
              style={fieldStyle}
              placeholder="competition-model  （留空则用默认模型名）"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={handleTest}
              disabled={!canTest}
              style={{
                padding: '8px 22px',
                borderRadius: 6,
                border: 'none',
                background: canTest ? 'var(--brand-cyan)' : 'var(--border-color)',
                color: canTest ? '#000' : 'var(--text-muted)',
                cursor: canTest ? 'pointer' : 'not-allowed',
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              {testing ? '⏳ 测试中...' : '🔌 测试连接'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              测试将依次调用 <code style={{ fontFamily: 'var(--font-mono)' }}>GET /models</code> 与{' '}
              <code style={{ fontFamily: 'var(--font-mono)' }}>POST /chat/completions</code>
            </span>
          </div>
        </div>
      </div>

      {/* 测试结果 */}
      {error && (
        <div style={{ ...sectionStyle, borderColor: 'var(--danger)' }}>
          <div style={{ ...sectionTitleStyle, color: 'var(--danger)' }}>{'\u{2716}'} 测试请求失败</div>
          <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
        </div>
      )}

      {result && !error && (
        <div style={{ ...sectionStyle, borderColor: result.ok ? 'var(--success)' : 'var(--danger)' }}>
          <div style={{ ...sectionTitleStyle, color: result.ok ? 'var(--success)' : 'var(--danger)' }}>
            {result.ok ? '\u{2705} 连接成功' : '\u{2716} 连接失败'}
            {result.latencyMs != null && (
              <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
                耗时 {result.latencyMs} ms
              </span>
            )}
          </div>

          {/* 失败详情 */}
          {!result.ok && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>
                失败阶段：<code style={{ fontFamily: 'var(--font-mono)', color: 'var(--warning)' }}>{result.step ?? '-'}</code>
                {result.status != null && <> · HTTP <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}>{result.status}</code></>}
              </div>
              <div style={{ marginTop: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)', overflowX: 'auto' }}>
                {result.error ?? '未知错误'}
              </div>
              {result.models && result.models.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  已获取模型列表（{result.models.length} 个）：
                  {result.models.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* 成功详情 */}
          {result.ok && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>模型列表（GET /models）</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {result.models && result.models.length > 0 ? result.models.map((m) => (
                      <code key={m} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-color)', color: 'var(--brand-cyan)' }}>
                        {m}
                      </code>
                    )) : <span style={{ color: 'var(--text-muted)' }}>（该服务未提供 /models 端点）</span>}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>测试消息回复（POST /chat/completions）</div>
                  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>
                    {result.reply ?? '(无回复内容)'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 说明 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>{'\u{1F4CB}'} 使用说明</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
          <p style={{ margin: 0 }}><strong style={{ color: 'var(--text-primary)' }}>· 测试什么：</strong>
            填写任意 OpenAI 兼容服务（vLLM / SGLang / 平台统一网关等）的 <code style={{ fontFamily: 'var(--font-mono)' }}>/v1</code> 地址与密钥，
            平台后端代为发起 <code style={{ fontFamily: 'var(--font-mono)' }}>GET /models</code> 与 <code style={{ fontFamily: 'var(--font-mono)' }}>POST /chat/completions</code> 验证连通性，可确认大模型网关是否可用。
          </p>
          <p style={{ margin: '6px 0 0' }}><strong style={{ color: 'var(--text-primary)' }}>· 平台统一网关：</strong>
            配置了 <code style={{ fontFamily: 'var(--font-mono)' }}>MODEL_SERVER_URL</code> 时，平台网关地址为{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>{window.location.origin}/api/v1</code>；
            未配置时为 mock 模式（返回确定性回显）。详见「使用帮助 → 统一 LLM 网关」。
          </p>
          <p style={{ margin: '6px 0 0' }}><strong style={{ color: 'var(--text-primary)' }}>· 常见地址：</strong>
            vLLM 默认 <code style={{ fontFamily: 'var(--font-mono)' }}>http://localhost:8000/v1</code>，SGLang 默认 <code style={{ fontFamily: 'var(--font-mono)' }}>http://localhost:30000/v1</code>。
          </p>
        </div>
      </div>
    </div>
  )
}
