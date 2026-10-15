import type { QuestionRecord } from './prdApi'
import { matchesArenaScenario, resolveArenaScenario } from './arenaTeaching'

export const questionKinds: Record<string, string> = {
  algorithm: '算法',
  model: '模型',
  distillation: '蒸馏',
  agent: 'Agent',
}
const activeStatuses = new Set(['pending', 'queued', 'running', 'judging', 'baseline', 'opponents'])
export function questionAttemptState(question: QuestionRecord): string {
  const status = question.latestSubmissionStatus || question.myStatus
  if (status && activeStatuses.has(status)) return 'running'
  if (status && ['error', 'timeout', 'cancelled'].includes(status)) return 'error'
  if (question.myScore != null) return 'scored'
  if (question.attempted || (status && status !== 'not_submitted')) return 'attempted'
  return 'not_submitted'
}
export function filterHallQuestions(questions: QuestionRecord[], params: URLSearchParams) {
  const search = (params.get('q') || '').trim().toLocaleLowerCase()
  const selected = questions.filter((q) => {
    const scenario = resolveArenaScenario(q)
    return (
      (!search ||
        [q.id, q.number, q.title, q.moduleCode, scenario?.title, ...(q.tags || [])]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)) &&
      (!params.get('difficulty') || q.difficulty === params.get('difficulty')) &&
      (!params.get('kind') || q.definition.kind === params.get('kind')) &&
      (!params.get('role') || q.definition.role === params.get('role')) &&
      (!params.get('module') || q.moduleCode === params.get('module')) &&
      (!params.get('state') || questionAttemptState(q) === params.get('state')) &&
      (!params.get('scenario') || matchesArenaScenario(q, params.get('scenario')!)) &&
      (!params.get('group') || scenario?.group === params.get('group'))
    )
  })
  const order = params.get('sort') || 'number'
  return selected.sort((a, b) => {
    if (order === 'score') {
      if (a.myScore == null && b.myScore != null) return 1
      if (a.myScore != null && b.myScore == null) return -1
      if (a.myScore !== b.myScore) return (b.myScore || 0) - (a.myScore || 0)
    }
    if (order === 'difficulty' && a.difficulty !== b.difficulty)
      return a.difficulty.localeCompare(b.difficulty)
    return (
      (a.moduleCode || '').localeCompare(b.moduleCode || '') ||
      (a.number || 0) - (b.number || 0) ||
      a.id.localeCompare(b.id)
    )
  })
}
export function hallPage(raw: string | null, total: number, size: number) {
  const value = Number(raw)
  const pages = Math.max(1, Math.ceil(total / size))
  return { page: Number.isSafeInteger(value) && value > 0 ? Math.min(value, pages) : 1, pages }
}
