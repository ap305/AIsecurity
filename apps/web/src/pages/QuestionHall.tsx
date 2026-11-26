import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { prdApi, statusLabel, type HallCategory, type QuestionRecord } from '../lib/prdApi'
import { difficultyLabels, difficultyGuide, displayQuestionTitle, teachingDifficulty } from '../lib/questionPresentation'
import {
  filterHallQuestions,
  hallPage,
  hallScene,
  hallSceneLabels,
  questionAttemptState,
  questionKinds,
  questionModuleLabel,
  hallFilterParams,
  hallLibraryQuestions,
} from '../lib/hallFilters'
import './QuestionHall.css'

const attemptStates: Record<string, string> = {
  not_submitted: '未提交',
  running: '评测中',
  scored: '已有成绩',
  attempted: '已尝试 · 未计分',
  error: '需要重试',
}
const PAGE_SIZE = 20

export default function QuestionHall({ category }: { category: HallCategory }) {
  const { isAdmin, user } = useAuth()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [questionRows, setQuestions] = useState<QuestionRecord[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const questions = loadedFor === user?.id ? questionRows : []
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const adversarial = category === 'adversarial'
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setQuestions([])
    setError('')
    const ownerId = user?.id
    if (!ownerId) {
      setLoading(false)
      return
    }
    prdApi
      .questions(category)
      .then((items) => {
        if (!cancelled) {
          setQuestions(items)
          setLoadedFor(ownerId)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '题目加载失败。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [category, attempt, user?.id])
  const updateFilter = (name: string, value: string) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value) next.set(name, value)
        else next.delete(name)
        if (name !== 'page') next.delete('page')
        if (name === 'scene') next.delete('scenario')
        return next
      },
      { replace: true },
    )
  }
  const libraryQuestions = useMemo(
    () => hallLibraryQuestions(questions, category),
    [questions, category],
  )
  const filterParams = useMemo(() => hallFilterParams(params, category), [params, category])
  const filtered = useMemo(
    () => filterHallQuestions(libraryQuestions, filterParams),
    [libraryQuestions, filterParams],
  )
  const { page, pages } = hallPage(params.get('page'), filtered.length, PAGE_SIZE)
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => {
    if (filterParams.toString() !== params.toString()) {
      setParams(filterParams, { replace: true })
    }
  }, [params, setParams, filterParams])
  const attempted = libraryQuestions.filter((q) => questionAttemptState(q) !== 'not_submitted').length
  const scored = libraryQuestions.filter((q) => q.myScore != null).length
  const hasFilters = filterParams.size > 0
  const filterCount = ['q', 'difficulty', 'kind', 'state', 'role']
    .filter((name) => filterParams.get(name)).length
  const select = (name: string, label: string, choices: Record<string, string>) => (
    <label className="hall-filter">
      <span>{label}</span>
      <select
        className="prd-input"
        aria-label={label}
        aria-describedby={adversarial && name === 'difficulty' ? 'hall-difficulty-guide' : undefined}
        value={params.get(name) || ''}
        onChange={(e) => updateFilter(name, e.target.value)}
      >
        <option value="">全部{label}</option>
        {Object.entries(choices).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="prd-page question-hall" data-filters-open={filtersOpen}>
      <header className="hall-heading">
        <div>
          <h1>{adversarial ? '对抗题库' : '基础题库'}</h1>
          <p className="prd-muted">
            {adversarial
              ? '按场景查找题目，在题目对应的攻击或防御角色下作答。'
              : '选择一道题，在左右分栏工作台阅读题目、编写代码并查看评测结果。'}
          </p>
        </div>
        <dl className="hall-progress" aria-label="我的练习进度">
          <div>
            <dt>已开放</dt>
            <dd>{loading || error ? '—' : libraryQuestions.length}</dd>
          </div>
          <div>
            <dt>已尝试</dt>
            <dd>{loading || error ? '—' : attempted}</dd>
          </div>
          <div>
            <dt>已有成绩</dt>
            <dd>{loading || error ? '—' : scored}</dd>
          </div>
        </dl>
      </header>
      <div className="hall-toolbar">
        {adversarial && (
          <div className="hall-scenarios" role="group" aria-label="场景">
            {Object.entries({ '': '全部场景', ...hallSceneLabels }).map(([value, label]) => {
              const selected = (filterParams.get('scene') || '') === value
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  className={selected ? 'selected' : undefined}
                  onClick={() => updateFilter('scene', value)}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          className="prd-button hall-filter-toggle"
          aria-controls="hall-filters"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {filtersOpen ? '收起筛选' : '搜索与筛选'}
          {filterCount > 0 && `（${filterCount}）`}
        </button>
        <button
          className="prd-button hall-refresh"
          disabled={loading}
          aria-busy={loading}
          onClick={() => setAttempt((v) => v + 1)}
        >
          {loading ? '加载中…' : '刷新题库'}
        </button>
      </div>
      <div id="hall-filters">
        <section className="hall-controls" aria-label="筛选题目">
          <label className="hall-search">
            <span>搜索</span>
            <input
              className="prd-input"
              aria-label="搜索题号、题目或场景"
              placeholder="搜索题号、题目或场景…"
              value={params.get('q') || ''}
              onChange={(e) => updateFilter('q', e.target.value)}
            />
          </label>
          {select('difficulty', '难度', difficultyLabels)}
          {!adversarial && select('kind', '题型', questionKinds)}
          {select('state', '状态', attemptStates)}
          {adversarial && select('role', '角色', { attack: '攻击', defense: '防御' })}
          {adversarial && <small id="hall-difficulty-guide" className="hall-difficulty-guide">{difficultyGuide}</small>}
        </section>
      </div>
      <div className="hall-table-heading">
        <span>{loading ? '正在加载题库…' : error ? '题库加载失败' : `${filtered.length} 道题目`}</span>
        <div>
          <label>
            排序{' '}
            <select
              aria-label="题目排序"
              value={params.get('sort') || 'number'}
              onChange={(e) => updateFilter('sort', e.target.value)}
            >
              <option value="number">题号</option>
              <option value="difficulty">难度</option>
              <option value="score">我的成绩</option>
            </select>
          </label>
          {hasFilters && (
            <button className="hall-text-button" onClick={() => setParams({}, { replace: true })}>
              重置筛选
            </button>
          )}
        </div>
      </div>
      {error && (
        <div role="alert" className="prd-error">
          {error}{' '}
          <button className="prd-button" onClick={() => setAttempt((v) => v + 1)}>
            重新加载
          </button>
        </div>
      )}
      <div
        className="prd-panel prd-table-wrap hall-table-panel"
        role="region"
        aria-label="题目列表，可横向滚动"
        tabIndex={0}
      >
        {loading ? (
          <div className="prd-loading">正在加载题目…</div>
        ) : (
          <table className="prd-table hall-table">
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">题目</th>
                {adversarial && <th scope="col">固定角色</th>}
                <th scope="col">{adversarial ? '难度' : '难度 / 题型'}</th>
                <th scope="col">{adversarial ? '当前成绩' : '我的最高分'}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((q) => {
                const state = questionAttemptState(q)
                const scene = adversarial ? hallScene(q) : undefined
                const role = q.role || q.definition.role
                const difficulty = teachingDifficulty(q)
                return (
                  <tr key={q.id}>
                    <td>
                      <span
                        className={`hall-state hall-state-${state}`}
                        title={statusLabel(q.latestSubmissionStatus || q.myStatus)}
                      >
                        {attemptStates[state]}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="hall-question-link"
                        state={{ hallLocation: location.pathname + location.search }}
                        to={`${adversarial ? '/arena' : '/question'}/${encodeURIComponent(q.id)}`}
                      >
                        <span className="hall-question-number">{q.id}</span>
                        <strong>{displayQuestionTitle(q)}</strong>
                      </Link>
                      <div className="hall-question-meta">
                        {adversarial ? (scene && hallSceneLabels[scene]) : (
                          <>
                            {questionModuleLabel(q.moduleCode)}
                            {q.tags?.length ? ` · ${q.tags.join(' / ')}` : ''}
                          </>
                        )}
                      </div>
                    </td>
                    {adversarial && (
                      <td>
                        <span className={`hall-role hall-role-${role}`}>
                          {role === 'attack'
                            ? '攻击'
                            : role === 'defense'
                              ? '防御'
                              : '配置未就绪'}
                        </span>
                      </td>
                    )}
                    <td>
                      <span className={`hall-difficulty hall-difficulty-${difficulty}`}>
                        {difficultyLabels[difficulty] || difficulty}
                      </span>
                      {!adversarial && <div className="hall-question-meta">
                        {questionKinds[q.definition.kind] || q.definition.kind}
                      </div>}
                    </td>
                    <td className="hall-score">
                      {q.myScore == null ? '—' : `${q.myScore.toFixed(2)}${adversarial ? '%' : ''}`}
                      {q.dynamicScore?.emptyPool && <div className="hall-question-meta">暂无有效对手</div>}
                      {q.dynamicScore?.updating && (
                        <div className="hall-question-meta">重评中 · 保留原成绩</div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={adversarial ? 5 : 4}>
                    <div className="hall-empty">
                      <strong>
                        {error
                          ? '题库暂时不可用'
                          : libraryQuestions.length
                            ? '没有符合筛选条件的题目'
                            : adversarial
                              ? '暂未开放攻防题目'
                              : '基础练习暂未开放提交'}
                      </strong>
                      <p>
                        {error
                          ? '请重新加载题库。'
                          : libraryQuestions.length
                            ? '调整筛选条件，查看其他题目。'
                            : '题目完成评测配置并发布后，会显示在这里。'}
                      </p>
                      {hasFilters && !error && (
                        <button
                          className="prd-button"
                          onClick={() => setParams({}, { replace: true })}
                        >
                          清除筛选，查看题库
                        </button>
                      )}
                      {!libraryQuestions.length &&
                        !error &&
                        (isAdmin ? (
                          <Link to="/admin/questions">前往题目管理</Link>
                        ) : (
                          <Link to={adversarial ? '/' : '/arena'}>
                            {adversarial ? '返回基础题库' : '前往对抗题库'}
                          </Link>
                        ))}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="hall-footer">
        <span className="prd-muted">
          {adversarial
            ? '通过基线后按有效对手胜率计分；正常失败仍计入分母。'
            : '每题保留最高有效分，基础总分参与排行榜。'}
        </span>
        <nav aria-label="题目列表分页">
          <button
            className="prd-button"
            disabled={loading || page <= 1}
            onClick={() => updateFilter('page', String(page - 1))}
          >
            上一页
          </button>
          <span aria-live="polite">
            {page} / {pages}
          </span>
          <button
            className="prd-button"
            disabled={loading || page >= pages}
            onClick={() => updateFilter('page', String(page + 1))}
          >
            下一页
          </button>
        </nav>
      </div>
    </div>
  )
}
