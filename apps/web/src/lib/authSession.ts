import type { User, UserRole } from '@ai-security/shared'
import { ApiError, apiGet, apiPost, apiPut, getAuthToken, setAuthToken } from './api'

export interface AuthUser extends User {
  school?: string
  createdAt?: string
  lastLoginAt?: string | null
  mustChangePassword?: boolean
}
export type SessionStatus = 'restoring' | 'authenticated' | 'anonymous' | 'unavailable'
export interface SessionSnapshot {
  status: SessionStatus
  user: AuthUser | null
  notice?: string
}
export interface ProfileForm {
  displayName: string
  school: string
  studentId?: string
  phone?: string
}
export interface RegistrationForm extends ProfileForm {
  username: string
  password: string
}
export interface LogoutResult {
  revoked: boolean
  sessionChanged?: boolean
}
interface AuthResponse {
  token: string
  user: AuthUser
}

export function isSessionInvalid(error: unknown): boolean {
  return error instanceof ApiError && error.code === 40100 && [200, 401].includes(error.status)
}

export function validateNewPassword(password: string): string | null {
  const length = [...password].length
  return length >= 15 && length <= 128 ? null : '新密码须为 15～128 个字符（支持中文和表情，不会去除空格）。'
}

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return '/'
  let decoded = value.split(/[?#]/)[0]
  try {
    for (let i = 0; i < 8; i++) {
      if (/[\\\u0000-\u0020\u007f]/.test(decoded) || /^\/\//.test(decoded)) return '/'
      if (/%(?:2f|5c)/i.test(decoded)) return '/'
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      if (i === 7) return '/'
    }
    const url = new URL(decoded, 'https://platform.invalid')
    if (
      url.origin !== 'https://platform.invalid' ||
      /^\/(?:login|register|auth\/change-password)\/?$/i.test(url.pathname)
    )
      return '/'
    return value
  } catch {
    return '/'
  }
}

export function loginHref(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}

export function passwordChangeHref(returnTo: string): string {
  return `/auth/change-password?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}

export function protectedDestination(
  snapshot: SessionSnapshot,
  returnTo: string,
  requireAdmin = false,
): string | null {
  if (snapshot.status === 'restoring' || snapshot.status === 'unavailable') return snapshot.status
  if (snapshot.status !== 'authenticated' || !snapshot.user) return loginHref(returnTo)
  if (snapshot.user.mustChangePassword && returnTo.split(/[?#]/)[0] !== '/auth/change-password')
    return passwordChangeHref(returnTo)
  if (requireAdmin && snapshot.user.role !== 'admin') return '/'
  return null
}

// The cached user is display data only. Only /auth/me or an auth response can grant access.
export class AuthSession {
  snapshot: SessionSnapshot = { status: getAuthToken() ? 'restoring' : 'anonymous', user: null }
  private version = 0
  private token = getAuthToken()
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  private publish(snapshot: SessionSnapshot) {
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }
  private current(version: number, token: string | null) {
    return version === this.version && token === getAuthToken()
  }
  private requireCurrent(version: number, token: string | null) {
    if (!this.current(version, token)) throw new Error('登录账号已变化，请在当前账号下重试。')
  }
  private clear(notice?: string) {
    this.version++
    this.token = null
    const cleared = setAuthToken(null)
    try {
      localStorage.removeItem('aisec_user')
    } catch {
      /* storage may be unavailable */
    }
    this.publish({
      status: 'anonymous',
      user: null,
      notice: cleared
        ? notice
        : `${notice ?? ''} 浏览器无法清除登录凭据，当前页面已屏蔽残留凭据。请先恢复浏览器存储权限并重新登录；问题解决前请勿刷新或关闭本页。解题草稿和任务引用已保留。`,
    })
  }
  private commit(user: AuthUser, token = getAuthToken()) {
    if (!user || typeof user.id !== 'string' || !['student', 'ta', 'teacher', 'admin'].includes(user.role)) {
      throw new Error('返回的用户信息不完整，请重试。')
    }
    if (!token || (token !== getAuthToken() && !setAuthToken(token))) {
      const message =
        '浏览器无法保存登录凭据，当前页面已退出。请修复存储权限后重新登录；若刚修改了密码，请使用新密码。'
      this.clear(message)
      throw new Error(message)
    }
    this.token = token
    try {
      localStorage.setItem('aisec_user', JSON.stringify(user))
    } catch {
      /* storage may be unavailable */
    }
    this.publish({ status: 'authenticated', user })
  }
  private commitAuth(data: AuthResponse) {
    if (!data || typeof data.token !== 'string' || !data.token) throw new Error('登录响应缺少凭据，请重试。')
    this.commit(data.user, data.token)
  }
  restore = async (): Promise<void> => {
    const version = ++this.version
    const token = getAuthToken()
    this.token = token
    if (!token) {
      this.publish({ status: 'anonymous', user: null, notice: this.snapshot.notice })
      return
    }
    this.publish({ status: 'restoring', user: null })
    try {
      const data = await apiGet<{ user: AuthUser }>('/auth/me')
      if (this.current(version, token)) this.commit(data.user, token)
    } catch (error) {
      if (!this.current(version, token)) return
      if (isSessionInvalid(error)) this.clear()
      else this.publish({ status: 'unavailable', user: null })
    }
  }
  syncStorage = async (force = false): Promise<void> => {
    if (force || this.token !== getAuthToken()) await this.restore()
  }
  onAuthFailure = (error: ApiError, token: string) => {
    if (token !== getAuthToken() || token !== this.token) return
    if (isSessionInvalid(error)) this.clear()
    else if (error.code === 42801 && this.snapshot.user) {
      this.publish({ status: 'authenticated', user: { ...this.snapshot.user, mustChangePassword: true } })
    }
  }
  login = async (username: string, password: string, role: UserRole): Promise<AuthUser> => {
    const version = ++this.version
    const token = getAuthToken()
    const data = await apiPost<AuthResponse>('/auth/login', { username, password, role })
    this.requireCurrent(version, token)
    this.commitAuth(data)
    return data.user
  }
  logout = async (): Promise<LogoutResult> => {
    ++this.version
    const token = getAuthToken()
    let revoked = !token
    try {
      if (token) {
        const data = await apiPost<{ ok: true }>('/auth/logout', {})
        revoked = data?.ok === true
      }
    } catch (error) {
      revoked = isSessionInvalid(error)
    }
    const sessionChanged = getAuthToken() !== token && getAuthToken() !== null
    if (getAuthToken() === token)
      this.clear(
        revoked
          ? '已安全退出。'
          : '已在本机退出；网络异常，服务端撤销尚未确认。请恢复连接后由管理员协助处理。',
      )
    return { revoked, sessionChanged }
  }
  register = async (form: RegistrationForm): Promise<void> => {
    const error = validateNewPassword(form.password)
    if (error) throw new Error(error)
    await apiPost('/auth/register', form)
  }
  updateProfile = async (form: ProfileForm): Promise<void> => {
    const version = this.version,
      token = getAuthToken()
    const data = await apiPut<{ user: AuthUser }>('/auth/me', form)
    this.requireCurrent(version, token)
    this.commit(data.user, token)
  }
  private rotate = async (path: string, body: unknown): Promise<void> => {
    const version = ++this.version,
      token = getAuthToken()
    const data = await apiPost<AuthResponse>(path, body)
    this.requireCurrent(version, token)
    this.commitAuth(data)
  }
  changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
    const error = validateNewPassword(newPassword)
    if (error) throw new Error(error)
    await this.rotate('/auth/change-password', { currentPassword, newPassword })
  }
  logoutOthers = async (): Promise<void> => this.rotate('/auth/logout-others', {})
}
