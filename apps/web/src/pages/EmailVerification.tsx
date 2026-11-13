import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { authEmailApi, clearEmailFragment, parseEmailLink } from '../lib/authEmail'
import Register from './Register'
import PasswordRecovery from './PasswordRecovery'

export default function EmailVerification() {
  const [link] = useState(() => (typeof window === 'undefined' ? null : parseEmailLink(window.location.hash)))
  const { user, logout } = useAuth()
  const [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false)
  useEffect(() => {
    clearEmailFragment()
  }, [])
  const bind = async (event: FormEvent) => {
    event.preventDefault()
    if (!link || busy) return
    setBusy(true)
    setError('')
    try {
      await authEmailApi.bind(link.token, password)
      setPassword('')
      setDone(true)
      await logout()
    } catch (err) {
      setError(err instanceof Error ? err.message : '邮箱绑定失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  if (link?.purpose === 'registration') return <Register verificationToken={link.token} />
  if (link?.purpose === 'reset') return <PasswordRecovery verificationToken={link.token} />
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>确认绑定邮箱</h1>
        {!link ? (
          <p role="alert">链接无效。刷新页面会清除本页凭据，请重新打开邮件中的链接，或回个人资料重新申请。</p>
        ) : done ? (
          <p role="status">邮箱已验证并绑定，原登录已失效，请重新登录。</p>
        ) : !user ? (
          <p>请先在另一页面登录发起绑定的账号，然后重新打开本邮件链接。不要将链接转发给他人。</p>
        ) : (
          <form onSubmit={bind} aria-busy={busy}>
            <p>
              正在为 {user.displayName} 确认邮箱。验证成功后将退出所有旧登录；在完成验证前原邮箱保持有效。
            </p>
            <label>
              当前密码
              <input
                className="form-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? '验证中…' : '确认绑定并重新登录'}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="prd-error">
            {error}
          </p>
        )}
        <p>
          <Link to="/login">前往登录</Link> · <Link to="/profile">返回个人资料</Link>
        </p>
      </div>
    </div>
  )
}
