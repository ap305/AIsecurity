import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { apiDelete, apiGet, apiPut } from '../../lib/api'
import {
  createTestAccount,
  setTestAccountStatus,
  userDeleteConfirmation,
  validateTestAccountForm,
  type AdminUser,
  type TestAccountForm,
} from '../../lib/adminUsers'
import TestAccountCreateForm from './TestAccountCreateForm'

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

  const handleResetPassword = async (u: AdminUser) => {
    if (pendingActionRef.current !== null) return
    if (!window.confirm(`确认重置 ${u.displayName}（${u.username}）的密码为 student123？`)) return
    if (!startAction(u.id)) return
    try {
      await apiPut(`/admin/users/${u.id}/password`, { password: 'student123' })
      alert(`已重置 ${u.displayName} 的密码为 student123`)
    } catch (e) {
      alert(`重置失败：${e instanceof Error ? e.message : '未知错误'}`)
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
                <th style={{ ...thStyle, textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
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
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
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
                          onClick={() => handleResetPassword(u)}
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
                          重置密码
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
