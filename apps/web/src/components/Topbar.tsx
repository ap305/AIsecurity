import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useTeaching } from '../contexts/TeachingContext'
import { workspaceRoleLabel } from '../lib/roleNavigation'

export default function Topbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthenticated, isAdmin, logout } = useAuth()
  const { canTeach, status } = useTeaching()
  const teachingSpace = location.pathname.startsWith('/teaching')
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      const result = await logout()
      if (result.sessionChanged) return
      navigate('/login', {
        replace: true,
        state: {
          logoutNotice: result.revoked
            ? '已安全退出。'
            : '已在本机退出；网络异常，服务端撤销尚未确认。请恢复连接后由管理员协助处理。',
        },
      })
    } finally {
      setLoggingOut(false)
    }
  }

  const avatarColor = isAdmin ? 'var(--tier-gold)' : 'var(--brand-cyan)'
  const initial = user?.displayName?.charAt(0) ?? 'U'

  return (
    <header className="app-topbar">
      <Link to="/" className="topbar-brand" aria-label="AI安全教学实验系统首页">
        <svg className="topbar-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3 4.5 6v5.5c0 4.2 2.9 7.6 7.5 9.5 4.6-1.9 7.5-5.3 7.5-9.5V6L12 3Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="m8.5 11.5 2.5 2.5 4.5-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="topbar-brand-text">
          <strong>
            AI-SEC <span>PLATFORM</span>
          </strong>
          <small>AI安全教学实验系统</small>
        </span>
      </Link>

      <nav className="topbar-nav workspace-switch" aria-label="空间切换">
        <Link to="/" aria-current={!teachingSpace ? 'page' : undefined}>
          练习空间
        </Link>
        {canTeach && (
          <Link to="/teaching" aria-current={teachingSpace ? 'page' : undefined}>
            教学空间
          </Link>
        )}
      </nav>

      {isAuthenticated && user ? (
        <div className="topbar-account">
          <span className="topbar-avatar" style={{ color: avatarColor }} aria-hidden="true">
            {initial}
          </span>
          <span className="topbar-user-name" title={user.displayName}>
            {user.displayName}
          </span>
          <span
            className="topbar-user-badge"
            style={{
              color: isAdmin ? 'var(--tier-gold)' : 'var(--brand-cyan)',
            }}
          >
            {isAdmin || status === 'ready' ? workspaceRoleLabel(user.role, canTeach) : '师生账号'}
          </span>
          <button className="topbar-logout" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? '退出中…' : '退出'}
          </button>
        </div>
      ) : (
        <span className="topbar-account prd-muted">未登录</span>
      )}
    </header>
  )
}
