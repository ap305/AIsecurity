import type { PromptInjectionScenario } from './scenario'

interface MatchResult {
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  interaction_log?: any[]
}

interface PromptInjectionBattleOutputProps {
  scenario: PromptInjectionScenario
  isRunning: boolean
  status: 'idle' | 'running' | 'finished' | 'error'
  result: MatchResult | null
  error: string | null
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8,
  padding: 16, height: '100%', overflow: 'auto',
}

export default function PromptInjectionBattleOutput({ scenario, isRunning, status, result, error }: PromptInjectionBattleOutputProps) {
  const log = (result?.interaction_log ?? []) as any[]
  const lastLog = log[log.length - 1]
  const tokenLeaked = lastLog ? String(lastLog.response ?? '').includes(scenario.attackToken) : false

  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 12, letterSpacing: 0.5 }}>
        {'\u{1F9E0}'} 提示词注入对战输出
      </div>

      {isRunning && (
        <div style={{ color: 'var(--warning)', fontSize: 13 }}>⏳ 对战中…引擎正在仿真模型对注入 payload 的响应。</div>
      )}

      {!isRunning && status === 'idle' && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.8 }}>
          在左侧编辑器编写 <code style={{ color: 'var(--brand-cyan)' }}>attack</code>（返回 payload）或 <code style={{ color: 'var(--brand-cyan)' }}>defend</code>（清洗 prompt），
          点击执行后在此查看模型响应与 token 是否泄露。完整结果见「复盘」面板。
        </div>
      )}

      {!isRunning && (status === 'finished' || status === 'error') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {error && <div style={{ color: '#ff6b6b', fontSize: 13 }}>错误：{error}</div>}
          {result && (
            <>
              <div style={{
                padding: 10, borderRadius: 6,
                background: result.win ? 'rgba(72, 219, 128, 0.08)' : 'rgba(255, 107, 107, 0.08)',
                border: `1px solid ${result.win ? 'var(--success)' : 'var(--danger)'}`,
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                  {result.win ? '✓ 胜利' : '✗ 未胜'} · 得分 {result.score ?? '-'} · 查询 {result.queries_used ?? '-'} · FBR {result.fbr != null ? `${(result.fbr * 100).toFixed(0)}%` : '-'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{result.message}</div>
              </div>

              {lastLog && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>最终模型响应</span>
                    <span style={{ color: tokenLeaked ? 'var(--danger)' : 'var(--success)' }}>
                      {tokenLeaked ? '⚠ token 已泄露' : '✓ token 未泄露'} · 覆盖分 {String(lastLog.override_score ?? '-')}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{String(lastLog.response ?? '').slice(0, 300)}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
