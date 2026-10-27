import type { AdminUser } from './adminUsers'

export interface AdminUserFilters {
  keyword: string
  accountType: 'all' | 'regular' | 'test'
  role: 'all' | 'admin' | 'student'
  status: 'all' | 'active' | 'disabled'
}

export function defaultAdminUserFilters(): AdminUserFilters {
  return { keyword: '', accountType: 'all', role: 'all', status: 'all' }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function filterAdminUsers(users: readonly AdminUser[], filters: AdminUserFilters): AdminUser[] {
  const terms = normalize(filters.keyword).split(' ').filter(Boolean)
  return users.filter((user) => {
    if (user.accountStatus === 'deleted') return false
    if (filters.accountType === 'test' && !user.isTestAccount) return false
    if (filters.accountType === 'regular' && user.isTestAccount) return false
    if (filters.role !== 'all' && user.role !== filters.role) return false
    if (filters.status !== 'all' && (user.accountStatus ?? 'active') !== filters.status) return false
    const fields = [user.username, user.displayName, user.school, user.studentId].map(normalize)
    return terms.every((term) => fields.some((field) => field.includes(term)))
  })
}
