import { useEffect, useState } from 'react'
import { prdApi, type BasicRank } from '../lib/prdApi'
import { useAuth } from '../contexts/AuthContext'
export default function Leaderboard() {
  const { user } = useAuth()
  const [entries, setEntries] = useState<BasicRank[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setError('')
    prdApi
      .ranks()
      .then((data) => {
        if (!stopped) setEntries(data)
      })
      .catch((err) => {
        if (!stopped) setError(err instanceof Error ? err.message : '排行榜加载失败。')
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [attempt])
  return (
    <div className="prd-page">
      <h1>基础题排行榜</h1>
      <p className="prd-muted">
        按全范围基础题最高分之和排序。同分时，先达到当前总分的同学排在前面；攻防百分比单独展示。
      </p>
      {error && (
        <div className="prd-error" role="alert">
          {error}{' '}
          <button className="prd-button" onClick={() => setAttempt((v) => v + 1)}>
            重新加载
          </button>
        </div>
      )}
      <div className="prd-panel prd-table-wrap">
        {loading ? (
          <div className="prd-loading">正在加载排行榜…</div>
        ) : (
          <table className="prd-table">
            <thead>
              <tr>
                <th>排名</th>
                <th>同学</th>
                <th>基础总分</th>
                <th>完成基础题</th>
                <th>达到当前总分时间</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <tr
                  key={row.userId}
                  style={row.userId === user?.id ? { background: 'var(--brand-cyan-dim)' } : undefined}
                >
                  <td>#{row.rank}</td>
                  <td>
                    {row.displayName}
                    {row.userId === user?.id ? '（我）' : ''}
                  </td>
                  <td>{(row.basicScore ?? row.totalScore).toFixed(2)}</td>
                  <td>{row.tasksCompleted ?? '—'}</td>
                  <td>{row.scoreReachedAt ? new Date(row.scoreReachedAt).toLocaleString('zh-CN') : '—'}</td>
                </tr>
              ))}
              {!entries.length && (
                <tr>
                  <td colSpan={5}>{error ? '排行榜暂不可用。' : '暂无基础题成绩。'}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
