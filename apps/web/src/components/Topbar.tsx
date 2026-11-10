import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { TIER_MAP } from '@ai-security/shared'
import { useAuth } from '../contexts/AuthContext'

const NAV_ITEMS = [
  { path: '/', label: '任务大厅' },
  { path: '/arena', label: '对战大厅' },
  { path: '/leaderboard', label: '排行榜' },
]

export default function Topbar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthenticated, isAdmin, logout } = useAuth()
  const navItems = NAV_ITEMS
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

      <nav className="topbar-nav" aria-label="快捷导航">
        {navItems.map((item) => {
          const isActive =
            item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
          return (
            <Link key={item.path} to={item.path} aria-current={isActive ? 'page' : undefined}>
              {item.label}
            </Link>
          )
        })}
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
              color: isAdmin ? 'var(--tier-gold)' : (TIER_MAP[user.tier]?.color ?? 'var(--tier-bronze)'),
            }}
          >
            {isAdmin
              ? '管理员'
              : `${TIER_MAP[user.tier]?.icon ?? ''} ${TIER_MAP[user.tier]?.label ?? user.tier}`}
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
