export const difficultyLabels: Record<string, string> = { L1: '入门', L2: '进阶', L3: '挑战' }
export const difficultyGuide = '入门：单一任务或规则；进阶：组合策略并权衡多个指标；挑战：跨阶段建模、优化或验证。'

// The published 261012 catalog uses L3 as an import default. Scope editorial
// levels to those exact revisions so that later authored values take precedence.
const courseLevels: Record<string, 'L1' | 'L2' | 'L3'> = {
  '01': 'L1', '02': 'L2', '03': 'L3', '04': 'L3', '05': 'L3',
  '06': 'L2', '07': 'L2', '08': 'L1', '09': 'L1', '10': 'L2',
  '11': 'L3', '12': 'L3', '13': 'L2', '14': 'L1', '15': 'L1',
  '16': 'L2', '17': 'L2', '18': 'L1', '19': 'L2', '20': 'L2',
  '21': 'L1', '22': 'L3', '23': 'L2', '24': 'L3', '25': 'L3',
  '26': 'L2', '27': 'L1', '28': 'L3', '30': 'L2', '31': 'L3',
}
const revisionThree = new Set(['A02', 'A08', 'D09', 'A28'])

type DifficultySource = { id: string; revision: number; category: string; difficulty: string }

export function importedTeachingLevel(q: DifficultySource) {
  if (q.difficulty !== 'L3' || (q.category !== 'adversarial' && q.category !== 'security')) return undefined
  const match = /^V3-261012-([AD](\d{2}))$/.exec(q.id)
  if (!match || q.revision !== (revisionThree.has(match[1]) ? 3 : 2)) return undefined
  return courseLevels[match[2]]
}

export function teachingDifficulty(q: DifficultySource) {
  return importedTeachingLevel(q) ?? q.difficulty
}

interface DisplayQuestion {
  id?: string | null
  questionId?: string | null
  title: string
  category?: string
  role?: string | null
  definition?: { role?: string }
}

export function displayQuestionTitle(q: DisplayQuestion): string {
  if (q.category === 'basic') return q.title
  const suffix = /\s*(?:[（(]\s*(攻击|防御)\s*[）)]|[·•]\s*(攻击|防御))\s*$/
  const existing = suffix.exec(q.title)
  const courseRole = /^V3-261012-([AD])\d{2}$/.exec(q.id ?? q.questionId ?? '')?.[1]
  const role = q.role ?? q.definition?.role
  const label = role === 'attack' ? '攻击' : role === 'defense' ? '防御'
    : courseRole === 'A' ? '攻击' : courseRole === 'D' ? '防御' : existing?.[1] ?? existing?.[2]
  return label ? `${q.title.replace(suffix, '').trimEnd()}（${label}）` : q.title
}
