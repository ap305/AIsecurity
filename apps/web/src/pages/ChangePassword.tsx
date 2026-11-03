import { useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import AccountSecurity from '../components/AccountSecurity'
import { safeReturnTo } from '../lib/authSession'
import { useAuth } from '../contexts/AuthContext'

export default function ChangePassword() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'))
  return (
    <main className="login-page">
      <div className="login-card" style={{ maxWidth: 700, width: '100%' }}>
        <h1>修改登录密码</h1>
        <p>账号：{user?.username}</p>
        <AccountSecurity onChanged={() => navigate(returnTo, { replace: true })} />
        <button
          type="button"
          className="btn-ghost"
          disabled={loggingOut}
          onClick={async () => {
            setLoggingOut(true)
            try {
              const result = await logout()
              if (!result.sessionChanged) navigate('/login', { replace: true })
            } finally {
              setLoggingOut(false)
            }
          }}
        >
          {loggingOut ? '退出中…' : '退出当前登录'}
        </button>
      </div>
    </main>
  )
}
