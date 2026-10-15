import { useEffect, useState } from 'react'
import { MODULES, getTotalQuestions } from '@ai-security/shared'
import ModuleCard from '../components/ModuleCard'
import { apiGet } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

interface UserStats {
  displayName: string
  totalScore: number
  tier: string
  matchWins: number
  tasksCompleted: number
}

const SEASON_END = '2026-08-31T23:59:59'

function getDaysRemaining(endDate: string): number {
  const now = Date.now()
  const end = new Date(endDate).getTime()
  return Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)))
}

export default function Dashboard() {
  const { user } = useAuth()
  const [stats, setStats] = useState<UserStats | null>(null)
  const [loading, setLoading] = useState(true)
  const daysRemaining = getDaysRemaining(SEASON_END)
  const totalQuestions = getTotalQuestions()

  useEffect(() => {
    if (user?.id) {
      apiGet<UserStats>(`/users/${user.id}/stats`)
        .then(setStats)
        .catch(() => setStats(null))
        .finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [user])

  const completed = stats?.tasksCompleted ?? 0
  const score = stats?.totalScore ?? 0
  const matches = stats?.matchWins ?? 0

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginBottom: 4,
          }}
        >
          任务大厅
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {totalQuestions} 道题目 · 编程实践 + Agent攻防 · 赛季倒计时{' '}
          <strong style={{ color: 'var(--brand-cyan)', fontFamily: 'var(--font-mono)' }}>
            {daysRemaining} 天
          </strong>
        </p>
      </div>

      {/* Stats cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 16,
          marginBottom: 32,
        }}
      >
        {[
          { label: '已完成', value: loading ? '...' : completed, unit: '题', color: 'var(--color-m1)' },
          { label: '当前积分', value: loading ? '...' : Math.round(score), unit: '', color: 'var(--color-m4)' },
          { label: '对战战绩', value: loading ? '...' : `${matches}胜`, unit: '', color: 'var(--color-m3)' },
          { label: '获得徽章', value: 0, unit: '枚', color: 'var(--color-m5)' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {stat.label}
            </span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: stat.color,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {stat.value}
              </span>
              {stat.unit && (
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {stat.unit}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Module cards grid */}
      <div>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: 16,
          }}
        >
          学习模块
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 16,
          }}
        >
          {MODULES.map((mod) => (
            <ModuleCard key={mod.code} module={mod} progress={0} />
          ))}
        </div>
      </div>
    </div>
  )
}
