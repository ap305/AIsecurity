import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

interface ProtectedRouteProps {
  requireAdmin?: boolean
  children?: React.ReactNode
}

export default function ProtectedRoute({ requireAdmin = false, children }: ProtectedRouteProps) {
  const { isAuthenticated, isAdmin, isLoading } = useAuth()

  // 等待 localStorage session 恢复，避免因时序问题误重定向到 /login
  if (isLoading) {
    return null
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/" replace />
  }

  if (children) {
    return <>{children}</>
  }

  return <Outlet />
}
