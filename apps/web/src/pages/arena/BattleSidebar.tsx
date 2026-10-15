import type { LogEntry } from '../ArenaTerminal'
import { BANKBOT_SCENARIO } from './scenario'

interface BattleSidebarProps {
  interactionLog: LogEntry[]
  isRunning: boolean
  attackerIban: string
}

export default function BattleSidebar({
  interactionLog,
  isRunning,
  attackerIban,
}: BattleSidebarProps) {
  const s = BANKBOT_SCENARIO
  const queriesUsed = interactionLog.length
  const maxQueries = 8
  const queriesPercent = Math.min(100, (queriesUsed / maxQueries) * 100)

  const lastEntry = interactionLog[interactionLog.length - 1]
  const currentScore = lastEntry?.injection_score ?? 0
  const injectionTriggered = lastEntry ? lastEntry.injection_score >= s.injectionThreshold : false

  const blockedCount = interactionLog.filter(e => e.defender_blocked != null).length
  const triggerCount = interactionLog.filter(e => e.injection_score >= s.injectionThreshold).length
  const updateAttempts = interactionLog.reduce(
    (n, e) => n + e.tool_calls.filter(tc => tc.tool === 'update_scheduled_transaction').length,
    0,
  )

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflowY: 'auto',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--brand-cyan)', fontWeight: 700, letterSpacing: 0.5 }}>
        实时指标
      </div>

      {/* Queries Used */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
          <span>queries_used</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: queriesPercent >= 75 ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {queriesUsed}/{maxQueries}
          </span>
        </div>
        <div
          style={{
            height: 6,
            background: 'var(--bg-secondary)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${queriesPercent}%`,
              height: '100%',
              background: queriesPercent >= 75 ? 'var(--danger)' : 'var(--brand-cyan)',
              transition: 'width 200ms ease',
            }}
          />
        </div>
      </div>

      {/* Current Injection Score */}
      <div
        style={{
          padding: 10,
          background: 'var(--bg-secondary)',
          border: `1px solid ${injectionTriggered ? 'var(--danger)' : 'var(--border-color)'}`,
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
          当前注入分数
        </div>
        <div
          style={{
            fontSize: 22,
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            color: injectionTriggered ? 'var(--danger)' : 'var(--text-primary)',
          }}
        >
          {currentScore}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
            / {s.injectionThreshold}
          </span>
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            color: injectionTriggered ? 'var(--danger)' : 'var(--text-muted)',
          }}
        >
          {injectionTriggered ? '⚠ 注入已触发' : '○ 未达阈值'}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <StatBox label="注入触发" value={triggerCount} color="var(--danger)" />
        <StatBox label="防方拦截" value={blockedCount} color="var(--brand-cyan)" />
        <StatBox label="update 调用" value={updateAttempts} color="var(--warning)" />
        <StatBox label="活跃 query" value={queriesUsed} color="var(--text-primary)" />
      </div>

      {/* Attacker IBAN */}
      <div
        style={{
          padding: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 4,
          fontSize: 10,
        }}
      >
        <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>attacker_iban</div>
        <code style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 10, wordBreak: 'break-all' }}>
          {attackerIban}
        </code>
      </div>

      {/* Status indicator */}
      {isRunning && (
        <div
          style={{
            marginTop: 'auto',
            padding: '6px 8px',
            border: '1px solid var(--brand-cyan)',
            borderRadius: 4,
            background: 'rgba(0, 212, 255, 0.06)',
            fontSize: 11,
            color: 'var(--brand-cyan)',
            textAlign: 'center',
          }}
        >
          <span className="terminal-cursor">█</span> 对战进行中
          <style>{`
            @keyframes terminal-blink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0; }
            }
            .terminal-cursor {
              animation: terminal-blink 1s step-end infinite;
            }
          `}</style>
        </div>
      )}
    </div>
  )
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        padding: 8,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontFamily: 'var(--font-mono)', fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  )
}
