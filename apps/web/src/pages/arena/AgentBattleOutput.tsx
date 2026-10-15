import type { AgentScenario } from './scenario'

interface MatchResult {
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  interaction_log?: any[]
}

interface AgentBattleOutputProps {
  scenario: AgentScenario
  isRunning: boolean
  status: 'idle' | 'running' | 'finished' | 'error'
  result: MatchResult | null
  error: string | null
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8,
  padding: 16, height: '100%', overflow: 'auto',
}

export default function AgentBattleOutput({ scenario, isRunning, status, result, error }: AgentBattleOutputProps) {
  const log = (result?.interaction_log ?? []) as any[]
  const lastEntry = log[log.length - 1]

  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 12, letterSpacing: 0.5 }}>
        {'\u{1F916}'} {scenario.agentName} 对战输出
      </div>

      {isRunning && (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8 }}>
          <div style={{ color: 'var(--warning)', marginBottom: 8 }}>⏳ 对战中…引擎正在仿真 {scenario.agentName} 的工具调用与防御中间件。</div>
        </div>
      )}

      {!isRunning && status === 'idle' && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.8 }}>
          在左侧编辑器编写 <code style={{ color: 'var(--brand-cyan)' }}>attack</code> 或 <code style={{ color: 'var(--brand-cyan)' }}>defend</code> 代码，
          点击「执行攻击/防御」后在此查看 {scenario.agentName} 的工具调用链、注入分与判定。完整结果见「复盘」面板。
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

              {/* 工具调用链 */}
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>工具调用链（最近一轮）</div>
                {lastEntry && Array.isArray(lastEntry.tool_calls) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(lastEntry.tool_calls as any[]).map((tc, i) => (
                      <div key={i} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                        <span style={{ color: tc.defender_blocked ? 'var(--danger)' : 'var(--brand-cyan)' }}>
                          {tc.defender_blocked ? '✗ 拦截' : '→'} {String(tc.tool)}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}> [{String(tc.stage ?? '-')}]</span>
                        <span style={{ color: 'var(--text-muted)' }}> {String(tc.input ?? '').slice(0, 60)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>无工具调用</div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  注入分：{String(lastEntry?.injection_score ?? 0)}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
