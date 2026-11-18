import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { getAuthToken } from '../lib/api'
import { classroomsApi } from '../lib/classrooms'

type Status = 'loading' | 'ready' | 'unavailable'
interface TeachingAccess {
  canTeach: boolean
  status: Status
  refresh: () => Promise<void>
}
const TeachingContext = createContext<TeachingAccess | null>(null)

export function TeachingProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth()
  const { pathname } = useLocation()
  const token = getAuthToken()
  const eligible = isAuthenticated && !!user && !user.mustChangePassword && !!token
  // Each teaching route must verify its permission before mounting privileged content.
  const key = JSON.stringify([
    eligible ? user?.id : null,
    token,
    pathname.startsWith('/teaching') ? pathname : 'practice',
  ])
  const currentKey = useRef(key)
  currentKey.current = key
  const request = useRef(0)
  const [access, setAccess] = useState<{ key: string; status: Status; canTeach: boolean }>({
    key: '',
    status: 'loading',
    canTeach: false,
  })
  const refresh = useCallback(async () => {
    const version = ++request.current
    const current = () =>
      version === request.current && key === currentKey.current && token === getAuthToken()
    if (!eligible) {
      setAccess({ key, status: 'ready', canTeach: false })
      return
    }
    setAccess({ key, status: 'loading', canTeach: false })
    try {
      const result = await classroomsApi.capabilities()
      if (typeof result?.canTeach !== 'boolean') throw new Error('教师权限响应无效')
      if (current()) setAccess({ key, status: 'ready', canTeach: result.canTeach })
    } catch {
      if (current()) setAccess({ key, status: 'unavailable', canTeach: false })
    }
  }, [key, token, eligible])

  useEffect(() => {
    void refresh()
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      ++request.current
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const confirmed = eligible && access.key === key
  return (
    <TeachingContext.Provider
      value={{
        canTeach: confirmed && access.status === 'ready' && access.canTeach,
        status: !eligible ? 'ready' : confirmed ? access.status : 'loading',
        refresh,
      }}
    >
      {children}
    </TeachingContext.Provider>
  )
}

export function useTeaching() {
  const value = useContext(TeachingContext)
  if (!value) throw new Error('useTeaching must be used within TeachingProvider')
  return value
}
