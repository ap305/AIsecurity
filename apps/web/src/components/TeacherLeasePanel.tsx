import { useEffect, useRef, useState } from 'react'
import { prdApi, type TeacherLease } from '../lib/prdApi'

const labels: Record<string, string> = {
  creating: '教师服务准备中（尚未开始计时）',
  preparing: '教师服务准备中（尚未开始计时）',
  active: '可用',
  expired: '已到期',
  revoked: '已撤销',
  error: '服务异常',
  idle: '尚未开启',
  not_started: '尚未开启',
  unavailable: '教师服务未就绪',
}

export function teacherLeaseControls(state = 'idle', leaseVersion?: number, questionVersion?: number) {
  const isCurrentVersion =
    leaseVersion == null || questionVersion == null || leaseVersion === questionVersion
  if (!isCurrentVersion) state = 'not_started'
  return {
    label: labels[state] ?? state,
    isCurrentVersion,
    canStart: ['not_started', 'idle', 'error', 'unavailable'].includes(state),
    canRenew: state === 'expired',
    canRevoke: ['active', 'creating', 'preparing'].includes(state),
  }
}

export default function TeacherLeasePanel({
  questionId,
  questionVersion,
}: {
  questionId: string
  questionVersion?: number
}) {
  const [lease, setLease] = useState<TeacherLease | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [copyState, setCopyState] = useState('')
  const anchor = useRef({ serverMs: Date.now(), monotonicMs: performance.now() })
  const accept = (value: TeacherLease | null) => {
    setLease(value)
    if (value?.serverTime) {
      anchor.current = { serverMs: Date.parse(value.serverTime), monotonicMs: performance.now() }
      setNow(anchor.current.serverMs)
    }
  }
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setLease(null)
    setError('')
    const refresh = async () => {
      try {
        const value = await prdApi.lease(questionId)
        if (!stopped) {
          accept(value)
          setError('')
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : '租约状态查询失败。')
      } finally {
        if (!stopped) setLoading(false)
      }
    }
    void refresh()
    const timer = setInterval(() => {
      setNow(anchor.current.serverMs + performance.now() - anchor.current.monotonicMs)
    }, 1000)
    const statusTimer = setInterval(refresh, 15000)
    return () => {
      stopped = true
      clearInterval(timer)
      clearInterval(statusTimer)
    }
  }, [questionId, questionVersion])
  const remaining = lease?.expiresAt ? Math.max(0, Math.ceil((Date.parse(lease.expiresAt) - now) / 1000)) : 0
  const expired =
    lease?.state === 'expired' || (lease?.state === 'active' && !!lease.expiresAt && remaining === 0)
  const controls = teacherLeaseControls(
    expired ? 'expired' : lease?.state,
    lease?.questionVersion,
    questionVersion,
  )
  const currentLease = controls.isCurrentVersion ? lease : null
  const perform = async (renew: boolean) => {
    setBusy(true)
    setError('')
    try {
      accept(renew ? await prdApi.renewLease(questionId) : await prdApi.startLease(questionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败。')
    } finally {
      setBusy(false)
    }
  }
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState('已复制')
    } catch {
      setCopyState('复制失败，请手动选择内容。')
    }
  }
  return (
    <section className="prd-panel">
      <h2>临时教师 API</h2>
      <p className="prd-muted">
        服务可用且租约生效后开始计时两小时。到期后需手动续期，刷新页面不会延长有效时间。
      </p>
      {loading ? (
        <p>正在查询租约…</p>
      ) : (
        <>
          <div className="prd-toolbar">
            <span className="prd-badge">
              {controls.label}
            </span>
            {currentLease?.state === 'active' && !expired && (
              <strong>
                {Math.floor(remaining / 3600)}:{String(Math.floor(remaining / 60) % 60).padStart(2, '0')}:
                {String(remaining % 60).padStart(2, '0')}
              </strong>
            )}
            {controls.canStart && (
              <button className="prd-button primary" disabled={busy} onClick={() => perform(false)}>
                {busy ? '正在开启…' : '开启临时 API'}
              </button>
            )}
            {controls.canRenew && (
              <button className="prd-button primary" disabled={busy} onClick={() => perform(true)}>
                {busy ? '正在续期…' : '手动续期两小时'}
              </button>
            )}
          </div>
          {currentLease?.expiresAt && (
            <p className="prd-muted">到期时间：{new Date(currentLease.expiresAt).toLocaleString('zh-CN')}</p>
          )}
          {currentLease && (
            <p className="prd-muted">
              已调用 {currentLease.calls ?? 0} 次
              {currentLease.maxCalls != null ? ` / ${currentLease.maxCalls} 次` : ''}
            </p>
          )}
          {currentLease?.reason && <p className="prd-muted">{currentLease.reason}</p>}
          {currentLease?.state === 'active' && !expired && currentLease.endpoint && (
            <>
              <label className="prd-label">
                本人的临时调用地址
                <input readOnly className="prd-input" value={currentLease.endpoint} />
              </label>
              <div className="prd-toolbar">
                <button className="prd-button" onClick={() => copy(currentLease.endpoint!)}>
                  复制地址
                </button>
                {currentLease.token && (
                  <button className="prd-button" onClick={() => copy(currentLease.token!)}>
                    复制访问凭证
                  </button>
                )}
                <span className="prd-muted" role="status">
                  {copyState}
                </span>
              </div>
              <p className="prd-muted">访问凭证仅供本人本地训练使用，请勿公开分享。</p>
            </>
          )}
        </>
      )}
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}
