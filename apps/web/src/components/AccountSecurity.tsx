import { useState, type FormEvent } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { validateNewPassword } from '../lib/authSession'

export default function AccountSecurity({ onChanged }: { onChanged?: () => void }) {
  const { user, changePassword, logoutOthers } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<'password' | 'sessions' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const change = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    setMessage('')
    const validation = validateNewPassword(newPassword)
    if (!currentPassword) {
      setError('请输入当前密码。')
      return
    }
    if (validation) {
      setError(validation)
      return
    }
    if (newPassword !== confirmation) {
      setError('两次新密码不一致。')
      return
    }
    setBusy('password')
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setMessage('密码已修改，其他登录已失效。请使用新密码登录。')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '密码修改失败，请重试。')
    } finally {
      setBusy(null)
    }
  }
  const endOtherSessions = async () => {
    if (busy || !window.confirm('确认退出其他登录？当前登录会保留，其他设备和标签页需要重新登录。')) return
    setError('')
    setMessage('')
    setBusy('sessions')
    try {
      await logoutOthers()
      setMessage('其他登录已撤销，当前登录已更新。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试。')
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="prd-panel" style={{ marginTop: 20 }} aria-labelledby="account-security-title">
      <h2 id="account-security-title">账号安全</h2>
      {user?.mustChangePassword && (
        <p role="alert">
          管理员已恢复或设置密码。请先修改密码再继续作答；若刚从旧页面进入，请刷新后在本页完成改密。人工恢复凭据仅在
          15 分钟内有效。
        </p>
      )}
      <p className="prd-muted">
        新密码须为 15～128 个字符，支持中文和表情；密码中的空格会保留。修改成功后其他登录将失效。
      </p>
      <form onSubmit={change} aria-busy={busy === 'password'}>
        <div className="prd-grid">
          <label className="prd-label">
            当前密码
            <input
              className="prd-input"
              autoComplete="current-password"
              type={showPassword ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>
          <label className="prd-label">
            新密码
            <input
              className="prd-input"
              autoComplete="new-password"
              type={showPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </label>
          <label className="prd-label">
            确认新密码
            <input
              className="prd-input"
              autoComplete="new-password"
              type={showPassword ? 'text' : 'password'}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
            />
          </label>
        </div>
        <button
          type="button"
          className="prd-button"
          aria-pressed={showPassword}
          onClick={() => setShowPassword((value) => !value)}
        >
          {showPassword ? '隐藏密码' : '显示密码'}
        </button>{' '}
        <button className="prd-button primary" type="submit" disabled={busy !== null}>
          {busy === 'password' ? '修改中…' : '修改密码'}
        </button>
      </form>
      {!user?.mustChangePassword && (
        <button
          type="button"
          className="prd-button"
          style={{ marginTop: 16 }}
          disabled={busy !== null}
          onClick={endOtherSessions}
        >
          {busy === 'sessions' ? '撤销中…' : '退出其他登录'}
        </button>
      )}
      {error && (
        <p className="prd-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="prd-notice" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
