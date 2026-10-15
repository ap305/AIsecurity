import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiGet } from '../../lib/api'
import { statusLabel } from '../../lib/prdApi'
import './StudentScores.css'

interface StudentSummary {
  userId: string
  username: string
  displayName: string
  studentId: string | null
  school: string | null
  basicTotalScore: number
  basicScoredQuestionCount: number
  submittedQuestionCount: number
  lastSubmittedAt: string | null
}

interface QuestionScore {
  questionId: string
  title: string
  number: number | null
  moduleCode: string | null
  category: string
  role: string | null
  questionVersion: number
  evaluationVersion: string | null
  questionStatus: string
  submissionCount: number
  currentSubmissionCount: number
  lastSubmittedAt: string | null
  score: number | null
  scoreKind: 'best' | 'current'
  state: 'scored' | 'pending' | 'no_score' | 'outdated'
  scoreReachedAt: string | null
  scoringSubmissionId: string | null
  updating: boolean
  latestSubmission: {
    id: string
    status: string
    score: number | null
    questionVersion: number
    createdAt: string
  } | null
}

interface StudentList {
  students: StudentSummary[]
  total: number
  page: number
  pageSize: number
}

interface StudentDetail {
  student: StudentSummary
  questions: QuestionScore[]
}

interface Result<T> {
  key: string
  data: T | null
  error: string
}

const PAGE_SIZE = 20
const emptyResult = { key: '', data: null, error: '' }
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

function scoreState(question: QuestionScore) {
  if (question.state === 'scored') return question.updating ? '已有成绩，正在更新' : '已计分'
  if (question.state === 'pending') return '评测中，尚未计分'
  if (question.state === 'outdated')
    return question.scoreKind === 'best' ? '旧版本或旧评测成绩已失效' : '旧版本或下架题目，成绩已失效'
  return '尚无有效成绩'
}

