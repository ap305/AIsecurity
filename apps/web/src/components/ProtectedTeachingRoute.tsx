import { useRef } from 'react'
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useTeaching } from '../contexts/TeachingContext'
import { useAuth } from '../contexts/AuthContext'
import { getAuthToken } from '../lib/api'

export function WorkspaceLanding() {
  const { status, canTeach } = useTeaching()
  if (status !== 'ready') return <TeachingAccessStatus />
  return <Navigate to={canTeach ? '/teaching' : '/'} replace />
}

function TeachingAccessStatus() {
  const { status, refresh } = useTeaching()
  return (
    <section className="prd-page" aria-labelledby="teaching-access-title">
      <h1 id="teaching-access-title">教学权限</h1>
      {status === 'loading' ? (
        <p role="status">正在验证教学权限…</p>
      ) : (
        <>
          <p role="alert">暂时无法验证教学权限，请恢复连接后重试。</p>
          <button
            type="button"
            className="prd-button"
            onClick={() => {
              void refresh()
            }}
          >
            重新验证教学权限
          </button>{' '}
          <Link to="/">进入练习空间</Link>
        </>
      )}
    </section>
  )
}

export default function ProtectedTeachingRoute() {
  const { status, canTeach, refresh } = useTeaching()
  const { user } = useAuth()
  const { pathname } = useLocation()
  const key = JSON.stringify([user?.id, getAuthToken(), pathname])
  const authorizedKey = useRef<string | null>(null)
  const authorized = status === 'ready' && canTeach
  if (authorized) authorizedKey.current = key
  else if (status !== 'loading' || authorizedKey.current !== key) authorizedKey.current = null
  return (
    <>
      {/* Retain same-page drafts during focus verification, without exposing controls. */}
      <div hidden={!authorized} aria-hidden={!authorized || undefined}>
        {authorizedKey.current === key && <Outlet />}
      </div>
      {status !== 'ready' ? (
        <TeachingAccessStatus />
      ) : !canTeach ? (
        <section className="prd-page" aria-labelledby="teaching-denied-title">
          <h1 id="teaching-denied-title">暂无教学权限</h1>
          <p role="status">教学权限尚未授予或已撤销。请联系平台管理员；已有班级、成员和成绩会保留。</p>
          <button
            type="button"
            className="prd-button"
            onClick={() => {
              void refresh()
            }}
          >
            刷新教学权限
          </button>{' '}
          <Link to="/classes">返回我加入的班级</Link>
        </section>
      ) : null}
    </>
  )
}
