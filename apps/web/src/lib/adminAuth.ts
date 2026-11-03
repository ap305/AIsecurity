import { apiGet, apiPost, apiPut } from './api'
import { validateNewPassword } from './authSession'

export interface PasswordRecovery {
  ok: true
  temporaryPassword: string
  expiresAt: string
}
export interface AuthEvent {
  id: string
  type: string
  action: string
  createdAt: string
  userId: string | null
  actorId: string | null
  success: boolean
}

export async function setUserPassword(userId: string, password: string, confirmation: string): Promise<void> {
  const error = validateNewPassword(password)
  if (error) throw new Error(error)
  if (password !== confirmation) throw new Error('两次密码不一致。')
  await apiPut(`/admin/users/${encodeURIComponent(userId)}/password`, { password })
}

export async function recoverInitialPassword(
  userId: string,
  identityVerified: boolean,
): Promise<PasswordRecovery> {
  if (!identityVerified) throw new Error('请先完成人工身份核验并勾选确认。')
  const data = await apiPost<PasswordRecovery>(`/admin/users/${encodeURIComponent(userId)}/password-reset`, {
    identityVerified: true,
  })
  if (
    data?.ok !== true ||
    typeof data.temporaryPassword !== 'string' ||
    !data.temporaryPassword ||
    !Number.isFinite(Date.parse(data.expiresAt))
  ) {
    throw new Error('恢复响应不完整，请重新核验操作结果。')
  }
  return data
}

export function fetchAuthEvents(userId: string): Promise<AuthEvent[]> {
  return apiGet<AuthEvent[]>(`/admin/auth-events?userId=${encodeURIComponent(userId)}&limit=20`)
}
