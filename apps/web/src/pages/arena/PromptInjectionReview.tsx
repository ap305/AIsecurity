import { useState } from 'react'
import ResultBanner from './ResultBanner'

interface MatchResult {
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  interaction_log?: any[]
}

interface PromptInjectionReviewProps {
  mode: 'solo_attack' | 'solo_defense'
  result: MatchResult | null
  onRetry: () => void
  code: string
  attackToken: string
}

export default function PromptInjectionReview({ mode, result, onRetry, code, attackToken }: PromptInjectionReviewProps) {
  const [showCode, setShowCode] = useState(false)
  const log = (result?.interaction_log ?? []) as any[]
  const maxOverride = log.reduce((m, e) => Math.max(m, Number(e.override_score ?? 0)), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ResultBanner
        mode={mode} win={result?.win} status={result?.status} score={result?.score}
        message={result?.message} queriesUsed={result?.queries_used} fbr={result?.fbr} onRetry={onRetry}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Metric label="查询次数" value={String(result?.queries_used ?? '-')} color="var(--brand-cyan)" />
        <Metric label="最高覆盖分" value={String(maxOverride)} color="var(--warning)" />
        <Metric label="FBR" value={result?.fbr != null ? `${(result.fbr * 100).toFixed(0)}%` : '-'} color="var(--text-primary)" />
        <Metric label="得分" value={String(result?.score ?? '-')} color={result?.win ? 'var(--success)' : 'var(--danger)'} />
      </div>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 10 }}>Prompt / 响应记录</div>
        {log.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>无记录</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {log.map((e, i) => {
              const resp = String(e.response ?? '')
              const leaked = resp.includes(attackToken)
              return (
                <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: 10, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Query {String(e.query_num ?? i + 1)}</span>
                    <span style={{ color: leaked ? 'var(--danger)' : 'var(--success)', fontFamily: 'var(--font-mono)' }}>
                      {leaked ? 'token 泄露' : '未泄露'} · 覆盖分 {String(e.override_score ?? 0)}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Prompt：</div>
                  <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: 6, fontSize: 11 }}>{String(e.prompt ?? '').slice(0, 200)}</div>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>响应：</div>
                  <div style={{ color: leaked ? 'var(--danger)' : 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{resp.slice(0, 200)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>

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

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  )
}
