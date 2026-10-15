import { useState } from 'react'
import type { LogEntry } from '../ArenaTerminal'
import ArenaTerminal from '../ArenaTerminal'
import type { ReviewMetrics } from './deriveReview'
import { BANKBOT_SCENARIO } from './scenario'
import ResultBanner from './ResultBanner'
import InjectionScoreChart from './InjectionScoreChart'
import ToolCallTimeline from './ToolCallTimeline'
import TransactionDiffTable from './TransactionDiffTable'

type Mode = 'solo_attack' | 'solo_defense'

interface ReviewPanelProps {
  mode: Mode
  result: {
    win?: boolean
    status?: string
    score?: number | null
    message?: string
    queries_used?: number
    fbr?: number
  } | null
  interactionLog: LogEntry[]
  attackerIban: string
  reviewMetrics: ReviewMetrics | null
  onRetry: () => void
  code: string
}

export default function ReviewPanel({
  mode,
  result,
  interactionLog,
  attackerIban,
  reviewMetrics,
  onRetry,
  code,
}: ReviewPanelProps) {
  const [showTerminal, setShowTerminal] = useState(false)
  const [showCode, setShowCode] = useState(false)

  if (!result) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        暂无复盘数据
      </div>
    )
  }

  return (
    <div>
      {/* Result Banner */}
      <ResultBanner
        mode={mode}
        win={result.win}
        status={result.status}
        score={result.score}
        message={result.message}
        queriesUsed={result.queries_used}
        fbr={result.fbr}
        onRetry={onRetry}
      />

      {!reviewMetrics ? (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 12,
            color: 'var(--text-muted)',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          {'\u{1F4ED}'} 无交互日志：本次对战未产生任何 query（攻击代码未调用 <code style={{ color: 'var(--brand-cyan)' }}>env.query()</code>），
          因此无法生成注入分数/工具调用等复盘图表。请在「对战」面板编写并执行真实的攻击代码后再查看复盘。
        </div>
      ) : (
        /* 4-grid visualization */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <Card title="① 注入分数曲线">
            <InjectionScoreChart
              data={reviewMetrics.injectionScoreSeries}
              threshold={BANKBOT_SCENARIO.injectionThreshold}
            />
          </Card>

          <Card title="② 工具调用时间线">
            <ToolCallTimeline data={reviewMetrics.toolCallSeries} />
          </Card>

          <Card title="③ 预约转账状态对比">
            <TransactionDiffTable metrics={reviewMetrics} attackerIban={attackerIban} />
          </Card>

          <Card title="④ 关键指标">
          <KeyMetrics
            metrics={reviewMetrics}
            queriesUsed={result.queries_used}
            fbr={result.fbr}
          />
        </Card>
      </div>
      )}

      {/* Collapsible terminal/code */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <button
          onClick={() => setShowTerminal(s => !s)}
          style={toggleBtnStyle(showTerminal)}
        >
          {showTerminal ? '▼' : '▶'} 展开终端日志
        </button>
        <button
          onClick={() => setShowCode(s => !s)}
          style={toggleBtnStyle(showCode)}
        >
          {showCode ? '▼' : '▶'} 展开代码
        </button>
      </div>

      {showTerminal && (
        <div style={{ height: 320, marginBottom: 12 }}>
          <ArenaTerminal
            interactionLog={interactionLog}
            attackerIban={attackerIban}
            isRunning={false}
            result={result}
            skipAnimation
          />
        </div>
      )}

      {showCode && (
        <pre
          style={{
            background: '#0a0a0a',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: 12,
            color: '#c0c8d0',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            overflow: 'auto',
            maxHeight: 320,
          }}
        >
          {code}
        </pre>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--brand-cyan)',
          marginBottom: 8,
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function KeyMetrics({
  metrics,
  queriesUsed,
  fbr,
}: {
  metrics: ReviewMetrics
  queriesUsed?: number
  fbr?: number
}) {
  const items: { label: string; value: string; color: string }[] = [
    {
      label: '总 query 数',
      value: queriesUsed != null ? `${queriesUsed}/8` : String(metrics.totalQueries),
      color: 'var(--text-primary)',
    },
    {
      label: '注入触发次数',
      value: String(metrics.injectionTriggers),
      color: metrics.injectionTriggers > 0 ? 'var(--danger)' : 'var(--success)',
    },
    {
      label: 'update 尝试次数',
      value: String(metrics.updateAttempts),
      color: 'var(--warning)',
    },
    {
      label: '防方拦截次数',
      value: String(metrics.injectionBlocked),
      color: 'var(--brand-cyan)',
    },
    {
      label: '被劫持转账',
      value: `${metrics.hijackedCount}/6`,
      color: metrics.hijackedCount > 0 ? 'var(--danger)' : 'var(--success)',
    },
    {
      label: '已拦截转账',
      value: `${metrics.blockedCount}/6`,
      color: 'var(--brand-cyan)',
    },
    {
      label: 'FBR',
      value: fbr != null ? `${(fbr * 100).toFixed(1)}%` : 'N/A',
      color: fbr != null && fbr > 0.1 ? 'var(--warning)' : 'var(--success)',
    },
  ]

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        padding: 10,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
      }}
    >
      {items.map(item => (
        <div
          key={item.label}
          style={{
            padding: 8,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 4,
          }}
        >
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
            {item.label}
          </div>
          <div
            style={{
              fontSize: 16,
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              color: item.color,
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function toggleBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: 4,
    border: active ? '1px solid var(--brand-cyan)' : '1px solid var(--border-color)',
    background: active ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
    color: active ? 'var(--brand-cyan)' : 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  }
}
