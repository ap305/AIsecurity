import { useEffect, useState, useMemo, useCallback, useRef, lazy, Suspense } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { apiGet, apiPost, apiPostMultipart } from '../lib/api'
import { startJudgeQueuePolling, queueStatusText, type JudgeQueueInfo } from '../lib/judgeQueue'
import { getMockQuestion, type MockQuestion } from '../lib/mockQuestions'
import { getQuestionHint } from '../lib/questionHints'
import { useAuth } from '../contexts/AuthContext'

const CodeEditor = lazy(() => import('../components/CodeEditor'))

const TYPE_LABELS: Record<string, string> = {
  T: '📖 理论',
  C: '💻 编程',
  'T+C': '📝 理论+编程',
  'A/D': '⚔️ 攻防',
}

const DIFFICULTY_LABELS: Record<string, string> = {
  L1: '入门',
  L2: '进阶',
  L3: '挑战',
}

const DIFFICULTY_COLORS: Record<string, string> = {
  L1: '#48db80',
  L2: '#ffb84d',
  L3: '#ff6b6b',
}

interface QuestionData {
  id: string
  moduleCode: string
  number: number
  title: string
  content: string
  answerTemplate: string | null
  type: string
  difficulty: string
  category: string
  status: string
  solution: string | null
  testConfig: string | null
}

interface SubmissionData {
  id: string
  questionId: string
  userId: string
  status: 'pending' | 'judging' | 'passed' | 'failed' | 'error'
  score: number | null
  result: {
    accuracy?: number
    message?: string
    passed?: boolean
    output?: string
    details?: {
      win?: boolean
      queries_used?: number
      fbr?: number
      interaction_log?: unknown[]
    }
    // theory_eval 字段
    wordCount?: number
    wordPenalty?: boolean
    minWords?: number
    hitRequired?: string[]
    missedRequired?: string[]
    hitOptional?: string[]
    requiredScore?: number
    optionalScore?: number
  } | null
  createdAt: string
}

interface ResourceItem {
  filename: string
  size: number
  sizeLabel: string
  extension: string
}

function detectLanguage(question: MockQuestion | QuestionData): string {
  // 理论题用 Markdown 作答
  if (question.type === 'T') return 'markdown'
  const content = ('answerTemplate' in question ? question.answerTemplate : '') ?? ''
  if (content.includes('import torch') || content.includes('import numpy')) return 'python'
  if (content.includes('public class') || content.includes('import java')) return 'java'
  if (content.includes('fn main') || content.includes('use ')) return 'rust'
  if (content.includes('console.log') || content.includes('const ')) return 'javascript'
  if (content.includes('package main') || content.includes('func ')) return 'go'
  return 'python'
}

const POLL_INTERVAL_MS = 2000
const POLL_MAX_RETRIES = 60 // 2 minutes max

