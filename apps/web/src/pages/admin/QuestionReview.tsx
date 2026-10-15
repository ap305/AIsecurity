import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, apiPut } from '../../lib/api'

interface ReviewQuestion {
  id: string
  moduleCode: string
  number: number
  title: string
  type: string
  difficulty: string
  category: 'basic' | 'security'
  status: 'published' | 'draft' | 'review' | 'pending'
  testConfig: string | null
  createdAt: string
  updatedAt: string
}

const TYPE_LABELS: Record<string, string> = {
  T: '理论',
  C: '编程',
  'T+C': '理论+编程',
  A: '攻防',
}

const DIFFICULTY_LABELS: Record<string, string> = {
  L1: 'L1 入门',
  L2: 'L2 基础',
  L3: 'L3 进阶',
  L4: 'L4 困难',
  L5: 'L5 挑战',
}

export default function QuestionReview() {
  const [reviews, setReviews] = useState<ReviewQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }

  const fetchReviews = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<ReviewQuestion[]>('/admin/questions?status=review')
      setReviews(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchReviews()
  }, [fetchReviews])

  const handleApprove = async (q: ReviewQuestion) => {
    setProcessing(q.id)
    try {
      await apiPut(`/admin/questions/${q.id}`, { status: 'published' })
      showToast(`题目 ${q.id} 已通过并发布`, 'success')
      setReviews(prev => prev.filter(item => item.id !== q.id))
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setProcessing(null)
    }
  }

  const handleReject = async (q: ReviewQuestion) => {
    setProcessing(q.id)
    try {
      await apiPut(`/admin/questions/${q.id}`, { status: 'draft' })
      showToast(`题目 ${q.id} 已退回（草稿）`, 'success')
      setReviews(prev => prev.filter(item => item.id !== q.id))
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setProcessing(null)
    }
  }

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    } catch {
      return iso
    }
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>题目审核</h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {loading
            ? '加载中...'
            : `待审核 ${reviews.length} 道题目`}
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 60,
            right: 20,
            zIndex: 1000,
            padding: '10px 16px',
            borderRadius: 6,
            border: `1px solid ${toast.type === 'success' ? 'var(--success)' : 'var(--danger)'}`,
            background:
              toast.type === 'success'
                ? 'rgba(72,219,128,0.12)'
                : 'rgba(255,107,107,0.12)',
            color: toast.type === 'success' ? 'var(--success)' : 'var(--danger)',
            fontSize: 13,
            maxWidth: 360,
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            padding: '16px 20px',
            background: 'rgba(255,107,107,0.08)',
            border: '1px solid var(--danger)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          加载失败：{error}
          <button
            onClick={fetchReviews}
            style={{
              marginLeft: 12,
              padding: '4px 12px',
              border: '1px solid var(--danger)',
              borderRadius: 4,
              background: 'transparent',
              color: 'var(--danger)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            重试
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && reviews.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '64px 24px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 48 }}>✅</span>
          <p style={{ marginTop: 12, fontSize: 15, fontWeight: 600 }}>暂无待审核题目</p>
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>
            所有题目已审核完毕
          </p>
          <Link
            to="/admin/questions"
            style={{
              display: 'inline-block',
              marginTop: 16,
              padding: '6px 16px',
              border: '1px solid var(--brand-cyan)',
              borderRadius: 4,
              color: 'var(--brand-cyan)',
              fontSize: 12,
            }}
          >
            前往题目管理 →
          </Link>
        </div>
      )}

      {/* Review list */}
      {!error && reviews.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {reviews.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 20px',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                  {item.title}
                </h3>
                <p
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{item.id}</span>
                  <span>模块: <strong>{item.moduleCode}</strong></span>
                  <span>类型: {TYPE_LABELS[item.type] ?? item.type}</span>
                  <span>难度: {DIFFICULTY_LABELS[item.difficulty] ?? item.difficulty}</span>
                  <span>分类: {item.category === 'security' ? '安全' : '基础'}</span>
                  <span>更新: {formatDate(item.updatedAt)}</span>
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 16 }}>
                <Link
                  to={`/admin/questions`}
                  style={{
                    padding: '6px 12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                >
                  详情
                </Link>
                <button
                  onClick={() => handleApprove(item)}
                  disabled={processing === item.id}
                  style={{
                    padding: '6px 16px',
                    border: '1px solid var(--success)',
                    borderRadius: 6,
                    background:
                      processing === item.id
                        ? 'rgba(72,219,128,0.04)'
                        : 'rgba(72,219,128,0.08)',
                    color: 'var(--success)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: processing === item.id ? 'not-allowed' : 'pointer',
                    opacity: processing === item.id ? 0.5 : 1,
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (processing !== item.id)
                      e.currentTarget.style.background = 'rgba(72,219,128,0.16)'
                  }}
                  onMouseLeave={(e) => {
                    if (processing !== item.id)
                      e.currentTarget.style.background = 'rgba(72,219,128,0.08)'
                  }}
                >
                  {processing === item.id ? '处理中...' : '通过'}
                </button>
                <button
                  onClick={() => handleReject(item)}
                  disabled={processing === item.id}
                  style={{
                    padding: '6px 16px',
                    border: '1px solid var(--danger)',
                    borderRadius: 6,
                    background:
                      processing === item.id
                        ? 'rgba(255,107,107,0.04)'
                        : 'rgba(255,107,107,0.08)',
                    color: 'var(--danger)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: processing === item.id ? 'not-allowed' : 'pointer',
                    opacity: processing === item.id ? 0.5 : 1,
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (processing !== item.id)
                      e.currentTarget.style.background = 'rgba(255,107,107,0.16)'
                  }}
                  onMouseLeave={(e) => {
                    if (processing !== item.id)
                      e.currentTarget.style.background = 'rgba(255,107,107,0.08)'
                  }}
                >
                  退回
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
