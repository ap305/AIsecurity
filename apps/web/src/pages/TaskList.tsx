import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { MODULES } from '@ai-security/shared'
import type { QuestionType, Difficulty } from '@ai-security/shared'
import { getMockQuestions } from '../lib/mockQuestions'
import { apiGet } from '../lib/api'

const TYPE_LABELS: Record<QuestionType, string> = {
  T: '📖 理论',
  C: '💻 编程',
  'T+C': '📝 理论+编程',
  'A/D': '⚔️ 攻防',
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  L1: '入门',
  L2: '进阶',
  L3: '挑战',
}

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  L1: '#48db80',
  L2: '#ffb84d',
  L3: '#ff6b6b',
}

interface QuestionListItem {
  id: string
  moduleCode: string
  number: number
  title: string
  type: QuestionType
  difficulty: Difficulty
  category: 'basic' | 'security'
}

export default function TaskList() {
  const { moduleCode } = useParams<{ moduleCode: string }>()
  const mod = MODULES.find((m) => m.code === moduleCode)

  const [questions, setQuestions] = useState<QuestionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [usingMock, setUsingMock] = useState(false)

  useEffect(() => {
    if (!moduleCode) return
    setLoading(true)
    apiGet<QuestionListItem[]>(`/modules/${moduleCode}/questions`)
      .then((data) => {
        setQuestions(data)
        setUsingMock(false)
      })
      .catch(() => {
        // Fallback to mock data
        setQuestions(getMockQuestions(moduleCode) as QuestionListItem[])
        setUsingMock(true)
      })
      .finally(() => setLoading(false))
  }, [moduleCode])

  if (!mod) {
    return (
      <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-muted)' }}>
        <p style={{ fontSize: 18, marginBottom: 8 }}>模块不存在</p>
        <Link to="/" style={{ color: 'var(--brand-cyan)' }}>
          返回任务大厅
        </Link>
      </div>
    )
  }

  const basicQs = questions.filter((q) => q.category === 'basic')
  const securityQs = questions.filter((q) => q.category === 'security')

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <div
          style={{
            width: 32,
            height: 32,
            border: '3px solid var(--border-color)',
            borderTopColor: 'var(--brand-cyan)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 16px',
          }}
        />
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>加载题目中...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div>
      {/* Module header */}
      <div style={{ marginBottom: 28 }}>
        <Link
          to="/"
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 12,
            display: 'inline-block',
          }}
        >
          &larr; 任务大厅
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          <span style={{ fontSize: 24 }}>{mod.icon}</span>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
              {mod.code} {mod.title}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {mod.description}
            </p>
          </div>
        </div>
        {usingMock && (
          <p style={{ fontSize: 12, color: 'var(--warning)', marginTop: 8 }}>
            ⚠ API 不可达，当前显示 Mock 数据
          </p>
        )}
      </div>

      {/* Question table */}
      {(['basic', 'security'] as const).map((category) => {
        const qs = category === 'basic' ? basicQs : securityQs
        if (qs.length === 0) return null

        return (
          <div key={category} style={{ marginBottom: 32 }}>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                color:
                  category === 'basic' ? 'var(--brand-cyan)' : 'var(--danger)',
                marginBottom: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background:
                    category === 'basic' ? 'var(--brand-cyan)' : 'var(--danger)',
                }}
              />
              {category === 'basic' ? '基础任务' : '安全任务'}
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                ({qs.length} 题)
              </span>
            </h2>

            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr
                    style={{
                      background: 'var(--bg-secondary)',
                      borderBottom: '1px solid var(--border-color)',
                    }}
                  >
                    <th
                      style={{
                        padding: '10px 16px',
                        textAlign: 'left',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        width: 60,
                      }}
                    >
                      #
                    </th>
                    <th
                      style={{
                        padding: '10px 16px',
                        textAlign: 'left',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                      }}
                    >
                      题目
                    </th>
                    <th
                      style={{
                        padding: '10px 16px',
                        textAlign: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        width: 104,
                      }}
                    >
                      类型
                    </th>
                    <th
                      style={{
                        padding: '10px 16px',
                        textAlign: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        width: 96,
                      }}
                    >
                      难度
                    </th>
                    <th
                      style={{
                        padding: '10px 16px',
                        textAlign: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: 1,
                        width: 80,
                      }}
                    >
                      状态
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {qs.map((q) => (
                    <tr
                      key={q.id}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                        transition: 'background var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--bg-card-hover)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <td
                        style={{
                          padding: '10px 16px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--text-muted)',
                        }}
                      >
                        {String(q.number).padStart(2, '0')}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <Link
                          to={`/question/${q.id}`}
                          style={{
                            fontSize: 13,
                            color: 'var(--text-primary)',
                            fontWeight: 500,
                          }}
                        >
                          {q.title}
                        </Link>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background:
                              q.type === 'A/D'
                                ? 'rgba(255, 107, 107, 0.15)'
                                : q.type === 'C'
                                  ? 'rgba(72, 219, 128, 0.12)'
                                  : 'rgba(0, 212, 255, 0.1)',
                            color:
                              q.type === 'A/D'
                                ? 'var(--danger)'
                                : q.type === 'C'
                                  ? 'var(--success)'
                                  : 'var(--brand-cyan)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {TYPE_LABELS[q.type]}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: `${DIFFICULTY_COLORS[q.difficulty]}15`,
                            color: DIFFICULTY_COLORS[q.difficulty],
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {DIFFICULTY_LABELS[q.difficulty]}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                          }}
                        >
                          未开始
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
