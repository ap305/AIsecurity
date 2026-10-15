import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiDelete, apiGet, apiPut } from '../../lib/api'

interface AdminUser {
  id: string
  username: string
  displayName: string
  role: string
  tier: string
  school: string
  createdAt: string
}

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

  const handleResetPassword = async (u: AdminUser) => {
    if (!window.confirm(`确认重置 ${u.displayName}（${u.username}）的密码为 student123？`)) return
    try {
      await apiPut(`/admin/users/${u.id}/password`, { password: 'student123' })
      alert(`已重置 ${u.displayName} 的密码为 student123`)
    } catch (e) {
      alert(`重置失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  const handleDeleteUser = async (u: AdminUser) => {
    if (!window.confirm(`确认删除学员「${u.displayName}」(${u.username})？此操作不可恢复。`)) return
    try {
      await apiDelete(`/admin/users/${u.id}`)
      alert(`已删除学员 ${u.displayName}`)
      fetchUsers()
    } catch (e) {
      alert(`删除失败：${e instanceof Error ? e.message : '未知错误'}`)
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
            全部注册用户：{users.length} 人（学员 {users.filter((u) => u.role !== 'admin').length} 人）
          </p>
        </div>
      </div>

      {error && (
        <div
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
            overflow: 'hidden',
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
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                    >
                      {formatDate(u.createdAt)}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    {u.role !== 'admin' && (
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <Link
                          className="prd-button"
                          style={{ padding: '3px 10px', fontSize: 11 }}
                          to={`/admin/student-scores?userId=${encodeURIComponent(u.id)}`}
                        >
                          查看成绩
                        </Link>
                        <button
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
