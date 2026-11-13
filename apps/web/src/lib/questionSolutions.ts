import { apiDelete, apiGet, apiPost } from './api'

export interface QuestionSolution {
  id: string
  title: string
  explanation: string
  code: string
  kind: 'standard' | 'user'
  author: string
  questionVersion: number
  source: 'manual' | 'submission' | 'evaluation'
  referenceKind: 'same_role' | 'opponent' | 'qualification' | null
  actualEvaluationReference: boolean
  score: number | null
  updating: boolean
  emptyPool: boolean
  notice: string
  needsModelAttachment: boolean
  canWithdraw: boolean
  createdAt: string
  sourceCreatedAt: string | null
}
export async function readSolutionFile(file: { size: number; text(): Promise<string> }) {
  if (file.size > 256 * 1024) throw new Error('文本文件不能超过 256 KiB')
  const code = await file.text()
  if (new TextEncoder().encode(code).byteLength > 256 * 1024) throw new Error('文本文件不能超过 256 KiB')
  if (code.includes('\0') || code.includes('\uFFFD'))
    throw new Error('请选择 UTF-8 文本源代码文件，不支持二进制或权重文件')
  return code
}

export interface SolutionPage {
  question: { id: string; title: string; revision: number; category: string; role: string | null }
  canPublishStandard: boolean
  standard: QuestionSolution[]
  standardNotice?: string
  user: QuestionSolution[]
  top: QuestionSolution[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}
export interface SolutionCandidate {
  id: string
  score: number | null
  createdAt: string
}
export const questionSolutionsApi = {
  list: (id: string, page = 1) =>
    apiGet<SolutionPage>(`/questions/${encodeURIComponent(id)}/solutions?page=${page}`, 15000),
  candidates: (id: string) =>
    apiGet<SolutionCandidate[]>(`/questions/${encodeURIComponent(id)}/solution-candidates`, 15000),
  publish: (
    id: string,
    data: {
      kind: 'user' | 'standard'
      title: string
      explanation: string
      code?: string
      sourceSubmissionId?: string
      referenceKind?: string
    },
  ) => apiPost<{ id: string }>(`/questions/${encodeURIComponent(id)}/solutions`, data, 15000),
  withdraw: (id: string) => apiDelete(`/solutions/${encodeURIComponent(id)}`, 15000),
}
