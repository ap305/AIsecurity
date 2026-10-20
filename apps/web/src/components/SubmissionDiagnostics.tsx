function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function numeric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}
function stateLabel(value: unknown) {
  const labels: Record<string, string> = {
    queued: '排队中',
    pending: '等待中',
    running: '进行中',
    completed: '完成',
    passed: '通过',
    failed: '未通过',
    error: '异常',
    timeout: '超时',
    cancelled: '已取消',
    scored: '已计分',
    unqualified: '未过基线',
    baseline_failed: '未过基线',
    active: '有效',
    updating: '更新中',
    superseded: '已被后续版本替换',
    stale: '旧版本',
  }
  return typeof value === 'string' ? (labels[value] ?? '等待状态更新') : '等待状态更新'
}

/** This view only consumes the student's explicit public diagnostics DTO. It never renders raw evaluator logs. */
export default function SubmissionDiagnostics({ value }: { value: unknown }) {
  const diagnostics = record(value)
  if (!diagnostics) return null
  const baseline = record(diagnostics.baseline)
  const evaluation = record(diagnostics.evaluation)
  const progress = record(diagnostics.progress)
  const metrics = record(diagnostics.metrics)
  const pairs = Array.isArray(evaluation?.pairs) ? evaluation.pairs.map(record).filter(Boolean) : []
  return (
    <div className="solve-diagnostics">
      {diagnostics.historicalVersion === true && (
        <p className="prd-notice">这是旧题目版本的评测记录，仅供回顾，不代表当前版本成绩。</p>
      )}
      {baseline && (
        <section>
          <h3>基线资格</h3>
          <p>
            {typeof baseline.metric === 'string' ? baseline.metric : '基线指标'}：
            <strong>{numeric(baseline.value)}</strong> / 门槛 ≥ {numeric(baseline.threshold)}
            {' · '}
            {baseline.passed === true ? '通过' : baseline.passed === false ? '未通过' : '等待实测结果'}
          </p>
          {diagnostics.role === 'defense' && diagnostics.evaluationVersion === 'v3-api-cumulative-reference-20261016-v9' && typeof metrics?.leakedSpans === 'number' && (
            <p className="prd-notice">
              累计回复泄露片段：{numeric(metrics.leakedSpans)} / {numeric(metrics.samples)}。
              多轮回复会合并检查，单条回复未命中也可能累计泄露。
              {typeof metrics.utilityDrop === 'number' && ` 业务准确率下降 ${numeric(metrics.utilityDrop)} 个百分点（负值表示提升）。`}
              {baseline.passed === false && '这是正常评测未过基线，请改进防守算法后重新提交。'}
            </p>
          )}
        </section>
      )}
      {progress && (
        <p className="prd-muted" role="status">
          对手评测进度：{numeric(progress.completedOpponents)} / {numeric(progress.totalOpponents)}
          {' · '}
          {stateLabel(progress.state)}
        </p>
      )}
      {evaluation && (
        <section>
          <h3>本轮对抗</h3>
          <p>
            {stateLabel(evaluation.state)} · {evaluation.counted === true ? '已正式计分' : '本轮尚未计分'}
            {typeof evaluation.snapshotRevision === 'number' &&
              ' · 对手池版本 ' + evaluation.snapshotRevision}
          </p>
          {evaluation.emptyPool === true && <p className="prd-muted">本轮没有有效对手，按规则记 100%。</p>}
          {pairs.length > 0 && (
            <div className="prd-table-wrap">
              <table className="prd-table solve-pairs-table">
                <thead>
                  <tr>
                    <th>对手</th>
                    <th>状态</th>
                    <th>判定指标</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map(
                    (pair, index) =>
                      pair && (
                        <tr key={index}>
                          <td>对手 {numeric(pair.ordinal)}</td>
                          <td>{stateLabel(pair.state)}</td>
                          <td>
                            {typeof pair.metric === 'string' ? pair.metric : '指标'} {numeric(pair.value)} / ≥{' '}
                            {numeric(pair.threshold)}
                          </td>
                          <td>
                            {pair.success === true ? '成功' : pair.success === false ? '失败' : '尚未完成'}
                          </td>
                        </tr>
                      ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
