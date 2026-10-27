import React, { type FormEvent } from 'react'
import type { TestAccountForm } from '../../lib/adminUsers'

interface Props {
  value: TestAccountForm
  busy: boolean
  blocked?: boolean
  error: string | null
  onChange: (value: TestAccountForm) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export default function TestAccountCreateForm({
  value,
  busy,
  blocked = false,
  error,
  onChange,
  onSubmit,
}: Props) {
  const disabled = busy || blocked
  return (
    <section
      aria-labelledby="test-account-title"
      style={{
        marginBottom: 24,
        padding: 20,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
      }}
    >
      <h2 id="test-account-title" style={{ margin: '0 0 8px', fontSize: 16 }}>
        创建测试账号
      </h2>
      <p style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
        测试账号使用学员入口登录，可提交和评测；不计入正式排行榜和学生成绩汇总。创建后可停用或删除。
      </p>
      <form onSubmit={onSubmit} aria-busy={busy}>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}
        >
          <div>
            <label htmlFor="test-account-username">用户名（必填）</label>
            <input
              id="test-account-username"
              name="username"
              className="form-input"
              type="text"
              value={value.username}
              required
              maxLength={32}
              disabled={disabled}
              autoComplete="off"
              placeholder="3～32 位字母或数字"
              aria-describedby="test-account-username-help"
              onChange={(event) => onChange({ ...value, username: event.target.value })}
            />
            <p
              id="test-account-username-help"
              style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}
            >
              用户名删除后仍会保留，不能重复使用。
            </p>
          </div>
          <div>
            <label htmlFor="test-account-display-name">姓名（必填）</label>
            <input
              id="test-account-display-name"
              name="displayName"
              className="form-input"
              type="text"
              value={value.displayName}
              required
              maxLength={64}
              disabled={disabled}
              autoComplete="off"
              placeholder="测试账号姓名"
              onChange={(event) => onChange({ ...value, displayName: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="test-account-password">初始密码（必填）</label>
            <input
              id="test-account-password"
              name="password"
              className="form-input"
              type="password"
              value={value.password}
              required
              minLength={6}
              maxLength={128}
              disabled={disabled}
              autoComplete="new-password"
              placeholder="6～128 位"
              onChange={(event) => onChange({ ...value, password: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="test-account-school">学校（选填）</label>
            <input
              id="test-account-school"
              name="school"
              className="form-input"
              type="text"
              value={value.school}
              maxLength={200}
              disabled={disabled}
              autoComplete="off"
              placeholder="可留空"
              onChange={(event) => onChange({ ...value, school: event.target.value })}
            />
          </div>
        </div>
        {error && (
          <p role="alert" style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <button className="prd-button" type="submit" disabled={disabled} style={{ marginTop: 16 }}>
          {busy ? '正在创建…' : '创建测试账号'}
        </button>
      </form>
    </section>
  )
}
