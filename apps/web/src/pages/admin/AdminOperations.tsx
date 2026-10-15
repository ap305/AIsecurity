import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import { statusLabel } from '../../lib/prdApi'
interface Task {
  id: string
  submissionId: string
  state: string
  attempts: number
  error?: string | null
  cleanupStatus?: string
  updatedAt: string
}
interface ArenaTask {
  id: string
  submissionId: string
  scenarioId: string
  role: string
  kind: 'candidate' | 'recompute'
  status: string
  attempts: number
  error?: string | null
  snapshotRevision?: number
  updatedAt: string
}
export default function AdminOperations() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [arena, setArena] = useState<ArenaTask[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const results = await Promise.allSettled([
      apiGet<Task[]>('/admin/evaluation-tasks'),
      apiGet<ArenaTask[]>('/admin/arena-evaluations'),
    ])
    if (results[0].status === 'fulfilled') setTasks(results[0].value)
    if (results[1].status === 'fulfilled') setArena(results[1].value)
    if (results.some((result) => result.status === 'rejected'))
      setError('部分评测队列暂不可查询，请刷新重试。')
    else setError('')
  }
  useEffect(() => {
    void load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])
  const retry = async (id: string, adversarial: boolean) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await apiPost(
        `/admin/${adversarial ? 'arena-evaluations' : 'evaluation-tasks'}/${encodeURIComponent(id)}/retry`,
        {},
      )
      setMessage('已重新排队，原材料与评测配置保持冻结。')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="prd-page">
      <div className="prd-split">
        <div>
          <h1>评测运行管理</h1>
          <p className="prd-muted">
            查询通用提交、攻防候选与动态重评积压；仅异常任务可重试，旧算法失效时拒绝重试。
          </p>
        </div>
        <button className="prd-button" onClick={() => void load()}>
          刷新状态
        </button>
      </div>
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="prd-notice" role="status">
          {message}
        </div>
      )}
      <section className="prd-panel prd-table-wrap">
        <h2>通用评测队列</h2>
        <table className="prd-table">
          <thead>
            <tr>
              <th>任务 / 提交</th>
              <th>状态</th>
              <th>尝试数</th>
              <th>清理</th>
              <th>公开错误说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  {task.id.slice(0, 12)}
                  <br />
                  {task.submissionId.slice(0, 12)}
                </td>
                <td>{statusLabel(task.state)}</td>
                <td>{task.attempts}</td>
                <td>{task.cleanupStatus ?? '—'}</td>
                <td>{task.error || '—'}</td>
                <td>
                  <button
                    className="prd-button"
                    disabled={busy || task.state !== 'error'}
                    onClick={() => void retry(task.id, false)}
                  >
                    重试
                  </button>
                </td>
              </tr>
            ))}
            {!tasks.length && (
              <tr>
                <td colSpan={6}>暂无通用评测任务。</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <section className="prd-panel prd-table-wrap">
        <h2>攻防候选与动态重评</h2>
        <table className="prd-table">
          <thead>
            <tr>
              <th>场景 / 角色</th>
              <th>类型</th>
              <th>状态</th>
              <th>尝试数 / 快照版本</th>
              <th>公开错误说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {arena.map((task) => (
              <tr key={task.id}>
                <td>
                  {task.scenarioId} · {task.role === 'attack' ? '攻击' : '防御'}
                </td>
                <td>{task.kind === 'recompute' ? '既有算法重评' : '候选首次评测'}</td>
                <td>{statusLabel(task.status)}</td>
                <td>
                  {task.attempts} / {task.snapshotRevision ?? '—'}
                </td>
                <td>{task.error || '—'}</td>
                <td>
                  {task.kind === 'recompute' && task.status === 'error' ? (
                    <button className="prd-button" disabled={busy} onClick={() => void retry(task.id, true)}>
                      重试重评
                    </button>
                  ) : task.kind === 'candidate' && task.status === 'error' ? (
                    '请在通用队列重试'
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {!arena.length && (
              <tr>
                <td colSpan={6}>暂无候选或重评任务。</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
