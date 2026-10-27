import { apiPost, apiPut } from './api'

export interface AdminUser {
  id: string
  username: string
  displayName: string
  role: string
  tier: string
  school: string
  studentId?: string | null
  createdAt: string
  isTestAccount: boolean
  accountStatus: 'active' | 'disabled' | 'deleted'
}

export interface TestAccountForm {
  username: string
  displayName: string
  password: string
  school: string
}

export function validateTestAccountForm(form: TestAccountForm): string | null {
  if (!/^[A-Za-z0-9]{3,32}$/.test(form.username.trim())) return '用户名仅限 3～32 位字母或数字'
  if (!form.displayName.trim()) return '请填写姓名'
  if (form.displayName.trim().length > 64) return '姓名最多 64 个字符'
  if (!form.password.trim() || form.password.length < 6) return '初始密码至少需要 6 位，且不能全为空格'
  if (form.password.length > 128) return '初始密码最多 128 位'
  if (form.school.trim().length > 200) return '学校名称最多 200 个字符'
  return null
}

function managedUser(data: { user: AdminUser }, status: 'active' | 'disabled', userId?: string): AdminUser {
  const user = data?.user
  if (
    !user ||
    typeof user.id !== 'string' ||
    !user.id ||
    typeof user.username !== 'string' ||
    !user.username ||
    user.isTestAccount !== true ||
    user.role !== 'student' ||
    user.accountStatus !== status ||
    (userId !== undefined && user.id !== userId)
  ) {
    throw new Error('返回的测试账号信息不完整，请刷新用户列表确认操作结果')
  }
  return user
}

export async function createTestAccount(form: TestAccountForm): Promise<AdminUser> {
  const error = validateTestAccountForm(form)
  if (error) throw new Error(error)
  const school = form.school.trim()
  const data = await apiPost<{ user: AdminUser }>('/admin/users', {
    username: form.username.trim(),
    displayName: form.displayName.trim(),
    password: form.password,
    ...(school ? { school } : {}),
  })
  return managedUser(data, 'active')
}

export async function setTestAccountStatus(
  user: AdminUser,
  status: 'active' | 'disabled',
): Promise<AdminUser> {
  if (!user.isTestAccount || user.role !== 'student' || user.accountStatus === 'deleted') {
    throw new Error('只能停用或启用尚未删除的测试账号')
  }
  if (status !== 'active' && status !== 'disabled') throw new Error('账号状态无效')
  const data = await apiPut<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(user.id)}/status`, {
    status,
  })
  return managedUser(data, status, user.id)
}

export function userDeleteConfirmation(user: AdminUser): string {
  if (user.isTestAccount) {
    return `确认删除测试账号「${user.displayName}」(${user.username})？删除后账号无法登录，历史提交、评测结果和用户名将保留。此操作不可恢复。`
  }
  return `确认删除学员「${user.displayName}」(${user.username})？此操作不可恢复。`
}
