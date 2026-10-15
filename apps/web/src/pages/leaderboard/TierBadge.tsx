import { TIER_MAP } from '@ai-security/shared'
import type { Tier } from '@ai-security/shared'

interface TierBadgeProps {
  tier: string
  size?: 'sm' | 'md' | 'lg'
}

const SIZE_STYLES: Record<'sm' | 'md' | 'lg', { padding: string; radius: number; fontSize: number; iconSize: number }> = {
  sm: { padding: '1px 8px', radius: 10, fontSize: 11, iconSize: 10 },
  md: { padding: '3px 10px', radius: 12, fontSize: 12, iconSize: 12 },
  lg: { padding: '6px 14px', radius: 16, fontSize: 14, iconSize: 16 },
}

export default function TierBadge({ tier, size = 'md' }: TierBadgeProps) {
  const meta = TIER_MAP[tier as Tier] ?? TIER_MAP.bronze
  const s = SIZE_STYLES[size]

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: s.padding,
        borderRadius: s.radius,
        fontSize: s.fontSize,
        fontWeight: 600,
        fontFamily: 'var(--font-sans)',
        background: `${meta.color}20`,
        color: meta.color,
        border: `1px solid ${meta.color}40`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: s.iconSize }}>{meta.icon}</span>
      {meta.label}
    </span>
  )
}
