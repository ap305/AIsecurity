import { isTerminal, type QuestionRecord, type SubmissionRecord } from '../lib/prdApi'

export function draftStorageKey(userId: string | undefined, questionId: string, revision: number) {
  return `prd_draft_${userId ?? 'unknown'}_${questionId}_${revision}`
}

export function createLatestRequest() {
  let current = 0
  return {
    next: () => ++current,
    isCurrent: (token: number) => token === current,
    invalidate: () => {
      current += 1
    },
  }
}

export function editorLanguage(question: QuestionRecord): string {
  if (question.type === 'T') return 'markdown'
  const template = question.answerTemplate ?? ''
  if (/\b(public class|import java\.)/.test(template)) return 'java'
  if (/\b(fn main|use std::)/.test(template)) return 'rust'
  if (/\b(package main|func \w+\()/.test(template)) return 'go'
  if (/\b(console\.log|const |let |function )/.test(template)) return 'javascript'
  return 'python'
}

// Only evaluator-approved numeric metrics enter the summary. Nested/raw logs are not rendered here.
export function publicMetrics(submission: SubmissionRecord): [string, number][] {
  const metrics = submission.diagnostics?.metrics
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return []
  return Object.entries(metrics).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
}

export function submissionPhaseLabel(submission: SubmissionRecord | null): string {
  if (!submission) return '尚未提交'
  const labels: Record<string, string> = {
    pending: '排队中',
    queued: '排队中',
    judging: '评测中',
    running: '评测中',
    baseline: '基线评测中',
    opponents: '对手评测中',
    passed: '评测完成',
    completed: '评测完成',
    failed: '评测完成',
    baseline_failed: '未过基线',
    stale: '旧版本已失效',
    error: '评测异常',
    timeout: '评测超时',
    cancelled: '已取消',
  }
  if (isTerminal(submission.status)) return labels[submission.status] ?? '评测完成'
  return (
    labels[submission.phase ?? submission.diagnostics?.phase ?? ''] ??
    labels[submission.status] ??
    '等待状态更新'
  )
}

export function hallReturnLocation(value: unknown, adversarial: boolean): string {
  const fallback = adversarial ? '/arena' : '/'
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(value)
  )
    return fallback
  try {
    const target = new URL(value, 'https://hall.invalid')
    return target.origin === 'https://hall.invalid' && target.pathname === fallback
      ? target.pathname + target.search
      : fallback
  } catch {
    return fallback
  }
}
