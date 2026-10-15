import type { GenericAdScenario } from './scenario'
import RoleSelectCards from './RoleSelectCards'
import BriefingHero from './BriefingHero'

type Mode = 'solo_attack' | 'solo_defense'

interface GenericAdBriefingProps {
  scenario: GenericAdScenario
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

export default function GenericAdBriefing({ scenario: s, pdfHref, mode, onModeChange, disabled }: GenericAdBriefingProps) {
  return (
    <div style={{ paddingBottom: 24 }}>
      {/* 引导横幅（统一 BriefingHero） */}
      <BriefingHero
        icon={'\u{1F3AF}'}
        title={`${s.agentName} 攻防对战大厅`}
        description={
          <>
            <strong style={{ color: 'var(--brand-cyan)' }}>{s.agentName}</strong> · {s.agentDescription}。
            模态：<code style={{ color: 'var(--brand-cyan)', fontFamily: 'var(--font-mono)' }}>{s.modality}</code>。
            评测由确定性仿真引擎完成（<strong style={{ color: 'var(--warning)' }}>完整题目说明请下载 PDF 查看</strong>）。
            {' '}{s.briefingNote}
          </>
        }
        pdfHref={pdfHref}
      />

      {/* 操作指引（统一） */}
      <div style={{ ...sectionStyle, marginBottom: 12 }}>
        <div style={sectionTitleStyle}>{'\u{1F4CB}'} 操作指引</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            '阅读上方场景简报，了解目标与攻防契约',
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

      {/* 攻击/防御接口（统一并排双卡片） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ ...sectionStyle, borderColor: '#5f1e1e', marginBottom: 0 }}>
          <div style={{ ...sectionTitleStyle, color: 'var(--danger)' }}>{'\u{2694}'} 攻击接口</div>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{s.attackApi}</pre>
        </div>
        <div style={{ ...sectionStyle, borderColor: '#1e3a5f', marginBottom: 0 }}>
          <div style={{ ...sectionTitleStyle, color: 'var(--brand-cyan)' }}>{'\u{1F6E1}'} 防御接口</div>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{s.defenseApi}</pre>
        </div>
      </div>

      {/* 角色选择 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>§ 4 · 选择角色</div>
        <RoleSelectCards
          mode={mode} onModeChange={onModeChange} disabled={disabled}
          roleData={{ attack: s.attack, defense: s.defense }}
          attackSubtitle={`${s.modality} Attack`}
          defenseSubtitle={`${s.modality} Defense`}
        />
      </div>
    </div>
  )
}
