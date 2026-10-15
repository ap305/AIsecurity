import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
export default function Profile() {
  const { user, updateProfile } = useAuth()
  const [form, setForm] = useState({
    displayName: user?.displayName ?? '',
    school: user?.school ?? '',
    studentId: user?.studentId ?? '',
    phone: user?.phone ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const save = async () => {
    if (!form.displayName.trim() || !form.school.trim()) {
      setError('姓名和学校不能为空。')
      return
    }
    if (form.studentId.trim() && !/^[A-Za-z0-9_-]{1,64}$/.test(form.studentId.trim())) {
      setError('学号限 1～64 位字母、数字、下划线或连字符。')
      return
    }
    if (form.phone.trim() && !/^\+?[0-9]{7,15}$/.test(form.phone.trim())) {
      setError('手机号需为 7～15 位数字，可带 + 国际区号。')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await updateProfile({
        displayName: form.displayName.trim(),
        school: form.school.trim(),
        studentId: form.studentId.trim(),
        phone: form.phone.trim(),
      })
      setMessage('个人资料已保存。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '资料保存失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="prd-page">
      <h1>个人资料</h1>
      <div className="prd-panel">
        <p className="prd-muted">账号：{user?.username}</p>
        <div className="prd-grid">
          {[
            ['姓名', 'displayName'],
            ['学校', 'school'],
            ['大学学号（选填）', 'studentId'],
            ['手机号（选填）', 'phone'],
          ].map(([label, key]) => (
            <label className="prd-label" key={key}>
              {label}
              <input
                className="prd-input"
                type={key === 'phone' ? 'tel' : 'text'}
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="prd-muted" style={{ marginTop: 20 }}>
          学号和手机号当前均为选填，学号前导零会保留。手机验证尚未开放；修改手机号后需要按后续规则重新验证。
        </p>
        {error && (
          <div className="prd-error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="prd-notice" role="status">
            {message}
          </div>
        )}
        <button className="prd-button primary" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存个人资料'}
        </button>
      </div>
    </div>
  )
}
