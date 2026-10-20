import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { prdApi, statusLabel, type HallCategory, type QuestionRecord } from '../lib/prdApi'
import {
  filterHallQuestions,
  hallPage,
  hallScenario,
  hallScenarios,
  questionAttemptState,
  questionKinds,
  questionModuleLabel,
  hallFilterParams,
  hallLibraryQuestions,
  resetHallFilters,
} from '../lib/hallFilters'
import './QuestionHall.css'

const difficulties: Record<string, string> = { L1: '入门', L2: '进阶', L3: '挑战' }
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
          setQuestions(items.filter((q) => q.category === category))
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
        if (name === 'group') next.delete('scenario')
        return next
      },
      { replace: true },
    )
  }
  const libraryQuestions = useMemo(
    () => hallLibraryQuestions(questions, category, params),
    [questions, category, params],
  )
  const filtered = useMemo(
    () => filterHallQuestions(libraryQuestions, hallFilterParams(params, category)),
    [libraryQuestions, params, category],
  )
  const { page, pages } = hallPage(params.get('page'), filtered.length, PAGE_SIZE)
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => {
    const next = hallFilterParams(params, category)
    if (next.toString() !== params.toString()) {
      next.delete('page')
      setParams(next, { replace: true })
    }
  }, [params, setParams, category])
  const scenarios = hallScenarios(libraryQuestions)
  const groups = [...new Set(scenarios.map((s) => s.group))]
  const attempted = libraryQuestions.filter((q) => questionAttemptState(q) !== 'not_submitted').length
  const scored = libraryQuestions.filter((q) => q.myScore != null).length
  const resetParams = resetHallFilters(params, category)
  const hasFilters = params.toString() !== resetParams.toString()
  const select = (name: string, label: string, choices: Record<string, string>) => (
    <label className="hall-filter">
      <span>{label}</span>
      <select
        className="prd-input"
        aria-label={label}
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
    <div className="prd-page question-hall">
      <header className="hall-heading">
        <div>
          <div className="hall-eyebrow">{adversarial ? '攻防训练' : '基础练习'}</div>
          <h1>
            {adversarial
              ? params.get('role') === 'attack'
                ? '攻击题库'
                : params.get('role') === 'defense'
                  ? '防御题库'
                  : '攻防题库'
              : '基础题库'}
          </h1>
          <p className="prd-muted">
            {adversarial
              ? '选择场景和固定角色，进入简报、编写代码、提交对战并复盘。'
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
        <nav className="hall-library-tabs" aria-label="选择题库类型">
          {[
            { to: '/', label: '基础题', active: !adversarial },
            {
              to: '/arena?role=attack',
              label: '攻击题',
              active: adversarial && params.get('role') === 'attack',
            },
            {
              to: '/arena?role=defense',
              label: '防御题',
              active: adversarial && params.get('role') === 'defense',
            },
          ].map((item) => (
            <Link key={item.to} to={item.to} aria-current={item.active ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          className="prd-button"
          disabled={loading}
          aria-busy={loading}
          onClick={() => setAttempt((v) => v + 1)}
        >
          {loading ? '加载中…' : '刷新题库'}
        </button>
      </div>
      {adversarial && scenarios.length > 0 && (
        <div className="hall-scenarios" aria-label="攻防场景">
          <button
            className={!params.get('scenario') ? 'selected' : ''}
            aria-pressed={!params.get('scenario')}
            onClick={() => updateFilter('scenario', '')}
          >
            全部场景
          </button>
          {scenarios
            .filter((s) => !params.get('group') || s.group === params.get('group'))
            .map((s) => (
              <button
                key={s.id}
                className={params.get('scenario') === s.id ? 'selected' : ''}
                aria-pressed={params.get('scenario') === s.id}
                onClick={() => updateFilter('scenario', s.id)}
              >
                {s.title}
              </button>
            ))}
        </div>
      )}
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
        {select('difficulty', '难度', difficulties)}
        {select('kind', '题型', questionKinds)}
        {select('state', '状态', attemptStates)}
        {adversarial ? (
          <>
            {select('group', '领域', Object.fromEntries(groups.map((g) => [g, g])))}
            {select('role', '角色', { attack: '攻击', defense: '防御' })}
          </>
        ) : null}
      </section>
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
            <button className="hall-text-button" onClick={() => setParams(resetParams, { replace: true })}>
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
      <div className="prd-panel prd-table-wrap hall-table-panel">
        {loading ? (
          <div className="prd-loading">正在加载题目…</div>
        ) : (
          <table className="prd-table hall-table">
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">题目</th>
                {adversarial && <th scope="col">固定角色</th>}
                <th scope="col">难度 / 题型</th>
                <th scope="col">{adversarial ? '当前成绩' : '我的最高分'}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((q) => {
                const state = questionAttemptState(q)
                const scenario = hallScenario(q)
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
                        <strong>{q.title}</strong>
                      </Link>
                      <div className="hall-question-meta">
                        {scenario
                          ? `${scenario.group} · ${scenario.title}`
                          : questionModuleLabel(q.moduleCode)}
                        {q.tags?.length ? ` · ${q.tags.join(' / ')}` : ''}
                      </div>
                    </td>
                    {adversarial && (
                      <td>
                        <span className={`hall-role hall-role-${q.definition.role}`}>
                          {q.definition.role === 'attack'
                            ? '攻击'
                            : q.definition.role === 'defense'
                              ? '防御'
                              : '配置未就绪'}
                        </span>
                      </td>
                    )}
                    <td>
                      <span className={`hall-difficulty hall-difficulty-${q.difficulty}`}>
                        {difficulties[q.difficulty] || q.difficulty}
                      </span>
                      <div className="hall-question-meta">
                        {questionKinds[q.definition.kind] || q.definition.kind}
                      </div>
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
                          : questions.length
                            ? '没有符合筛选条件的题目'
                            : adversarial
                              ? '暂未开放攻防题目'
                              : '基础练习暂未开放提交'}
                      </strong>
                      <p>
                        {error
                          ? '请重新加载题库。'
                          : questions.length
                            ? '调整筛选条件，查看其他题目。'
                            : '题目完成评测配置并发布后，会显示在这里。'}
                      </p>
                      {hasFilters && !error && (
                        <button
                          className="prd-button"
                          onClick={() => setParams(resetParams, { replace: true })}
                        >
                          清除筛选，查看题库
                        </button>
                      )}
                      {!questions.length &&
                        !error &&
                        (isAdmin ? (
                          <Link to="/admin/questions">前往题目管理</Link>
                        ) : (
                          <Link to={adversarial ? '/' : '/arena'}>
                            {adversarial ? '返回任务大厅' : '前往对战大厅练习'}
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
