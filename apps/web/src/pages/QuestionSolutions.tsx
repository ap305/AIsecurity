import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getAuthToken } from '../lib/api'
import {
  questionSolutionsApi,
  readSolutionFile,
  type QuestionSolution,
  type SolutionCandidate,
  type SolutionPage,
} from '../lib/questionSolutions'

const referenceNames = {
  same_role: '同角色参考实现',
  opponent: '对手参考',
  qualification: '资格基线学习说明',
}
const date = (value: string) => new Date(value).toLocaleString('zh-CN')
export function SolutionCards({
  rows,
  kind,
  busyId,
  onWithdraw,
}: {
  rows: QuestionSolution[]
  kind: 'standard' | 'user' | 'top'
  busyId: string | string[]
  onWithdraw: (id: string) => void
}) {
  if (!rows.length)
    return (
      <p className="prd-muted">
        {kind === 'standard'
          ? '尚未发布标准题解。教师可发布说明或文本代码；线上实际参考实现须经来源核验后单独发布。'
          : kind === 'top'
            ? '当前没有主动公开且有效的最高分题解。不会公开未授权的历史提交。'
            : '尚无用户题解。你可以主动分享文字、代码或自己的已完成提交。'}
      </p>
    )
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {rows.map((row) => (
        <article className="prd-card" key={row.id} style={{ padding: 20, minWidth: 0 }}>
          <h2>{row.title}</h2>
          <p className="prd-muted">
            {row.author} · 版本 {row.questionVersion} · {date(row.createdAt)} ·{' '}
            {row.source === 'evaluation'
              ? '已核对当前评测基线'
              : row.source === 'submission'
                ? '主动公开的提交快照'
                : '手工发布'}
          </p>
          {row.referenceKind && (
            <p>
              {row.actualEvaluationReference ? '实际资格基线（源码节选）' : referenceNames[row.referenceKind]}
            </p>
          )}
          {row.sourceCreatedAt && <p className="prd-muted">源提交时间：{date(row.sourceCreatedAt)}</p>}
          {row.score !== null && (
            <p>
              分数：{row.score}
              {row.updating ? ' · 更新中' : ''}
            </p>
          )}
          {row.notice && <p role="note">{row.notice}</p>}
          {row.needsModelAttachment && (
            <p role="note">缺少模型附件：权重文件未公开，仅凭此代码可能无法复现。</p>
          )}
          {row.explanation && (
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                disallowedElements={['img']}
                components={{
                  a: ({ children, href }) => (
                    <a href={href} rel="noopener noreferrer" target="_blank">
                      {children}
                    </a>
                  ),
                }}
              >
                {row.explanation}
              </ReactMarkdown>
            </div>
          )}
          {row.code && (
            <pre
              style={{
                overflowX: 'auto',
                maxHeight: 600,
                padding: 16,
                background: 'var(--bg-secondary, #111827)',
                color: 'var(--text-primary, #f3f4f6)',
              }}
            >
              <code>{row.code}</code>
            </pre>
          )}
          {row.canWithdraw && (
            <button
              className="prd-button"
              disabled={Array.isArray(busyId) ? busyId.includes(row.id) : busyId === row.id}
              onClick={() => onWithdraw(row.id)}
            >
              {(Array.isArray(busyId) ? busyId.includes(row.id) : busyId === row.id) ? '撤回中…' : '撤回公开'}
            </button>
          )}
        </article>
      ))}
    </div>
  )
}

