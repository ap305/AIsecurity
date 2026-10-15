import { useEffect, useState } from 'react'
import { prdApi, type ApiPoolItem } from '../../lib/prdApi'
const blank = (): ApiPoolItem => ({
  id: '',
  name: '',
  kind: 'llm',
  model: 'qwen3-8b',
  modelVersion: '',
  baseUrl: '',
  credentialEnv: '',
  parameters: {},
  enabled: true,
  isDefault: false,
  revision: 1,
})
function containsCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, child]) =>
      /api.?key|secret|^(token|authorization|password)$/i.test(key) || containsCredential(child),
  )
}
export default function ApiPoolManager() {
  const [items, setItems] = useState<ApiPoolItem[]>([])
  const [form, setForm] = useState<ApiPoolItem | null>(null)
  const [editing, setEditing] = useState(false)
  const [parameters, setParameters] = useState('{}')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      setItems(await prdApi.pool())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API 池加载失败。')
    }
  }
  useEffect(() => {
    void load()
  }, [])
  const edit = (item: ApiPoolItem, existing: boolean) => {
    setForm({ ...item, credentialEnv: item.credentialEnv ?? '' })
    setEditing(existing)
    setParameters(JSON.stringify(item.parameters ?? {}, null, 2))
    setError('')
    setMessage('')
  }
  const save = async () => {
    if (!form) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(parameters)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      if (containsCredential(parsed)) {
        setError('参数中不得包含实际密钥、令牌或密码，请使用服务器环境变量引用。')
        return
      }
    } catch {
      setError('固定参数须为合法 JSON 对象。')
      return
    }
    if (!form.name.trim() || !form.model.trim() || !form.modelVersion.trim()) {
      setError('请填写配置名称、模型标识与精确版本。')
      return
    }
    try {
      const url = new URL(form.baseUrl)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
    } catch {
      setError('服务地址须为 http / https，且不能在地址中携带账号密码。')
      return
    }
    if (form.credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.credentialEnv)) {
      setError('密钥环境变量名称格式无效。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await prdApi.savePool({ ...form, parameters: parsed }, editing ? form.id : undefined)
      setForm(null)
      setMessage('平台 API 配置已保存。已发布题目的绑定保持原冻结版本。')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="prd-page">
      <div className="prd-split">
        <div>
          <h1>平台 API 池</h1>
          <p className="prd-muted">
            统一维护模型与教师服务。出题人选择题目固定配置，学生不提供 API 或自选模型。
          </p>
        </div>
        <button className="prd-button primary" onClick={() => edit(blank(), false)}>
          新增配置
        </button>
      </div>
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
      {form && (
        <section className="prd-panel">
          <h2>{editing ? '编辑配置' : '新增配置'}</h2>
          <div className="prd-grid">
            {[
              ['名称', 'name'],
              ['模型标识', 'model'],
              ['精确模型版本', 'modelVersion'],
              ['服务地址', 'baseUrl'],
              ['服务器密钥环境变量名（不填写实际密钥）', 'credentialEnv'],
            ].map(([label, key]) => (
              <label className="prd-label" key={key}>
                {label}
                <input
                  className="prd-input"
                  value={String(form[key as keyof ApiPoolItem])}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </label>
            ))}
            <label className="prd-label">
              服务类型
              <select
                className="prd-input"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as 'llm' | 'teacher' })}
              >
                <option value="llm">大模型评测</option>
                <option value="teacher">教师模型</option>
              </select>
            </label>
            <label className="prd-check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="prd-check">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
              />
              默认配置
            </label>
            <label className="prd-label full">
              固定模型参数（JSON，不含密钥）
              <textarea
                className="prd-input"
                rows={6}
                value={parameters}
                onChange={(e) => setParameters(e.target.value)}
              />
            </label>
          </div>
          <div className="prd-toolbar">
            <button className="prd-button primary" disabled={busy} onClick={save}>
              {busy ? '保存中…' : '保存配置'}
            </button>
            <button className="prd-button" disabled={busy} onClick={() => setForm(null)}>
              取消
            </button>
          </div>
        </section>
      )}
      <section className="prd-panel prd-table-wrap">
        <table className="prd-table">
          <thead>
            <tr>
              <th>配置</th>
              <th>用途</th>
              <th>模型 / 精确版本</th>
              <th>配置版本</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  {item.isDefault && <span className="prd-badge">默认</span>}
                </td>
                <td>{item.kind === 'llm' ? '大模型评测' : '教师服务'}</td>
                <td>
                  {item.model}
                  <br />
                  {item.modelVersion}
                </td>
                <td>{item.revision}</td>
                <td>{item.enabled ? '可用' : '停用'}</td>
                <td>
                  <button className="prd-button" onClick={() => edit(item, true)}>
                    编辑
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={6}>暂无平台 API 配置。</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
