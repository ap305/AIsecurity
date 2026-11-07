import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ApiError, apiGet } from '../../lib/api'
import { statusLabel } from '../../lib/prdApi'

interface EvaluationOutcome {
  evaluationStatus?: string
  failedPhase?: string
  qualified?: boolean
  counted?: boolean
  successCount?: number
  opponentCount?: number
}

export interface EvaluationRunRow {
  id: string
  userId: string
  username: string | null
  displayName: string | null
  isTestAccount: boolean | null
  questionVersion: number
  evaluationVersion: string
  status: string
  score: number | null
  createdAt: string
  updatedAt: string
  task: {
    state: string
    attempts: number
    cleanupStatus: string | null
    updatedAt: string
  } | null
  arenaRuns: {
    id: string
    kind: string
    status: string
    attempts: number
    snapshotRevision: number | null
    createdAt: string
    updatedAt: string
    result: (EvaluationOutcome & { score?: number }) | null
  }[]
  arenaRunCount: number
  result: (EvaluationOutcome & { publicMessage?: string }) | null
}

interface EvaluationRunPage {
  question: { id: string; title: string; revision: number }
  page: number
  pageSize: number
  total: number
  rows: EvaluationRunRow[]
}

type HistoryRequest = { page: number }

const PAGE_SIZE = 20
const REQUEST_TIMEOUT_MS = 20000
const evaluationStatusLabels: Record<string, string> = {
  student_error: '提交内容异常',
  system_error: '评测系统异常',
  timeout: '评测超时',
}
const phaseLabels: Record<string, string> = {
  basic: '基础题评测',
  baseline: '基线评测',
  opponent: '对手评测',
}
const cleanupLabels: Record<string, string> = {
  cleaned: '已清理',
  cleanup_failed: '清理失败',
  not_started: '未开始',
}
const arenaKindLabels: Record<string, string> = { candidate: '候选首次评测', recompute: '既有算法重评' }

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString('zh-CN', { hour12: false })}</time>
}

function OutcomeDetails({ result }: { result: EvaluationOutcome }) {
  const { successCount, opponentCount } = result
  const unsuccessful =
    successCount != null && opponentCount != null && opponentCount >= successCount
      ? opponentCount - successCount
      : null
  return (
    <div className="prd-muted">
      {result.evaluationStatus && result.evaluationStatus !== 'completed' && (
        <div>{evaluationStatusLabels[result.evaluationStatus] ?? statusLabel(result.evaluationStatus)}</div>
      )}
      {result.failedPhase && <div>失败阶段 · {phaseLabels[result.failedPhase] ?? result.failedPhase}</div>}
      {result.qualified != null && <div>{result.qualified ? '通过基线' : '未过基线'}</div>}
      {result.counted != null && <div>{result.counted ? '本次计分' : '本次不计分'}</div>}
      {(successCount != null || opponentCount != null) && (
        <div>
          成功 {successCount ?? '—'} 次 · 对手 {opponentCount ?? '—'} 个
          {unsuccessful != null && ` · 未成功 ${unsuccessful} 次`}
        </div>
      )}
    </div>
  )
}

