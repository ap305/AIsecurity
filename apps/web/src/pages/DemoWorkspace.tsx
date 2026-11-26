import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import './DemoWorkspace.css'

const question = '机器遗忘与遗忘验证（防御）'
const steps = [
  { title: '准备提交', text: '为示例学员 01 选择模型附件，再将代码和附件一并提交。', action: '选择示例附件' },
  { title: '材料已就绪', text: '已选择 solution.py 和 model.pt。', action: '提交示例' },
  { title: '等待评测', text: '第 1 次提交已受理，评测任务已进入队列。', action: '开始基线评测' },
  { title: '基线评测中', text: '系统正在检验本次提交是否达到题目的准入条件。', action: '查看基线结果' },
  {
    title: '基线资格未通过',
    text: '本次不计分。学员可以修改代码、更换附件后重新提交。',
    action: '修改代码并更换示例附件',
  },
  {
    title: '重交材料已就绪',
    text: '代码与模型附件均已更新，第 1 次提交记录仍可查看。',
    action: '重新提交示例',
  },
  { title: '重交已排队', text: '第 2 次提交已受理，等待基线评测。', action: '查看基线与对抗进度' },
  {
    title: '基线已通过，正在对抗评测',
    text: '本次进入对手池评测，系统将按胜出的对手占比计算成绩。',
    action: '查看评分结果',
  },
  { title: '评测完成', text: '对 4 个示例对手胜出 3 场，当前成绩为 75.00%。', action: '从头演示' },
] as const
const last = steps.length - 1

interface DemoRecord {
  id: string
  student: string
  attempt: string
  state: string
  score: string
  detail: string
}

function recordsAt(step: number): DemoRecord[] {
  const records: DemoRecord[] = []
  if (step >= 6)
    records.push({
      id: 'DEMO-02',
      student: '示例学员 01',
      attempt: '第 2 次',
      state: steps[step].title,
      score: step === last ? '75.00%' : '待出分',
      detail: step === last ? '已过基线。4 场对抗胜出 3 场，胜率 75.00%。' : steps[step].text,
    })
  if (step >= 2)
    records.push({
      id: 'DEMO-01',
      student: '示例学员 01',
      attempt: '第 1 次',
      state: step >= 4 ? steps[4].title : steps[step].title,
      score: step >= 4 ? '本次不计分' : '待出分',
      detail: step >= 4 ? '未达到基线准入条件，本次没有产生分数。' : steps[step].text,
    })
  records.push({
    id: 'DEMO-03',
    student: '示例学员 02',
    attempt: '第 1 次',
    state: '评测完成',
    score: '0.00%',
    detail: '已通过基线，对 4 个示例对手均未胜出，有效成绩为 0.00%。',
  })
  return records
}

function Flow({ step, advance }: { step: number; advance: () => void }) {
  const current = steps[step]
  return (
    <>
      <h1>提交流程</h1>
      <p className="demo-intro">以示例学员 01 的两次提交，逐步查看附件上传、基线检验、重交和评分。</p>
      <article className="demo-panel">
        <header className="demo-question">
          <span>深度学习 · D25</span>
          <h2>{question}</h2>
        </header>
        <progress max={last} value={step} aria-label="演示进度" />
        <div className="demo-stage" aria-live="polite" aria-atomic="true">
          <p>
            步骤 {step + 1} / {steps.length}
          </p>
          <h3>{current.title}</h3>
          <p>{current.text}</p>
        </div>
        <div className="demo-actions">
          <button type="button" className="btn-primary" onClick={advance}>
            {current.action}
          </button>
          <Link to="/demo/records">查看评测记录</Link>
        </div>
      </article>
    </>
  )
}

