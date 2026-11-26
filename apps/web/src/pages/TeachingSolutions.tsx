import { displayQuestionTitle } from '../lib/questionPresentation'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, getAuthToken } from '../lib/api'
import {
  questionSolutionsApi,
  readSolutionFile,
  type QuestionSolution,
  type TeachingQuestion,
  type TeachingSolution,
  type TeachingSolutionsPage,
} from '../lib/questionSolutions'
import { SolutionCards } from './QuestionSolutions'

type Draft = {
  token: string | null
  question: TeachingQuestion
  id?: string
  updatedAt?: string
  published: boolean
  title: string
  explanation: string
  code: string
  referenceKind: NonNullable<QuestionSolution['referenceKind']>
}
const referenceNames = {
  same_role: '同角色参考实现',
  opponent: '对手参考',
  qualification: '资格基线学习说明',
}
function previewCard(draft: Draft): QuestionSolution {
  return {
    id: draft.id ?? 'preview',
    title: draft.title,
    explanation: draft.explanation,
    code: draft.code,
    kind: 'standard',
    author: '我的教师讲解',
    questionVersion: draft.question.revision,
    source: 'manual',
    referenceKind: draft.referenceKind,
    actualEvaluationReference: false,
    score: null,
    updating: false,
    emptyPool: false,
    needsModelAttachment: false,
    canWithdraw: false,
    notice: '教师手工学习参考，不代表当前线上实际评测实现或资格基线。模型权重不会公开。',
    createdAt: new Date().toISOString(),
    sourceCreatedAt: null,
  }
}