export function EvaluationRunsTable({ rows }: { rows: EvaluationRunRow[] }) {
  return (
    <div className="prd-panel prd-table-wrap">
      <table className="prd-table" aria-label="题目评测记录">
        <thead>
          <tr>
            <th scope="col">提交人</th>
            <th scope="col">提交 / 版本</th>
            <th scope="col">评测状态</th>
            <th scope="col">分数</th>
            <th scope="col">通用评测任务</th>
            <th scope="col">攻防运行</th>
            <th scope="col">时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong title={row.userId}>{row.displayName || row.username || row.userId}</strong>
                {row.username && row.displayName && row.username !== row.displayName && (
                  <div className="prd-muted">{row.username}</div>
                )}
                {row.isTestAccount && (
                  <div>
                    <span className="prd-badge">测试账号</span>
                  </div>
                )}
              </td>
              <td style={{ overflowWrap: 'anywhere', maxWidth: '24ch' }}>
                <code>{row.id}</code>
                <div className="prd-muted">题目版本 v{row.questionVersion}</div>
                <div className="prd-muted">评测版本 {row.evaluationVersion}</div>
              </td>
              <td>
                <span className="prd-badge">{statusLabel(row.status)}</span>
                {row.result && <OutcomeDetails result={row.result} />}
                {row.result?.publicMessage && <div className="prd-muted">{row.result.publicMessage}</div>}
              </td>
              <td>{row.score ?? '未出分'}</td>
              <td>
                {row.task ? (
                  <>
                    <div>
                      {statusLabel(row.task.state)} · 尝试 {row.task.attempts} 次
                    </div>
                    <div className="prd-muted">
                      清理 ·{' '}
                      {row.task.cleanupStatus
                        ? (cleanupLabels[row.task.cleanupStatus] ?? row.task.cleanupStatus)
                        : '—'}
                    </div>
                    <div className="prd-muted">
                      更新 <Timestamp value={row.task.updatedAt} />
                    </div>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {row.arenaRuns.length ? (
                  <details>
                    <summary>
                      {row.arenaRunCount} 次（最近 {row.arenaRuns.length} 次）
                    </summary>
                    <ul style={{ listStyle: 'none' }}>
                      {row.arenaRuns.map((run) => (
                        <li key={run.id} style={{ marginTop: 8 }}>
                          <div>
                            {arenaKindLabels[run.kind] ?? run.kind} · {statusLabel(run.status)}
                          </div>
                          <div className="prd-muted">
                            尝试 {run.attempts} 次 · 快照版本 {run.snapshotRevision ?? '—'}
                          </div>
                          <div className="prd-muted">本次得分 {run.result?.score ?? '未出分'}</div>
                          {run.result && <OutcomeDetails result={run.result} />}
                          <div className="prd-muted">
                            创建 <Timestamp value={run.createdAt} />
                          </div>
                          <div className="prd-muted">
                            更新 <Timestamp value={run.updatedAt} />
                          </div>
                          <code className="prd-muted" style={{ overflowWrap: 'anywhere' }}>
                            {run.id}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  `${row.arenaRunCount} 次`
                )}
              </td>
              <td>
                <div>
                  提交 <Timestamp value={row.createdAt} />
                </div>
                <div className="prd-muted">
                  更新 <Timestamp value={row.updatedAt} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QuestionHistory({ id }: { id: string }) {
  const { search } = useLocation()
  const [request, setRequest] = useState<HistoryRequest>({ page: 1 })
  const [response, setResponse] = useState<{
    request: HistoryRequest
    data?: EvaluationRunPage
    error?: string
  }>()
  const { page } = request
  const loading = response?.request !== request
  const data = loading ? undefined : response?.data
  const error = loading ? undefined : response?.error
  const lastPage = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? PAGE_SIZE)))

  useEffect(() => {
    let active = true
    apiGet<EvaluationRunPage>(
      `/admin/questions/${encodeURIComponent(id)}/evaluation-runs?page=${page}&pageSize=${PAGE_SIZE}`,
      REQUEST_TIMEOUT_MS,
    )
      .then((result) => {
        if (!active) return
        const last = Math.max(1, Math.ceil(result.total / result.pageSize))
        if (page > last) setRequest({ page: last })
        else setResponse({ request, data: result })
      })
      .catch((reason) => {
        if (active)
          setResponse({
            request,
            error:
              reason instanceof ApiError && reason.status === 404
                ? '该题目不存在。'
                : '评测记录加载失败，请重试。',
          })
      })
    return () => {
      active = false
    }
  }, [id, page, request])

  return (
    <div className="prd-page">
      <h1>题目评测记录</h1>
      <p className="prd-muted">查看该题各次提交的评测状态、分数及任务进度。</p>
      <div className="prd-toolbar">
        <Link className="prd-button" to={{ pathname: '/admin/questions', search }}>
          返回题目列表
        </Link>
        <button className="prd-button" disabled={loading} onClick={() => setRequest({ page })}>
          {error ? '重试加载' : '刷新记录'}
        </button>
      </div>
      {loading && (
        <div className="prd-loading" role="status">
          正在加载评测记录…
        </div>
      )}
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      {data && (
        <section aria-labelledby="evaluation-question">
          <h2 id="evaluation-question">{data.question.title}</h2>
          <p className="prd-muted">
            {data.question.id} · 当前题目版本 v{data.question.revision}
          </p>
          {data.rows.length ? (
            <>
              <div className="prd-toolbar" role="group" aria-label="评测记录分页">
                <button
                  className="prd-button"
                  disabled={page <= 1}
                  onClick={() => setRequest({ page: page - 1 })}
                >
                  上一页
                </button>
                <span>
                  第 {data.page} / {lastPage} 页 · 共 {data.total} 条提交
                </span>
                <button
                  className="prd-button"
                  disabled={page >= lastPage}
                  onClick={() => setRequest({ page: page + 1 })}
                >
                  下一页
                </button>
              </div>
              <EvaluationRunsTable rows={data.rows} />
            </>
          ) : (
            <p className="prd-panel" role="status">
              该题暂无评测记录。
            </p>
          )}
        </section>
      )}
    </div>
  )
}

export default function QuestionEvaluationRuns() {
  const { id = '' } = useParams()
  return <QuestionHistory key={id} id={id} />
}
