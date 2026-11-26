import { useState, type FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { passwordChangeHref, type LoginRole } from '../lib/authSession'
import { loginWorkspaceDestination } from '../lib/roleNavigation'
import { getAuthToken } from '../lib/api'
import DemoSessionNotice from '../components/DemoSessionNotice'

type RoleTab = { role: LoginRole; label: string }

const ROLE_TABS: RoleTab[] = [
  { role: 'student', label: '师生登录' },
  { role: 'admin', label: '管理员登录' },
  { role: 'demo', label: '演示登录' },
]

export default function Login() {
  const { login, logoutNotice: sessionNotice } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const requestedReturnTo = new URLSearchParams(location.search).get('returnTo')
  const logoutNotice = sessionNotice || (location.state as { logoutNotice?: string } | null)?.logoutNotice

  const [activeRole, setActiveRole] = useState<RoleTab>(
    requestedReturnTo?.split('/')[1] === 'demo' ? ROLE_TABS[2] : ROLE_TABS[0],
  )
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username || !password) {
      setError('请输入用户名和密码')
      return
    }

    setLoading(true)
    try {
      const loggedIn = await login(username, password, activeRole.role)
      const returnTo = loginWorkspaceDestination(requestedReturnTo, loggedIn.role)
      navigate(loggedIn.mustChangePassword ? passwordChangeHref(returnTo) : returnTo, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  if (activeRole.role === 'demo' && getAuthToken()) return <DemoSessionNotice />
  return (
    <main className="login-page sign-in-page">
      <section className="login-card sign-in-card" aria-labelledby="sign-in-title">
        <header className="sign-in-heading">
          <span className="sign-in-symbol" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3 4.5 6v5.5c0 4.2 2.9 7.6 7.5 9.5 4.6-1.9 7.5-5.3 7.5-9.5V6L12 3Z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="m8.5 11.5 2.5 2.5 4.5-5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <p className="sign-in-brand">AI-SEC PLATFORM</p>
            <h1 id="sign-in-title">ai安全教学实验平台</h1>
          </div>
        </header>
        <div className="sign-in-roles" role="group" aria-label="登录身份">
          {ROLE_TABS.map((tab) => (
            <button
              key={tab.role}
              type="button"
              disabled={loading}
              aria-pressed={tab.role === activeRole.role}
              onClick={() => {
                setActiveRole(tab)
                if ((activeRole.role === 'demo') !== (tab.role === 'demo')) {
                  setUsername('')
                  setPassword('')
                  setShowRecoveryHelp(false)
                }
                setError('')
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {logoutNotice && <p role="status">{logoutNotice}</p>}
        {activeRole.role === 'demo' && <p className="sign-in-help">使用演示账号查看提交评测和班级成绩示例。</p>}
        <form onSubmit={handleSubmit} aria-busy={loading}>
          <div>
            <label htmlFor="login-username">用户名</label>
            <input
              id="login-username"
              className="form-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                setError('')
              }}
            />
          </div>
          <div>
            <label htmlFor="login-password">密码</label>
            <div className="sign-in-password">
              <input
                id="login-password"
                className="form-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError('')
                }}
              />
              <button
                type="button"
                aria-controls="login-password"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? '隐藏密码' : '显示密码'}
              </button>
            </div>
          </div>
          {error && (
            <p className="sign-in-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn-primary sign-in-submit" type="submit" disabled={loading}>
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
        <div className="sign-in-links">
          <button
            type="button"
            aria-expanded={showRecoveryHelp}
            aria-controls="sign-in-help"
            onClick={() => setShowRecoveryHelp((value) => !value)}
          >
            忘记密码？
          </button>
          {activeRole.role === 'student' && <Link to="/register">注册新账号</Link>}
        </div>
        {showRecoveryHelp && (
          <p className="sign-in-help" id="sign-in-help" role="status">
            {activeRole.role === 'demo' ? '请联系提供演示账号的管理员获取登录信息。' : <>
              请联系平台管理员，核验身份后人工恢复密码。教师授权不包含密码管理权限。手机验证和短信找回尚未开放。{' '}
              <Link to="/password-recovery">已绑定邮箱？查看邮箱找回</Link>
            </>}
          </p>
        )}
      </section>
    </main>
  )
}
