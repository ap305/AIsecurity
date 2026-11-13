import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { authEmailApi, clearEmailFragment, parseEmailLink } from '../lib/authEmail'
import { validateNewPassword } from '../lib/authSession'

export default function PasswordRecovery({ verificationToken = '' }: { verificationToken?: string }) {
  const [token] = useState(
    () =>
      verificationToken ||
      (typeof window !== 'undefined' && parseEmailLink(window.location.hash)?.purpose === 'reset'
        ? parseEmailLink(window.location.hash)!.token
        : ''),
  )
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const loadConfig = () => {
    setError('')
    void authEmailApi
      .config()
      .then((config) => setEnabled(config.emailEnabled))
      .catch((err) => setError(err.message))
  }
  useEffect(() => {
    clearEmailFragment()
    loadConfig()
  }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !enabled || done) return
    setError('')
    setMessage('')
    if (token) {
      const validation = validateNewPassword(password)
      if (validation || password !== confirmation) {
        setError(validation || '两次密码不一致')
        return
      }
    }
    setBusy(true)
    try {
      if (token) {
        await authEmailApi.recover(token, password)
        setPassword('')
        setConfirmation('')
        setDone(true)
        setMessage('密码已恢复，原登录已失效。请使用新密码重新登录。')
      } else {
        await authEmailApi.request('reset', email)
        setMessage(
          '申请已受理。如该邮箱已绑定可恢复账号，系统将尝试发送验证链接；请在15分钟内打开。若未收到，请联系老师或管理员。',
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{token ? '设置新密码' : '邮箱找回密码'}</h1>
        <p>未绑定邮箱、管理员账号或无法收到邮件时，请联系授课老师或平台管理员核验身份后人工恢复。</p>
        {enabled === null ? (
          <p role="status">
            正在检查邮箱功能…{' '}
            <button type="button" onClick={loadConfig}>
              重试
            </button>
          </p>
        ) : !enabled ? (
          <p role="status">邮箱找回尚未开放，请使用人工恢复。</p>
        ) : (
          !done && (
            <form onSubmit={submit} aria-busy={busy}>
              {token ? (
                <>
                  <label>
                    新密码（15～128个字符）
                    <input
                      className="form-input"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    确认新密码
                    <input
                      className="form-input"
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      required
                    />
                  </label>
                </>
              ) : (
                <label>
                  已绑定邮箱
                  <input
                    className="form-input"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
              )}
              <button className="btn-primary" type="submit" disabled={busy}>
                {busy ? '处理中…' : token ? '确认恢复密码' : '发送恢复链接'}
              </button>
            </form>
          )
        )}
        {error && (
          <p role="alert" className="prd-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {token && !done && (
          <p>
            <Link to="/password-recovery">重新申请恢复链接</Link>
          </p>
        )}
        <p>
          <Link to="/login">返回登录</Link>
        </p>
      </div>
    </div>
  )
}
