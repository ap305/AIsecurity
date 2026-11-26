import type { HallCategory, QuestionRecord } from './prdApi'
import { ARENA_TEACHING_SCENARIOS, resolveArenaScenario } from './arenaTeaching'
import { displayQuestionTitle, teachingDifficulty } from './questionPresentation'

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

export const hallSceneLabels = {
  'deep-learning': '深度学习',
  llm: '大模型',
  agent: '智能体',
} as const
type HallScene = keyof typeof hallSceneLabels
export function isHallScene(value: unknown): value is HallScene {
  return typeof value === 'string' && Object.hasOwn(hallSceneLabels, value)
}

// The course uses the same scenario ID for the two roles. Both the LLM and
// the agent exercises use definition.kind="agent", so kind cannot separate them.
const courseSceneNumbers: Record<HallScene, readonly string[]> = {
  'deep-learning': ['01', '04', '05', '06', '07', '10', '11', '12', '23', '24', '25', '26', '30', '31'],
  llm: ['02', '03', '08', '09', '13', '27', '28'],
  agent: ['14', '15', '16', '17', '18', '19', '20', '21', '22'],
}
const deepLearningModules = new Set(['AI_SECURITY_V3', 'AI_MEDIA_V3', 'AI_PRIVACY_V3', 'AI_RECO_V3'])

function sceneFromId(id: string | null | undefined): HallScene | undefined {
  if (!id) return undefined
  const number = /^V3-261012-(?:ML|A|D)?(\d{2})$/.exec(id)?.[1]
  if (number) {
    return (Object.keys(courseSceneNumbers) as HallScene[]).find((scene) => courseSceneNumbers[scene].includes(number))
  }
  const legacy = ARENA_TEACHING_SCENARIOS.find((scenario) => scenario.id === id)
  if (legacy) return legacy.group === 'Agent 攻防' ? 'agent' : 'deep-learning'
}
export function hallScene(question: QuestionRecord, scenario = hallScenario(question)): HallScene | undefined {
  if (question.category !== 'adversarial' && question.category !== 'security') return undefined
  if (isHallScene(question.moduleCode)) return question.moduleCode
  const scene = sceneFromId(scenario?.id ?? question.id)
  if (scene) return scene
  if (deepLearningModules.has(question.moduleCode ?? '')) return 'deep-learning'
}

export function hallFilterParams(params: URLSearchParams, category: HallCategory) {
  const next = new URLSearchParams(params)
  if (category === 'basic') {
    next.delete('scene')
    next.delete('role')
    next.delete('group')
  } else {
    // These options belong to the retired taxonomy. Old bookmarks still keep
    // their supported scene, search, status, role, difficulty and page.
    next.delete('kind')
    next.delete('group')
    next.delete('module')
    if (!['attack', 'defense'].includes(next.get('role') || '')) next.delete('role')
    if (!next.has('scene')) {
      const scene = sceneFromId(next.get('scenario'))
      if (scene) next.set('scene', scene)
    }
    if (!isHallScene(next.get('scene'))) next.delete('scene')
  }
  next.delete('scenario')
  if (/^M[1-5]$/i.test(next.get('module') || '')) next.delete('module')
  return next
}

export function hallLibraryQuestions(questions: QuestionRecord[], category: HallCategory) {
  return questions.filter((q) => q.category === category)
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
  if (isHallScene(code)) return hallSceneLabels[code]
  return code ? moduleLabels[code] || code : '基础练习'
}
export function hallScenario(question: QuestionRecord) {
  const legacy = resolveArenaScenario(question)
  if (legacy) return { id: legacy.id, title: legacy.title }
  const id = question.scenarioId ?? question.definition.scenarioId
  if (!id || !['adversarial', 'security'].includes(question.category)) return undefined
  return {
    id,
    title: question.title.replace(/\s*(?:[（(](?:攻击|防御)[）)]|·\s*(?:攻击|防御))$/, ''),
  }
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
    const basic = q.category === 'basic'
    const scenario = hallScenario(q)
    const scene = hallScene(q, scenario)
    return (
      (!search ||
        [
          q.id,
          q.number,
          displayQuestionTitle(q),
          ...(basic ? [q.moduleCode, questionModuleLabel(q.moduleCode), ...(q.tags || [])] : []),
          scenario?.title,
          scene && hallSceneLabels[scene],
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)) &&
      (!params.get('difficulty') || teachingDifficulty(q) === params.get('difficulty')) &&
      (!basic || !params.get('kind') || q.definition.kind === params.get('kind')) &&
      (!params.get('role') || (q.role || q.definition.role) === params.get('role')) &&
      (!basic || !params.get('module') ||
        /^M[1-5]$/i.test(params.get('module')!) ||
        q.moduleCode === params.get('module')) &&
      (!params.get('state') || questionAttemptState(q) === params.get('state')) &&
      (!params.get('scene') || scene === params.get('scene'))
    )
  })
  const order = params.get('sort') || 'number'
  return selected.sort((a, b) => {
    if (order === 'score') {
      if (a.myScore == null && b.myScore != null) return 1
      if (a.myScore != null && b.myScore == null) return -1
      if (a.myScore !== b.myScore) return (b.myScore || 0) - (a.myScore || 0)
    }
    if (order === 'difficulty') {
      const byDifficulty = teachingDifficulty(a).localeCompare(teachingDifficulty(b))
      if (byDifficulty) return byDifficulty
    }
    return (
      (a.number || 0) - (b.number || 0) ||
      (a.moduleCode || '').localeCompare(b.moduleCode || '') ||
      a.id.localeCompare(b.id)
    )
  })
}
export function hallPage(raw: string | null, total: number, size: number) {
  const value = Number(raw)
  const pages = Math.max(1, Math.ceil(total / size))
  return { page: Number.isSafeInteger(value) && value > 0 ? Math.min(value, pages) : 1, pages }
}
