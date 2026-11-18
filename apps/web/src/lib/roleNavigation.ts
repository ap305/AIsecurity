import { safeReturnTo } from './authSession'

export function loginWorkspaceDestination(returnTo: string | null, role: string): string {
  if (returnTo && returnTo !== '/' && safeReturnTo(returnTo) === returnTo) return returnTo
  return role === 'admin' ? '/' : '/workspace'
}

export function workspaceRoleLabel(role: string | undefined, canTeach: boolean): string {
  return role === 'admin' ? '管理员' : canTeach ? '教师' : '学生'
}
