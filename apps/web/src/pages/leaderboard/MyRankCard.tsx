import TierBadge from './TierBadge'
import TierProgressBar from './TierProgressBar'

interface MyRankCardProps {
  rank: number | null
  totalScore: number
  tier: string
  isLoggedIn: boolean
}

export default function MyRankCard({ rank, totalScore, tier, isLoggedIn }: MyRankCardProps) {
  if (!isLoggedIn) {
    return (
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
          padding: '16px 20px',
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--text-muted)',
        }}
      >
        登录后查看个人排名
      </div>
    )
  }

  return (
    <div
      style={{
        background: 'var(--brand-cyan-dim)',
        border: '1px solid var(--brand-cyan)',
        borderRadius: 8,
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        fontSize: 13,
      }}
    >
      {/* Rank */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>我的排名</span>
        <span
          style={{
            fontSize: 20,
            fontFamily: 'var(--font-mono)',
            color: 'var(--brand-cyan)',
            fontWeight: 700,
          }}
        >
          {rank != null ? `#${rank}` : '--'}
        </span>
      </div>

      {/* Score */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 80 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>积分</span>
        <span
          style={{
            fontSize: 20,
            fontFamily: 'var(--font-mono)',
            color: 'var(--brand-cyan)',
            fontWeight: 700,
          }}
        >
          {Math.round(totalScore).toLocaleString()}
        </span>
      </div>

      {/* Tier badge */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 70 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>段位</span>
        <TierBadge tier={tier} size="md" />
      </div>

      {/* Progress bar */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <TierProgressBar score={totalScore} />
      </div>
    </div>
  )
}
