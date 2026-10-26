import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import './SolveQuestion.css'
import { useAuth } from '../contexts/AuthContext'
import { apiGet } from '../lib/api'
import {
  groupResources,
  isPublicResource,
  resourceSize,
  type QuestionResource,
} from '../lib/questionResources'
import TeacherLeasePanel from '../components/TeacherLeasePanel'
import ArenaTeachingBriefing from '../components/ArenaTeachingBriefing'
import LegacyUploadHistory from '../components/LegacyUploadHistory'
import SubmissionDiagnostics from '../components/SubmissionDiagnostics'
import {
  draftStorageKey,
  editorLanguage,
  publicMetrics,
  submissionPhaseLabel,
  hallReturnLocation,
  createLatestRequest,
} from './solveWorkbench'
import {
  dynamicSummary,
  isTerminal,
  parsedResult,
  prdApi,
  submitMaterials,
  validateMaterial,
  type CurrentDynamicScore,
  type QuestionRecord,
  type SubmissionRecord,
} from '../lib/prdApi'

const CodeEditor = lazy(() => import('../components/CodeEditor'))
function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeWrite(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
function idempotencyKey(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('')
}

function QuestionResources({ questionId }: { questionId: string }) {
  const [resources, setResources] = useState<QuestionResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setResources([])
    setError('')
    apiGet<unknown>(`/questions/${encodeURIComponent(questionId)}/resources`)
      .then((data) => {
        if (!Array.isArray(data)) throw new Error('资料列表格式异常。')
        if (active) setResources(data.filter(isPublicResource))
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : '资料列表加载失败。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [questionId, attempt])
  if (!loading && !error && resources.length === 0)
    return <p className="solve-empty">本题暂无补充资料，请直接阅读题面中的说明和代码模板。</p>
  return (
    <section className="solve-resources" aria-label="题目资料下载">
      <h3>资料下载</h3>
      <p className="prd-muted">附件按用途分类。优先阅读说明、下载模板和实验包；配图可展开查看。</p>
      {loading && (
        <p className="prd-muted" role="status">
          正在加载资料…
        </p>
      )}
      {error && (
        <div className="prd-error" role="alert">
          {error}{' '}
          <button className="prd-button" onClick={() => setAttempt((value) => value + 1)}>
            重新加载资料
          </button>
        </div>
      )}
      {groupResources(resources).map((group) => {
        const links = (
          <ul className="solve-resource-list">
            {group.resources.map((resource) => (
              <li key={resource.filename}>
                <a
                  className="solve-resource-link"
                  href={`/api/questions/${encodeURIComponent(questionId)}/resources/${encodeURIComponent(resource.filename)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={resource.filename}
                >
                  <span className="solve-resource-name">{resource.filename}</span>
                  <span className="solve-resource-size">{resourceSize(resource.size)}</span>
                  <span className="solve-resource-action">下载</span>
                </a>
              </li>
            ))}
          </ul>
        )
        return group.kind === 'image' ? (
          <details className="solve-resource-group" key={group.kind}>
            <summary>
              {group.label} <span>({group.resources.length})</span>
            </summary>
            <p className="prd-muted">{group.hint}</p>
            {links}
          </details>
        ) : (
          <section className="solve-resource-group" key={group.kind} aria-label={group.label}>
            <h4>
              {group.label} <span>({group.resources.length})</span>
            </h4>
            <p className="prd-muted">{group.hint}</p>
            {links}
          </section>
        )
      })}
    </section>
  )
}

export default function SolveQuestion() {
  const { questionId = '' } = useParams<{ questionId: string }>()
  const location = useLocation()
  const { user } = useAuth()
  const [question, setQuestion] = useState<QuestionRecord | null>(null)
  const [code, setCode] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [history, setHistory] = useState<SubmissionRecord[]>([])
  const [historyError, setHistoryError] = useState('')
  const [submission, setSubmission] = useState<SubmissionRecord | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [currentScore, setCurrentScore] = useState<CurrentDynamicScore | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [saved, setSaved] = useState(false)
  const [draftError, setDraftError] = useState(false)
  const [leftTab, setLeftTab] = useState<'description' | 'resources' | 'history'>('description')
  const [mobilePane, setMobilePane] = useState<'question' | 'code'>('question')
  const [toolPanel, setToolPanel] = useState<'materials' | 'teacher' | null>(null)
  const [resultOpen, setResultOpen] = useState(false)
  const [resultTab, setResultTab] = useState<'current' | 'history' | 'score'>('current')
  const [inspectedSubmission, setInspectedSubmission] = useState<SubmissionRecord | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const inspectionRequest = useRef(createLatestRequest())
  const editorPanel = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const draftContext = useRef<string | null>(null)
  const [reload, setReload] = useState(0)
  const requestIdentity = useRef<{ signature: string; key: string } | null>(null)
  const scopeIdentity = user?.id + '::' + questionId
  const requestContextRef = useRef({ identity: scopeIdentity })
  // A fresh object also rejects old A responses after navigating A → B → A.
  if (requestContextRef.current.identity !== scopeIdentity)
    requestContextRef.current = { identity: scopeIdentity }
  const requestContext = requestContextRef.current
  const draftKey = draftStorageKey(user?.id, questionId, question?.revision ?? 1)
  const taskKey = `prd_submission_${user?.id ?? 'unknown'}_${questionId}`
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setQuestion(null)
    setError('')
    setHistoryError('')
    setHistory([])
    setSubmission(null)
    setActiveId(null)
    setCurrentScore(null)
    setFile(null)
    setLeftTab('description')
    setToolPanel(null)
    setResultOpen(false)
    setResultTab('current')
    setInspectedSubmission(null)
    setHistoryLoading(false)
    inspectionRequest.current.invalidate()
    setSaved(false)
    setDraftError(false)
    draftContext.current = null
    setUploading(false)
    requestIdentity.current = null
    prdApi
      .question(questionId)
      .then((q) => {
        if (!stopped) {
          setQuestion(q)
          draftContext.current = draftStorageKey(user?.id, questionId, q.revision)
          setCode(safeRead(draftContext.current) ?? q.answerTemplate ?? '')
          const restoredTask = safeRead(taskKey)
          setActiveId(restoredTask)
          if (restoredTask) setResultOpen(true)
          if (q.category === 'adversarial')
            void prdApi
              .arenaScore(questionId)
              .then((value) => {
                if (!stopped) setCurrentScore(value)
              })
              .catch(() => {})
        }
      })
      .catch((err) => {
        if (!stopped) setError(err instanceof Error ? err.message : '题目加载失败。')
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    prdApi
      .history(questionId)
      .then((items) => {
        if (!stopped) setHistory(items)
      })
      .catch((err) => {
        if (!stopped) setHistoryError(err instanceof Error ? err.message : '历史提交加载失败。')
      })
    return () => {
      stopped = true
    }
  }, [questionId, user?.id, reload, taskKey])
  useEffect(() => {
    if (!question || question.id !== questionId || draftContext.current !== draftKey) return
    const save = () => {
      const stored = safeWrite(draftKey, code)
      setSaved(stored)
      setDraftError(!stored)
    }
    const timer = setTimeout(save, 600)
    const flush = () => {
      safeWrite(draftKey, code)
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [code, draftKey, question, questionId])
  useEffect(() => {
    if (!activeId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const item = await prdApi.submission(activeId)
        if (stopped) return
        setSubmission(item)
        setError('')
        if (isTerminal(item.status)) {
          setResultOpen(true)
          safeWrite(taskKey, null)
          setActiveId(null)
          void prdApi
            .history(questionId)
            .then((items) => {
              if (requestContextRef.current === requestContext) setHistory(items)
            })
            .catch((err) => {
              if (requestContextRef.current === requestContext)
                setHistoryError(err instanceof Error ? err.message : '历史提交刷新失败。')
            })
          if (question?.category === 'adversarial')
            void prdApi
              .arenaScore(questionId)
              .then((score) => {
                if (requestContextRef.current === requestContext) setCurrentScore(score)
              })
              .catch(() => {})
          return
        }
        timer = setTimeout(poll, 2000)
      } catch (err) {
        if (!stopped) {
          setError(`进度查询暂不可用：${err instanceof Error ? err.message : '连接中断'}。系统将继续重试。`)
          timer = setTimeout(poll, 5000)
        }
      }
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [activeId, questionId, taskKey, question?.category, requestContext])
  useEffect(() => {
    if (question?.category !== 'adversarial') return
    let stopped = false
    const timer = setInterval(() => {
      void prdApi
        .arenaScore(questionId)
        .then((score) => {
          if (!stopped) setCurrentScore(score)
        })
        .catch(() => {})
    }, 15000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [questionId, question?.category])
  const submit = async () => {
    if (!question || uploading || activeId) return
    const invalid = validateMaterial(question.definition, code, file)
    if (invalid) {
      setError(invalid)
      if (question.definition.weights.required && !file) setToolPanel('materials')
      return
    }
    const signature = `${question.id}\n${question.revision}\n${code}\n${file ? `${file.name}:${file.size}:${file.lastModified}` : ''}`
    if (requestIdentity.current?.signature !== signature)
      requestIdentity.current = { signature, key: idempotencyKey() }
    const body = new FormData()
    body.append('questionId', question.id)
    body.append('questionVersion', String(question.revision))
    body.append('code', code)
    body.append('idempotencyKey', requestIdentity.current.key)
    if (file) body.append('file', file)
    const submittedId = question.id
    setUploading(true)
    setProgress(0)
    setError('')
    setResultOpen(true)
    setResultTab('current')
    inspectionRequest.current.invalidate()
    setHistoryLoading(false)
    setMobilePane('code')
    try {
      const result = await submitMaterials(body, (value) => {
        if (requestContextRef.current === requestContext) setProgress(value)
      })
      safeWrite(taskKey, isTerminal(result.status) ? null : result.id)
      if (requestContextRef.current === requestContext) {
        setSubmission(result)
        setActiveId(isTerminal(result.status) ? null : result.id)
        requestIdentity.current = null
        void prdApi
          .history(submittedId)
          .then((records) => {
            if (requestContextRef.current === requestContext) setHistory(records)
          })
          .catch((err) => {
            if (requestContextRef.current === requestContext)
              setHistoryError(err instanceof Error ? err.message : '历史提交刷新失败。')
          })
        if (isTerminal(result.status) && question.category === 'adversarial')
          void prdApi
            .arenaScore(submittedId)
            .then((score) => {
              if (requestContextRef.current === requestContext) setCurrentScore(score)
            })
            .catch(() => {})
      }
    } catch (err) {
      if (requestContextRef.current === requestContext)
        setError(err instanceof Error ? err.message : '提交失败。')
    } finally {
      if (requestContextRef.current === requestContext) setUploading(false)
    }
  }
  if (loading) return <div className="prd-loading">正在加载题目…</div>
  if (!question)
    return (
      <div className="prd-error" role="alert">
        {error || '题目不可用。'}{' '}
        <button className="prd-button" onClick={() => setReload((v) => v + 1)}>
          重新加载
        </button>
      </div>
    )
  const adversarial = question.category === 'adversarial'
  const definition = question.definition
  const roleReady = !adversarial || !!definition.role
  const visibleSubmission = resultTab === 'history' ? inspectedSubmission : submission
  const focusCode = () => {
    setMobilePane('code')
    requestAnimationFrame(() => {
      editorPanel.current?.querySelector<HTMLElement>('.cm-content')?.focus()
    })
  }
  const openReview = () => {
    setResultOpen(true)
    setResultTab('current')
    inspectionRequest.current.invalidate()
    setHistoryLoading(false)
    setMobilePane('code')
  }
  const loadHistoricalCode = (item: SubmissionRecord) => {
    if (!item.code || !window.confirm('用这次提交的代码替换当前草稿？当前草稿会被覆盖。')) return
    setCode(item.code)
    setSaved(false)
    focusCode()
  }
  const refreshHistory = () => {
    const requestedQuestion = question.id
    void prdApi
      .history(requestedQuestion)
      .then((items) => {
        if (requestContextRef.current !== requestContext) return
        setHistory(items)
        setHistoryError('')
      })
      .catch((err) => {
        if (requestContextRef.current === requestContext)
          setHistoryError(err instanceof Error ? err.message : '历史查询失败。')
      })
  }
  const inspect = async (id: string) => {
    const request = inspectionRequest.current.next()
    setInspectedSubmission(null)
    setHistoryLoading(true)
    setHistoryError('')
    setResultTab('history')
    setResultOpen(true)
    setMobilePane('code')
    try {
      const item = await prdApi.submission(id)
      if (requestContextRef.current !== requestContext || !inspectionRequest.current.isCurrent(request))
        return
      setInspectedSubmission(item)
      setResultTab('history')
      setResultOpen(true)
      setMobilePane('code')
    } catch (err) {
      if (requestContextRef.current === requestContext && inspectionRequest.current.isCurrent(request))
        setHistoryError(err instanceof Error ? err.message : '详情加载失败。')
    } finally {
      if (requestContextRef.current === requestContext && inspectionRequest.current.isCurrent(request))
        setHistoryLoading(false)
    }
  }
  return (
    <div className="solve-workbench" data-mobile-pane={mobilePane}>
      <header className="solve-topbar">
        <div className="solve-heading">
          <Link
            className="solve-back"
            to={hallReturnLocation(location.state?.hallLocation, adversarial)}
            aria-label={'返回' + (adversarial ? '对战大厅' : '任务大厅')}
          >
            ← 题目列表
          </Link>
          <h1 title={question.title}>{question.title}</h1>
          <div className="solve-question-meta">
            <span>
              {adversarial
                ? definition.role === 'attack'
                  ? '攻击任务'
                  : definition.role === 'defense'
                    ? '防御任务'
                    : '角色未配置'
                : '基础题'}
            </span>
            <span>版本 {question.revision}</span>
            <span>
              {({ L1: '入门', L2: '进阶', L3: '挑战' } as Record<string, string>)[question.difficulty] ??
                question.difficulty}
            </span>
          </div>
        </div>
        <div className="solve-actions">
          {definition.weights.enabled && (
            <button
              className="prd-button"
              aria-expanded={toolPanel === 'materials'}
              aria-controls="solve-tools"
              onClick={() => setToolPanel(toolPanel === 'materials' ? null : 'materials')}
            >
              {file ? '已选参数文件' : definition.weights.required ? '上传参数（必需）' : '上传参数'}
            </button>
          )}
          {definition.teacherApi.enabled && (
            <button
              className="prd-button"
              aria-expanded={toolPanel === 'teacher'}
              aria-controls="solve-tools"
              onClick={() => setToolPanel(toolPanel === 'teacher' ? null : 'teacher')}
            >
              临时教师 API
            </button>
          )}
          <button
            className="prd-button primary"
            disabled={uploading || !!activeId || !roleReady}
            onClick={submit}
          >
            {uploading ? '上传 ' + progress + '%' : activeId ? '评测进行中…' : '提交评测'}
          </button>
        </div>
      </header>
      <div className="solve-workflow">
        <div className="solve-mobile-switch" aria-label="工作区切换">
          <button
            className="prd-button"
            aria-pressed={mobilePane === 'question'}
            onClick={() => setMobilePane('question')}
          >
            题面
          </button>
          <button className="prd-button" aria-pressed={mobilePane === 'code'} onClick={focusCode}>
            代码 / 结果
          </button>
        </div>
        {adversarial ? (
          <nav className="solve-stages" aria-label="攻防学习流程">
            <button
              onClick={() => {
                setLeftTab('description')
                setMobilePane('question')
              }}
            >
              1 简报
            </button>
            <span aria-hidden="true">›</span>
            <button onClick={focusCode}>2 对战</button>
            <span aria-hidden="true">›</span>
            <button onClick={openReview}>3 复盘</button>
          </nav>
        ) : (
          <span className="solve-evaluation-note">正式提交按题目规则评测计分；本题暂无独立样例试运行。</span>
        )}
        <button className="solve-live-status" onClick={openReview}>
          {activeId ? '● ' : ''}
          {submissionPhaseLabel(submission)}
          {submission?.score != null ? ' · ' + submission.score.toFixed(2) + (adversarial ? '%' : ' 分') : ''}
        </button>
      </div>
      {error && (
        <div className="solve-alert prd-error" role="alert">
          {error}
        </div>
      )}
      {draftError && (
        <p className="solve-alert prd-error" role="alert">
          浏览器无法保存草稿，请保留本地代码副本，避免刷新后丢失。
        </p>
      )}
      {!roleReady && (
        <div className="solve-alert prd-error">题目的固定角色尚未配置，暂不能提交。请联系题目管理员。</div>
      )}
      {uploading && (
        <div className="solve-upload-status" role="status">
          <label>
            材料上传 {progress}% <progress max={100} value={progress} />
          </label>
          {progress === 100 && <span>等待服务器受理…</span>}
        </div>
      )}
      {toolPanel && (
        <section
          className="solve-tools"
          id="solve-tools"
          aria-label={toolPanel === 'materials' ? '参数文件' : '教师 API'}
        >
          <button
            className="solve-tool-close prd-button"
            onClick={() => setToolPanel(null)}
            aria-label="收起操作面板"
          >
            收起
          </button>
          {toolPanel === 'materials' && definition.weights.enabled && (
            <div className="solve-materials">
              <label className="prd-label">
                参数文件{definition.weights.required ? '（必需）' : '（可选）'}
                <input
                  type="file"
                  ref={fileInput}
                  disabled={uploading}
                  accept={definition.weights.extensions
                    .map((ext) => (ext.startsWith('.') ? ext : '.' + ext))
                    .join(',')}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null)
                    setError('')
                  }}
                />
              </label>
              <p className="prd-muted">
                {definition.weights.extensions.join(' / ')} · 最大{' '}
                {(definition.weights.maxBytes / 1024 / 1024).toFixed(1)} MB
              </p>
              {file && (
                <p>
                  已选择：{file.name}（{resourceSize(file.size)}）{' '}
                  <button
                    className="prd-button"
                    disabled={uploading}
                    onClick={() => {
                      setFile(null)
                      if (fileInput.current) fileInput.current.value = ''
                    }}
                  >
                    移除
                  </button>
                </p>
              )}
              {definition.weights.description && (
                <p className="prd-muted">{definition.weights.description}</p>
              )}
              {definition.weights.modelStructure && (
                <p className="prd-muted">模型结构：{definition.weights.modelStructure}</p>
              )}
              {definition.weights.loadInterface && (
                <p className="prd-muted">加载接口：{definition.weights.loadInterface}</p>
              )}
              {definition.weights.device && (
                <p className="prd-muted">设备兼容：{definition.weights.device}</p>
              )}
            </div>
          )}
          {toolPanel === 'teacher' && definition.teacherApi.enabled && (
            <TeacherLeasePanel key={question.id} questionId={question.id} />
          )}
        </section>
      )}
      <div className="solve-panes">
        <section
          className="solve-question-pane"
          aria-label={adversarial ? '攻防简报与提交记录' : '题面与提交记录'}
        >
          <div className="solve-tabs" role="tablist" aria-label="题目信息">
            {(
              [
                ['description', adversarial ? '简报 / 题目' : '题目描述'],
                ['resources', '资料下载'],
                ['history', '提交记录' + (history.length ? ' · ' + history.length : '')],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                id={'solve-tab-' + tab}
                aria-selected={leftTab === tab}
                aria-controls={'solve-panel-' + tab}
                onClick={() => setLeftTab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="solve-pane-scroll"
            role="tabpanel"
            id={'solve-panel-' + leftTab}
            aria-labelledby={'solve-tab-' + leftTab}
          >
            {leftTab === 'description' && (
              <>
                {adversarial && <ArenaTeachingBriefing question={question} />}
                <div className="prd-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeHighlight, rehypeKatex]}
                  >
                    {question.content || '暂无题面。'}
                  </ReactMarkdown>
                </div>
                {definition.llm.enabled && (
                  <p className="prd-notice">评测使用本题固定的平台模型配置，所有同学使用同一配置。</p>
                )}
                {adversarial && (
                  <p className="prd-notice">
                    达到基线门槛（≥）后评测相反角色的有效算法。零有效对手正式记 100%；正常全败可为
                    0%。异常或未完成不会替换旧有效版本。
                  </p>
                )}
              </>
            )}
            {leftTab === 'resources' && (
              <>
                <p className="prd-muted">
                  题面可直接在“{adversarial ? '简报 / 题目' : '题目描述'}
                  ”中阅读。以下资料用于本地实验和补充学习。
                </p>
                <QuestionResources key={user?.id + '_' + question.id} questionId={question.id} />
              </>
            )}
            {leftTab === 'history' && (
              <>
                <div className="solve-history-heading">
                  <span className="prd-muted">仅显示本人的正式提交</span>
                  <button className="prd-button" onClick={refreshHistory}>
                    刷新
                  </button>
                </div>
                {historyError && (
                  <div className="prd-error" role="alert">
                    {historyError}
                  </div>
                )}
                {history.length ? (
                  <ol className="solve-history-list">
                    {history.map((item) => (
                      <li key={item.id}>
                        <button className="solve-history-open" onClick={() => void inspect(item.id)}>
                          <span>
                            <strong>
                              {item.score != null
                                ? item.score.toFixed(2) + (adversarial ? '%' : ' 分')
                                : isTerminal(item.status)
                                  ? '本次不计分'
                                  : '评测中'}
                            </strong>
                            <span>{submissionPhaseLabel(item)}</span>
                          </span>
                          <span className="prd-muted">
                            {new Date(item.createdAt).toLocaleString('zh-CN')} · 版本{' '}
                            {item.questionVersion ?? '—'}
                          </span>
                          <span className="solve-history-id">
                            {item.id.slice(0, 12)} · 查看{adversarial ? '复盘' : '结果'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="solve-empty">暂无本人提交记录。完成作答后点击上方“提交评测”。</div>
                )}
                {adversarial && <LegacyUploadHistory question={question} />}
              </>
            )}
          </div>
        </section>
        <section className="solve-code-pane" aria-label="作答工作区">
          <div className="solve-editor-toolbar">
            <div>
              <strong>
                {adversarial
                  ? definition.role === 'attack'
                    ? '攻击代码'
                    : '防御代码'
                  : question.type === 'T'
                    ? '作答内容'
                    : '代码'}
              </strong>
              <span className="solve-language">{editorLanguage(question)}</span>
            </div>
            <div className="solve-editor-actions">
              <span className="solve-save-status" role="status">
                {draftError ? '浏览器无法保存草稿' : saved ? '草稿已保存' : '正在保存草稿…'}
              </span>
              <button
                className="prd-button"
                disabled={uploading}
                onClick={() => {
                  const stored = safeWrite(draftKey, code)
                  setSaved(stored)
                  setDraftError(!stored)
                }}
              >
                保存
              </button>
              <button
                className="prd-button"
                disabled={uploading}
                onClick={() => {
                  if (window.confirm('重置会覆盖当前代码草稿，是否继续？')) {
                    setCode(question.answerTemplate ?? '')
                    setSaved(false)
                  }
                }}
              >
                重置
              </button>
            </div>
          </div>
          {question.answerTemplate?.includes('# BEGIN STUDENT') && (
            <p className="solve-code-hint">请仅修改 BEGIN STUDENT 与 END STUDENT 之间的填空区域。</p>
          )}
          <div className="solve-editor-body" ref={editorPanel}>
            <Suspense fallback={<div className="prd-loading">正在加载编辑器…</div>}>
              <CodeEditor
                value={code}
                onChange={(value) => {
                  setCode(value)
                  setSaved(false)
                }}
                language={editorLanguage(question)}
                height="100%"
                readOnly={uploading}
                wordWrap
              />
            </Suspense>
          </div>
          <section
            className={'solve-results ' + (resultOpen ? 'is-open' : '')}
            aria-label={adversarial ? '对战与复盘' : '评测结果'}
          >
            <div className="solve-result-toolbar">
              <button
                className="solve-result-toggle"
                aria-expanded={resultOpen}
                aria-controls="solve-result-content"
                onClick={() => setResultOpen(!resultOpen)}
              >
                <span aria-hidden="true">{resultOpen ? '▾' : '▸'}</span>{' '}
                {adversarial ? '对战 / 复盘' : '评测结果'}
              </button>
              <span className="prd-muted">
                {visibleSubmission ? submissionPhaseLabel(visibleSubmission) : '提交后在此查看结果'}
              </span>
            </div>
            {resultOpen && (
              <>
                <div className="solve-tabs solve-result-tabs" role="tablist" aria-label="结果类型">
                  <button
                    role="tab"
                    id="solve-result-tab-current"
                    aria-selected={resultTab === 'current'}
                    aria-controls="solve-result-content"
                    onClick={() => {
                      inspectionRequest.current.invalidate()
                      setHistoryLoading(false)
                      setResultTab('current')
                    }}
                  >
                    本次{adversarial ? '对战' : '提交'}
                  </button>
                  {adversarial && (
                    <button
                      role="tab"
                      id="solve-result-tab-score"
                      aria-selected={resultTab === 'score'}
                      aria-controls="solve-result-content"
                      onClick={() => {
                        inspectionRequest.current.invalidate()
                        setHistoryLoading(false)
                        setResultTab('score')
                      }}
                    >
                      当前正式成绩
                    </button>
                  )}
                  {(inspectedSubmission || historyLoading || resultTab === 'history') && (
                    <button
                      role="tab"
                      id="solve-result-tab-history"
                      aria-selected={resultTab === 'history'}
                      aria-controls="solve-result-content"
                      onClick={() => setResultTab('history')}
                    >
                      历史{adversarial ? '复盘' : '结果'}
                    </button>
                  )}
                </div>
                <div
                  className="solve-result-content"
                  id="solve-result-content"
                  role="tabpanel"
                  aria-labelledby={'solve-result-tab-' + resultTab}
                >
                  {resultTab === 'score' && adversarial ? (
                    <div>
                      <div className="prd-score">
                        {currentScore?.score != null ? currentScore.score.toFixed(2) + '%' : '暂无正式成绩'}
                      </div>
                      {currentScore?.updating && (
                        <p className="prd-notice">正在重评，当前展示上次正式成绩。</p>
                      )}
                      {currentScore?.emptyPool && <p className="prd-muted">暂无有效对手，正式赋分 100%。</p>}
                      {currentScore?.opponentCount != null && (
                        <p>
                          成功 {currentScore.successCount ?? '—'} / 有效对手 {currentScore.opponentCount}
                        </p>
                      )}
                      {currentScore?.updatedAt && (
                        <p className="prd-muted">
                          更新时间：{new Date(currentScore.updatedAt).toLocaleString('zh-CN')}
                        </p>
                      )}
                    </div>
                  ) : resultTab === 'history' && historyLoading ? (
                    <p className="prd-muted" role="status">
                      正在加载所选提交…
                    </p>
                  ) : resultTab === 'history' && historyError ? (
                    <p className="prd-error" role="alert">
                      {historyError}
                    </p>
                  ) : visibleSubmission ? (
                    <>
                      <SubmissionResult submission={visibleSubmission} adversarial={adversarial} />
                      {resultTab === 'history' && visibleSubmission.code && (
                        <button
                          className="prd-button"
                          disabled={uploading}
                          onClick={() => loadHistoricalCode(visibleSubmission)}
                        >
                          将本次代码载入编辑器
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="solve-empty">
                      {uploading
                        ? '材料正在上传，上传完成后等待服务器受理。'
                        : activeId
                          ? '正在恢复评测任务，请稍候…'
                          : '完成作答后点击上方“提交评测”。评测状态、实际得分和公开指标将显示在这里。'}
                      <p>正式提交按题目规则计分，当前不提供独立样例试运行。</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </section>
      </div>
    </div>
  )
}

function SubmissionResult({
  submission,
  adversarial,
}: {
  submission: SubmissionRecord
  adversarial: boolean
}) {
  const result = parsedResult(submission)
  const summary = dynamicSummary(submission)
  const metrics = publicMetrics(submission)
  const message =
    submission.publicMessage ||
    (typeof result.publicMessage === 'string'
      ? result.publicMessage
      : typeof result.message === 'string'
        ? result.message
        : '')
  return (
    <div className="solve-submission-result" aria-live="polite">
      <div className="solve-result-summary">
        <div className="prd-score">
          {submission.score != null
            ? submission.score.toFixed(2) +
              (adversarial ? '%' : ' / ' + (submission.maxScore ?? result.maxScore ?? 100))
            : isTerminal(submission.status)
              ? '本次不计分'
              : '等待评测结果'}
        </div>
        <span>{submissionPhaseLabel(submission)}</span>
      </div>
      {message && <p className="prd-muted">{message}</p>}
      {adversarial && (
        <>
          <p>
            基线资格：
            {summary.baselinePassed === true || summary.qualified === true
              ? '通过'
              : summary.baselinePassed === false || summary.qualified === false
                ? '未通过'
                : '尚未确定'}
          </p>
          {summary.opponentCount != null && (
            <p>
              成功 {summary.successCount ?? '—'} / 有效对手 {summary.opponentCount}
              {summary.emptyPool ? ' · 零对手正式赋分 100%' : ''}
            </p>
          )}
        </>
      )}
      <SubmissionDiagnostics value={submission.diagnostics} questionId={submission.questionId} />
      {metrics.length > 0 && (
        <dl className="solve-metrics">
          {metrics.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="solve-submission-id">
        提交编号：{submission.id} · 题目版本 {submission.questionVersion ?? '—'}
      </p>
      {submission.code && (
        <details className="solve-frozen-code">
          <summary>查看本次冻结代码</summary>
          <pre>{submission.code}</pre>
        </details>
      )}
    </div>
  )
}
