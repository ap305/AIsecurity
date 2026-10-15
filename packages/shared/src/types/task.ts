/** Spec #1 题目类型 */
export type QuestionType = 'T' | 'C' | 'T+C' | 'A/D'

/** Spec #1 难度等级 */
export type Difficulty = 'L1' | 'L2' | 'L3'

/** Spec #1 模块编号（PRACTICE 已并入 M1-M5，见 constants/modules.ts） */
export type ModuleCode = 'M1' | 'M2' | 'M3' | 'M4' | 'M5'

/** 题目分类 */
export type QuestionCategory = 'basic' | 'security'

/** 题目状态 */
export type QuestionStatus = 'draft' | 'published' | 'archived'

/** 提交状态 */
export type SubmissionStatus = 'pending' | 'judging' | 'passed' | 'failed' | 'error'

/** 比赛状态 */
export type MatchStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 提交记录 */
export interface Submission {
  id: string
  questionId: string
  userId: string
  code: string
  filePath: string | null
  status: SubmissionStatus
  score: number | null
  result: string | null
  createdAt: string
  updatedAt: string
}

/** 评测结果详情 */
export interface SubmissionResult {
  accuracy?: number
  message: string
  passed?: boolean
  details?: Record<string, unknown>
}
