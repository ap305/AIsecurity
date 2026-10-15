import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { User, UserRole } from '@ai-security/shared'
import { apiGet, apiPost, apiPut, setAuthToken, getAuthToken } from '../lib/api'

/** 后端返回的用户（含 school/createdAt 等字段） */
export interface AuthUser extends User {
  school?: string
  createdAt?: string
}

interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  isAdmin: boolean
  isLoading: boolean
  login: (username: string, password: string, role: UserRole) => Promise<void>
  logout: () => void
  register: (form: {
    displayName: string
    school: string
    username: string
    password: string
    studentId?: string
    phone?: string
  }) => Promise<void>
  updateProfile: (form: {
    displayName: string
    school: string
    studentId?: string
    phone?: string
  }) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

const USER_KEY = 'aisec_user'
const OLD_AUTH_KEY = 'aisec_auth'
const OLD_USERS_KEY = 'aisec_users'

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(readStoredUser)
  const [isLoading, setIsLoading] = useState(true)

  // 会话恢复：校验 Token 有效性并刷新用户信息；清理旧版本地注册数据
  useEffect(() => {
    ;(async () => {
      try {
        localStorage.removeItem(OLD_AUTH_KEY)
        localStorage.removeItem(OLD_USERS_KEY)
        const token = getAuthToken()
        if (!token) {
          setUser(null)
          return
        }
        const data = await apiGet<{ user: AuthUser }>('/auth/me')
        setUser(data.user)
        try {
          localStorage.setItem(USER_KEY, JSON.stringify(data.user))
        } catch {
          /* ignore */
        }
      } catch {
        setUser(null)
        setAuthToken(null)
        try {
          localStorage.removeItem(USER_KEY)
        } catch {
          /* ignore */
        }
      } finally {
        setIsLoading(false)
      }
    })()
  }, [])

  const login = useCallback(async (username: string, password: string, role: UserRole) => {
    const data = await apiPost<{ token: string; user: AuthUser }>('/auth/login', { username, password, role })
    setAuthToken(data.token)
    setUser(data.user)
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
    } catch {
      /* ignore */
    }
  }, [])

  const logout = useCallback(() => {
    setAuthToken(null)
    setUser(null)
    try {
      localStorage.removeItem(USER_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const register = useCallback(
    async (form: {
      displayName: string
      school: string
      username: string
      password: string
      studentId?: string
      phone?: string
    }) => {
      await apiPost<{ user: AuthUser }>('/auth/register', form)
    },
    [],
  )

  const isAuthenticated = user !== null
  const updateProfile = useCallback(
    async (form: { displayName: string; school: string; studentId?: string; phone?: string }) => {
      const data = await apiPut<{ user: AuthUser }>('/auth/me', form)
      setUser(data.user)
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      } catch {
        /* ignore */
      }
    },
    [],
  )
  const isAdmin = user?.role === 'admin'

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated, isAdmin, isLoading, login, logout, register, updateProfile }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
