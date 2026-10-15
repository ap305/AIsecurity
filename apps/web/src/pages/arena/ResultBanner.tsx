type Mode = 'solo_attack' | 'solo_defense'

interface ResultBannerProps {
  mode: Mode
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queriesUsed?: number
  fbr?: number
  onRetry: () => void
}

export default function ResultBanner({
  mode,
  win,
  status,
  score,
  message,
  queriesUsed,
  fbr,
  onRetry,
}: ResultBannerProps) {
  const isAttack = mode === 'solo_attack'
  const accent = isAttack ? 'var(--danger)' : 'var(--brand-cyan)'
  const accentDim = isAttack ? 'rgba(255, 107, 107, 0.1)' : 'rgba(0, 212, 255, 0.1)'

  // Determine outcome label
  let outcomeLabel: string
  let outcomeColor: string
  if (win === true) {
    outcomeLabel = isAttack ? '攻方成功 · 注入生效' : '防御成功 · 全部拦截'
    outcomeColor = 'var(--success)'
  } else if (win === false) {
    outcomeLabel = isAttack ? '攻击失败 · 未触发注入' : '防御失败 · 被攻破'
    outcomeColor = 'var(--danger)'
  } else if (status === 'passed') {
    outcomeLabel = '通过'
    outcomeColor = 'var(--success)'
  } else {
    outcomeLabel = '未通过'
    outcomeColor = 'var(--warning)'
  }

  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${accentDim} 0%, var(--bg-card) 100%)`,
        border: `1px solid ${accent}`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 16,
        alignItems: 'center',
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>{isAttack ? '⚔' : '🛡'}</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: accent,
              textTransform: 'uppercase',
            }}
          >
            {isAttack ? 'ATTACK' : 'DEFENSE'} · REVIEW
          </span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: outcomeColor, marginBottom: 6 }}>
          {outcomeLabel}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Metric label="得分" value={score != null ? String(Math.round(score)) : '—'} valueColor="var(--success)" />
          <Metric
            label="queries_used"
            value={queriesUsed != null ? `${queriesUsed}/8` : '—'}
            valueColor="var(--text-primary)"
          />
          <Metric
            label="FBR"
            value={fbr != null ? `${(fbr * 100).toFixed(1)}%` : 'N/A'}
            valueColor={fbr != null && fbr > 0.1 ? 'var(--warning)' : 'var(--text-primary)'}
          />
        </div>
        {message && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {message}
          </div>
        )}
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: '8px 18px',
          borderRadius: 4,
          border: `1px solid ${accent}`,
          background: accent,
          color: '#000',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'inherit',
        }}
      >
        ↻ 重新挑战
      </button>
    </div>
  )
}

function Metric({ label, value, valueColor }: { label: string; value: string; valueColor: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontFamily: 'var(--font-mono)', color: valueColor, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  )
}
