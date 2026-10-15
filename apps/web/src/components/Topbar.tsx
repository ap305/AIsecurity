import { Link, useLocation, useNavigate } from 'react-router-dom'
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

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const avatarColor = isAdmin ? 'var(--tier-gold)' : 'var(--brand-cyan)'
  const initial = user?.displayName?.charAt(0) ?? 'U'

  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 'var(--topbar-height)',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        zIndex: 100,
        backdropFilter: 'blur(8px)',
      }}
    >
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 20 }}>&#x1f6e1;&#xfe0f;</span>
        <Link
          to="/"
          style={{
            fontWeight: 700,
            fontSize: 16,
            color: 'var(--brand-cyan)',
            letterSpacing: 2,
            fontFamily: 'var(--font-mono)',
          }}
        >
          AI-SEC PLATFORM
        </Link>
      </div>

      {/* Nav */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {navItems.map((item) => {
          const isActive =
            item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                padding: '6px 16px',
                borderRadius: 4,
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--brand-cyan)' : 'var(--text-secondary)',
                background: isActive ? 'var(--brand-cyan-dim)' : 'transparent',
                transition: 'all var(--transition-fast)',
              }}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* User area */}
      {isAuthenticated && user ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Avatar */}
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: avatarColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#0a0e17',
            }}
          >
            {initial}
          </div>

          {/* Name */}
          <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
            {user.displayName}
          </span>

          {/* Tier / Admin badge */}
          <span
            style={{
              fontSize: 11,
              padding: '1px 8px',
              borderRadius: 10,
              fontWeight: 600,
              background: isAdmin
                ? 'rgba(255,107,107,0.15)'
                : `${TIER_MAP[user.tier]?.color ?? 'var(--tier-bronze)'}20`,
              color: isAdmin ? 'var(--danger)' : (TIER_MAP[user.tier]?.color ?? 'var(--tier-bronze)'),
            }}
          >
            {isAdmin
              ? 'ADMIN'
              : `${TIER_MAP[user.tier]?.icon ?? ''} ${TIER_MAP[user.tier]?.label ?? user.tier}`}
          </span>

          {/* Logout */}
          <button
            onClick={handleLogout}
            style={{
              marginLeft: 4,
              padding: '4px 10px',
              border: '1px solid var(--border-color)',
              borderRadius: 4,
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 11,
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--danger)'
              e.currentTarget.style.color = 'var(--danger)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-color)'
              e.currentTarget.style.color = 'var(--text-secondary)'
            }}
          >
            退出
          </button>
        </div>
      ) : (
        /* Unauthenticated — should not normally render (Login page has no Topbar),
           but kept as fallback */
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: 'var(--text-muted)',
            }}
          >
            U
          </div>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>未登录</span>
        </div>
      )}
    </header>
  )
}
