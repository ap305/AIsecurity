import { Fragment, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { protectedDestination } from '../lib/authSession'

interface ProtectedRouteProps {
  requireAdmin?: boolean
  children?: React.ReactNode
}

export default function ProtectedRoute({ requireAdmin = false, children }: ProtectedRouteProps) {
  const { user, sessionStatus, retrySession, logout } = useAuth()
  const location = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)
  const destination = protectedDestination(
    { status: sessionStatus, user },
    `${location.pathname}${location.search}${location.hash}`,
    requireAdmin,
  )
  if (destination === 'restoring')
    return (
      <div className="login-page" role="status">
        正在验证登录状态…
      </div>
    )
  if (destination === 'unavailable')
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>暂时无法验证登录</h1>
          <p role="alert">网络或身份服务暂不可用。登录凭据、解题草稿和任务引用已保留，请恢复连接后重试。</p>
          <button
            className="btn-primary"
            onClick={() => {
              void retrySession()
            }}
          >
            重新验证
          </button>
          <button
            className="btn-ghost"
            disabled={loggingOut}
            onClick={async () => {
              setLoggingOut(true)
              try {
                await logout()
              } finally {
                setLoggingOut(false)
              }
            }}
          >
            {loggingOut ? '退出中…' : '退出当前登录'}
          </button>
        </div>
      </div>
    )
  if (destination) return <Navigate to={destination} replace />
  return <Fragment key={user?.id}>{children ?? <Outlet />}</Fragment>
}
