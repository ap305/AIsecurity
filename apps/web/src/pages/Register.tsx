import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Register() {
  const { register } = useAuth()
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (
      !displayName.trim() ||
      !school.trim() ||
      !username.trim() ||
      !password.trim() ||
      !confirmPassword.trim()
    ) {
      setError('请填写所有字段')
      return
    }
    if (password.length < 6) {
      setError('密码至少需要6位')
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
      await register({
        displayName: displayName.trim(),
        school: school.trim(),
        username: username.trim(),
        password,
        studentId: studentId.trim() || undefined,
        phone: phone.trim() || undefined,
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
              placeholder="密码（至少6位）"
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
            disabled={loading}
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
