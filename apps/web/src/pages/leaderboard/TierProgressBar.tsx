import { getTierByScore, getNextTier } from '@ai-security/shared'

interface TierProgressBarProps {
  score: number
  showLabel?: boolean
}

export default function TierProgressBar({ score, showLabel = true }: TierProgressBarProps) {
  const roundedScore = Math.round(score)
  const current = getTierByScore(roundedScore)
  const next = getNextTier(roundedScore)

  // 已达最高段位
  if (!next) {
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            position: 'relative',
            height: 8,
            borderRadius: 4,
            background: 'var(--bg-secondary)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: current.gradient,
              borderRadius: 4,
            }}
          />
        </div>
        {showLabel && (
          <div style={{ marginTop: 4, fontSize: 11, color: current.color, fontWeight: 600 }}>
            {current.icon} 已达最高段位（{current.label}）
          </div>
        )}
      </div>
    )
  }

  const progressInTier = roundedScore - current.threshold
  const tierRange = next.threshold - current.threshold
  const percent = Math.min(100, Math.max(0, (progressInTier / tierRange) * 100))
  const remaining = next.threshold - roundedScore

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 4,
          background: 'var(--bg-secondary)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${percent}%`,
            background: current.gradient,
            borderRadius: 4,
            transition: 'width 400ms ease',
          }}
        />
      </div>
      {showLabel && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: 'var(--text-secondary)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>
            {current.icon} {current.label}
          </span>
          <span style={{ color: next.color, fontWeight: 600 }}>
            距 {next.label} {remaining} 分
          </span>
        </div>
      )}
    </div>
  )
}
