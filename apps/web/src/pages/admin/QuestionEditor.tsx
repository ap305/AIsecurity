import { useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost, apiPostMultipart, apiPut } from '../../lib/api'
import {
  defaultDefinition,
  normalizeQuestion,
  questionDefinitionErrors,
  type HallCategory,
  type QuestionRecord,
} from '../../lib/prdApi'
import QuestionDefinitionEditor from '../../components/QuestionDefinitionEditor'

interface Resource {
  filename: string
  sizeLabel: string
}
function newQuestion(): QuestionRecord {
  return {
    id: '',
    title: '',
    content: '',
    category: 'basic',
    moduleCode: 'GENERAL',
    number: 1,
    type: 'C',
    difficulty: 'L1',
    status: 'draft',
    answerTemplate: '',
    revision: 1,
    definition: defaultDefinition(),
  }
}
export default function QuestionEditor() {
  const [questions, setQuestions] = useState<QuestionRecord[]>([])
  const [form, setForm] = useState<QuestionRecord | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [original, setOriginal] = useState<QuestionRecord | null>(null)
  const [resources, setResources] = useState<Resource[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [definitionValid, setDefinitionValid] = useState(true)
  const load = async () => {
    setLoading(true)
    try {
      setQuestions((await apiGet<QuestionRecord[]>('/admin/questions')).map(normalizeQuestion))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '题目加载失败。')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  const edit = async (question: QuestionRecord) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const detail = normalizeQuestion(
        await apiGet<QuestionRecord>(`/admin/questions/${encodeURIComponent(question.id)}`),
      )
      setForm(detail)
      setOriginal(detail)
      setEditingId(detail.id)
      setDefinitionValid(true)
      setResources(
        await apiGet<Resource[]>(`/questions/${encodeURIComponent(detail.id)}/resources`).catch(() => []),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '题目详情加载失败。')
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!form || busy) return
    if (!form.id.trim() || !form.title.trim() || !form.content?.trim()) {
      setError('题目 ID、标题和 Markdown 题面为必填项。')
      return
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(form.id)) {
      setError('题目 ID 仅支持字母、数字、下划线和连字符。')
      return
    }
    if (!definitionValid) {
      setError('请先修正评测参数 JSON。')
      return
    }
    const configErrors = questionDefinitionErrors(form.definition, form.category as HallCategory)
    if (form.status === 'published' && configErrors.length) {
      setError(configErrors.join(' '))
      return
    }
    if (
      original?.status === 'published' &&
      original.category === 'basic' &&
      form.status === 'published' &&
      !window.confirm(
        '修改已发布基础题的内容或评测配置会清零该题当前计入成绩，历史记录保留审计。建议另建新题。确认保存？',
      )
    )
      return
    setBusy(true)
    setError('')
    setMessage('')
    const payload = {
      id: form.id.trim(),
      title: form.title.trim(),
      content: form.content,
      moduleCode: form.moduleCode || 'GENERAL',
      number: Number(form.number || 1),
      type: form.category === 'adversarial' ? 'A/D' : form.type || 'C',
      difficulty: form.difficulty,
      category: form.category,
      status: form.status,
      answerTemplate: form.answerTemplate,
      solution: form.solution,
      definition: form.definition,
      role: form.category === 'adversarial' ? form.definition.role : null,
      scenarioId: form.category === 'adversarial' ? form.definition.scenarioId : null,
    }
    try {
      const result = normalizeQuestion(
        editingId
          ? await apiPut<QuestionRecord>(`/admin/questions/${encodeURIComponent(editingId)}`, payload)
          : await apiPost<QuestionRecord>('/admin/questions', payload),
      )
      setForm(result)
      setOriginal(result)
      setEditingId(result.id)
      setMessage(`题目已保存，当前版本 ${result.revision}。`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '题目保存失败。')
    } finally {
      setBusy(false)
    }
  }
  const archive = async (question: QuestionRecord) => {
    if (!window.confirm(`将“${question.title}”下架并保留历史记录？`)) return
    setBusy(true)
    try {
      await apiDelete(`/admin/questions/${encodeURIComponent(question.id)}`)
      await load()
      setMessage('题目已下架，历史记录保留。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '下架失败。')
    } finally {
      setBusy(false)
    }
  }
  const uploadResources = async (files: FileList | null) => {
    if (!editingId || !files?.length) return
    setBusy(true)
    try {
      const body = new FormData()
      Array.from(files).forEach((file) => body.append('files', file))
      setResources(
        await apiPostMultipart<Resource[]>(
          `/admin/questions/${encodeURIComponent(editingId)}/resources`,
          body,
        ),
      )
      setMessage('公开资源已上传。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '资源上传失败。')
    } finally {
      setBusy(false)
    }
  }
  const patch = (values: Partial<QuestionRecord>) =>
    setForm((current) => (current ? { ...current, ...values } : null))
  return (
    <div className="prd-page">
      <div className="prd-split">
        <div>
          <h1>题目管理</h1>
          <p className="prd-muted">
            配置题面、提交能力、独立评测环境与评分规则。攻击和防御分别创建题目，共用攻防关联标识。
          </p>
        </div>
        <button
          className="prd-button primary"
          disabled={busy}
          onClick={() => {
            setForm(newQuestion())
            setOriginal(null)
            setEditingId(null)
            setResources([])
            setError('')
            setMessage('')
            setDefinitionValid(true)
          }}
        >
          新建题目
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
      {form ? (
        <section className="prd-panel">
          <div className="prd-split">
            <h2>{editingId ? `编辑 ${editingId}` : '创建题目'}</h2>
            <button className="prd-button" disabled={busy} onClick={() => setForm(null)}>
              返回题目列表
            </button>
          </div>
          {original?.status === 'published' && original.category === 'basic' && (
            <p className="prd-notice">
              已发布基础题发生变化后，当前计入分将清零；历史记录保留审计。优先使用新题目 ID 发布。
            </p>
          )}
          <div className="prd-grid">
            <label className="prd-label">
              题目 ID
              <input
                className="prd-input"
                disabled={!!editingId}
                value={form.id}
                onChange={(e) => patch({ id: e.target.value })}
              />
            </label>
            <label className="prd-label">
              标题
              <input
                className="prd-input"
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>
            <label className="prd-label">
              所属大厅
              <select
                className="prd-input"
                value={form.category}
                onChange={(e) => patch({ category: e.target.value as HallCategory })}
              >
                <option value="basic">基础任务大厅</option>
                <option value="adversarial">对战大厅</option>
              </select>
            </label>
            <label className="prd-label">
              难度
              <select
                className="prd-input"
                value={form.difficulty}
                onChange={(e) => patch({ difficulty: e.target.value })}
              >
                <option value="L1">入门</option>
                <option value="L2">进阶</option>
                <option value="L3">挑战</option>
              </select>
            </label>
            <label className="prd-label">
              知识领域（兼容已有模块）
              <input
                className="prd-input"
                value={form.moduleCode ?? 'GENERAL'}
                onChange={(e) => patch({ moduleCode: e.target.value })}
              />
            </label>
            <label className="prd-label">
              题号
              <input
                className="prd-input"
                type="number"
                min={1}
                step={1}
                value={form.number ?? 1}
                onChange={(e) => patch({ number: Number(e.target.value) })}
              />
            </label>
            <label className="prd-label">
              发布状态
              <select
                className="prd-input"
                value={form.status}
                onChange={(e) => patch({ status: e.target.value })}
              >
                <option value="draft">草稿</option>
                <option value="review">审核中</option>
                <option value="published">发布</option>
                <option value="archived">下架</option>
              </select>
            </label>
            <label className="prd-label">
              作答内容类型
              <select
                className="prd-input"
                value={form.type}
                onChange={(e) => patch({ type: e.target.value })}
              >
                <option value="C">代码填空</option>
                <option value="T+C">理论与代码</option>
                <option value="T">Markdown 作答（旧题兼容）</option>
                {form.category === 'adversarial' && <option value="A/D">攻防代码</option>}
              </select>
            </label>
            <label className="prd-label full">
              题面（Markdown）
              <textarea
                className="prd-input"
                rows={10}
                value={form.content ?? ''}
                onChange={(e) => patch({ content: e.target.value })}
              />
            </label>
            <label className="prd-label full">
              学生初始代码 / 填空模板
              <textarea
                className="prd-input"
                rows={8}
                value={form.answerTemplate ?? ''}
                onChange={(e) => patch({ answerTemplate: e.target.value })}
              />
            </label>
            <label className="prd-label full">
              管理员参考答案（不向学生公开）
              <textarea
                className="prd-input"
                rows={5}
                value={form.solution ?? ''}
                onChange={(e) => patch({ solution: e.target.value })}
              />
            </label>
          </div>
          <QuestionDefinitionEditor
            key={editingId ?? '__new__'}
            value={form.definition}
            onChange={(definition) => patch({ definition })}
            category={form.category as HallCategory}
            onValidityChange={setDefinitionValid}
          />
          {editingId && (
            <section className="prd-section">
              <h2>公开补充资源</h2>
              <p className="prd-muted">
                题面在页面直接显示。资源可作为补充材料；不得上传隐藏测试数据、基线答案或平台密钥。
              </p>
              <input
                type="file"
                multiple
                disabled={busy}
                onChange={(e) => void uploadResources(e.target.files)}
              />
              <ul>
                {resources.map((resource) => (
                  <li key={resource.filename}>
                    <a
                      href={`/api/questions/${encodeURIComponent(editingId)}/resources/${encodeURIComponent(resource.filename)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {resource.filename}
                    </a>{' '}
                    · {resource.sizeLabel}
                    <button
                      className="prd-button danger"
                      disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`删除公开资源 ${resource.filename}？`)) return
                        try {
                          setResources(
                            await apiDelete<Resource[]>(
                              `/admin/questions/${encodeURIComponent(editingId)}/resources/${encodeURIComponent(resource.filename)}`,
                            ),
                          )
                        } catch (err) {
                          setError(err instanceof Error ? err.message : '删除失败。')
                        }
                      }}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="prd-toolbar">
            <button className="prd-button primary" disabled={busy || !definitionValid} onClick={save}>
              {busy ? '正在保存…' : form.status === 'published' ? '保存并发布' : '保存草稿 / 状态'}
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="prd-toolbar">
            <input
              className="prd-input"
              aria-label="搜索管理题目"
              placeholder="搜索题名或 ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="prd-button" onClick={() => void load()}>
              刷新列表
            </button>
          </div>
          <div className="prd-panel prd-table-wrap">
            {loading ? (
              <div className="prd-loading">正在加载题目…</div>
            ) : (
              <table className="prd-table">
                <thead>
                  <tr>
                    <th>ID / 题名</th>
                    <th>大厅 / 角色</th>
                    <th>状态</th>
                    <th>版本</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {questions
                    .filter((q) => `${q.id} ${q.title}`.toLowerCase().includes(search.toLowerCase()))
                    .map((q) => (
                      <tr key={q.id}>
                        <td>
                          {q.id}
                          <br />
                          {q.title}
                        </td>
                        <td>
                          {q.category === 'basic'
                            ? '基础'
                            : q.definition.role === 'attack'
                              ? '攻击'
                              : q.definition.role === 'defense'
                                ? '防御'
                                : '角色未配置'}
                        </td>
                        <td>{q.status}</td>
                        <td>{q.revision}</td>
                        <td>
                          <button className="prd-button" disabled={busy} onClick={() => void edit(q)}>
                            完整配置
                          </button>{' '}
                          <button
                            className="prd-button danger"
                            disabled={busy || q.status === 'archived'}
                            onClick={() => void archive(q)}
                          >
                            下架
                          </button>
                        </td>
                      </tr>
                    ))}
                  {!questions.length && (
                    <tr>
                      <td colSpan={5}>暂无题目，请创建草稿。</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