export default function Question() {
  const { user } = useAuth()
  const { questionId } = useParams<{ questionId: string }>()
  const [code, setCode] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitResult, setSubmitResult] = useState<string | null>(null)
  const [submissionData, setSubmissionData] = useState<SubmissionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [queueInfo, setQueueInfo] = useState<JudgeQueueInfo | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Question data: try API first, fallback to mock
  const [question, setQuestion] = useState<MockQuestion | QuestionData | null>(null)

  // Resource downloads for this question
  const [resources, setResources] = useState<ResourceItem[]>([])

  useEffect(() => {
    if (!questionId) {
      setLoading(false)
      setLoadError('题目不存在')
      return
    }

    setLoading(true)
    setLoadError(null)

    // Try API first（带 role：学生视角后端返回提示而非完整代码）
    apiGet<QuestionData>(`/questions/${questionId}?role=${user?.role ?? ''}`)
      .then((data) => {
        setQuestion(data)
        setLoading(false)
      })
      .catch(() => {
        // Fallback to mock data
        const mock = getMockQuestion(questionId)
        if (mock) {
          // 学生视角：mock 回退也用提示替代完整代码
          if (user?.role === 'student') {
            const h = getQuestionHint(mock.id)
            if (h) (mock as { answerTemplate: string | null }).answerTemplate = h
          }
          setQuestion(mock)
        } else {
          setLoadError('题目不存在')
        }
        setLoading(false)
      })
  }, [questionId])

  // Load resource list for this question (silent failure)
  useEffect(() => {
    if (!questionId) {
      setResources([])
      return
    }
    apiGet<ResourceItem[]>(`/questions/${questionId}/resources`)
      .then(setResources)
      .catch(() => setResources([]))
  }, [questionId])

  // Init code editor when question loads — restore saved code if available
  useEffect(() => {
    if (question) {
      // v2：作废旧版保存的完整模板，确保学生视角看到的是提示（后端已对学生返回提示）
      const savedCode = localStorage.getItem(`saved_code_v2_${question.id}`)
      setCode(savedCode ?? question.answerTemplate ?? '')
      setSubmitResult(null)
      setSubmissionData(null)
      setFile(null)
    }
  }, [question])

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current)
      }
    }
  }, [])

  const needsModelFile = useMemo(() => {
    if (!question) return false
    const qType = question.type
    // Always allow model file upload for programming questions
    if (qType === 'C' || qType === 'T+C') {
      // If testConfig specifies otherwise, check it; default to showing upload
      const testCfg = ('testConfig' in question ? question.testConfig : null) as string | null
      if (testCfg) {
        try {
          const cfg = JSON.parse(testCfg)
          // If testConfig explicitly says NOT model_eval, hide upload
          if (cfg.type && cfg.type !== 'model_eval') return false
        } catch { /* ignore */ }
      }
      return true
    }
    return false
  }, [question])

  const isAgentQuestion = useMemo(() => {
    if (!question) return false
    const testCfg = ('testConfig' in question ? question.testConfig : null) as string | null
    if (!testCfg) return false
    try {
      const cfg = JSON.parse(testCfg)
      return cfg.type === 'agent_attack_defense'
    } catch {
      return false
    }
  }, [question])

  const agentMode = useMemo(() => {
    if (!question || !isAgentQuestion) return 'attack'
    const testCfg = ('testConfig' in question ? question.testConfig : null) as string | null
    if (!testCfg) return 'attack'
    try {
      const cfg = JSON.parse(testCfg)
      return cfg.mode || 'attack'
    } catch {
      return 'attack'
    }
  }, [question, isAgentQuestion])

  // 从 testConfig 读取 arena 场景（攻防题对应的引擎 scenario）
  const agentScenario = useMemo(() => {
    if (!question || !isAgentQuestion) return undefined
    const testCfg = ('testConfig' in question ? question.testConfig : null) as string | null
    if (!testCfg) return undefined
    try {
      const cfg = JSON.parse(testCfg)
      return cfg.scenario as string | undefined
    } catch {
      return undefined
    }
  }, [question, isAgentQuestion])

  const pollSubmission = useCallback((submissionId: string, retriesLeft: number) => {
    if (retriesLeft <= 0) {
      setSubmitResult('timeout')
      setSubmitting(false)
      return
    }

    pollTimerRef.current = setTimeout(async () => {
      try {
        const endpoint = isAgentQuestion
          ? `/matches/${submissionId}`
          : `/submissions/${submissionId}`
        const data = await apiGet<SubmissionData>(endpoint)
        setSubmissionData(data)

        if (data.status === 'passed' || data.status === 'failed' || data.status === 'error') {
          setSubmitResult(data.status)
          setSubmitting(false)
        } else {
          // Still judging, keep polling
          pollSubmission(submissionId, retriesLeft - 1)
        }
      } catch {
        pollSubmission(submissionId, retriesLeft - 1)
      }
    }, POLL_INTERVAL_MS)
  }, [isAgentQuestion])

  const handleSubmit = () => {
    if (!question) return
    setSubmitResult(null)
    setShowConfirm(true)
  }

  const handleConfirmSubmit = () => {
    setShowConfirm(false)
    doSubmit()
  }

  const doSubmit = async () => {
    if (!question) return
    setSubmitting(true)
    setSubmitResult(null)
    setSubmissionData(null)
    // 判题并发闸门：提交期间轮询队列状态，排队时给学生提示
    const stopQueuePoll = startJudgeQueuePolling(setQueueInfo)

    try {
      if (isAgentQuestion) {
        // Agent attack/defense: POST JSON to /api/matches/run
        const data = await apiPost<SubmissionData>('/matches/run', {
          attackCode: agentMode === 'attack' ? code : '',
          defenseCode: agentMode === 'defense' ? code : '',
          role: agentMode === 'attack' ? 'solo_attack' : 'solo_defense',
          scenario: agentScenario,
          questionId: question.id,
          userId: user?.id ?? 'anonymous',
          displayName: user?.displayName ?? 'Anonymous',
        })
        setSubmissionData(data)
        // Agent judging is synchronous, result is immediate
        if (data.status === 'passed' || data.status === 'failed' || data.status === 'error') {
          setSubmitResult(data.status)
          setSubmitting(false)
        } else {
          pollSubmission(data.id, POLL_MAX_RETRIES)
        }
      } else {
        // Existing flow: multipart FormData for model_eval
        const formData = new FormData()
        formData.append('code', code)
        formData.append('questionId', question.id)
        formData.append('userId', user?.id ?? 'anonymous')
        formData.append('displayName', user?.displayName ?? 'Anonymous')

        if (file) {
          formData.append('file', file)
        }

        const data = await apiPostMultipart<SubmissionData>('/submissions', formData)
        setSubmissionData(data)

        // Start polling
        pollSubmission(data.id, POLL_MAX_RETRIES)
      }
    } catch (err) {
      setSubmitResult('error')
      setSubmitting(false)
    } finally {
      stopQueuePoll()
      setQueueInfo(null)
    }
  }

  const handleSave = () => {
    if (!question) return
    localStorage.setItem(`saved_code_v2_${question.id}`, code)
    setSubmitResult('saved')
    setTimeout(() => setSubmitResult(null), 2000)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setFile(f)
  }

  const handleRemoveFile = () => {
    setFile(null)
  }

  // ---- State: Loading ----
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <div
          style={{
            width: 32,
            height: 32,
            border: '3px solid var(--border-color)',
            borderTopColor: 'var(--brand-cyan)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 16px',
          }}
        />
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>加载题目中...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ---- State: Error / Empty ----
  if (loadError || !question) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 20px' }}>
        <p style={{ fontSize: 18, color: 'var(--danger)', marginBottom: 12 }}>
          题目加载失败
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          {loadError ?? '题目不存在'}
        </p>
        <Link
          to="/"
          style={{
            color: 'var(--brand-cyan)',
            fontSize: 14,
          }}
        >
          &larr; 返回任务大厅
        </Link>
      </div>
    )
  }

  const typeLabel = TYPE_LABELS[question.type] ?? question.type
  const diffLabel = DIFFICULTY_LABELS[question.difficulty] ?? question.difficulty
  const diffColor = DIFFICULTY_COLORS[question.difficulty] ?? '#888'
  const categoryLabel = question.category === 'security' ? '安全任务' : '基础任务'

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <Link
          to="/"
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 8,
            display: 'inline-block',
          }}
        >
          &larr; 返回任务大厅
        </Link>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-muted)',
              background: 'var(--bg-secondary)',
              padding: '2px 8px',
              borderRadius: 4,
            }}
          >
            #{String(question.number).padStart(2, '0')}
          </span>
          <h1
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--text-primary)',
              margin: 0,
            }}
          >
            {question.title}
          </h1>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background:
                question.type === 'A/D'
                  ? 'rgba(255, 107, 107, 0.15)'
                  : 'rgba(0, 212, 255, 0.1)',
              color: question.type === 'A/D' ? 'var(--danger)' : 'var(--brand-cyan)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {typeLabel}
          </span>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background: `${diffColor}15`,
              color: diffColor,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {diffLabel}
          </span>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              background:
                question.category === 'security'
                  ? 'rgba(255, 107, 107, 0.08)'
                  : 'rgba(0, 212, 255, 0.06)',
              color:
                question.category === 'security' ? 'var(--danger)' : 'var(--brand-cyan)',
            }}
          >
            {categoryLabel}
          </span>
        </div>
      </div>

      {/* Split pane */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          height: 'calc(100vh - var(--topbar-height) - 130px)',
        }}
      >
        {/* Left: Markdown content */}
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: 24,
            overflowY: 'auto',
          }}
          className="markdown-body"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {question.content}
          </ReactMarkdown>

          {resources.length > 0 && (
            <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--border-color)' }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ color: 'var(--brand-cyan)' }}>&#128206;</span>
                资源下载
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
                以下为本题所需的参考资料、数据集和代码模板，请下载后用于本地完成实验。
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {resources.map((r) => (
                  <a
                    key={r.filename}
                    href={`/api/questions/${encodeURIComponent(question.id)}/resources/${encodeURIComponent(r.filename)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 6,
                      border: '1px solid var(--border-color)',
                      background: 'var(--bg-secondary)',
                      textDecoration: 'none',
                      cursor: 'pointer',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--brand-cyan)'
                      ;(e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0, 212, 255, 0.04)'
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--border-color)'
                      ;(e.currentTarget as HTMLAnchorElement).style.background = 'var(--bg-secondary)'
                    }}
                  >
                    <span style={{ fontSize: 16, lineHeight: 1 }}>{getResourceIcon(r.extension)}</span>
                    <span
                      style={{
                        fontSize: 13,
                        color: 'var(--brand-cyan)',
                        fontFamily: 'var(--font-mono)',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.filename}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {r.sizeLabel}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 4 }}>
                      &#11015;
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Code editor + File upload + Submit */}
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Editor toolbar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 16px',
              borderBottom: '1px solid var(--border-color)',
              background: 'var(--bg-secondary)',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
              }}
            >
              {question.type === 'A/D'
                ? (agentMode === 'defense' ? '防御脚本' : '攻击脚本')
                : '代码编辑器'}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleSave}
                disabled={submitting}
                style={{
                  padding: '5px 14px',
                  borderRadius: 4,
                  border: '1px solid var(--border-color)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                保存
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                style={{
                  padding: '5px 14px',
                  borderRadius: 4,
                  border: 'none',
                  background: submitting ? 'var(--border-color)' : 'var(--brand-cyan)',
                  color: submitting ? 'var(--text-muted)' : '#000',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                {submitting ? '评测中...' : '提交'}
              </button>
            </div>
          </div>

          {/* Code editor (CodeMirror) */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <Suspense fallback={null}>
              <CodeEditor
                height="100%"
                language={detectLanguage(question)}
                value={code}
                onChange={(value) => setCode(value)}
                fontSize={13}
                wordWrap
              />
            </Suspense>
          </div>

          {/* File upload area (for model_eval questions) */}
          {needsModelFile && (
            <div
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border-color)',
                background: 'var(--bg-secondary)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  模型文件:
                </span>
                {file ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--brand-cyan)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {file.name}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      ({(file.size / 1024 / 1024).toFixed(1)} MB)
                    </span>
                    <button
                      onClick={handleRemoveFile}
                      disabled={submitting}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--danger)',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '2px 6px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <label
                    style={{
                      padding: '4px 12px',
                      borderRadius: 4,
                      border: '1px dashed var(--border-color)',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontFamily: 'inherit',
                    }}
                  >
                    选择文件
                    <input
                      type="file"
                      accept=".pth,.pt,.h5,.onnx,.ckpt,.bin,.weights"
                      onChange={handleFileChange}
                      style={{ display: 'none' }}
                      disabled={submitting}
                    />
                  </label>
                )}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  上传训练好的 model.pth
                </span>
              </div>
            </div>
          )}

          {/* Submit result feedback */}
          {submitting && (
            <div
              style={{
                padding: '8px 16px',
                borderTop: '1px solid var(--border-color)',
                flexShrink: 0,
                fontSize: 12,
                color: 'var(--brand-cyan)',
              }}
            >
              {queueStatusText(queueInfo)}
            </div>
          )}
          {(submitResult || submissionData) && (
            <div
              style={{
                padding: '10px 16px',
                borderTop: '1px solid var(--border-color)',
                flexShrink: 0,
                ...getResultStyle(submitResult, submissionData),
              }}
            >
              {submissionData && submissionData.status === 'judging' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      border: '2px solid var(--border-color)',
                      borderTopColor: 'var(--brand-cyan)',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--brand-cyan)' }}>
                    评测中...
                  </span>
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              ) : submissionData && submissionData.result ? (
                <div>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: getStatusColor(submissionData.status),
                    }}
                  >
                    {submissionData.status === 'passed'
                      ? '通过'
                      : submissionData.status === 'failed'
                        ? '未通过'
                        : submissionData.status === 'error'
                          ? '评测错误'
                          : ''}
                  </span>
                  {submissionData.result.accuracy != null && (
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 12 }}>
                      准确率: {(submissionData.result.accuracy * 100).toFixed(2)}%
                    </span>
                  )}
                  {submissionData.result.message && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {submissionData.result.message}
                    </div>
                  )}
                  {submissionData.result.output && (
                    <pre
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        marginTop: 4,
                        whiteSpace: 'pre-wrap',
                        maxHeight: 100,
                        overflow: 'auto',
                        background: 'rgba(0,0,0,0.2)',
                        padding: 6,
                        borderRadius: 4,
                      }}
                    >
                      {submissionData.result.output}
                    </pre>
                  )}
                  {/* Agent attack/defense specific fields */}
                  {submissionData.result.details && (
                    <div style={{ marginTop: 4 }}>
                      {submissionData.result.details.queries_used !== undefined && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          Queries: {submissionData.result.details.queries_used}/8
                        </div>
                      )}
                      {submissionData.result.details.fbr !== undefined && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          FBR: {(submissionData.result.details.fbr * 100).toFixed(1)}%
                        </div>
                      )}
                      {submissionData.result.details.win !== undefined && (
                        <div style={{
                          fontSize: 12,
                          color: submissionData.result.details.win ? '#48db80' : '#ff6b6b',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                        }}>
                          {submissionData.result.details.win ? 'Win' : 'Lose'}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Theory eval specific fields */}
                  {submissionData.result.hitRequired !== undefined && (
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        得分: <strong style={{ color: getStatusColor(submissionData.status) }}>
                          {submissionData.score != null ? Math.round(submissionData.score) : 0}
                        </strong>
                        <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>
                          (必需 {submissionData.result.requiredScore ?? 0} + 可选 {submissionData.result.optionalScore ?? 0})
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        字数: {submissionData.result.wordCount ?? 0}
                        {submissionData.result.wordPenalty && (
                          <span style={{ color: 'var(--warning)', marginLeft: 8 }}>
                            (不足 {submissionData.result.minWords ?? 50}，扣 20 分)
                          </span>
                        )}
                      </div>
                      {submissionData.result.hitRequired && submissionData.result.hitRequired.length > 0 && (
                        <div style={{ fontSize: 12, color: '#48db80' }}>
                          命中关键词: {submissionData.result.hitRequired.join('、')}
                        </div>
                      )}
                      {submissionData.result.missedRequired && submissionData.result.missedRequired.length > 0 && (
                        <div style={{ fontSize: 12, color: '#ff6b6b' }}>
                          缺失关键词: {submissionData.result.missedRequired.join('、')}
                        </div>
                      )}
                      {submissionData.result.hitOptional && submissionData.result.hitOptional.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--brand-cyan)' }}>
                          加分关键词: {submissionData.result.hitOptional.join('、')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : submitResult === 'saved' ? (
                <span style={{ fontSize: 12, color: 'var(--brand-cyan)' }}>代码已保存</span>
              ) : submitResult === 'error' ? (
                <span style={{ fontSize: 12, color: 'var(--danger)' }}>提交失败，请重试</span>
              ) : submitResult === 'timeout' ? (
                <span style={{ fontSize: 12, color: '#ffb84d' }}>评测超时，请稍后查看结果</span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowConfirm(false)}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: '24px 28px',
              maxWidth: 420,
              width: '90%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16, color: 'var(--text-primary)' }}>
              确认提交
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              提交评测会覆盖之前的模型和代码记录。建议先保存代码。是否确认提交？
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{
                  padding: '6px 16px',
                  borderRadius: 4,
                  border: '1px solid var(--border-color)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                取消
              </button>
              <button
                onClick={handleConfirmSubmit}
                style={{
                  padding: '6px 16px',
                  borderRadius: 4,
                  border: 'none',
                  background: 'var(--brand-cyan)',
                  color: '#000',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                }}
              >
                确认提交
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function getResultStyle(
  submitResult: string | null,
  submissionData: SubmissionData | null,
): React.CSSProperties {
  const status = submissionData?.status || submitResult
  switch (status) {
    case 'passed':
      return { background: 'rgba(72, 219, 128, 0.1)' }
    case 'failed':
      return { background: 'rgba(255, 107, 107, 0.1)' }
    case 'error':
    case 'timeout':
      return { background: 'rgba(255, 184, 77, 0.1)' }
    case 'saved':
    case 'judging':
    case 'pending':
      return { background: 'rgba(0, 212, 255, 0.08)' }
    default:
      return {}
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'passed':
      return '#48db80'
    case 'failed':
      return '#ff6b6b'
    case 'error':
      return '#ffb84d'
    default:
      return 'var(--brand-cyan)'
  }
}

function getResourceIcon(extension: string): string {
  switch (extension) {
    case 'pdf':
      return '\u{1F4D1}'
    case 'zip':
      return '\u{1F4E6}'
    case 'py':
      return '\u{1F40D}'
    case 'txt':
      return '\u{1F4DD}'
    default:
      return '\u{1F4C4}'
  }
}
