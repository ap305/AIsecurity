import type { PromptInjectionScenario } from './scenario'
import RoleSelectCards from './RoleSelectCards'
import BriefingHero from './BriefingHero'

type Mode = 'solo_attack' | 'solo_defense'

interface PromptInjectionBriefingProps {
  scenario: PromptInjectionScenario
  pdfHref: string
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

export default function PromptInjectionBriefing({ scenario, pdfHref, mode, onModeChange, disabled }: PromptInjectionBriefingProps) {
  const s = scenario
  return (
    <div style={{ paddingBottom: 24 }}>
      {/* 引导横幅（统一 BriefingHero） */}
      <BriefingHero
        icon={'\u{1F510}'}
        title={`${s.agentName} 提示词注入攻防对战大厅`}
        description={
          <>
            这是 <strong style={{ color: 'var(--brand-cyan)' }}>提示词注入</strong> 攻防练习场（与「越狱」不同：注入是利用外部数据通道夹带指令，
            诱导 LLM 偏离原任务、输出 <code style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>attack_token</code>）。
            评测由确定性仿真引擎完成（<strong style={{ color: 'var(--warning)' }}>完整题目说明请下载 PDF 查看</strong>）。
          </>
        }
        pdfHref={pdfHref}
      />

      {/* 操作指引（统一） */}
      <div style={{ ...sectionStyle, marginBottom: 12 }}>
        <div style={sectionTitleStyle}>{'\u{1F4CB}'} 操作指引</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            '阅读上方场景简报，了解攻击目标 token',
            '下载完整题目 PDF，获取接口细节与提交格式',
            '在「选择角色」区选择攻击方或防御方',
            '切换到「对战」面板，编写代码并执行',
            '在「复盘」面板查看结果与评测指标',
          ].map((text, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                fontSize: 12, color: 'var(--text-secondary)', flex: '1 1 auto', minWidth: 200,
              }}
            >
              <span style={{
                width: 20, height: 20, borderRadius: '50%', background: 'var(--brand-cyan)',
                color: '#000', fontSize: 11, fontWeight: 700, display: 'flex',
                alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>{i + 1}</span>
              {text}
            </div>
          ))}
        </div>
      </div>

      {/* §1 目标与信号 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>{'\u{1F3AF}'} 攻击目标 token</div>
          <code style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}>{s.attackToken}</code>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>原任务指令（不得删除/覆盖）：</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{s.targetInstruction}</div>
        </div>
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>{'\u{26A0}'} 覆盖信号（阈值 ≥ {s.overrideThreshold}）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {s.overrideSignals.map(sig => (
              <span key={sig.pattern} style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '2px 6px', borderRadius: 3, border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                {sig.pattern}({sig.weight})
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* §2 攻防接口（统一并排双卡片） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ ...sectionStyle, borderColor: '#5f1e1e', marginBottom: 0 }}>
          <div style={{ ...sectionTitleStyle, color: 'var(--danger)' }}>{'\u{2694}'} 攻击接口</div>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{`def attack(env) -> str:
    env.attack_token         # 攻击目标
    env.target_instruction   # 原任务
    env.input                # 干净输入
    env.set_injection(payload)
    env.query() -> str       # 探测（≤ ${s.maxRounds} 次）
    return payload           # 返回最终 payload`}</pre>
        </div>
        <div style={{ ...sectionStyle, borderColor: '#1e3a5f', marginBottom: 0 }}>
          <div style={{ ...sectionTitleStyle, color: 'var(--brand-cyan)' }}>{'\u{1F6E1}'} 防御接口</div>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{`def defend(env) -> str:
    env.final_prompt  # 含注入的完整 prompt
    return cleaned     # 清洗后的 prompt
# 剥离覆盖信号句与 token，保留原任务与数据`}</pre>
        </div>
      </div>

      {/* §3 角色选择 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>§ 3 · 选择角色</div>
        <RoleSelectCards
          mode={mode} onModeChange={onModeChange} disabled={disabled}
          roleData={{ attack: s.attack, defense: s.defense }}
          attackSubtitle="Prompt Injection" defenseSubtitle="Input Sanitization"
        />
      </div>
    </div>
  )
}