export default function TeachingSolutions() {
  const token = getAuthToken()
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const scope = useRef({ token, mounted: true, read: 0, editor: 0, busy: false })
  if (scope.current.token !== token) scope.current = { token, mounted: true, read: 0, editor: 0, busy: false }
  const current = scope.current
  const isCurrent = () => scope.current === current && current.mounted && current.token === getAuthToken()
  const [result, setResult] = useState<{ token: string | null; page: TeachingSolutionsPage } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState(false)
  const [consent, setConsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [reload, setReload] = useState(0)
  const [viewToken, setViewToken] = useState(token)
  const sameAccount = viewToken === token
  const data = result?.token === token ? result.page : null
  const editor = draft?.token === token ? draft : null
  const currentQuestion = data?.questions.find((q) => q.id === editor?.question.id)
  const stale = !!editor && (!currentQuestion || currentQuestion.revision !== editor.question.revision)

  useEffect(() => {
    current.mounted = true
    setViewToken(token)
    setResult(null)
    setDraft(null)
    setPreview(false)
    setConsent(false)
    setError('')
    setNotice('')
    setBusy(false)
    setFileLoading(false)
    setSearchInput('')
    setSearch('')
    setPageNumber(1)
    return () => {
      current.mounted = false
    }
  }, [token])
  useEffect(() => {
    const version = ++current.read
    let active = true
    setLoading(true)
    setError('')
    questionSolutionsApi
      .mine(search, pageNumber)
      .then((page) => {
        if (active && isCurrent() && current.read === version) setResult({ token, page })
      })
      .catch((reason) => {
        if (active && isCurrent() && current.read === version) fail(reason)
      })
      .finally(() => {
        if (active && isCurrent() && current.read === version) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [token, search, pageNumber, reload])

  function fail(reason: unknown) {
    if (!isCurrent()) return
    setError(reason instanceof Error ? reason.message : '讲解操作失败，请重试')
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) {
      current.read++
      current.editor++
      setResult(null)
      setDraft(null)
      setPreview(false)
      setConsent(false)
      setFileLoading(false)
      setLoading(false)
    }
  }
  function refresh() {
    if (!isCurrent()) return
    current.read++
    setReload((n) => n + 1)
  }
  function choose(next: Draft | null) {
    if (!isCurrent() || current.busy) return
    current.editor++
    setDraft(next)
    setPreview(false)
    setConsent(false)
    setFileLoading(false)
    setError('')
    setNotice('')
  }
  function edit(row: TeachingSolution, readonly = false) {
    if (!row.question || !isCurrent() || current.busy) return
    choose({
      token,
      question: { ...row.question, revision: row.questionVersion },
      id: row.id,
      updatedAt: row.updatedAt,
      published: row.published,
      title: row.title,
      explanation: row.explanation,
      code: row.code,
      referenceKind: row.referenceKind ?? 'same_role',
    })
    if (readonly) setPreview(true)
    if (editorHeading.current)
      requestAnimationFrame(() => {
        editorHeading.current?.focus({ preventScroll: true })
        editorHeading.current?.scrollIntoView({ block: 'start' })
      })
  }
  function change(key: 'title' | 'explanation' | 'code' | 'referenceKind', value: string) {
    if (!isCurrent() || current.busy) return
    current.editor++
    setDraft((valueBefore) => (valueBefore ? { ...valueBefore, [key]: value } : null))
    setFileLoading(false)
    setConsent(false)
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!isCurrent() || current.busy || fileLoading || !editor || !data) return
    if (stale) {
      setError('题目版本已变化，请选择当前题目重新编写讲解。')
      return
    }
    if (!preview || !consent) {
      setError('请预览讲解并确认全站公开范围。')
      return
    }
    if (!editor.title.trim() || (!editor.explanation.trim() && !editor.code.trim())) {
      setError('请填写标题及说明或代码。')
      return
    }
    if (new TextEncoder().encode(editor.title + editor.explanation + editor.code).byteLength > 256 * 1024) {
      setError('讲解文本合计不能超过 256 KiB')
      return
    }
    current.busy = true
    current.read++
    setBusy(true)
    setLoading(false)
    setError('')
    setNotice('')
    try {
      const content = { title: editor.title, explanation: editor.explanation, code: editor.code }
      if (editor.id)
        await questionSolutionsApi.update(editor.id, {
          ...content,
          published: true,
          expectedUpdatedAt: editor.updatedAt,
        })
      else
        await questionSolutionsApi.publish(editor.question.id, {
          ...content,
          kind: 'standard',
          referenceKind: editor.referenceKind,
          questionVersion: editor.question.revision,
        })
      if (!isCurrent()) return
      current.editor++
      setDraft(null)
      setPreview(false)
      setConsent(false)
      setNotice('讲解已发布，全站已登录用户可见。')
      refresh()
    } catch (reason) {
      fail(reason)
      if (isCurrent() && reason instanceof ApiError && reason.status === 409) setConsent(false)
    } finally {
      if (isCurrent()) {
        current.busy = false
        setBusy(false)
      }
    }
  }
  async function withdraw(row: TeachingSolution) {
    if (!isCurrent() || current.busy) return
    current.busy = true
    current.read++
    setBusy(true)
    setLoading(false)
    setError('')
    setNotice('')
    try {
      await questionSolutionsApi.withdraw(row.id)
      if (!isCurrent()) return
      setResult((value) =>
        value
          ? {
              ...value,
              page: {
                ...value.page,
                items: value.page.items.map((item) =>
                  item.id === row.id ? { ...item, published: false } : item,
                ),
              },
            }
          : null,
      )
      if (editor?.id === row.id) {
        current.editor++
        setDraft(null)
        setPreview(false)
        setConsent(false)
      }
      setNotice('已撤回公开，可编辑后重新发布。')
      refresh()
    } catch (reason) {
      fail(reason)
    } finally {
      if (isCurrent()) {
        current.busy = false
        setBusy(false)
      }
    }
  }

  return (
    <main className="prd-page teaching-solutions">
      <header className="teaching-solutions-heading">
        <div>
          <h1>我的讲解</h1>
        </div>
        <div className="teaching-solutions-actions">
          {data && (
            <a className="prd-button primary lecture-editor-jump" href="#lecture-editor-heading">
              前往讲解编辑区
            </a>
          )}
          <Link className="prd-button" to="/teaching">
            返回班级管理
          </Link>
        </div>
      </header>
      <aside className="teaching-solutions-scope" aria-label="发布范围">
        <strong>发布后，全站已登录用户可见。</strong>
        <p>教师讲解用于学习参考，不会替换实际评测基线。</p>
      </aside>
      {sameAccount && error && (
        <p className="prd-error" role="alert">
          {error}
        </p>
      )}
      {sameAccount && notice && <p role="status">{notice}</p>}
      <div className="teaching-solutions-toolbar">
        <form
          aria-label="搜索我的讲解"
          onSubmit={(e) => {
            e.preventDefault()
            if (isCurrent() && !current.busy) {
              setSearch(searchInput.trim())
              setPageNumber(1)
              refresh()
            }
          }}
        >
          <label>
            搜索我的讲解
            <input
              name="search"
              value={sameAccount ? searchInput : ''}
              maxLength={100}
              disabled={busy}
              placeholder="讲解标题或题目名称"
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </label>
          <button className="prd-button" disabled={busy}>
            搜索
          </button>
        </form>
        <button className="prd-button" disabled={busy || loading} onClick={refresh}>
          刷新讲解
        </button>
      </div>
      {loading && <p role="status">正在加载我的讲解…</p>}
      {data && (
        <div className="teaching-solutions-layout">
          <section aria-label="我的讲解列表" className="teaching-solutions-list">
            <h2>
              已创建讲解 <small>({data.pagination.total})</small>
            </h2>
            {!data.items.length && (
              <p className="prd-muted">暂无符合条件的讲解。选择已发布题目即可新建讲解。</p>
            )}
            {data.items.map((row) => (
              <article className="prd-card teaching-solutions-item" key={row.id}>
                <h3>{row.title}</h3>
                <p>
                  {row.question ? displayQuestionTitle(row.question) : '题目已不可用'} · 版本 {row.questionVersion}
                </p>
                <p className="prd-muted">
                  {row.published
                    ? row.canEdit
                      ? '已公开 · 全站已登录用户可见'
                      : '旧版本或题目未发布 · 当前题解页不展示'
                    : '已撤回 · 不公开'}
                </p>
                {!row.canEdit && (
                  <p className="prd-muted">旧版本或不可用题目只能预览、撤回；请为当前题目新建讲解。</p>
                )}
                <div className="teaching-solutions-actions">
                  <button
                    className="prd-button"
                    disabled={busy || !row.question}
                    onClick={() => edit(row, true)}
                  >
                    预览
                  </button>
                  {row.canEdit && (
                    <button className="prd-button" disabled={busy} onClick={() => edit(row)}>
                      {row.published ? '编辑讲解' : '编辑并重新发布'}
                    </button>
                  )}
                  {row.published && (
                    <button className="prd-button" disabled={busy} onClick={() => withdraw(row)}>
                      撤回公开
                    </button>
                  )}
                </div>
                {row.canEdit && row.published && (
                  <Link to={`/question/${encodeURIComponent(row.questionId)}/solutions`}>
                    查看题目公开题解
                  </Link>
                )}
              </article>
            ))}
            <nav className="teaching-solutions-actions" aria-label="我的讲解分页">
              <button
                className="prd-button"
                disabled={busy || loading || data.pagination.page <= 1}
                onClick={() => setPageNumber((n) => n - 1)}
              >
                上一页
              </button>
              <span>
                {data.pagination.page} / {Math.max(1, data.pagination.totalPages)}
              </span>
              <button
                className="prd-button"
                disabled={busy || loading || data.pagination.page >= data.pagination.totalPages}
                onClick={() => setPageNumber((n) => n + 1)}
              >
                下一页
              </button>
            </nav>
          </section>
          <section className="prd-card teaching-solutions-editor" aria-label="讲解创作">
            <h2 id="lecture-editor-heading" ref={editorHeading} tabIndex={-1}>
              {editor?.id ? '查看与编辑讲解' : '新建教师讲解'}
            </h2>
            <label>
              选择已发布题目
              <select
                name="question"
                value={editor?.id ? '' : (editor?.question.id ?? '')}
                disabled={busy}
                onChange={(e) => {
                  const q = data.questions.find((item) => item.id === e.target.value)
                  choose(
                    q
                      ? {
                          token,
                          question: q,
                          published: false,
                          title: '',
                          explanation: '',
                          code: '',
                          referenceKind: 'same_role',
                        }
                      : null,
                  )
                }}
              >
                <option value="">请选择题目以新建讲解</option>
                {data.questions.map((q) => (
                  <option key={q.id} value={q.id}>
                    {displayQuestionTitle(q)} · 版本 {q.revision} · {q.category === 'basic' ? '基础题' : '攻防题'}
                  </option>
                ))}
              </select>
            </label>
            <p className="prd-muted">草稿仅保留在当前页面；切换题目或讲解会替换未发布草稿。</p>
            {editor && (
              <form aria-label="讲解编辑器" onSubmit={publish}>
                <p>
                  <strong>{displayQuestionTitle(editor.question)}</strong> · 版本 {editor.question.revision}
                </p>
                {stale && (
                  <p role="alert">题目版本已变化或未发布。当前讲解仅可预览，请选择当前已发布题目新建讲解。</p>
                )}
                {preview ? (
                  <>
                    <h3>讲解预览</h3>
                    <SolutionCards
                      rows={[previewCard(editor)]}
                      kind="standard"
                      busyId=""
                      onWithdraw={() => {}}
                    />
                    {!stale && (
                      <button
                        type="button"
                        className="prd-button"
                        disabled={busy}
                        onClick={() => {
                          setPreview(false)
                          setConsent(false)
                        }}
                      >
                        返回编辑
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <label>
                      标题
                      <input
                        name="title"
                        required
                        maxLength={120}
                        disabled={busy || stale}
                        value={editor.title}
                        onChange={(e) => change('title', e.target.value)}
                      />
                    </label>
                    <label>
                      参考用途
                      <select
                        name="referenceKind"
                        value={editor.referenceKind}
                        disabled={busy || !!editor.id || stale}
                        onChange={(e) => change('referenceKind', e.target.value)}
                      >
                        {Object.entries(referenceNames).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      说明（支持 Markdown）
                      <textarea
                        name="explanation"
                        rows={8}
                        disabled={busy || stale}
                        value={editor.explanation}
                        onChange={(e) => change('explanation', e.target.value)}
                      />
                    </label>
                    <label>
                      上传 UTF-8 文本源代码（最多 256 KiB）
                      <input
                        name="file"
                        type="file"
                        accept=".py,.js,.ts,.java,.go,.rs,.c,.cpp,.h,.txt,.md,.json,.yaml,.yml"
                        disabled={busy || fileLoading || stale}
                        onChange={async (e) => {
                          const file = e.target.files?.[0]
                          e.target.value = ''
                          if (!file || !isCurrent() || current.busy || fileLoading) return
                          const version = ++current.editor
                          setFileLoading(true)
                          setConsent(false)
                          setError('')
                          try {
                            const code = await readSolutionFile(file)
                            if (isCurrent() && version === current.editor)
                              setDraft((value) => (value ? { ...value, code } : null))
                          } catch (reason) {
                            if (isCurrent() && version === current.editor) fail(reason)
                          } finally {
                            if (isCurrent() && version === current.editor) setFileLoading(false)
                          }
                        }}
                      />
                    </label>
                    <label>
                      代码
                      <textarea
                        name="code"
                        rows={10}
                        spellCheck={false}
                        disabled={busy || fileLoading || stale}
                        value={editor.code}
                        onChange={(e) => change('code', e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="prd-button"
                      disabled={busy || fileLoading || stale}
                      onClick={() => {
                        setPreview(true)
                        setConsent(false)
                      }}
                    >
                      预览讲解
                    </button>
                  </>
                )}
                {preview && !stale && (
                  <>
                    <p className="teaching-solutions-publish-note">
                      {editor.published ? '确认后会立即更新公开内容。' : '确认后会立即公开。'}
                      全站已登录用户可见，不限本班级。
                    </p>
                    <label className="teaching-solutions-consent">
                      <input
                        name="consent"
                        type="checkbox"
                        checked={consent}
                        disabled={busy}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      我确认公开以上说明和代码，已检查不含密钥或私人信息。
                    </label>
                    <button className="prd-button primary" disabled={busy || fileLoading || !consent}>
                      {busy ? '正在发布…' : editor.published ? '确认更新公开讲解' : '确认发布讲解'}
                    </button>
                  </>
                )}
              </form>
            )}
          </section>
        </div>
      )}
    </main>
  )
}
