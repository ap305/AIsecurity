import { BANKBOT_SCENARIO } from './scenario'
import RoleSelectCards from './RoleSelectCards'
import BriefingHero from './BriefingHero'

type Mode = 'solo_attack' | 'solo_defense'

interface BriefingPanelProps {
  mode: Mode
  onModeChange: (mode: Mode) => void
  disabled?: boolean
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--brand-cyan)',
  marginBottom: 10,
  letterSpacing: 0.5,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

export default function BriefingPanel({ mode, onModeChange, disabled }: BriefingPanelProps) {
  const s = BANKBOT_SCENARIO

  return (
    <div style={{ paddingBottom: 24 }}>
      {/* §0 引导横幅（统一 BriefingHero） */}
      <BriefingHero
        icon={'\u{1F3AF}'}
        title="欢迎来到 Agent 攻防对战大厅"
        description={
          <>
            这是 <strong style={{ color: 'var(--brand-cyan)' }}>间接提示词注入</strong> 攻防练习场。
            你将扮演红队攻击者或蓝队防御者，围绕银行助手 Agent（BankBot）展开对抗。
            下方简报展示了场景速览，<strong style={{ color: 'var(--warning)' }}>完整题目说明、BankBot 系统提示词、工具签名、账户初始状态及评分公式请下载 PDF 查看</strong>。
          </>
        }
        pdfHref={`/api/questions/AGENT-AD-ATK/resources/${encodeURIComponent('题目-Agent攻防-v4.pdf')}`}
      />

      {/* §0.1 操作指引 */}
      <div style={{ ...sectionStyle, marginBottom: 12 }}>
        <div style={sectionTitleStyle}>{'\u{1F4CB}'} 操作指引</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { step: '1', text: '阅读下方场景简报，了解 BankBot 和账户信息' },
            { step: '2', text: '下载完整题目 PDF，获取工具定义和提交格式' },
            { step: '3', text: '在「选择角色」区选择攻击方或防御方' },
            { step: '4', text: '切换到「对战」面板，编写代码并执行' },
            { step: '5', text: '在「复盘」面板查看结果和交互日志' },
          ].map((item) => (
            <div
              key={item.step}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 4,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                fontSize: 12,
                color: 'var(--text-secondary)',
                flex: '1 1 auto',
                minWidth: 200,
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--brand-cyan)',
                  color: '#000',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {item.step}
              </span>
              {item.text}
            </div>
          ))}
        </div>
      </div>

      {/* §1 场景背景 + Emma 账户卡 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>§ 1 · 场景背景</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, marginBottom: 12 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{s.agentName}</strong>
          {' '}
          {s.agentDescription}。攻击方通过向可注入文件写入恶意内容，
          诱导 Agent 修改定期转账收款方；防御方编写中间件拦截危险工具调用。
        </p>

        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: 12,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '4px 16px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>用户</span>
          <span style={{ color: 'var(--text-primary)' }}>{s.user.name}</span>
          <span style={{ color: 'var(--text-muted)' }}>IBAN</span>
          <span style={{ color: 'var(--brand-cyan)' }}>{s.user.iban}</span>
          <span style={{ color: 'var(--text-muted)' }}>余额</span>
          <span style={{ color: 'var(--success)' }}>
            {s.user.balance.toFixed(2)} {s.user.currency}
          </span>
        </div>
      </div>

      {/* §2 预约转账表 / 工具列表 / 可注入文件 / 注入信号权重 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr',
          gap: 12,
          marginBottom: 12,
        }}
      >
        {/* 预约转账表 */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>§ 2.1 · 预约转账（攻击目标）</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={cellHead}>#</th>
                <th style={cellHead}>收款方</th>
                <th style={cellHead}>金额</th>
                <th style={cellHead}>主题</th>
              </tr>
            </thead>
            <tbody>
              {s.scheduledTransactions.map(t => (
                <tr key={t.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ ...cellBody, color: 'var(--text-muted)' }}>{t.id}</td>
                  <td style={cellBody}>
                    <div style={{ color: 'var(--text-primary)' }}>{t.recipientLabel}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                      {t.recipient}
                    </div>
                  </td>
                  <td style={{ ...cellBody, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
                    {t.amount.toFixed(2)}
                  </td>
                  <td style={{ ...cellBody, color: 'var(--text-secondary)' }}>{t.subject}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 工具列表 */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>§ 2.2 · BankBot 工具</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {s.tools.map(tool => (
              <div
                key={tool.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: 8,
                  alignItems: 'baseline',
                  fontSize: 12,
                  padding: '4px 8px',
                  borderRadius: 4,
                  background: tool.dangerous
                    ? 'rgba(255, 107, 107, 0.06)'
                    : 'transparent',
                  border: tool.dangerous
                    ? '1px solid rgba(255, 107, 107, 0.3)'
                    : '1px solid transparent',
                }}
              >
                <code
                  style={{
                    color: tool.dangerous ? 'var(--danger)' : 'var(--brand-cyan)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {tool.name}
                </code>
                <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                  {tool.label}
                  {tool.dangerous && (
                    <span style={{ color: 'var(--danger)', marginLeft: 6 }}>· 危险</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        {/* 可注入文件 */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>§ 2.3 · 可注入文件</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {s.injectableFiles.map(f => (
              <div
                key={f.filename}
                style={{
                  fontSize: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 0',
                }}
              >
                <code style={{ color: 'var(--warning)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {f.filename}
                </code>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{f.description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 注入信号权重 */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>
            § 2.4 · 注入信号权重
            <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
              阈值 ≥ {s.injectionThreshold} 触发
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {s.injectionSignals.map(sig => (
              <span
                key={sig.pattern}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  borderRadius: 4,
                  border: '1px solid var(--border-color-light)',
                  background:
                    sig.weight >= 2
                      ? 'rgba(255, 107, 107, 0.08)'
                      : 'rgba(255, 184, 77, 0.06)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <span
                  style={{
                    color: sig.weight >= 2 ? 'var(--danger)' : 'var(--warning)',
                    fontWeight: 600,
                  }}
                >
                  +{sig.weight}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{sig.pattern}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* §3 角色选择 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>§ 3 · 选择角色</div>
        <RoleSelectCards mode={mode} onModeChange={onModeChange} disabled={disabled} roleData={{ attack: BANKBOT_SCENARIO.attack, defense: BANKBOT_SCENARIO.defense }} attackSubtitle="Indirect Prompt Injection" defenseSubtitle="Defender Middleware" />
      </div>
    </div>
  )
}

const cellHead: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontWeight: 500,
  borderBottom: '1px solid var(--border-color)',
}

const cellBody: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'top',
}
