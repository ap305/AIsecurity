import type { GenericAdScenario } from './scenario'

interface MatchResult {
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  interaction_log?: any[]
}

interface GenericAdBattleOutputProps {
  scenario: GenericAdScenario
  isRunning: boolean
  status: 'idle' | 'running' | 'finished' | 'error'
  result: MatchResult | null
  error: string | null
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8,
  padding: 16, height: '100%', overflow: 'auto',
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

export default function GenericAdBattleOutput({ scenario, isRunning, status, result, error }: GenericAdBattleOutputProps) {
  const log = (result?.interaction_log ?? []) as any[]

  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 12, letterSpacing: 0.5 }}>
        {'\u{1F3AF}'} {scenario.agentName} 对战输出
      </div>

      {isRunning && (
        <div style={{ color: 'var(--warning)', fontSize: 13, lineHeight: 1.8 }}>
          ⏳ 对战中…引擎正在仿真 {scenario.agentName} 的攻防过程。
        </div>
      )}

      {!isRunning && status === 'idle' && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.8 }}>
          在左侧编辑器编写 <code style={{ color: 'var(--brand-cyan)' }}>attack</code> 或 <code style={{ color: 'var(--brand-cyan)' }}>defend</code> 代码，
          点击「执行攻击/防御」后在此查看结果。完整结果见「复盘」面板。
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

              {log.length > 0 && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>仿真日志（最近 {Math.min(log.length, 5)} 条，共 {log.length}）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {log.slice(-5).map((e, i) => (
                      <div key={i} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                        {Object.entries(e).filter(([, v]) => isScalar(v)).map(([k, v]) => `${k}=${String(v).slice(0, 50)}`).join('  ')}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
