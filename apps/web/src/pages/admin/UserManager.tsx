import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { apiDelete, apiGet } from '../../lib/api'
import {
  fetchAuthEvents,
  recoverInitialPassword,
  setUserPassword,
  type AuthEvent,
  type PasswordRecovery,
} from '../../lib/adminAuth'
import {
  createTestAccount,
  setTestAccountStatus,
  userDeleteConfirmation,
  validateTestAccountForm,
  type AdminUser,
  type TestAccountForm,
} from '../../lib/adminUsers'
import TestAccountCreateForm from './TestAccountCreateForm'
import { defaultAdminUserFilters, filterAdminUsers, type AdminUserFilters } from '../../lib/adminUserFilters'

const thStyle: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 1,
}

export default function UserManager() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [filters, setFilters] = useState<AdminUserFilters>(defaultAdminUserFilters)
  const visibleUsers = useMemo(() => filterAdminUsers(users, filters), [users, filters])
  const hasActiveFilters =
    filters.keyword !== '' ||
    filters.accountType !== 'all' ||
    filters.role !== 'all' ||
    filters.status !== 'all'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState<TestAccountForm>({
    username: '',
    displayName: '',
    password: '',
    school: '',
  })
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [identityVerified, setIdentityVerified] = useState(false)
  const [recovery, setRecovery] = useState<PasswordRecovery | null>(null)
  const [manualResetEnabled, setManualResetEnabled] = useState(false)
  const [eventUser, setEventUser] = useState<AdminUser | null>(null)
  const [authEvents, setAuthEvents] = useState<AuthEvent[]>([])
  const eventRequest = useRef(0)

  useEffect(() => {
    if (!recovery) return
    const timer = setTimeout(
      () => setRecovery(null),
      Math.max(0, Date.parse(recovery.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [recovery])

  const startAction = (key: string) => {
    if (pendingActionRef.current !== null) return false
    pendingActionRef.current = key
    setPendingAction(key)
    setNotice(null)
    return true
  }

  const finishAction = () => {
    pendingActionRef.current = null
    setPendingAction(null)
  }

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<AdminUser[]>('/admin/users')
      setUsers(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载用户失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    let active = true
    apiGet<{ manualResetEnabled: boolean }>('/auth/config')
      .then((data) => {
        if (active) setManualResetEnabled(data.manualResetEnabled === true)
      })
      .catch(() => {})
    return () => {
      active = false
      eventRequest.current++
    }
  }, [fetchUsers])

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pendingActionRef.current !== null) return
    const validationError = validateTestAccountForm(createForm)
    setCreateError(validationError)
    if (validationError || !startAction('create')) return
    try {
      const created = await createTestAccount(createForm)
      setCreateForm({ username: '', displayName: '', password: '', school: '' })
      setNotice(`测试账号 ${created.username} 创建成功。请使用学员入口登录，管理员会话保持不变。`)
      await fetchUsers()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '创建测试账号失败，请重试')
    } finally {
      finishAction()
    }
  }

  const handleAccountStatus = async (u: AdminUser) => {
    if (pendingActionRef.current !== null) return
    const status = u.accountStatus === 'disabled' ? 'active' : 'disabled'
    const action = status === 'disabled' ? '停用' : '启用'
    const consequence =
      status === 'disabled'
        ? '停用后不能登录，已有会话将失效；历史提交和评测结果保留。'
        : '启用后需要重新登录。'
    if (!window.confirm(`确认${action}测试账号「${u.displayName}」(${u.username})？${consequence}`)) return
    if (!startAction(u.id)) return
    setError(null)
    try {
      await setTestAccountStatus(u, status)
      setNotice(
        `已${action}测试账号 ${u.username}。${status === 'active' ? '请重新登录。' : '历史记录已保留。'}`,
      )
      await fetchUsers()
    } catch (e) {
      setError(`${action}失败：${e instanceof Error ? e.message : '请稍后重试'}`)
    } finally {
      finishAction()
    }
  }

  const openPasswordEditor = (u: AdminUser) => {
    setPasswordUser(u)
    setNewPassword('')
    setConfirmPassword('')
    setIdentityVerified(false)
    setRecovery(null)
    setError(null)
  }

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!passwordUser || !startAction(`password:${passwordUser.id}`)) return
    setError(null)
    try {
      await setUserPassword(passwordUser.id, newPassword, confirmPassword)
      setNotice(`已为 ${passwordUser.username} 设置独立新密码。其他登录已失效，该账号登录后须先修改密码。`)
      setNewPassword('')
      setConfirmPassword('')
      setPasswordUser(null)
      setRecovery(null)
      await fetchUsers()
    } catch (e) {
      setError(`设置失败：${e instanceof Error ? e.message : '请重试'}`)
    } finally {
      finishAction()
    }
  }

  const handleRecoverPassword = async () => {
    if (!passwordUser || !manualResetEnabled || !identityVerified || pendingActionRef.current !== null) return
    if (
      !window.confirm(
        `已核验 ${passwordUser.displayName}（${passwordUser.username}）的身份，确认恢复初始密码？原有登录将失效；恢复凭据仅 15 分钟内有效，须首次改密。`,
      )
    )
      return
    if (!startAction(`password:${passwordUser.id}`)) return
    setError(null)
    setRecovery(null)
    try {
      const result = await recoverInitialPassword(passwordUser.id, identityVerified)
      setRecovery(result)
      setIdentityVerified(false)
      setNewPassword('')
      setConfirmPassword('')
      setNotice(
        `已恢复 ${passwordUser.username} 的初始密码。请通过已核验的人工渠道交付，下方凭据关闭后不再显示。`,
      )
    } catch (e) {
      setError(`恢复失败：${e instanceof Error ? e.message : '请重试'}`)
    } finally {
      finishAction()
    }
  }

  const showAuthEvents = async (u: AdminUser) => {
    if (!startAction(`events:${u.id}`)) return
    const version = ++eventRequest.current
    setEventUser(u)
    setAuthEvents([])
    setError(null)
    try {
      const events = await fetchAuthEvents(u.id)
      if (version === eventRequest.current) setAuthEvents(events)
    } catch (e) {
      if (version === eventRequest.current)
        setError(e instanceof Error ? e.message : '安全事件加载失败，请重试。')
    } finally {
      finishAction()
    }
  }

  const handleDeleteUser = async (u: AdminUser) => {
    if (pendingActionRef.current !== null) return
    if (!window.confirm(userDeleteConfirmation(u)) || !startAction(u.id)) return
    try {
      await apiDelete(`/admin/users/${u.id}`)
      if (u.isTestAccount) setNotice(`已删除测试账号 ${u.username}，历史提交、评测结果和用户名已保留。`)
      else alert(`已删除学员 ${u.displayName}`)
      await fetchUsers()
    } catch (e) {
      alert(`删除失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      finishAction()
    }
  }

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      const p = (x: number) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch {
      return iso
    }
  }

  return (
    <div>
      <div
        style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>用户管理</h1>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            全部用户：{users.length} 人（正式学员{' '}
            {users.filter((u) => u.role !== 'admin' && !u.isTestAccount).length} 人，测试账号{' '}
            {users.filter((u) => u.isTestAccount).length} 人）
          </p>
        </div>
      </div>

      <TestAccountCreateForm
        value={createForm}
        busy={pendingAction === 'create'}
        blocked={pendingAction !== null}
        error={createError}
        onChange={(value) => {
          setCreateForm(value)
          setCreateError(null)
        }}
        onSubmit={handleCreateAccount}
      />

      {passwordUser && (
        <section className="prd-panel" style={{ margin: '16px 0' }} aria-labelledby="password-reset-title">
          <h2 id="password-reset-title">
            设置密码：{passwordUser.displayName}（{passwordUser.username}）
          </h2>
          <p>请为该账号单独输入新密码。成功后原有登录撤销，使用新密码登录后须先改密。</p>
          <form onSubmit={handleResetPassword}>
            <div className="prd-grid">
              <label className="prd-label">
                独立新密码（15～128 个字符）
                <input
                  type="password"
                  autoComplete="new-password"
                  className="prd-input"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
              </label>
              <label className="prd-label">
                确认新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  className="prd-input"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </label>
            </div>
            <button className="prd-button primary" type="submit" disabled={pendingAction !== null}>
              {pendingAction === `password:${passwordUser.id}` ? '处理中…' : '确认设置新密码'}
            </button>
          </form>
          {manualResetEnabled && (
            <div style={{ marginTop: 20 }}>
              <p>人工恢复初始密码：核验身份后操作，恢复凭据在 15 分钟内有效且首次登录必须改密。</p>
              <label>
                <input
                  type="checkbox"
                  checked={identityVerified}
                  onChange={(event) => setIdentityVerified(event.target.checked)}
                />{' '}
                我已人工核验此账号使用者身份
              </label>{' '}
              <button
                className="prd-button"
                type="button"
                disabled={!identityVerified || pendingAction !== null}
                onClick={handleRecoverPassword}
              >
                恢复初始密码
              </button>
            </div>
          )}
          {recovery && (
            <div className="prd-notice" role="status">
              <p>仅本次显示，请通过已核验的人工渠道交付，不要发布到群聊。</p>
              <p>
                恢复密码：<code>{recovery.temporaryPassword}</code>
              </p>
              <p>有效期至：{formatDate(recovery.expiresAt)}；首次登录必须修改密码。</p>
              <button className="prd-button" type="button" onClick={() => setRecovery(null)}>
                已交付，隐藏凭据
              </button>
            </div>
          )}
          <button
            className="prd-button"
            type="button"
            disabled={pendingAction !== null}
            style={{ marginTop: 12 }}
            onClick={() => {
              setPasswordUser(null)
              setRecovery(null)
              setNewPassword('')
              setConfirmPassword('')
              setIdentityVerified(false)
            }}
          >
            关闭密码操作
          </button>
        </section>
      )}

      {eventUser && (
        <section className="prd-panel" style={{ margin: '16px 0' }} aria-labelledby="auth-events-title">
          <h2 id="auth-events-title">最近安全事件：{eventUser.username}</h2>
          {pendingAction === `events:${eventUser.id}` ? (
            <p role="status">加载中…</p>
          ) : authEvents.length === 0 ? (
            <p>暂无安全事件。</p>
          ) : (
            <ul>
              {authEvents.map((event) => (
                <li key={event.id}>
                  {formatDate(event.createdAt)} · {event.action || event.type} ·{' '}
                  {event.success ? '成功' : '失败'}
                  {event.actorId ? ` · 操作人 ${event.actorId}` : ''}
                </li>
              ))}
            </ul>
          )}
          <button
            className="prd-button"
            type="button"
            disabled={pendingAction !== null}
            onClick={() => {
              void showAuthEvents(eventUser)
            }}
          >
            刷新事件
          </button>{' '}
          <button
            className="prd-button"
            type="button"
            onClick={() => {
              eventRequest.current++
              setEventUser(null)
              setAuthEvents([])
            }}
          >
            关闭事件
          </button>
        </section>
      )}

      {notice && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            background: 'rgba(0,212,255,0.08)',
            color: 'var(--brand-cyan)',
          }}
        >
          {notice}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            background: 'rgba(255,107,107,0.08)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
          }}
        >
          {error}
        </div>
      )}

      <section
        aria-label="账号筛选"
        style={{
          marginBottom: 16,
          padding: 16,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 8,
        }}
      >
        <div
          role="search"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}
        >
          <div>
            <label htmlFor="user-filter-keyword">搜索账号</label>
            <input
              id="user-filter-keyword"
              type="search"
              className="form-input"
              value={filters.keyword}
              placeholder="用户名、姓名、学校或学号"
              autoComplete="off"
              onChange={(event) => setFilters((current) => ({ ...current, keyword: event.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="user-filter-account-type">账号类型</label>
            <select
              id="user-filter-account-type"
              className="form-input"
              value={filters.accountType}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  accountType: event.target.value as AdminUserFilters['accountType'],
                }))
              }
            >
              <option value="all">全部账号</option>
              <option value="regular">正式账号</option>
              <option value="test">测试账号</option>
            </select>
          </div>
          <div>
            <label htmlFor="user-filter-role">角色</label>
            <select
              id="user-filter-role"
              className="form-input"
              value={filters.role}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  role: event.target.value as AdminUserFilters['role'],
                }))
              }
            >
              <option value="all">全部角色</option>
              <option value="admin">管理员</option>
              <option value="student">学员</option>
            </select>
          </div>
          <div>
            <label htmlFor="user-filter-status">账号状态</label>
            <select
              id="user-filter-status"
              className="form-input"
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value as AdminUserFilters['status'],
                }))
              }
            >
              <option value="all">全部状态</option>
              <option value="active">已启用</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            marginTop: 12,
          }}
        >
          <p
            role="status"
            aria-live="polite"
            style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}
          >
            {loading ? '正在加载账号…' : `显示 ${visibleUsers.length} / ${users.length} 个账号`}
          </p>
          <button
            type="button"
            className="prd-button"
            disabled={!hasActiveFilters}
            onClick={() => setFilters(defaultAdminUserFilters())}
          >
            重置筛选
          </button>
        </div>
      </section>

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>加载用户中...</div>
      ) : users.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: 'center',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
          }}
        >
          <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>暂无注册用户</p>
        </div>
      ) : visibleUsers.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: 'center',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
          }}
        >
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            没有符合筛选条件的账号，请调整条件或重置筛选。
          </p>
        </div>
      ) : (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            overflowX: 'auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr
                style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}
              >
                <th style={thStyle}>用户名</th>
                <th style={thStyle}>姓名</th>
                <th style={thStyle}>学校</th>
                <th style={thStyle}>角色</th>
                <th style={thStyle}>账号类型</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>注册时间</th>
                <th style={thStyle}>最近登录</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}
                    >
                      {u.username}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{u.displayName}</span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{u.school || '—'}</span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 8px',
                        borderRadius: 10,
                        fontWeight: 600,
                        background: u.role === 'admin' ? 'rgba(255,107,107,0.15)' : 'rgba(0,212,255,0.12)',
                        color: u.role === 'admin' ? 'var(--danger)' : 'var(--brand-cyan)',
                      }}
                    >
                      {u.role === 'admin' ? '管理员' : '学员'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: u.isTestAccount ? 'var(--brand-cyan)' : 'var(--text-secondary)',
                      }}
                    >
                      {u.isTestAccount ? '测试账号' : '正式账号'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: u.accountStatus === 'disabled' ? 'var(--danger)' : 'var(--text-secondary)',
                      }}
                    >
                      {u.accountStatus === 'disabled' ? '已停用' : '已启用'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                    >
                      {formatDate(u.createdAt)}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>{u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <button
                      className="prd-button"
                      type="button"
                      disabled={pendingAction !== null}
                      onClick={() => {
                        void showAuthEvents(u)
                      }}
                    >
                      安全事件
                    </button>{' '}
                    {u.role !== 'admin' && (
                      <div
                        style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}
                      >
                        {!u.isTestAccount && (
                          <Link
                            className="prd-button"
                            style={{ padding: '3px 10px', fontSize: 11 }}
                            to={`/admin/student-scores?userId=${encodeURIComponent(u.id)}`}
                          >
                            查看成绩
                          </Link>
                        )}
                        {u.isTestAccount && u.role === 'student' && (
                          <button
                            className="prd-button"
                            type="button"
                            disabled={pendingAction !== null}
                            onClick={() => handleAccountStatus(u)}
                            style={{ padding: '3px 10px', fontSize: 11 }}
                          >
                            {pendingAction === u.id
                              ? '处理中…'
                              : u.accountStatus === 'disabled'
                                ? '启用'
                                : '停用'}
                          </button>
                        )}
                        <button
                          disabled={pendingAction !== null}
                          onClick={() => openPasswordEditor(u)}
                          style={{
                            padding: '3px 10px',
                            fontSize: 11,
                            borderRadius: 4,
                            cursor: 'pointer',
                            background: 'transparent',
                            border: '1px solid var(--brand-cyan)',
                            color: 'var(--brand-cyan)',
                            fontFamily: 'inherit',
                          }}
                        >
                          设置密码 / 人工恢复
                        </button>
                        <button
                          disabled={pendingAction !== null}
                          onClick={() => handleDeleteUser(u)}
                          style={{
                            padding: '3px 10px',
                            fontSize: 11,
                            borderRadius: 4,
                            cursor: 'pointer',
                            background: 'transparent',
                            border: '1px solid var(--danger)',
                            color: 'var(--danger)',
                            fontFamily: 'inherit',
                          }}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
