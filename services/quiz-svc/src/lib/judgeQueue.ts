/**
 * 判题并发闸门（队列化）
 *
 * 背景：受管判题会为每场对阵调用真实大模型，单次提交可能跑十几分钟。
 * 若不限并发，多人同时提交会互相抢占模型带宽，所有人的判题都变慢，
 * 严重时还会一起踩到超时上限。
 *
 * 策略：
 *   - 最多 capacity 个判题任务同时运行（默认 3）；
 *   - 超出的进入 FIFO 队列等待（默认最多排 20 个）；
 *   - 队列满了直接拒绝，返回“当前排队任务过多”；
 *   - 排队超过 maxWaitMs（默认 30 分钟）自动放弃，避免请求无限挂起。
 *
 * 配置（环境变量，改完重启 quiz-svc 生效）：
 *   JUDGE_MAX_CONCURRENCY     并发上限，默认 3
 *   JUDGE_QUEUE_LIMIT         排队上限，默认 20（0 = 不排队，超并发即拒绝）
 *   JUDGE_QUEUE_MAX_WAIT_MS   最长排队时间，默认 1800000（30 分钟）
 *
 * 也可以写 services/quiz-svc/judge-queue-config.json（与 llm-config.json 同目录约定），
 * 运行时每 5 秒热加载一次，改完无需重启容器：
 *   { "maxConcurrency": 3, "queueLimit": 20, "maxWaitMs": 1800000 }
 * 文件优先于环境变量。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../judge-queue-config.json')
const CONFIG_TTL_MS = 5000

interface RawQueueConfig {
  maxConcurrency?: number
  queueLimit?: number
  maxWaitMs?: number
}

interface ResolvedLimits {
  capacity: number
  queueLimit: number
  maxWaitMs: number
}

export interface JudgeQueueStats {
  running: number
  queued: number
  capacity: number
  queueLimit: number
  /** 队首已等待毫秒数（无排队为 0） */
  oldestWaitMs: number
}

export class JudgeQueueFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgeQueueFullError'
  }
}

export class JudgeQueueTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgeQueueTimeoutError'
  }
}

interface WaitingItem {
  label: string
  enqueuedAt: number
  timer: NodeJS.Timeout | null
  resolve: () => void
  reject: (e: Error) => void
}

function intEnv(name: string, dft: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return dft
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dft
}

function pick(value: unknown, envName: string, dft: number): number {
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  return intEnv(envName, dft)
}

let limitsCache: { at: number; value: ResolvedLimits } | null = null

/** 读取生效的并发参数：judge-queue-config.json 优先，其次环境变量，最后默认值 */
function resolveLimits(): ResolvedLimits {
  const now = Date.now()
  if (limitsCache && now - limitsCache.at < CONFIG_TTL_MS) return limitsCache.value
  let raw: RawQueueConfig = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as RawQueueConfig
  } catch { /* 文件不存在或格式错误：回退环境变量 */ }
  const value: ResolvedLimits = {
    capacity: Math.max(1, pick(raw.maxConcurrency, 'JUDGE_MAX_CONCURRENCY', 3)),
    queueLimit: Math.max(0, pick(raw.queueLimit, 'JUDGE_QUEUE_LIMIT', 20)),
    maxWaitMs: Math.max(1000, pick(raw.maxWaitMs, 'JUDGE_QUEUE_MAX_WAIT_MS', 30 * 60 * 1000)),
  }
  limitsCache = { at: now, value }
  return value
}

export class JudgeQueue {
  private running = 0
  private waiting: WaitingItem[] = []

  /** 固定的“测试用”参数；为 null 时读配置/环境变量 */
  private readonly override: ResolvedLimits | null

  constructor(capacity?: number, queueLimit?: number, maxWaitMs?: number) {
    this.override = (capacity === undefined && queueLimit === undefined && maxWaitMs === undefined)
      ? null
      : {
          capacity: Math.max(1, capacity ?? 3),
          queueLimit: Math.max(0, queueLimit ?? 20),
          maxWaitMs: Math.max(1000, maxWaitMs ?? 30 * 60 * 1000),
        }
  }

  private limits(): ResolvedLimits {
    return this.override ?? resolveLimits()
  }

  get capacity(): number { return this.limits().capacity }
  get queueLimit(): number { return this.limits().queueLimit }
  get maxWaitMs(): number { return this.limits().maxWaitMs }

  stats(): JudgeQueueStats {
    const { capacity, queueLimit } = this.limits()
    const oldest = this.waiting.length ? Date.now() - this.waiting[0].enqueuedAt : 0
    return {
      running: this.running,
      queued: this.waiting.length,
      capacity,
      queueLimit,
      oldestWaitMs: oldest,
    }
  }

  /** 占用一个判题名额（必要时排队），执行 fn 后自动释放 */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(label)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(label: string): Promise<void> {
    const { capacity, queueLimit, maxWaitMs } = this.limits()
    if (this.running < capacity && this.waiting.length === 0) {
      this.running += 1
      return Promise.resolve()
    }
    if (queueLimit <= 0 || this.waiting.length >= queueLimit) {
      return Promise.reject(new JudgeQueueFullError(
        `当前判题任务较多（运行 ${this.running}/${capacity}，排队 ${this.waiting.length}/${queueLimit}），请稍后重新提交`))
    }
    return new Promise<void>((resolve, reject) => {
      const item: WaitingItem = {
        label,
        enqueuedAt: Date.now(),
        timer: null,
        resolve: () => resolve(),
        reject,
      }
      item.timer = setTimeout(() => {
        const idx = this.waiting.indexOf(item)
        if (idx >= 0) this.waiting.splice(idx, 1)
        reject(new JudgeQueueTimeoutError(
          `排队等待超过 ${Math.round(maxWaitMs / 60000)} 分钟，已自动取消，请稍后重试`))
      }, maxWaitMs)
      this.waiting.push(item)
    })
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1)
    const next = this.waiting.shift()
    if (!next) return
    if (next.timer) clearTimeout(next.timer)
    this.running += 1
    next.resolve()
  }
}

export const judgeQueue = new JudgeQueue()
