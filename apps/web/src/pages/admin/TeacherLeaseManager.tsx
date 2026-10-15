import { useEffect, useState } from 'react'
import { prdApi, type TeacherLease } from '../../lib/prdApi'
export default function TeacherLeaseManager() {
  const [leases, setLeases] = useState<TeacherLease[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      setLeases(await prdApi.leases())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '租约列表加载失败。')
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [])
  const revoke = async (lease: TeacherLease) => {
    if (!window.confirm('撤销后该租约立即失效，学生将无法继续调用。确认撤销？')) return
    setBusy(true)
    try {
      await prdApi.revokeLease(lease.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="prd-page">
      <h1>临时教师 API 管理</h1>
      <p className="prd-muted">
        查询服务准备、有效期、调用额度和异常状态。有效租约从服务可用时开始计时两小时。
      </p>
      <div className="prd-toolbar">
        <input
          className="prd-input"
          aria-label="筛选租约"
          placeholder="筛选用户、题目或状态"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="prd-button" onClick={() => void load()}>
          刷新状态
        </button>
      </div>
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      <div className="prd-panel prd-table-wrap">
        <table className="prd-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>题目 / 作用范围</th>
              <th>状态</th>
              <th>开始 / 到期时间</th>
              <th>调用数</th>
              <th>维护</th>
            </tr>
          </thead>
          <tbody>
            {leases
              .filter((lease) =>
                `${lease.username ?? lease.userId} ${lease.questionTitle ?? lease.questionId} ${lease.state}`.includes(
                  filter,
                ),
              )
              .map((lease) => (
                <tr key={lease.id}>
                  <td>{lease.username ?? lease.userId ?? '—'}</td>
                  <td>
                    {lease.questionTitle ?? lease.questionId ?? '—'}
                    <div className="prd-muted">{lease.scope}</div>
                  </td>
                  <td>
                    {lease.state}
                    {lease.reason && <div className="prd-muted">{lease.reason}</div>}
                  </td>
                  <td>
                    {lease.startsAt
                      ? new Date(lease.startsAt).toLocaleString('zh-CN')
                      : '服务准备中，尚未计时'}
                    <br />
                    {lease.expiresAt ? new Date(lease.expiresAt).toLocaleString('zh-CN') : '—'}
                  </td>
                  <td>
                    {lease.calls ?? 0} / {lease.maxCalls ?? '—'}
                  </td>
                  <td>
                    <button
                      className="prd-button danger"
                      disabled={busy || !['active', 'preparing'].includes(lease.state)}
                      onClick={() => void revoke(lease)}
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            {!leases.length && (
              <tr>
                <td colSpan={6}>暂无临时 API 租约。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