function EvaluationRecords({ records }: { records: DemoRecord[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const active = records.find((row) => row.id === selected)
  return (
    <>
      <h1>评测记录</h1>
      <p className="demo-intro">选择一条示例记录，查看该次提交的资格、评分和判定说明。</p>
      <div className="demo-panel">
        <div className="demo-table-wrap">
          <table>
            <caption className="demo-caption">示例提交 · {question}</caption>
            <thead>
              <tr>
                <th scope="col">提交编号</th>
                <th scope="col">学员</th>
                <th scope="col">状态</th>
                <th scope="col">本次成绩</th>
              </tr>
            </thead>
            <tbody>
              {records.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <button
                      className="demo-link"
                      type="button"
                      aria-expanded={selected === row.id}
                      onClick={() => setSelected(selected === row.id ? null : row.id)}
                    >
                      {row.id}
                    </button>
                  </th>
                  <td>{row.student}</td>
                  <td>{row.state}</td>
                  <td>{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {active && (
          <section className="demo-detail" aria-live="polite">
            <h2>
              {active.id} · {active.attempt}提交
            </h2>
            <p>{active.detail}</p>
          </section>
        )}
      </div>
    </>
  )
}

function ClassScores({ records, step }: { records: DemoRecord[]; step: number }) {
  const [group, setGroup] = useState('A')
  const [selected, setSelected] = useState<string | null>(null)
  const students = group === 'A' ? ['示例学员 01', '示例学员 02'] : ['示例学员 03']
  return (
    <>
      <h1>班级成绩</h1>
      <p className="demo-intro">选择示例班级和学员，查看逐题成绩和最近一次提交状态。</p>
      <div className="demo-panel">
        <div className="demo-picker">
          <label htmlFor="demo-class-filter">班级</label>
          <select
            id="demo-class-filter"
            className="form-input"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value)
              setSelected(null)
            }}
          >
            <option value="A">示例 A 班</option>
            <option value="B">示例 B 班</option>
          </select>
        </div>
        <div className="demo-table-wrap">
          <table>
            <caption className="demo-caption">{question}</caption>
            <thead>
              <tr>
                <th scope="col">学员</th>
                <th scope="col">当前成绩</th>
                <th scope="col">最近一次提交状态</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => {
                const latest = records.find((row) => row.student === student)
                const score =
                  student === '示例学员 02'
                    ? '0.00%'
                    : student === '示例学员 01' && step === last
                      ? '75.00%'
                      : '暂无成绩'
                return (
                  <tr key={student}>
                    <th scope="row">
                      <button
                        type="button"
                        className="demo-link"
                        aria-expanded={selected === student}
                        onClick={() => setSelected(selected === student ? null : student)}
                      >
                        {student}
                      </button>
                    </th>
                    <td>{score}</td>
                    <td>{latest?.state ?? '未提交'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {selected && (
          <section className="demo-detail" aria-live="polite">
            <h2>{selected}的逐题记录</h2>
            {records.filter((row) => row.student === selected).length ? (
              <ul>
                {records
                  .filter((row) => row.student === selected)
                  .map((row) => (
                    <li key={row.id}>
                      {row.attempt}提交 · {row.state} · {row.score}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>该学员暂无提交记录。</p>
            )}
          </section>
        )}
      </div>
    </>
  )
}

export default function DemoWorkspace() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const records = recordsAt(step)
  async function exitDemo() {
    setLeaving(true)
    try {
      const result = await logout()
      if (!result.sessionChanged) navigate('/login?returnTo=%2Fdemo', { replace: true })
    } finally {
      setLeaving(false)
    }
  }
  return (
    <div className="demo-workspace">
      <a className="skip-to-content" href="#demo-content">
        跳转到主要内容
      </a>
      <header className="demo-top">
        <Link to="/demo" className="demo-brand">
          ai安全教学实验平台
        </Link>
        <div>
          <span>只读演示账号</span>
          <button type="button" className="topbar-logout" disabled={leaving} onClick={exitDemo}>
            {leaving ? '退出中…' : '退出'}
          </button>
        </div>
      </header>
      <div className="demo-shell">
        <aside>
          <h2>演示工作台</h2>
          <nav aria-label="演示工作台">
            <NavLink end to="/demo">
              提交流程
            </NavLink>
            <NavLink to="/demo/records">评测记录</NavLink>
            <NavLink to="/demo/classes">班级成绩</NavLink>
          </nav>
        </aside>
        <main id="demo-content" tabIndex={-1}>
          <p className="demo-notice">只读演示 · 学员、评测和成绩均为示例数据。演示操作仅在当前页面生效。</p>
          <Routes>
            <Route
              index
              element={
                <Flow step={step} advance={() => setStep((value) => (value === last ? 0 : value + 1))} />
              }
            />
            <Route path="records" element={<EvaluationRecords records={records} />} />
            <Route path="classes" element={<ClassScores records={records} step={step} />} />
            <Route path="*" element={<Navigate to="/demo" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
