import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../../lib/api'
import {
  modelUsageApi,
  parseUsagePolicyDraft,
  usagePolicyDraft,
  USAGE_POLICY_FIELDS,
  type ModelUsageDashboard,
  type UsagePolicy,
  type UsagePolicyDraft,
  type UsageTotals,
} from '../../lib/modelUsage'

const count = (value: number) => value.toLocaleString('zh-CN')
const tokens = (value: number | null) => (value === null ? '未报告' : count(value))
const timestamp = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

function UsageTable({
  title,
  label,
  rows,
}: {
  title: string
  label: string
  rows: { id: string; label: ReactNode; totals: UsageTotals }[]
}) {
  return (
    <section className="prd-panel">
      <h2>{title}</h2>
      {rows.length ? (
        <div className="prd-table-wrap">
          <table className="prd-table" aria-label={title}>
            <thead>
              <tr>
                {[
                  label,
                  '上游尝试',
                  '成功',
                  '失败',
                  '待完成',
                  '缓存命中',
                  '已报 usage',
                  '缺 usage（含待完成）',
                  '已报输入 token',
                  '已报输出 token',
                  '已报总 token',
                  '教师请求 / 健康检查',
                ].map((heading) => (
                  <th scope="col" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ id, label: rowLabel, totals: t }) => (
                <tr key={id}>
                  <th scope="row" style={{ minWidth: 120, overflowWrap: 'anywhere' }}>
                    {rowLabel}
                  </th>
                  <td>{count(t.upstreamAttempts)}</td>
                  <td>{count(t.successes)}</td>
                  <td>{count(t.failures)}</td>
                  <td>{count(t.pending)}</td>
                  <td>{count(t.snapshotHits)}</td>
                  <td>{count(t.knownUsageRequests)}</td>
                  <td>{count(t.unknownUsageRequests)}</td>
                  <td>{tokens(t.inputTokens)}</td>
                  <td>{tokens(t.outputTokens)}</td>
                  <td>{tokens(t.totalTokens)}</td>
                  <td>
                    {count(t.teacherRequests)} / {count(t.healthChecks)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="prd-muted">该时间范围尚无记录。</p>
      )}
    </section>
  )
}

export function UsageOverview({ data }: { data: ModelUsageDashboard }) {
  return (
    <>
      <section className="prd-panel" aria-label="统计口径与覆盖范围">
        <h2>统计口径与覆盖范围</h2>
        <p>
          按北京时间自然日统计；近 {data.days}{' '}
          天包含今天。上游尝试包含成功、失败及待完成请求；缓存命中不重复计入上游次数和 token。
        </p>
        <p>
          token 仅汇总上游已报告的数值；“缺 usage”表示未报告总
          token，包含待完成请求，不代表零费用。输入、输出和总 token 各自汇总，可能不完整。
        </p>
        <p className="prd-muted">
          记录起点：{data.coverage.startedAt ? timestamp(data.coverage.startedAt) : '尚无记录'}
          。历史用量未知，累计仅含已采集记录；货币费用未知，未换算金额。统计包含测试账号；教师请求与健康检查单列，不计入大模型次数阈值。
        </p>
      </section>
      <UsageTable
        title="用量汇总"
        label="时间范围"
        rows={[
          { id: 'today', label: '今日', totals: data.today },
          { id: 'range', label: `近 ${data.days} 天`, totals: data.range },
          { id: 'all', label: '累计', totals: data.allTime },
        ]}
      />
      <p className="prd-muted">
        以下明细均为近 {data.days} 天；时间范围 {timestamp(data.from)} 至 {timestamp(data.to)}
        （结束时间不含）。
      </p>
      <UsageTable
        title="按日"
        label="日期（北京时间）"
        rows={data.daily.map((row) => ({ id: row.day, label: row.day, totals: row }))}
      />
      <UsageTable
        title="按模型"
        label="模型"
        rows={data.byModel.map((row, index) => ({
          id: String(index),
          label: row.model || '未关联模型',
          totals: row,
        }))}
      />
      <UsageTable
        title="按题目"
        label="题目"
        rows={data.byQuestion.map((row, index) => ({
          id: String(index),
          label: (
            <>
              {row.title || row.questionId || '未关联题目'}
              {row.title && row.questionId && <div className="prd-muted">{row.questionId}</div>}
            </>
          ),
          totals: row,
        }))}
      />
      <UsageTable
        title="按账号"
        label="账号"
        rows={data.byUser.map((row, index) => ({
          id: String(index),
          label: (
            <>
              {row.displayName || row.username || row.actorId || '系统 / 未关联账号'}
              {row.username && row.displayName && <div className="prd-muted">{row.username}</div>}
              {row.isTestAccount && (
                <div>
                  <span className="prd-badge">测试账号</span>
                </div>
              )}
            </>
          ),
          totals: row,
        }))}
      />
    </>
  )
}

type ReadRequest = { days: number }
type PolicyForm = { revision: number; values: UsagePolicyDraft }
const scopeLabels = { global: '平台', user: '账号', pool: '模型配置', source: '调用来源' }
const periodLabels = { daily: '当日', total: '累计', rolling: '近期' }

export default function ModelUsage() {
  const [request, setRequest] = useState<ReadRequest>({ days: 7 })
  const [response, setResponse] = useState<{
    request: ReadRequest
    data?: ModelUsageDashboard
    error?: string
  }>()
  const [serverPolicy, setServerPolicy] = useState<UsagePolicy | null>(null)
  const [form, setForm] = useState<PolicyForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [acknowledging, setAcknowledging] = useState<string | null>(null)
  const [policyError, setPolicyError] = useState('')
  const [alertError, setAlertError] = useState('')
  const [message, setMessage] = useState('')
  const [conflicted, setConflicted] = useState(false)
  const alive = useRef(false)
  const operation = useRef('load')
  const loading = response?.request !== request
  const blocked = loading || saving || acknowledging !== null
  const data = response?.request === request ? response.data : undefined
  const readError = response?.request === request ? response.error : undefined
  const newerPolicy = !!form && !!serverPolicy && form.revision !== serverPolicy.revision

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    operation.current = 'load'
    modelUsageApi
      .get(request.days)
      .then((result) => {
        if (!active) return
        setResponse({ request, data: result })
        setServerPolicy(result.policy)
        setForm(
          (current) =>
            current ?? { revision: result.policy.revision, values: usagePolicyDraft(result.policy) },
        )
      })
      .catch(() => {
        if (active) setResponse({ request, error: '模型用量加载失败，请重试。' })
      })
      .finally(() => {
        if (active) operation.current = ''
      })
    return () => {
      active = false
    }
  }, [request])

  const refresh = (days = request.days) => {
    if (!alive.current || operation.current) return
    operation.current = 'load'
    setRequest({ days })
  }

  const save = async () => {
    if (!alive.current || operation.current || !form || !serverPolicy || (conflicted && !newerPolicy)) return
    let input
    try {
      input = parseUsagePolicyDraft(form.values, serverPolicy.revision)
    } catch (reason) {
      setPolicyError(reason instanceof Error ? reason.message : '请检查输入。')
      return
    }
    operation.current = 'save'
    setSaving(true)
    setPolicyError('')
    setMessage('')
    try {
      const result = await modelUsageApi.savePolicy(input)
      if (!alive.current) return
      setServerPolicy(result)
      setForm({ revision: result.revision, values: usagePolicyDraft(result) })
      setConflicted(false)
      setMessage('预警设置已保存；仍仅预警，不拦截提交。')
    } catch (reason) {
      if (!alive.current) return
      if (reason instanceof ApiError && reason.status === 409) {
        setConflicted(true)
        setPolicyError('设置已被其他管理员更新，您的输入已保留。正在加载最新版本，请比较后再保存。')
        operation.current = 'load'
        setRequest({ days: request.days })
      } else setPolicyError('保存失败或结果尚未确认，您的输入已保留。可刷新核对服务器设置后重试。')
    } finally {
      if (alive.current) {
        setSaving(false)
        if (operation.current === 'save') operation.current = ''
      }
    }
  }

  const acknowledge = async (id: string) => {
    if (!alive.current || operation.current) return
    operation.current = 'ack'
    setAcknowledging(id)
    setAlertError('')
    try {
      const alert = await modelUsageApi.acknowledge(id)
      if (!alive.current) return
      setResponse((current) =>
        current?.data
          ? {
              ...current,
              data: {
                ...current.data,
                alerts: current.data.alerts.map((item) => (item.id === alert.id ? alert : item)),
              },
            }
          : current,
      )
    } catch {
      if (alive.current) setAlertError('告警确认失败或结果尚未确认，请重试或刷新核对。')
    } finally {
      if (alive.current) {
        setAcknowledging(null)
        operation.current = ''
      }
    }
  }

  return (
    <div className="prd-page">
      <h1>模型用量与告警</h1>
      <div className="prd-notice">
        <strong>仅预警，不拦截提交</strong>
        <p>
          次数阈值用于发现异常用量，不是费用上限或硬限额。达到阈值后继续正常提交与评测；告警仅在此页面展示，不自动发送外部通知。
        </p>
      </div>
      <div className="prd-toolbar">
        <label className="prd-label" htmlFor="model-usage-days">
          明细时间范围
          <select
            id="model-usage-days"
            className="prd-input"
            value={request.days}
            disabled={blocked}
            onChange={(event) => refresh(Number(event.target.value))}
          >
            <option value={7}>近 7 天（含今天）</option>
            <option value={30}>近 30 天（含今天）</option>
          </select>
        </label>
        <button className="prd-button" disabled={blocked} onClick={() => refresh()}>
          {readError ? '重试加载' : '刷新统计'}
        </button>
      </div>
      {loading && (
        <div className="prd-loading" role="status">
          正在加载模型用量…
        </div>
      )}
      {readError && (
        <div className="prd-error" role="alert">
          {readError}
        </div>
      )}
      {message && (
        <div className="prd-notice" role="status">
          {message}
        </div>
      )}
      {form && serverPolicy && (
        <section className="prd-panel" aria-labelledby="usage-policy-title">
          <h2 id="usage-policy-title">预警设置</h2>
          <p className="prd-muted">
            按大模型上游尝试次数触发。达到预警百分比时提示，达到 100%
            时升级告警；两者均不阻断调用。当前服务器版本 v{serverPolicy.revision}。
          </p>
          {policyError && (
            <div className="prd-error" role="alert">
              {policyError}
            </div>
          )}
          {newerPolicy && (
            <div className="prd-notice">
              服务器设置已更新至 v{serverPolicy.revision}
              ，下方保留您的输入并列出服务器最新值。保存将用当前输入更新最新版本。
            </div>
          )}
          <div className="prd-grid">
            {USAGE_POLICY_FIELDS.map(([key, label]) => (
              <label key={key} className="prd-label" htmlFor={`usage-${key}`}>
                {label}
                {key === 'warnPercent' ? '（%）' : '（次）'}
                <input
                  id={`usage-${key}`}
                  name={key}
                  className="prd-input"
                  inputMode="numeric"
                  value={form.values[key]}
                  disabled={blocked}
                  maxLength={10}
                  onChange={(event) =>
                    setForm({ ...form, values: { ...form.values, [key]: event.target.value } })
                  }
                />
                <span className="prd-muted">
                  服务器当前值：{count(serverPolicy[key])}
                  {key === 'warnPercent' ? '%' : ' 次'}
                </span>
              </label>
            ))}
          </div>
          <div className="prd-toolbar">
            <button
              className="prd-button primary"
              disabled={blocked || (conflicted && !newerPolicy)}
              onClick={save}
            >
              {saving ? '保存中…' : newerPolicy ? '按最新版本保存我的输入' : '保存预警设置'}
            </button>
          </div>
          {conflicted && !newerPolicy && !loading && (
            <p className="prd-muted">请先成功刷新统计，取得最新设置后再保存；当前输入仍保留。</p>
          )}
        </section>
      )}
      {data && (
        <section className="prd-panel" aria-labelledby="usage-alerts-title">
          <h2 id="usage-alerts-title">告警与确认记录</h2>
          <p className="prd-muted">
            显示最近 100 条，未确认优先；完整历史由后台保留。确认仅标记已阅，再次触发会重新提醒。
          </p>
          {alertError && (
            <div className="prd-error" role="alert">
              {alertError}
            </div>
          )}
          {data.alerts.length ? (
            <div className="prd-table-wrap">
              <table className="prd-table" aria-label="模型用量告警">
                <thead>
                  <tr>
                    {['级别 / 内容', '范围', '计数 / 阈值', '首次 / 最近发现', '出现次数', '确认'].map(
                      (label) => (
                        <th key={label} scope="col">
                          {label}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.map((alert) => (
                    <tr key={alert.id}>
                      <td>
                        <span className="prd-badge">{alert.severity === 'critical' ? '严重' : '预警'}</span>
                        <div>{alert.message}</div>
                      </td>
                      <td>
                        {scopeLabels[alert.scope]} · {periodLabels[alert.period]}
                        {alert.scopeId && (
                          <div className="prd-muted" style={{ overflowWrap: 'anywhere' }}>
                            {alert.scopeId}
                          </div>
                        )}
                      </td>
                      <td>
                        {count(alert.value)} / {count(alert.threshold)}
                      </td>
                      <td>
                        <div>{timestamp(alert.firstSeenAt)}</div>
                        <div>{timestamp(alert.lastSeenAt)}</div>
                      </td>
                      <td>{count(alert.occurrences)}</td>
                      <td>
                        {alert.acknowledgedAt ? (
                          <>
                            <span>已确认</span>
                            <div className="prd-muted">{timestamp(alert.acknowledgedAt)}</div>
                          </>
                        ) : (
                          <button
                            className="prd-button"
                            disabled={blocked}
                            onClick={() => acknowledge(alert.id)}
                          >
                            {acknowledging === alert.id ? '确认中…' : '确认告警'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="prd-muted">暂无告警记录。</p>
          )}
        </section>
      )}
      {data && <UsageOverview data={data} />}
    </div>
  )
}
