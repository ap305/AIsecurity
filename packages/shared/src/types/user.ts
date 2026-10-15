/** Spec #2 用户角色 */
export type UserRole = 'student' | 'ta' | 'teacher' | 'admin'

/** Spec #2 段位等级 */
export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum'

/** 赛季状态 */
export type SeasonStatus = 'draft' | 'active' | 'frozen' | 'archived'

/** 队伍角色 */
export type TeamRole = 'blue' | 'red'

/** 告警级别 */
export type AlertLevel = 'low' | 'medium' | 'high' | 'critical'

/** 用户 */
export interface User {
  id: string
  username: string
  displayName: string
  role: UserRole
  tier: Tier
  school?: string
  studentId?: string | null
  phone?: string | null
  phoneVerified?: boolean
}