export default function QuestionSolutions() {
  const { questionId = '' } = useParams<{ questionId: string }>()
  const scopeKey = JSON.stringify([questionId, getAuthToken()])
  const scope = useRef({
    key: scopeKey,
    mounted: true,
    readVersion: 0,
    publishing: false,
    fileLoading: false,
    withdrawals: new Set<string>(),
  })
  if (scope.current.key !== scopeKey)
    scope.current = {
      key: scopeKey,
      mounted: true,
      readVersion: 0,
      publishing: false,
      fileLoading: false,
      withdrawals: new Set<string>(),
    }
  const currentScope = scope.current
  const isCurrent = () =>
    scope.current === currentScope &&
    currentScope.mounted &&
    currentScope.key === JSON.stringify([questionId, getAuthToken()])
  useEffect(() => {
    currentScope.mounted = true
    return () => {
      currentScope.mounted = false
    }
  }, [scopeKey])
  const [page, setPage] = useState<SolutionPage | null>(null)
  const [candidates, setCandidates] = useState<SolutionCandidate[]>([])
  const [tab, setTab] = useState<'standard' | 'user' | 'top'>('standard')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [error, setError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [busyIds, setBusyIds] = useState<string[]>([])
  const [publishing, setPublishing] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [kind, setKind] = useState<'user' | 'standard'>('user')
  const [title, setTitle] = useState('')
  const [explanation, setExplanation] = useState('')
  const [code, setCode] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [referenceKind, setReferenceKind] = useState('same_role')
  const [consent, setConsent] = useState(false)
  useEffect(() => {
    let active = true
    const version = ++currentScope.readVersion
    const currentRead = () => active && isCurrent() && version === currentScope.readVersion
    setLoading(true)
    setError('')
    setCandidateError('')
    setCandidates([])
    questionSolutionsApi
      .list(questionId, pageNumber)
      .then((data) => {
        if (currentRead()) setPage(data)
      })
      .catch((e) => {
        if (currentRead()) {
          setPage(null)
          setError(e instanceof Error ? e.message : '题解加载失败')
        }
      })
      .finally(() => {
        if (currentRead()) setLoading(false)
      })
    questionSolutionsApi
      .candidates(questionId)
      .then((data) => {
        if (currentRead()) setCandidates(data)
      })
      .catch((e) => {
        if (currentRead()) setCandidateError(e instanceof Error ? e.message : '提交列表加载失败')
      })
    return () => {
      active = false
    }
  }, [scopeKey, reload, pageNumber])
  useEffect(() => {
    setPage(null)
    setPageNumber(1)
    setTitle('')
    setExplanation('')
    setCode('')
    setSourceId('')
    setConsent(false)
    setSuccess('')
    setPublishing(false)
    setFileLoading(false)
    setBusyIds([])
    setKind('user')
  }, [scopeKey])
  function refresh() {
    if (!isCurrent()) return
    // Invalidate before React flushes effects: a pre-mutation read must never restore withdrawn code.
    currentScope.readVersion++
    setReload((n) => n + 1)
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!isCurrent() || currentScope.publishing || currentScope.fileLoading) return
    if (!consent) {
      setError('请先确认主动公开题解内容')
      return
    }
    if (new TextEncoder().encode(title + explanation + (sourceId ? '' : code)).byteLength > 256 * 1024) {
      setError('题解文本合计不能超过 256 KiB')
      return
    }
    currentScope.publishing = true
    setPublishing(true)
    setError('')
    setSuccess('')
    try {
      await questionSolutionsApi.publish(questionId, {
        kind,
        title,
        explanation,
        ...(kind === 'user' && sourceId ? { sourceSubmissionId: sourceId } : { code }),
        ...(kind === 'standard' ? { referenceKind } : {}),
      })
      if (!isCurrent()) return
      setSuccess('题解已公开，可随时撤回。')
      setConsent(false)
      setTitle('')
      setExplanation('')
      setCode('')
      setSourceId('')
      setTab(kind)
      setPageNumber(1)
      refresh()
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : '发布失败，请重试')
    } finally {
      if (isCurrent()) {
        currentScope.publishing = false
        setPublishing(false)
      }
    }
  }
  async function withdraw(id: string) {
    if (!isCurrent() || currentScope.withdrawals.has(id)) return
    currentScope.withdrawals.add(id)
    setBusyIds([...currentScope.withdrawals])
    setError('')
    setSuccess('')
    try {
      await questionSolutionsApi.withdraw(id)
      if (!isCurrent()) return
      setPage((data) =>
        data
          ? {
              ...data,
              standard: data.standard.filter((r) => r.id !== id),
              user: data.user.filter((r) => r.id !== id),
              top: data.top.filter((r) => r.id !== id),
            }
          : data,
      )
      setSuccess('已撤回公开。')
      refresh()
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : '撤回失败，请重试')
    } finally {
      if (isCurrent()) {
        currentScope.withdrawals.delete(id)
        setBusyIds([...currentScope.withdrawals])
      }
    }
  }
  return (
    <main className="prd-page" style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <Link className="prd-button" to={`/question/${encodeURIComponent(questionId)}`}>
        ← 返回提交页
      </Link>
      <h1>{page?.question.id === questionId ? page.question.title : '题目'} · 题解</h1>
      <p className="prd-muted">展示当前已发布版本的代码和说明，所有内容仅供阅读。模型权重不会自动公开。</p>
      <button className="prd-button" disabled={loading} onClick={refresh}>
        刷新题解和当前分数
      </button>
      {error && (
        <p className="prd-error" role="alert">
          {error}{' '}
          <button className="prd-button" onClick={refresh}>
            重新加载
          </button>
        </p>
      )}
      {success && <p role="status">{success}</p>}
      {loading && <p role="status">正在加载题解…</p>}
      {page?.question.id === questionId && (
        <>
          <nav aria-label="题解来源" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
            {(
              [
                ['standard', '标准题解'],
                ['user', '用户题解'],
                ['top', '当前最高分'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={`prd-button${tab === value ? ' primary' : ''}`}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'top' && (
            <p className="prd-muted">
              仅比较主动公开的有效提交；同一提交重复发帖只保留一篇。并列最高分按原提交时间取最新两份。攻防分数随当前有效槽位动态变化。
            </p>
          )}
          {tab === 'standard' && page.standardNotice && <p role="note">{page.standardNotice}</p>}
          <SolutionCards rows={page[tab]} kind={tab} busyId={busyIds} onWithdraw={withdraw} />
          {tab === 'user' && (
            <nav
              aria-label="用户题解分页"
              style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16 }}
            >
              <button
                className="prd-button"
                disabled={loading || page.pagination.page <= 1}
                onClick={() => setPageNumber((n) => n - 1)}
              >
                上一页
              </button>
              <span>
                第 {page.pagination.page} / {Math.max(1, page.pagination.totalPages)} 页 · 共{' '}
                {page.pagination.total} 篇
              </span>
              <button
                className="prd-button"
                disabled={loading || page.pagination.page >= page.pagination.totalPages}
                onClick={() => setPageNumber((n) => n + 1)}
              >
                下一页
              </button>
            </nav>
          )}
          <section className="prd-card" style={{ marginTop: 32, padding: 20 }}>
            <h2>发布题解</h2>
            <p className="prd-muted">
              每人每题当前版本最多公开 20 篇；可选最近 100 次已完成代码提交。撤回旧题解后可继续发布。
            </p>
            <form onSubmit={publish} style={{ display: 'grid', gap: 14 }}>
              {page.canPublishStandard && (
                <label>
                  题解来源{' '}
                  <select
                    value={kind}
                    disabled={publishing}
                    onChange={(e) => {
                      setKind(e.target.value as 'user' | 'standard')
                      setSourceId('')
                      setConsent(false)
                    }}
                  >
                    <option value="user">用户题解</option>
                    <option value="standard">
                      {page.question.category === 'adversarial' ? '教师补充讲解' : '标准题解'}
                    </option>
                  </select>
                </label>
              )}
              {kind === 'standard' && (
                <>
                  <label>
                    参考用途{' '}
                    <select
                      value={referenceKind}
                      disabled={publishing}
                      onChange={(e) => setReferenceKind(e.target.value)}
                    >
                      {Object.entries(referenceNames).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p role="note">
                    此处为教师手工学习参考。对抗题的实际基线从当前评测版本核验展示；如需替换基线，应完成校准与题目发布。上传补充讲解不会改变评测与成绩。
                  </p>
                </>
              )}
              <label>
                标题{' '}
                <input
                  value={title}
                  maxLength={120}
                  required
                  disabled={publishing}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
              {kind === 'user' && (
                <label>
                  公开自己的提交（可选）{' '}
                  <select
                    value={sourceId}
                    disabled={publishing}
                    onChange={(e) => {
                      setSourceId(e.target.value)
                      setConsent(false)
                    }}
                    style={{ width: '100%' }}
                  >
                    <option value="">自行填写说明或代码</option>
                    {candidates.map((s) => (
                      <option key={s.id} value={s.id}>
                        {date(s.createdAt)}
                        {s.score === null ? ' · 攻防分数以当前槽位为准' : ` · 提交得分 ${s.score}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {candidateError && (
                <p role="alert">
                  {candidateError}{' '}
                  <button type="button" className="prd-button" onClick={refresh}>
                    重新加载提交列表
                  </button>
                </p>
              )}
              <label>
                说明（支持 Markdown）
                <textarea
                  value={explanation}
                  rows={5}
                  disabled={publishing}
                  onChange={(e) => setExplanation(e.target.value)}
                  style={{ width: '100%' }}
                />
              </label>
              {!sourceId && (
                <>
                  <label>
                    上传 UTF-8 文本源代码（最多 256 KiB）
                    <input
                      type="file"
                      accept=".py,.js,.ts,.java,.go,.rs,.c,.cpp,.h,.txt,.md,.json,.yaml,.yml"
                      disabled={publishing || fileLoading}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (!file || !isCurrent() || currentScope.fileLoading) return
                        currentScope.fileLoading = true
                        setFileLoading(true)
                        setError('')
                        try {
                          const content = await readSolutionFile(file)
                          if (isCurrent()) setCode(content)
                        } catch (reason) {
                          if (isCurrent()) setError(reason instanceof Error ? reason.message : '文件读取失败')
                        } finally {
                          if (isCurrent()) {
                            currentScope.fileLoading = false
                            setFileLoading(false)
                          }
                        }
                      }}
                    />
                  </label>
                  <label>
                    代码
                    <textarea
                      value={code}
                      rows={10}
                      disabled={publishing || fileLoading}
                      onChange={(e) => setCode(e.target.value)}
                      spellCheck={false}
                      style={{ width: '100%', fontFamily: 'monospace' }}
                    />
                  </label>
                </>
              )}
              {sourceId && <p>发布所选提交的固定代码快照，不公开内部评测结果、配置或权重附件。</p>}
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={publishing}
                  onChange={(e) => setConsent(e.target.checked)}
                />{' '}
                我主动允许所有已登录用户查看以上代码和说明，并允许有效提交参与“当前最高分”题解展示；已检查内容不含密钥或私人信息。
              </label>
              <button className="prd-button primary" disabled={publishing || fileLoading || !consent}>
                {publishing ? '正在发布…' : '确认公开题解'}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  )
}
