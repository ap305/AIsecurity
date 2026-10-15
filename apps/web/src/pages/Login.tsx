import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { UserRole } from '@ai-security/shared'

type RoleTab = { role: UserRole; label: string }

const ROLE_TABS: RoleTab[] = [
  { role: 'student', label: '学员登录' },
  { role: 'admin', label: '管理员登录' },
]

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [activeRole, setActiveRole] = useState<RoleTab>(ROLE_TABS[0])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码')
      return
    }

    setLoading(true)
    try {
      await login(username.trim(), password, activeRole.role)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <span style={{ fontSize: 36 }}>&#x1f6e1;&#xfe0f;</span>
          <h1
            style={{
              marginTop: 12,
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--brand-cyan)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: 2,
            }}
          >
            AI-SEC PLATFORM
          </h1>
          <p style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
            AI安全教学实验系统
          </p>
        </div>

        {/* Role Tabs */}
        <div style={{ display: 'flex', marginBottom: 24, borderBottom: '1px solid var(--border-color)' }}>
          {ROLE_TABS.map((tab) => {
            const isActive = tab.role === activeRole.role
            return (
              <button
                key={tab.role}
                type="button"
                onClick={() => { setActiveRole(tab); setError('') }}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  border: 'none',
                  borderBottom: isActive ? '2px solid var(--brand-cyan)' : '2px solid transparent',
                  background: 'transparent',
                  color: isActive ? 'var(--brand-cyan)' : 'var(--text-muted)',
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <input
              className="form-input"
              type="text"
              placeholder="用户名"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setError('') }}
              autoComplete="username"
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input
              className="form-input"
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              autoComplete="current-password"
            />
          </div>

          {/* Error */}
          {error && (
            <p style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            className="btn-primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', marginTop: 8 }}
          >
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>

        {/* Register link */}
        {activeRole.role === 'student' && (
          <div style={{ marginTop: 20, textAlign: 'center' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 12,
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              <span style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
              <span style={{ flexShrink: 0 }}>或</span>
              <span style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
            </div>
            <Link
              to="/register"
              className="btn-ghost"
              style={{
                display: 'inline-block',
                textDecoration: 'none',
                fontSize: 13,
                padding: '6px 20px',
              }}
            >
              注册新账号
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
