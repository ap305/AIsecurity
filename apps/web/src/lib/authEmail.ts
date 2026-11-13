import { apiGet, apiPost, ApiError, AUTH_TIMEOUT_MS } from './api'

export type EmailPurpose = 'registration' | 'bind' | 'reset'
export type EmailLink = { token: string; purpose: EmailPurpose }
export function parseEmailLink(fragment: string): EmailLink | null {
  if (!fragment.startsWith('#')) return null
  const params = new URLSearchParams(fragment.slice(1))
  const token = params.get('token') ?? '',
    purpose = params.get('purpose')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !['registration', 'bind', 'reset'].includes(purpose ?? ''))
    return null
  return { token, purpose: purpose as EmailPurpose }
}
export function clearEmailFragment(): void {
  if (window.location.hash)
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}
async function anonymous<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS)
  try {
    const response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || json?.code !== 0)
      throw new ApiError(
        response.status,
        typeof json?.message === 'string' ? json.message : '服务暂不可用，请稍后重试',
        json?.code,
      )
    if (!Object.prototype.hasOwnProperty.call(json, 'data')) throw new Error('服务返回格式异常，请重试')
    return json.data
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
export type EmailConfig = { emailEnabled: boolean; manualResetEnabled: boolean }
export type OwnEmail = { emailEnabled: boolean; email: string | null; verifiedAt: string | null }
export const authEmailApi = {
  config: () => anonymous<EmailConfig>('/auth/config'),
  own: () => apiGet<OwnEmail>('/auth/email'),
  request: (purpose: EmailPurpose, email: string, currentPassword?: string) =>
    purpose === 'bind'
      ? apiPost<{ accepted: true }>('/auth/email/request', { purpose, email, currentPassword })
      : anonymous<{ accepted: true }>('/auth/email/request', { purpose, email }),
  register: (form: {
    username: string
    displayName: string
    password: string
    school?: string
    studentId?: string
    phone?: string
    emailToken?: string
  }) => anonymous('/auth/register', form),
  bind: (token: string, currentPassword: string) =>
    apiPost<{ ok: true; relogin: true }>('/auth/email/bind', { token, currentPassword }),
  recover: (token: string, newPassword: string) =>
    anonymous<{ ok: true; relogin: true }>('/auth/password-recovery', { token, newPassword }),
}
