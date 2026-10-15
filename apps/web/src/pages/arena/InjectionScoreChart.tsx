import type { InjectionScorePoint } from './deriveReview'

interface InjectionScoreChartProps {
  data: InjectionScorePoint[]
  threshold: number
}

const W = 480
const H = 160
const PAD = 28

export default function InjectionScoreChart({ data, threshold }: InjectionScoreChartProps) {
  if (data.length === 0) {
    return (
      <div style={emptyStyle}>
        <span style={{ color: 'var(--text-muted)' }}>无注入分数数据</span>
      </div>
    )
  }

  const maxScore = Math.max(threshold, ...data.map(d => d.score), 5)
  const xStep = data.length === 1 ? 0 : (W - 2 * PAD) / (data.length - 1)
  const points = data.map((d, i) => ({
    x: PAD + i * xStep,
    y: H - PAD - (d.score / maxScore) * (H - 2 * PAD),
    score: d.score,
    triggered: d.triggered,
    queryNum: d.queryNum,
  }))

  const thresholdY = H - PAD - (threshold / maxScore) * (H - 2 * PAD)

  return (
    <div style={containerStyle}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* Grid lines */}
        {[0, 0.5, 1].map(t => {
          const y = H - PAD - t * (H - 2 * PAD)
          return (
            <line
              key={t}
              x1={PAD}
              y1={y}
              x2={W - PAD}
              y2={y}
              stroke="var(--border-color)"
              strokeWidth={1}
            />
          )
        })}

        {/* Threshold dashed line */}
        <line
          x1={PAD}
          y1={thresholdY}
          x2={W - PAD}
          y2={thresholdY}
          stroke="var(--warning)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text
          x={W - PAD}
          y={thresholdY - 4}
          fill="var(--warning)"
          fontSize={9}
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          阈值={threshold}
        </text>

        {/* Polyline */}
        <polyline
          points={points.map(p => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="var(--brand-cyan)"
          strokeWidth={2}
        />

        {/* Data points */}
        {points.map((p, i) => (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={4}
              fill={p.triggered ? 'var(--danger)' : 'var(--text-muted)'}
              stroke="var(--bg-card)"
              strokeWidth={1}
            />
            <text
              x={p.x}
              y={p.y - 8}
              fill={p.triggered ? 'var(--danger)' : 'var(--text-muted)'}
              fontSize={9}
              fontFamily="var(--font-mono)"
              textAnchor="middle"
            >
              {p.score}
            </text>
            <text
              x={p.x}
              y={H - PAD + 12}
              fill="var(--text-muted)"
              fontSize={9}
              fontFamily="var(--font-mono)"
              textAnchor="middle"
            >
              Q{p.queryNum}
            </text>
          </g>
        ))}
      </svg>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
        红点 = 已触发注入（score ≥ {threshold}） · 灰点 = 未触发
      </div>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: 8,
}

const emptyStyle: React.CSSProperties = {
  ...containerStyle,
  height: 120,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
}
