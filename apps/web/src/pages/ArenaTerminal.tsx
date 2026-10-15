import { useEffect, useState, useRef } from 'react'
import { formatToolOutput } from './arena/formatTool'

export interface LogEntry {
  query_num: number
  user_message: string
  bot_response: string
  tool_calls: Array<{
    tool: string
    input: Record<string, unknown>
    output: string
  }>
  injection_score: number
  injection_reasons?: string[]
  defender_blocked?: string | null
  phase?: string
}

interface ArenaTerminalProps {
  interactionLog: LogEntry[]
  attackerIban: string
  isRunning: boolean
  result: {
    win?: boolean
    status?: string
    score?: number | null
    message?: string
    queries_used?: number
    fbr?: number
  } | null
  skipAnimation?: boolean
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取文件',
  get_balance: '查询余额',
  get_most_recent_transactions: '查询交易记录',
  get_scheduled_transactions: '查询预约转账',
  send_money: '转账',
  update_scheduled_transaction: '修改预约转账',
}

export default function ArenaTerminal({
  interactionLog,
  attackerIban,
  isRunning,
  result,
  skipAnimation,
}: ArenaTerminalProps) {
  const [visibleCount, setVisibleCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Animate log entries sequentially (or skip animation entirely)
  useEffect(() => {
    if (interactionLog.length === 0) {
      setVisibleCount(0)
      return
    }

    if (skipAnimation) {
      setVisibleCount(interactionLog.length)
      return
    }

    setVisibleCount(0)
    let idx = 0

    function showNext() {
      idx++
      if (idx <= interactionLog.length) {
        setVisibleCount(idx)
      }
      if (idx < interactionLog.length) {
        const delay = 400 + Math.random() * 400 // 400-800ms
        timerRef.current = setTimeout(showNext, delay)
      }
    }

    // Small initial delay
    timerRef.current = setTimeout(showNext, 300)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [interactionLog, skipAnimation])

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [visibleCount])

  return (
    <div
      ref={containerRef}
      style={{
        background: '#0a0a0a',
        border: '1px solid #1e3a5f',
        borderRadius: 8,
        padding: 16,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 12,
        lineHeight: 1.7,
        color: '#c0c8d0',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ color: '#00d4ff', marginBottom: 8 }}>
        $ arena start
      </div>
      <div style={{ color: '#48db80', marginBottom: 4 }}>
        [系统] 攻击者IBAN: {attackerIban}
      </div>
      <div style={{ color: '#48db80', marginBottom: 12 }}>
        [系统] 靶机 BankBot 就绪
      </div>
      <div style={{ color: '#333', marginBottom: 8 }}>
        {'─'.repeat(44)}
      </div>

      {/* Log entries */}
      {interactionLog.slice(0, visibleCount).map((entry, i) => (
        <div key={i} style={{ marginBottom: 4 }}>
          {/* User query */}
          <div style={{ color: '#ffb84d' }}>
            {'> '}
            <span style={{ color: '#ff6b6b' }}>
              [攻方 Query#{entry.query_num}]
            </span>{' '}
            {entry.user_message.length > 60
              ? entry.user_message.slice(0, 60) + '...'
              : entry.user_message}
          </div>

          {/* Tool calls */}
          {entry.tool_calls.map((tc, j) => (
            <div key={j} style={{ paddingLeft: 12 }}>
              {tc.tool === 'update_scheduled_transaction' && entry.injection_score >= 3 ? (
                <div style={{ color: '#ff6b6b' }}>
                  {'⚠️ '}
                  <span style={{ color: '#ffb84d' }}>
                    [注入触发] {TOOL_LABELS[tc.tool] || tc.tool}
                  </span>
                </div>
              ) : (
                <div style={{ color: '#888' }}>
                  [tool:{tc.tool}] {formatToolOutput(tc)}
                </div>
              )}
            </div>
          ))}

          {/* Bot response */}
          <div style={{ paddingLeft: 12, color: '#48db80', marginBottom: 2 }}>
            [Bot] {entry.bot_response.length > 80
              ? entry.bot_response.slice(0, 80) + '...'
              : entry.bot_response}
          </div>

          {/* Injection warning */}
          {entry.injection_score >= 3 && (
            <div style={{ paddingLeft: 12, marginBottom: 2 }}>
              <span style={{ color: '#ff6b6b' }}>
                {'⚠️ '}注入检测! score={entry.injection_score}
              </span>
              {entry.injection_reasons && entry.injection_reasons.length > 0 && (
                <span style={{ color: '#888', fontSize: 10 }}>
                  {' '}({entry.injection_reasons.join(', ')})
                </span>
              )}
            </div>
          )}

          {/* Defender block */}
          {entry.defender_blocked && (
            <div style={{ paddingLeft: 12, color: '#00d4ff' }}>
              {'[防方拦截] '}{entry.defender_blocked}
            </div>
          )}

          <div style={{ color: '#222' }}>{'─'.repeat(44)}</div>
        </div>
      ))}

      {/* Running indicator */}
      {isRunning && (
        <div style={{ color: '#00d4ff', marginTop: 4 }}>
          <span className="terminal-cursor">&#9608;</span> Running...
        </div>
      )}

      {/* Result */}
      {result && !isRunning && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: '#00d4ff', fontWeight: 700 }}>
            [结果] {result.win !== undefined
              ? (result.win ? '攻方成功' : '防御成功')
              : result.status === 'passed' ? '通过' : '未通过'}
          </div>
          {result.queries_used !== undefined && (
            <div style={{ color: '#888' }}>
              queries_used: {result.queries_used}/8
            </div>
          )}
          {result.fbr !== undefined && (
            <div style={{ color: '#888' }}>
              FBR: {(result.fbr * 100).toFixed(1)}%
            </div>
          )}
          {result.score != null && (
            <div style={{ color: '#48db80' }}>
              得分: {Math.round(result.score)}
            </div>
          )}
          {result.message && (
            <div style={{ color: '#c0c8d0', marginTop: 4, fontSize: 11 }}>
              {result.message}
            </div>
          )}
        </div>
      )}

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
  )
}
