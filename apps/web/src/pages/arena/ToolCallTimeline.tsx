import type { ToolCallPoint } from './deriveReview'

interface ToolCallTimelineProps {
  data: ToolCallPoint[]
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'read',
  get_balance: 'balance',
  get_most_recent_transactions: 'recent',
  get_scheduled_transactions: 'scheduled',
  send_money: 'send',
  update_scheduled_transaction: 'update',
}

export default function ToolCallTimeline({ data }: ToolCallTimelineProps) {
  if (data.length === 0) {
    return (
      <div style={emptyStyle}>
        <span style={{ color: 'var(--text-muted)' }}>无工具调用记录</span>
      </div>
    )
  }

  // Group by queryNum
  const queries = Array.from(new Set(data.map(d => d.queryNum)))
  const maxCallsPerQuery = Math.max(
    ...queries.map(q => data.filter(d => d.queryNum === q).length),
  )

  return (
    <div style={containerStyle}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '60px 1fr',
          gap: 4,
          fontSize: 11,
        }}
      >
        {queries.map(q => {
          const calls = data.filter(d => d.queryNum === q)
          return (
            <div key={q} style={{ display: 'contents' }}>
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)',
                  padding: '3px 0',
                }}
              >
                Q{q}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  alignItems: 'center',
                  minHeight: 22,
                }}
              >
                {calls.length === 0 && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>（无工具调用）</span>
                )}
                {calls.map((c, i) => (
                  <ToolChip key={i} call={c} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
        <Legend color="var(--text-muted)" label="read/query" />
        <Legend color="var(--warning)" label="update (未触发)" />
        <Legend color="var(--danger)" label="update (注入触发)" />
        <Legend color="var(--brand-cyan)" label="已拦截" />
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
        最多调用次数 / query: {maxCallsPerQuery}
      </div>
    </div>
  )
}

function ToolChip({ call }: { call: ToolCallPoint }) {
  const color = chipColor(call)
  const label = TOOL_LABELS[call.tool] ?? call.tool
  const borderColor = call.injectionTriggered && call.tool === 'update_scheduled_transaction'
    ? 'var(--danger)'
    : 'transparent'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 3,
        background: 'var(--bg-primary)',
        border: `1px solid ${borderColor === 'transparent' ? color : borderColor}`,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color,
        opacity: call.blocked ? 0.7 : 1,
        textDecoration: call.blocked ? 'line-through' : 'none',
      }}
    >
      {call.blocked ? '⊘ ' : ''}{label}
    </span>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          background: color,
          borderRadius: 2,
        }}
      />
      {label}
    </span>
  )
}

function chipColor(call: ToolCallPoint): string {
  if (call.blocked) return 'var(--brand-cyan)'
  if (call.tool === 'update_scheduled_transaction' || call.tool === 'send_money') {
    return call.injectionTriggered ? 'var(--danger)' : 'var(--warning)'
  }
  return 'var(--text-muted)'
}

const containerStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: 10,
}

const emptyStyle: React.CSSProperties = {
  ...containerStyle,
  height: 120,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
}
