import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { apiGet } from '../lib/api'
import type { QuestionRecord } from '../lib/prdApi'
import {
  formatLegacyUploadSize,
  legacyUploadScope,
  normalizeLegacyUploads,
  type LegacyUploadRecord,
  type LegacyUploadScope,
} from '../lib/legacyUploadHistory'

function HistoryForScope({ scope }: { scope: LegacyUploadScope }) {
  const [records, setRecords] = useState<LegacyUploadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const { query, scenario, role } = scope

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    setRecords([])
    apiGet<unknown>(query)
      .then((data) => {
        if (!cancelled) setRecords(normalizeLegacyUploads(data, { query, scenario, role }))
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [query, scenario, role, attempt])

  return (
    <section className="legacy-upload-history">
      <h3>原版上传记录</h3>
      <p className="prd-muted">
        以下为本人在本场景{role === 'solo_attack' ? '攻击' : '防御'}
        角色的原版材料记录，供核对历史上传及归档情况；它们不代表新版评测结果或逐题成绩。
      </p>
      {loading ? (
        <p className="prd-muted" role="status">
          正在读取原版上传记录…
        </p>
      ) : error ? (
        <div className="prd-error" role="alert">
          原版上传记录暂时无法加载。
          <button className="prd-button" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </button>
        </div>
      ) : records.length ? (
        <div className="prd-table-wrap">
          <table className="prd-table">
            <caption className="prd-muted">原版材料与归档状态</caption>
            <thead>
              <tr>
                <th>文件名</th>
                <th>版本</th>
                <th>上传时间</th>
                <th>大小</th>
                <th>归档状态</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, index) => (
                <tr key={`${record.fileName}-${record.version}-${record.uploadedAt}-${index}`}>
                  <td>{record.fileName}</td>
                  <td>{record.version == null ? '未记录' : `v${record.version}`}</td>
                  <td>
                    {record.uploadedAt ? new Date(record.uploadedAt).toLocaleString('zh-CN') : '未记录'}
                  </td>
                  <td>{formatLegacyUploadSize(record.size)}</td>
                  <td>
                    {record.archived === true ? '已归档' : record.archived === false ? '未归档' : '未记录'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="prd-muted">当前场景与角色没有本人的原版上传记录。</p>
      )}
    </section>
  )
}

export default function LegacyUploadHistory({ question }: { question: QuestionRecord }) {
  const { user } = useAuth()
  const scope = legacyUploadScope(question)
  if (!scope || !user) return null
  // Reset synchronously when the authenticated user or question changes. Cleanup
  // also prevents an older response from repopulating the next scope's table.
  return <HistoryForScope key={`${user.id}:${question.id}:${scope.query}`} scope={scope} />
}
