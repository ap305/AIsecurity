import { useState } from 'react'
import ResultBanner from './ResultBanner'
import type { GenericAdScenario } from './scenario'

interface MatchResult {
  [k: string]: unknown
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  interaction_log?: any[]
}

interface GenericAdReviewProps {
  scenario: GenericAdScenario
  mode: 'solo_attack' | 'solo_defense'
  result: MatchResult | null
  onRetry: () => void
  code: string
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

export default function GenericAdReview({ scenario, mode, result, onRetry, code }: GenericAdReviewProps) {
  const [showCode, setShowCode] = useState(false)
  const log = (result?.interaction_log ?? []) as any[]
  const r = (result ?? {}) as Record<string, unknown>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ResultBanner
        mode={mode} win={result?.win} status={result?.status} score={result?.score}
        message={result?.message} queriesUsed={result?.queries_used} fbr={result?.fbr} onRetry={onRetry}
      />

      {/* 指标卡（数据驱动） */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(scenario.metrics.length, 4)}, 1fr)`, gap: 8 }}>
        {scenario.metrics.map(m => {
          const raw = r[m.key]
          let val = '-'
          if (raw != null) {
            if (m.key === 'fbr' && typeof raw === 'number') val = `${(raw * 100).toFixed(0)}%`
            else if (typeof raw === 'number') val = Number.isInteger(raw) ? String(raw) : raw.toFixed(2)
            else val = String(raw)
          }
          return <Metric key={m.key} label={m.label} value={val} />
        })}
      </div>

      {/* 仿真日志 */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 10 }}>仿真日志</div>
        {log.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无记录</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {log.map((e, i) => (
              <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: 8, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {Object.entries(e).filter(([, v]) => isScalar(v)).map(([k, v]) => (
                  <span key={k}><span style={{ color: 'var(--text-muted)' }}>{k}:</span> {String(v).slice(0, 80)}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 可展开代码 */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8 }}>
        <button
          onClick={() => setShowCode(v => !v)}
          style={{ width: '100%', textAlign: 'left', padding: '10px 16px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {showCode ? '▼ 收起代码' : '▶ 查看提交代码'}
        </button>
        {showCode && (
          <pre style={{ margin: 0, padding: 16, borderTop: '1px solid var(--border-color)', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{code}</pre>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}
