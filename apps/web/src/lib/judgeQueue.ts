import { apiGet } from './api'

/** 判题队列状态（后端 /api/matches/queue） */
export interface JudgeQueueInfo {
  running: number
  queued: number
  capacity: number
  queueLimit: number
  oldestWaitMs: number
}

/**
 * 提交判题期间轮询队列状态，用于给学生显示“排队中 / 评测中”。
 * 返回停止函数（提交结束时必须调用）。
 */
export function startJudgeQueuePolling(
  onUpdate: (info: JudgeQueueInfo | null) => void,
  intervalMs = 2000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const tick = async () => {
    try {
      const info = await apiGet<JudgeQueueInfo>('/matches/queue')
      if (!stopped) onUpdate(info)
    } catch {
      if (!stopped) onUpdate(null)
    }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }
  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** 排队/评测状态文案 */
export function queueStatusText(info: JudgeQueueInfo | null): string {
  if (!info) return '评测中...'
  if (info.queued > 0) {
    return `排队中：前面还有 ${info.queued} 个任务，轮到后自动开始评测`
      + `（当前评测中 ${info.running}/${info.capacity}）`
  }
  return '评测中...'
}
