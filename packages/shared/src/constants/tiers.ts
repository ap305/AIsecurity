import type { Tier } from '../types/user'

/** Spec #4 段位元数据 */
export interface TierMeta {
  code: Tier
  label: string       // 中文标签
  color: string       // CSS 变量
  threshold: number   // 最低分数
  icon: string        // emoji 图标
  gradient: string    // 徽章渐变背景
}

/** 段位列表（从低到高） */
export const TIERS: TierMeta[] = [
  {
    code: 'bronze',
    label: '青铜',
    color: 'var(--tier-bronze)',
    threshold: 0,
    icon: '🥉',
    gradient: 'linear-gradient(135deg, #cd7f32, #8b4513)',
  },
  {
    code: 'silver',
    label: '白银',
    color: 'var(--tier-silver)',
    threshold: 1000,
    icon: '🥈',
    gradient: 'linear-gradient(135deg, #c0c0c0, #808080)',
  },
  {
    code: 'gold',
    label: '黄金',
    color: 'var(--tier-gold)',
    threshold: 3000,
    icon: '🥇',
    gradient: 'linear-gradient(135deg, #ffb84d, #ff6348)',
  },
  {
    code: 'platinum',
    label: '铂金',
    color: 'var(--tier-platinum)',
    threshold: 6000,
    icon: '💎',
    gradient: 'linear-gradient(135deg, #a87cff, #6c5ce7)',
  },
]

/** 段位 code -> TierMeta 映射 */
export const TIER_MAP: Record<Tier, TierMeta> = Object.fromEntries(
  TIERS.map((t) => [t.code, t]),
) as Record<Tier, TierMeta>

/** 根据分数获取当前段位 */
export function getTierByScore(score: number): TierMeta {
  return TIERS.slice().reverse().find((t) => score >= t.threshold) ?? TIERS[0]
}

/** 获取下一段位（已达最高段位返回 null） */
export function getNextTier(score: number): TierMeta | null {
  return TIERS.find((t) => t.threshold > score) ?? null
}
