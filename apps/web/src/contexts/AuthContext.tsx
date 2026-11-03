import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { subscribeAuthFailures, TOKEN_KEY } from '../lib/api'
import { AuthSession } from '../lib/authSession'
export type { AuthUser } from '../lib/authSession'

function useAuthSession(session: AuthSession) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return {
    user: snapshot.user,
    logoutNotice: snapshot.notice,
    sessionStatus: snapshot.status,
    isAuthenticated: snapshot.status === 'authenticated',
    isAdmin: snapshot.status === 'authenticated' && snapshot.user?.role === 'admin',
    isLoading: snapshot.status === 'restoring',
    retrySession: session.restore,
    login: session.login,
    logout: session.logout,
    register: session.register,
    updateProfile: session.updateProfile,
    changePassword: session.changePassword,
    logoutOthers: session.logoutOthers,
  }
}
const AuthContext = createContext<ReturnType<typeof useAuthSession> | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session] = useState(() => new AuthSession())
  const value = useAuthSession(session)
  useEffect(() => {
    try {
      localStorage.removeItem('aisec_auth')
      localStorage.removeItem('aisec_users')
    } catch {
      /* discard legacy local account data when storage permits */
    }
    const unsubscribe = subscribeAuthFailures(session.onAuthFailure)
    const sync = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return
      if (event.key === TOKEN_KEY || event.key === null) void session.syncStorage(true)
    }
    const onFocus = () => {
      void session.syncStorage()
    }
    window.addEventListener('storage', sync)
    window.addEventListener('focus', onFocus)
    void session.restore()
    return () => {
      unsubscribe()
      window.removeEventListener('storage', sync)
      window.removeEventListener('focus', onFocus)
    }
  }, [session])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
