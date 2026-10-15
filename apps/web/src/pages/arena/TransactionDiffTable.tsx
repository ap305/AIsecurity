import type { ReviewMetrics, TransactionStatus } from './deriveReview'
import { BANKBOT_SCENARIO } from './scenario'

interface TransactionDiffTableProps {
  metrics: ReviewMetrics
  attackerIban: string
}

const STATUS_LABEL: Record<TransactionStatus, string> = {
  UNCHANGED: '未变更',
  BLOCKED: '已拦截',
  HIJACKED: '已劫持',
  MODIFIED: '已修改',
}

const STATUS_COLOR: Record<TransactionStatus, string> = {
  UNCHANGED: 'var(--text-muted)',
  BLOCKED: 'var(--brand-cyan)',
  HIJACKED: 'var(--danger)',
  MODIFIED: 'var(--warning)',
}

export default function TransactionDiffTable({ metrics, attackerIban }: TransactionDiffTableProps) {
  const initial = BANKBOT_SCENARIO.scheduledTransactions
  const finalMap = new Map(metrics.finalTransactions.map(t => [t.id, t.recipient]))

  return (
    <div style={containerStyle}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', fontSize: 10 }}>
            <th style={cellHead}>#</th>
            <th style={cellHead}>收款方</th>
            <th style={cellHead}>原始 IBAN</th>
            <th style={cellHead}>最终 IBAN</th>
            <th style={cellHead}>尝试次数</th>
            <th style={cellHead}>状态</th>
          </tr>
        </thead>
        <tbody>
          {metrics.changedTransactions.map(c => {
            const init = initial.find(t => t.id === c.transactionId)
            const final = finalMap.get(c.transactionId) ?? c.final
            const isAttacker = final === attackerIban
            return (
              <tr
                key={c.transactionId}
                style={{
                  borderTop: '1px solid var(--border-color)',
                  background:
                    c.status === 'HIJACKED'
                      ? 'rgba(255, 107, 107, 0.06)'
                      : c.status === 'BLOCKED'
                        ? 'rgba(0, 212, 255, 0.04)'
                        : 'transparent',
                }}
              >
                <td style={{ ...cellBody, color: 'var(--text-muted)' }}>{c.transactionId}</td>
                <td style={cellBody}>
                  <div style={{ color: 'var(--text-primary)' }}>{init?.recipientLabel}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 9 }}>
                    {init?.subject}
                  </div>
                </td>
                <td style={{ ...cellBody, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  {maskIban(c.original)}
                </td>
                <td
                  style={{
                    ...cellBody,
                    fontFamily: 'var(--font-mono)',
                    color: isAttacker ? 'var(--danger)' : c.status === 'UNCHANGED' ? 'var(--text-muted)' : 'var(--text-primary)',
                  }}
                >
                  {maskIban(final)}
                  {isAttacker && (
                    <span style={{ color: 'var(--danger)', marginLeft: 4, fontSize: 10 }}>
                      ← attacker
                    </span>
                  )}
                </td>
                <td style={{ ...cellBody, color: 'var(--text-secondary)', textAlign: 'center' }}>
                  {c.attemptedUpdates > 0 ? c.attemptedUpdates : '-'}
                </td>
                <td style={cellBody}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontSize: 10,
                      fontWeight: 600,
                      color: STATUS_COLOR[c.status],
                      border: `1px solid ${STATUS_COLOR[c.status]}`,
                    }}
                  >
                    {STATUS_LABEL[c.status]}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Summary */}
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          gap: 12,
          fontSize: 10,
          color: 'var(--text-muted)',
        }}
      >
        <SummaryItem label="未变更" count={metrics.unchangedCount} color="var(--text-muted)" />
        <SummaryItem label="已拦截" count={metrics.blockedCount} color="var(--brand-cyan)" />
        <SummaryItem label="已劫持" count={metrics.hijackedCount} color="var(--danger)" />
        <SummaryItem label="已修改" count={metrics.modifiedCount} color="var(--warning)" />
      </div>
    </div>
  )
}

function SummaryItem({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          background: color,
          borderRadius: 2,
        }}
      />
      {label}: <strong style={{ color }}>{count}</strong>
    </span>
  )
}

function maskIban(iban: string): string {
  if (!iban || iban.length < 8) return iban
  return `${iban.slice(0, 4)}...${iban.slice(-4)}`
}

const containerStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: 10,
}

const cellHead: React.CSSProperties = {
  textAlign: 'left',
  padding: '4px 6px',
  fontWeight: 500,
  borderBottom: '1px solid var(--border-color)',
}

const cellBody: React.CSSProperties = {
  padding: '4px 6px',
  verticalAlign: 'top',
}
