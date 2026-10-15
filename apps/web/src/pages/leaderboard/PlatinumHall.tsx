import TierBadge from './TierBadge'

interface PlatinumEntry {
  rank: number
  userId: string
  displayName: string
  totalScore: number
  tier: string
}

interface PlatinumHallProps {
  entries: PlatinumEntry[]
}

export default function PlatinumHall({ entries }: PlatinumHallProps) {
  if (entries.length === 0) return null

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(168,124,255,0.12) 0%, var(--bg-card) 100%)',
        border: '1px solid var(--tier-platinum)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 18 }}>💎</span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--tier-platinum)',
            letterSpacing: 1,
          }}
        >
          铂金名人堂
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          共 {entries.length} 位铂金选手
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 10,
        }}
      >
        {entries.map((e) => (
          <div
            key={e.userId}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  flexShrink: 0,
                }}
              >
                #{e.rank}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {e.displayName}
              </span>
            </div>
            <span
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                color: 'var(--tier-platinum)',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {Math.round(e.totalScore).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
