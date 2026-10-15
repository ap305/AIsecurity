import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'

/**
 * LLM 网关配置（仅 admin）：配置统一大模型网关的地址/端口/URL、API Key、模型参数。
 * 保存后运行时立即生效（无需重启服务）。保存后可点击「测试连接」验证连通性。
 */

interface GatewayConfig {
  baseUrl?: string
  apiKey?: string
  modelName?: string
  enabled?: boolean
  temperature?: number
  maxTokens?: number
  configPath?: string
}

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

export default function LlmGatewayConfig() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelName, setModelName] = useState('')
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [hasStoredKey, setHasStoredKey] = useState(false)

  useEffect(() => {
    apiGet<GatewayConfig>('/llm/admin/config?role=admin')
      .then((cfg) => {
        setEnabled(cfg.enabled !== false)
        setBaseUrl(cfg.baseUrl ?? '')
        setModelName(cfg.modelName ?? '')
        setTemperature(cfg.temperature != null ? String(cfg.temperature) : '')
        setMaxTokens(cfg.maxTokens != null ? String(cfg.maxTokens) : '')
        setHasStoredKey(!!cfg.apiKey)
      })
      .catch((e) => setMessage({ type: 'err', text: e instanceof Error ? e.message : '加载配置失败' }))
      .finally(() => setLoading(false))
  }, [])

  const handleModeSwitch = async (target: 'mock' | 'proxy') => {
    setSaving(true)
    setMessage(null)
    try {
      const data = await apiPost<{ ok: boolean; mode: string; enabled: boolean; note?: string }>(
        '/llm/admin/mode?role=admin',
        { mode: target },
      )
      setEnabled(data.enabled)
      setMessage({
        type: data.ok ? 'ok' : 'err',
        text: data.ok
          ? `已切换到 ${target === 'proxy' ? 'LLM 网关' : 'Mock'} 模式`
          : (data.note ?? '切换失败'),
      })
    } catch (e) {
      setMessage({ type: 'err', text: e instanceof Error ? e.message : '切换失败' })
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    const body: Record<string, unknown> = {
      enabled,
      baseUrl,
      modelName,
      // apiKey 未输入则不发（保留原密钥）；输入则更新
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }
    if (temperature.trim()) {
      const t = parseFloat(temperature)
      if (Number.isFinite(t)) body.temperature = t
    }
    if (maxTokens.trim()) {
      const m = parseInt(maxTokens)
      if (Number.isFinite(m)) body.maxTokens = m
    }
    try {
      const data = await apiPost<GatewayConfig & { ok: boolean }>('/llm/admin/config?role=admin', body)
      setSavedAt(new Date().toLocaleTimeString())
      setHasStoredKey(!!data.apiKey)
      setMessage({ type: 'ok', text: '配置已保存，运行时立即生效（无需重启）' })
    } catch (e) {
      setMessage({ type: 'err', text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const data = await apiPost<TestResult>('/llm/test-connection', {
        baseUrl: baseUrl.trim() || (enabled ? undefined : ''),
        apiKey: apiKey.trim() || undefined,
        model: modelName.trim() || undefined,
      })
      setTestResult(data)
    } catch (e) {
      setMessage({ type: 'err', text: e instanceof Error ? e.message : '测试请求失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Page header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, marginTop: 0 }}>
          LLM 网关配置
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          配置统一大模型网关：地址/端口/URL、API Key、模型参数。保存后即时生效，所有攻防题通过该网关调用模型。
        </p>
      </div>

      {loading ? (
        <div style={{ ...sectionStyle, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          加载配置中...
        </div>
      ) : (
        <>
          {/* 网关连接配置 */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>{'\u{1F4E1}'} 运行模式</div>
            {/* 模式切换：mock / LLM 网关 一键切换 */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <button
                onClick={() => handleModeSwitch('mock')}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: enabled ? '1px solid var(--border-color)' : '1px solid var(--warning)',
                  background: enabled ? 'var(--bg-secondary)' : 'rgba(255, 184, 77, 0.1)',
                  color: enabled ? 'var(--text-muted)' : 'var(--warning)',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontWeight: enabled ? 400 : 700,
                  fontFamily: 'inherit',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span style={{ fontSize: 18 }}>🛡</span>
                <span>Mock 模式</span>
                <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>确定性回显 · 无需模型</span>
              </button>
              <button
                onClick={() => handleModeSwitch('proxy')}
                disabled={saving}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: enabled ? '1px solid var(--brand-cyan)' : '1px solid var(--border-color)',
                  background: enabled ? 'rgba(0, 212, 255, 0.1)' : 'var(--bg-secondary)',
                  color: enabled ? 'var(--brand-cyan)' : 'var(--text-muted)',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontWeight: enabled ? 700 : 400,
                  fontFamily: 'inherit',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span style={{ fontSize: 18 }}>🧠</span>
                <span>LLM 网关模式</span>
                <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>转发真实模型 · 需配置地址</span>
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={labelStyle}>网关地址（URL，含端口/路径）</label>
                <input
                  style={fieldStyle}
                  placeholder="http://127.0.0.1:8000/v1   （vLLM/SGLang 的 /v1 地址）"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  API Key {hasStoredKey && <span style={{ color: 'var(--success)', fontSize: 11 }}>（已配置，留空则保留）</span>}
                </label>
                <input
                  style={fieldStyle}
                  type="password"
                  placeholder={hasStoredKey ? 'sk-*** （输入新值则覆盖，留空保留）' : 'sk-... （上游未鉴权可留空）'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          {/* 模型参数 */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>{'\u{1F9E9}'} 模型参数</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>默认模型名</label>
                <input
                  style={fieldStyle}
                  placeholder="competition-model"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div>
                <label style={labelStyle}>默认温度 temperature</label>
                <input
                  style={fieldStyle}
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  placeholder="0.7"
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>默认最大输出 max_tokens</label>
                <input
                  style={fieldStyle}
                  type="number"
                  step="16"
                  min="1"
                  placeholder="2048"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* 操作 */}
          <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: '8px 22px', borderRadius: 6, border: 'none',
                  background: saving ? 'var(--border-color)' : 'var(--brand-cyan)',
                  color: saving ? 'var(--text-muted)' : '#000',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                }}
              >
                {saving ? '保存中...' : '💾 保存配置'}
              </button>
              <button
                onClick={handleTest}
                disabled={testing || !baseUrl.trim()}
                style={{
                  padding: '8px 22px', borderRadius: 6, border: '1px solid var(--brand-cyan)',
                  background: 'transparent',
                  color: testing || !baseUrl.trim() ? 'var(--text-muted)' : 'var(--brand-cyan)',
                  cursor: testing || !baseUrl.trim() ? 'not-allowed' : 'pointer',
                  fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                }}
              >
                {testing ? '测试中...' : '🔌 测试连接'}
              </button>
              {savedAt && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  上次保存：{savedAt}
                </span>
              )}
            </div>
            {message && (
              <div style={{ marginTop: 10, fontSize: 12, color: message.type === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
                {message.text}
              </div>
            )}
          </div>

          {/* 测试结果 */}
          {testResult && (
            <div style={{ ...sectionStyle, borderColor: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
              <div style={{ ...sectionTitleStyle, color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                {testResult.ok ? '\u{2705} 连接成功' : '\u{2716} 连接失败'}
                {testResult.latencyMs != null && (
                  <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
                    耗时 {testResult.latencyMs} ms
                  </span>
                )}
              </div>
              {testResult.ok ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                  <div>
                    模型列表：
                    {testResult.models && testResult.models.length > 0
                      ? testResult.models.map((m) => (
                          <code key={m} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-color)', color: 'var(--brand-cyan)', marginLeft: 6 }}>
                            {m}
                          </code>
                        ))
                      : <span style={{ color: 'var(--text-muted)' }}>（无 /models 端点）</span>}
                  </div>
                  <div style={{ marginTop: 6 }}>
                    测试回复：<code style={{ fontFamily: 'var(--font-mono)' }}>{testResult.reply ?? ''}</code>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  失败阶段 <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--warning)' }}>{testResult.step}</code>
                  {testResult.status != null && <> · HTTP {testResult.status}</>}
                  <div style={{ marginTop: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)' }}>
                    {testResult.error ?? '未知错误'}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 说明 */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>{'\u{1F4CB}'} 说明</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
              <p style={{ margin: 0 }}>
                · 配置保存在服务器 <code style={{ fontFamily: 'var(--font-mono)' }}>llm-config.json</code>，保存后<b>即时生效，无需重启</b>。
              </p>
              <p style={{ margin: '4px 0 0' }}>
                · 未启用或地址不可达时，网关返回确定性 mock 响应，赛题可正常开发联调。
              </p>
              <p style={{ margin: '4px 0 0' }}>
                · 配置了 <code style={{ fontFamily: 'var(--font-mono)' }}>apiKey</code> 后，调用方需带{' '}
                <code style={{ fontFamily: 'var(--font-mono)' }}>Authorization: Bearer &lt;key&gt;</code>（OpenAI SDK 的 api_key 参数）。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
