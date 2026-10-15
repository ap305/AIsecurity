import { useState } from 'react'
import ResultBanner from './ResultBanner'

type Mode = 'solo_attack' | 'solo_defense'

interface SafeLLMLogEntry {
  query_num?: number
  messages?: Array<{ role: string; content: string }>
  response?: string
  jailbreak_score?: number
  jailbreak_signals?: string[]
  goal_present?: boolean
  complied?: boolean
  refused?: boolean
  defense_wrapped?: boolean
  final_replay?: boolean
}

interface SafeLLMReviewProps {
  mode: Mode
  result: {
    win?: boolean
    status?: string
    score?: number | null
    message?: string
    queries_used?: number
    fbr?: number
    task?: { sample_id?: string; goal?: string; risk_category?: string }
    interaction_log?: unknown[]
  } | null
  onRetry: () => void
  code: string
}

const THRESHOLD = 3

export default function SafeLLMReview({ mode, result, onRetry, code }: SafeLLMReviewProps) {
  const [showCode, setShowCode] = useState(false)

  if (!result) {
    return <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>暂无复盘数据</div>
  }

  const log = (result.interaction_log ?? []) as unknown as SafeLLMLogEntry[]
  const isAttack = mode === 'solo_attack'

  return (
    <div>
      <ResultBanner
        mode={mode}
        win={result.win}
        status={result.status}
        score={result.score}
        message={result.message}
        queriesUsed={result.queries_used}
        fbr={result.fbr}
        onRetry={onRetry}
      />

      {/* 任务卡 */}
      {result.task && (
        <div style={cardStyle}>
          <div style={titleStyle}>{'\u{1F3AF}'} 目标任务</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>{result.task.goal}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {result.task.sample_id} · 风险类别：{result.task.risk_category}
          </div>
        </div>
      )}

      {/* 关键指标 */}
      <div style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={titleStyle}>{'\u{1F4CA}'} 关键指标</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
          <Metric label="总 query 数" value={result.queries_used != null ? `${result.queries_used}` : '-'} color="var(--text-primary)" />
          <Metric label="越狱触发" value={`${log.filter(e => (e.jailbreak_score ?? 0) >= THRESHOLD).length}`} color="var(--danger)" />
          <Metric label={isAttack ? '攻击成功' : '攻击穿透'} value={log.some(e => e.complied) ? '是' : '否'} color={log.some(e => e.complied) ? 'var(--danger)' : 'var(--success)'} />
          {!isAttack && <Metric label="FBR" value={result.fbr != null ? `${(result.fbr * 100).toFixed(0)}%` : '-'} color={result.fbr != null && result.fbr > 0.1 ? 'var(--warning)' : 'var(--success)'} />}
          {isAttack && <Metric label="最终判定" value={result.win ? '越狱成功' : '未成功'} color={result.win ? 'var(--danger)' : 'var(--success)'} />}
        </div>
      </div>

      {/* 对话日志 */}
      <div style={cardStyle}>
        <div style={titleStyle}>{'\u{1F4DD}'} 对话与判定日志</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {log.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>无日志</div>}
          {log.map((e, i) => {
            const lastUser = e.messages && e.messages.length ? e.messages[e.messages.length - 1].content : ''
            const jb = e.jailbreak_score ?? 0
            const triggered = jb >= THRESHOLD
            return (
              <div
                key={i}
                style={{
                  background: 'var(--bg-secondary)', border: `1px solid ${triggered ? 'rgba(255,107,107,0.3)' : 'var(--border-color)'}`,
                  borderRadius: 6, padding: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    Query {e.query_num ?? i + 1}{e.final_replay ? ' · 最终重放' : ''}{e.defense_wrapped ? ' · 经防御' : ''}
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Badge color={triggered ? 'var(--danger)' : 'var(--text-muted)'}>越狱分 {jb}</Badge>
                    <Badge color={e.goal_present ? 'var(--warning)' : 'var(--text-muted)'}>{e.goal_present ? '含目标意图' : '无目标意图'}</Badge>
                    <Badge color={e.complied ? 'var(--danger)' : e.refused ? 'var(--success)' : 'var(--text-muted)'}>
                      {e.complied ? '合规(被越狱)' : e.refused ? '拒绝' : '正常'}
                    </Badge>
                  </div>
                </div>
                <div style={rowStyle}>
                  <span style={labelStyle}>用户</span>
                  <span style={valueStyle}>{truncate(lastUser, 300)}</span>
                </div>
                <div style={rowStyle}>
                  <span style={labelStyle}>响应</span>
                  <span style={valueStyle}>{truncate(e.response ?? '', 300)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 可展开代码 */}
      <div style={{ marginTop: 12 }}>
        <button onClick={() => setShowCode(s => !s)} style={toggleBtnStyle(showCode)}>
          {showCode ? '▼' : '▶'} 展开代码
        </button>
        {showCode && (
          <pre style={{
            background: '#0a0a0a', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12,
            color: '#c0c8d0', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, overflow: 'auto', maxHeight: 320,
          }}>
            {code}
          </pre>
        )}
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, marginBottom: 12,
}
const titleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 8, letterSpacing: 0.5,
}
const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '48px 1fr', gap: 8, fontSize: 12, marginBottom: 4, alignItems: 'baseline',
}
const labelStyle: React.CSSProperties = { color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }
const valueStyle: React.CSSProperties = { color: 'var(--text-secondary)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: 8, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 4 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontFamily: 'var(--font-mono)', fontWeight: 700, color }}>{value}</div>
    </div>
  )
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 3, border: `1px solid ${color}`,
      color, fontSize: 10, fontFamily: 'var(--font-mono)', background: `${color}14`,
    }}>{children}</span>
  )
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px', borderRadius: 4,
    border: active ? '1px solid var(--brand-cyan)' : '1px solid var(--border-color)',
    background: active ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
    color: active ? 'var(--brand-cyan)' : 'var(--text-secondary)',
    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
  }
}
