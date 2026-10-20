import type { HallCategory, QuestionRecord } from './prdApi'
import { resolveArenaScenario } from './arenaTeaching'

const moduleLabels: Record<string, string> = {
  M1: '对抗攻击与规避',
  M2: '数据投毒与后门',
  M3: '模型隐私与保护',
  M4: '大模型与 Agent 安全',
  M5: '公平性与审计',
  AI_BASIC_V3: '人工智能基础实验',
  AI_API_V3: '大模型与 Agent 攻防',
  AI_MEDIA_V3: '图像与音频安全',
  AI_SECURITY_V3: '模型安全',
  AI_PRIVACY_V3: '隐私保护',
  AI_RECO_V3: '推荐系统安全',
}
export const libraryTypes: Record<string, string> = { basic: '基础题', attack: '攻击题', defense: '防御题' }

export function hallFilterParams(params: URLSearchParams, category: HallCategory) {
  const next = new URLSearchParams(params)
  if (category === 'basic') {
    for (const key of ['role', 'scenario', 'group']) next.delete(key)
  } else if (!['attack', 'defense'].includes(next.get('role') || '')) next.delete('role')
  if (/^M[1-5]$/i.test(next.get('module') || '')) next.delete('module')
  return next
}

export function resetHallFilters(params: URLSearchParams, category: HallCategory) {
  const next = new URLSearchParams()
  const role = hallFilterParams(params, category).get('role')
  if (role) next.set('role', role)
  return next
}

export function hallLibraryQuestions(
  questions: QuestionRecord[],
  category: HallCategory,
  params: URLSearchParams,
) {
  const role = hallFilterParams(params, category).get('role')
  return questions.filter((q) => q.category === category && (!role || (q.role || q.definition.role) === role))
}
export function isCurrentLibraryQuestion(question: {
  id: string
  moduleCode?: string
  status?: string
}): boolean {
  return !/^M[1-5]$/i.test(question.moduleCode || '')
}
export function questionLibraryType(
  question: Pick<QuestionRecord, 'category' | 'role' | 'definition'>,
): string {
  if (question.category === 'basic') return 'basic'
  return question.role || question.definition.role || 'adversarial'
}
export function questionLibraryLabel(
  question: Pick<QuestionRecord, 'category' | 'role' | 'definition'>,
): string {
  return libraryTypes[questionLibraryType(question)] || '攻防题'
}
export function questionModuleLabel(code?: string | null): string {
  return code ? moduleLabels[code] || code : '基础练习'
}
export function hallScenario(question: QuestionRecord) {
  const legacy = resolveArenaScenario(question)
  if (legacy) return { id: legacy.id, title: legacy.title, group: legacy.group }
  const id = question.scenarioId ?? question.definition.scenarioId
  if (!id || !['adversarial', 'security'].includes(question.category)) return undefined
  return {
    id,
    title: question.title.replace(/\s*(?:[（(](?:攻击|防御)[）)]|·\s*(?:攻击|防御))$/, ''),
    group: question.moduleCode ? questionModuleLabel(question.moduleCode) : '其他攻防',
  }
}
export function hallScenarios(questions: QuestionRecord[]) {
  const scenarios = new Map<string, NonNullable<ReturnType<typeof hallScenario>>>()
  for (const question of questions) {
    const scenario = hallScenario(question)
    if (scenario && !scenarios.has(scenario.id)) scenarios.set(scenario.id, scenario)
  }
  return [...scenarios.values()]
}

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
    const scenario = hallScenario(q)
    return (
      (!search ||
        [
          q.id,
          q.number,
          q.title,
          q.moduleCode,
          questionModuleLabel(q.moduleCode),
          scenario?.title,
          ...(q.tags || []),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)) &&
      (!params.get('difficulty') || q.difficulty === params.get('difficulty')) &&
      (!params.get('kind') || q.definition.kind === params.get('kind')) &&
      (!params.get('role') || (q.role || q.definition.role) === params.get('role')) &&
      (!params.get('module') ||
        /^M[1-5]$/i.test(params.get('module')!) ||
        q.moduleCode === params.get('module')) &&
      (!params.get('state') || questionAttemptState(q) === params.get('state')) &&
      (!params.get('scenario') || scenario?.id === params.get('scenario')) &&
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
