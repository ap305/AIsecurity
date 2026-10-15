// Types — Spec #3 API
export type { ApiResponse, PaginatedResponse } from './types/api'

// Types — Spec #1 Tasks
export type {
  QuestionType,
  Difficulty,
  ModuleCode,
  QuestionCategory,
  QuestionStatus,
  SubmissionStatus,
  MatchStatus,
} from './types/task'

// Types — Submission
export type { Submission, SubmissionResult } from './types/task'

// Types — Spec #2 Users & Enums
export type {
  UserRole,
  Tier,
  SeasonStatus,
  TeamRole,
  AlertLevel,
  User,
} from './types/user'

// Error Codes — Spec #3
export { ErrorCode } from './types/error'

// Constants — Spec #4 Modules
export {
  MODULES,
  getTotalQuestions,
  getTotalBasic,
  getTotalSecurity,
} from './constants/modules'
export type { ModuleMeta } from './constants/modules'

// Constants - Spec #4 Tiers
export { TIERS, TIER_MAP, getTierByScore, getNextTier } from './constants/tiers'
export type { TierMeta } from './constants/tiers'

