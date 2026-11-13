import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { validateNewPassword } from '../lib/authSession'
import { authEmailApi } from '../lib/authEmail'

export default function Register({ verificationToken = '' }: { verificationToken?: string }) {
  const navigate = useNavigate()

  const [displayName, setDisplayName] = useState('')
  const [school, setSchool] = useState('')
  const [studentId, setStudentId] = useState('')
  const [phone, setPhone] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMessage, setEmailMessage] = useState('')
  const loadConfig = () => {
    setError('')
    void authEmailApi
      .config()
      .then((config) => setEmailEnabled(config.emailEnabled))
      .catch((err) => setError(err.message))
  }
  useEffect(loadConfig, [])
  const sendEmail = async () => {
    if (emailBusy) return
    setError('')
    setEmailMessage('')
    setEmailBusy(true)
    try {
      await authEmailApi.request('registration', email)
      setEmailMessage(
        '申请已受理。如邮箱可用，系统将尝试发送验证链接。请在15分钟内打开邮件完成注册；本页密码不会保存。',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '申请失败，请重试')
    } finally {
      setEmailBusy(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (emailEnabled === null || (emailEnabled && !verificationToken)) {
      setError('请先完成邮箱验证，再填写注册资料')
      return
    }

    if (!displayName.trim() || !school.trim() || !username.trim() || !password || !confirmPassword) {
      setError('请填写所有字段')
      return
    }
    const passwordError = validateNewPassword(password)
    if (passwordError) {
      setError(passwordError)
      return
    }
    if (password !== confirmPassword) {
      setError('两次密码不一致')
      return
    }
    if (!/^[a-zA-Z0-9]+$/.test(username.trim())) {
      setError('用户名只能包含字母和数字')
      return
    }
    if (studentId.trim() && !/^[A-Za-z0-9_-]{1,64}$/.test(studentId.trim())) {
      setError('学号限 1～64 位字母、数字、下划线或连字符')
      return
    }
    if (phone.trim() && !/^\+?[0-9]{7,15}$/.test(phone.trim())) {
      setError('手机号需为 7～15 位数字，可带 + 国际区号')
      return
    }

    setLoading(true)
    try {
      await authEmailApi.register({
        displayName: displayName.trim(),
        school: school.trim(),
        username: username.trim(),
        password,
        studentId: studentId.trim() || undefined,
        phone: phone.trim() || undefined,
        ...(emailEnabled ? { emailToken: verificationToken } : {}),
      })
      alert('注册成功！请登录')
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <span style={{ fontSize: 36 }}>&#x1f6e1;&#xfe0f;</span>
          <h1
            style={{
              marginTop: 12,
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--brand-cyan)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: 2,
            }}
          >
            AI-SEC PLATFORM
          </h1>
          <p style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>注册新账号</p>
          <p style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>加入AI安全教学实验系统</p>
        </div>

        {/* Form */}
        {emailEnabled === null && (
          <p role="status">
            正在检查注册配置…{' '}
            <button type="button" onClick={loadConfig}>
              重试
            </button>
          </p>
        )}
        {emailEnabled && !verificationToken && (
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="register-email">注册邮箱</label>
            <input
              id="register-email"
              className="form-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn-primary" type="button" disabled={emailBusy || !email} onClick={sendEmail}>
              {emailBusy ? '申请中…' : '发送注册验证链接'}
            </button>
            <p>请先打开邮件中的验证链接，再填写以下资料。已绑定邮箱请前往登录或找回密码。</p>
          </div>
        )}
        {emailEnabled && verificationToken && (
          <p role="status">
            已读取邮箱验证链接，提交注册时完成验证。链接15分钟内有效；刷新本页后请重新打开邮件链接。
          </p>
        )}
        {emailMessage && <p role="status">{emailMessage}</p>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="register-student-id" style={{ fontSize: 12 }}>
              大学学号（选填）
            </label>
            <input
              id="register-student-id"
              className="form-input"
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="不填写也可注册与作答"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="register-phone" style={{ fontSize: 12 }}>
              手机号（选填）
            </label>
            <input
              id="register-phone"
              className="form-input"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="手机验证功能尚未开放"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <input
              className="form-input"
              type="text"
              placeholder="姓名"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                setError('')
              }}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <input
              className="form-input"
              type="text"
              placeholder="学校"
              value={school}
              onChange={(e) => {
                setSchool(e.target.value)
                setError('')
              }}
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <input
              className="form-input"
              type="text"
              placeholder="用户名（字母和数字）"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                setError('')
              }}
              autoComplete="username"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <input
              className="form-input"
              type="password"
              aria-label="新密码（15～128个字符）"
              placeholder="密码（15～128个字符）"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError('')
              }}
              autoComplete="new-password"
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input
              className="form-input"
              type="password"
              placeholder="确认密码"
              aria-label="确认密码"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value)
                setError('')
              }}
              autoComplete="new-password"
            />
          </div>

          {/* Error */}
          {error && <p style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>{error}</p>}

          {/* Submit */}
          <button
            className="btn-primary"
            type="submit"
            disabled={loading || emailEnabled === null || (emailEnabled && !verificationToken)}
            style={{ width: '100%', marginTop: 8 }}
          >
            {loading ? '注册中...' : '注 册'}
          </button>
        </form>

        {/* Login link */}
        <p
          style={{
            marginTop: 20,
            fontSize: 13,
            color: 'var(--text-muted)',
            textAlign: 'center',
          }}
        >
          已有账号？
          <Link
            to="/login"
            style={{
              color: 'var(--brand-cyan)',
              textDecoration: 'none',
              marginLeft: 4,
            }}
          >
            立即登录
          </Link>
        </p>
      </div>
    </div>
  )
}