function QuestionRows({ questions }: { questions: QuestionScore[] }) {
  return (
    <div className="prd-table-wrap">
      <table className="prd-table student-scores-questions">
        <thead>
          <tr>
            <th>已提交题目</th>
            <th>类型 / 角色</th>
            <th>当前成绩</th>
            <th>提交次数</th>
            <th>最新提交</th>
            <th>成绩达到时间</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question) => (
            <tr key={question.questionId}>
              <td>
                <strong>{question.title}</strong>
                <div className="student-scores-secondary">
                  {question.moduleCode ? `${question.moduleCode} · ` : ''}
                  {question.number != null ? `第 ${question.number} 题 · ` : ''}
                  当前版本 v{question.questionVersion} · {statusLabel(question.questionStatus)}
                </div>
              </td>
              <td>
                {question.scoreKind === 'best' ? '基础题' : '攻防题'}
                {question.role && (
                  <div className="student-scores-secondary">
                    {question.role === 'attack' ? '攻击方' : '防御方'}
                  </div>
                )}
              </td>
              <td>
                <strong className="student-scores-value">
                  {question.score == null
                    ? '—'
                    : `${numberFormat.format(question.score)}${question.scoreKind === 'current' ? '%' : ' 分'}`}
                </strong>
                <div className="student-scores-secondary">
                  {question.scoreKind === 'best' ? '当前版本最高分' : '动态当前分'}
                </div>
                <div className="student-scores-secondary">{scoreState(question)}</div>
              </td>
              <td>
                共 {question.submissionCount} 次
                <div className="student-scores-secondary">当前版本 {question.currentSubmissionCount} 次</div>
              </td>
              <td>
                {question.latestSubmission ? statusLabel(question.latestSubmission.status) : '—'}
                {question.latestSubmission && (
                  <div className="student-scores-secondary">
                    提交版本 v{question.latestSubmission.questionVersion}
                  </div>
                )}
                <div className="student-scores-secondary">{formatDate(question.lastSubmittedAt)}</div>
              </td>
              <td>{formatDate(question.scoreReachedAt)}</td>
            </tr>
          ))}
          {!questions.length && (
            <tr>
              <td colSpan={6} className="student-scores-empty">
                该学生尚未提交题目。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default function StudentScores() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedUserId = searchParams.get('userId') || ''
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [listResult, setListResult] = useState<Result<StudentList>>(emptyResult)
  const [detailResult, setDetailResult] = useState<Result<StudentDetail>>(emptyResult)
  const listKey = JSON.stringify([search, page, refresh])
  const detailKey = JSON.stringify([selectedUserId, refresh])
  const listLoading = listResult.key !== listKey
  const detailLoading = detailResult.key !== detailKey
  const list = listResult.key === listKey ? listResult.data : null
  const detail = detailResult.key === detailKey ? detailResult.data : null
  const error = selectedUserId
    ? detailResult.key === detailKey
      ? detailResult.error
      : ''
    : listResult.key === listKey
      ? listResult.error
      : ''
  const pageCount = Math.max(1, Math.ceil((list?.total ?? 0) / PAGE_SIZE))

  useEffect(() => {
    let active = true
    const query = new URLSearchParams({ search, page: String(page), pageSize: String(PAGE_SIZE) })
    apiGet<StudentList>(`/admin/student-scores?${query}`)
      .then((data) => {
        if (!active) return
        setListResult({ key: listKey, data, error: '' })
        const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
        if (page > lastPage) setPage(lastPage)
      })
      .catch((reason) => {
        if (active)
          setListResult({
            key: listKey,
            data: null,
            error: reason instanceof Error ? reason.message : '学生成绩加载失败。',
          })
      })
    return () => {
      active = false
    }
  }, [search, page, listKey])

  useEffect(() => {
    if (!selectedUserId) return
    let active = true
    setDetailResult(emptyResult)
    apiGet<StudentDetail>(`/admin/student-scores/${encodeURIComponent(selectedUserId)}`)
      .then((data) => {
        if (active) setDetailResult({ key: detailKey, data, error: '' })
      })
      .catch((reason) => {
        if (active)
          setDetailResult({
            key: detailKey,
            data: null,
            error: reason instanceof Error ? reason.message : '学生成绩明细加载失败。',
          })
      })
    return () => {
      active = false
    }
  }, [selectedUserId, detailKey])

  const selectStudent = (userId: string) => {
    const next = new URLSearchParams(searchParams)
    if (userId) next.set('userId', userId)
    else next.delete('userId')
    setSearchParams(next)
  }

  const searchStudents = (event: FormEvent) => {
    event.preventDefault()
    setSearch(searchInput.trim())
    setPage(1)
    setRefresh((value) => value + 1)
  }

  return (
    <div className="prd-page student-scores-page">
      <div className="prd-split">
        <div>
          <h1>学生成绩</h1>
          <p className="prd-muted">按学生查看已提交题目的成绩、提交次数和评测状态。</p>
        </div>
        <div className="student-scores-actions">
          {selectedUserId && (
            <button className="prd-button" onClick={() => selectStudent('')}>
              返回学生列表
            </button>
          )}
          <button
            className="prd-button"
            disabled={selectedUserId ? detailLoading : listLoading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新成绩
          </button>
        </div>
      </div>
      <div className="prd-notice">
        基础题显示当前版本的最高有效分，并计入基础总分；攻防题显示动态当前胜率，单独统计，不计入基础总分。
        “—”表示尚无当前有效成绩；正常评测得到的 0
        分（0%）会明确显示。题目版本变化后旧成绩失效，历史提交保留。基础题下架后仍保留当前版本成绩；攻防题下架后动态成绩失效。
      </div>
      {error && (
        <div className="prd-error" role="alert">
          {error} 请点击“刷新成绩”重试。
        </div>
      )}

      {selectedUserId ? (
        detailLoading ? (
          <div className="prd-loading" role="status">
            正在加载学生成绩明细…
          </div>
        ) : (
          detail && (
            <>
              <section className="prd-panel" aria-label="学生成绩汇总">
                <h2>{detail.student.displayName || detail.student.username}</h2>
                <p className="prd-muted">
                  账号：{detail.student.username} · 学号：{detail.student.studentId || '未填写'} · 学校：
                  {detail.student.school || '未填写'}
                </p>
                <div className="student-scores-summary">
                  <div>
                    <span>基础题总分</span>
                    <strong>{numberFormat.format(detail.student.basicTotalScore)}</strong>
                  </div>
                  <div>
                    <span>基础题已计分</span>
                    <strong>{detail.student.basicScoredQuestionCount} 题</strong>
                  </div>
                  <div>
                    <span>累计已提交</span>
                    <strong>{detail.student.submittedQuestionCount} 题</strong>
                  </div>
                  <div>
                    <span>最近提交</span>
                    <strong className="student-scores-date">
                      {formatDate(detail.student.lastSubmittedAt)}
                    </strong>
                  </div>
                </div>
              </section>
              <section className="prd-panel" aria-label="逐题成绩明细">
                <h2>逐题成绩明细</h2>
                <p className="prd-muted">
                  基础题重复提交保留最高有效分；攻防题以最新有效算法的动态胜率为准，新算法未通过基线或评测异常时保留已有有效成绩。最新提交状态单独展示。
                </p>
                <QuestionRows questions={detail.questions} />
              </section>
            </>
          )
        )
      ) : (
        <section className="prd-panel" aria-label="学生列表">
          <form className="prd-toolbar student-scores-search" onSubmit={searchStudents}>
            <label htmlFor="student-score-search">搜索学生</label>
            <input
              id="student-score-search"
              className="prd-input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="姓名、账号或学号"
            />
            <button className="prd-button primary" type="submit">
              搜索
            </button>
            {search && (
              <button
                className="prd-button"
                type="button"
                onClick={() => {
                  setSearchInput('')
                  setSearch('')
                  setPage(1)
                }}
              >
                清除筛选
              </button>
            )}
          </form>
          {listLoading ? (
            <div className="prd-loading" role="status">
              正在加载学生列表…
            </div>
          ) : (
            list && (
              <>
                <div className="prd-table-wrap">
                  <table className="prd-table student-scores-students">
                    <thead>
                      <tr>
                        <th>学生 / 账号</th>
                        <th>学号 / 学校</th>
                        <th>基础题总分</th>
                        <th>已提交题数</th>
                        <th>最近提交</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.students.map((student) => (
                        <tr key={student.userId}>
                          <td>
                            <strong>{student.displayName || student.username}</strong>
                            <div className="student-scores-secondary">{student.username}</div>
                          </td>
                          <td>
                            {student.studentId || '未填写学号'}
                            <div className="student-scores-secondary">{student.school || '未填写学校'}</div>
                          </td>
                          <td>
                            <strong className="student-scores-value">
                              {numberFormat.format(student.basicTotalScore)}
                            </strong>
                            <div className="student-scores-secondary">
                              {student.basicScoredQuestionCount} 题已计分
                            </div>
                          </td>
                          <td>{student.submittedQuestionCount}</td>
                          <td>{formatDate(student.lastSubmittedAt)}</td>
                          <td>
                            <button
                              className="prd-button"
                              onClick={() => selectStudent(student.userId)}
                              aria-label={`查看${student.displayName || student.username}的逐题成绩`}
                            >
                              查看逐题成绩
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!list.students.length && (
                        <tr>
                          <td className="student-scores-empty" colSpan={6}>
                            {search ? '没有找到匹配的学生，可修改或清除搜索条件。' : '暂无学生账号。'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="prd-split student-scores-pagination">
                  <span className="prd-muted">
                    共 {list.total} 名学生 · 第 {page} / {pageCount} 页 · 每页 {PAGE_SIZE} 人
                  </span>
                  <div className="student-scores-actions">
                    <button
                      className="prd-button"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      上一页
                    </button>
                    <button
                      className="prd-button"
                      disabled={page >= pageCount}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </>
            )
          )}
        </section>
      )}
    </div>
  )
}
