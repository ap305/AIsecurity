type Mode = 'solo_attack' | 'solo_defense'

interface RoleSelectCardsProps {
  mode: Mode
  onModeChange: (mode: Mode) => void
  disabled?: boolean
  /** 标准化的角色卡数据（attack/defense）；由各场景 Briefing 传入，避免硬编码 BankBot */
  roleData: {
    attack: { objective: string; api: string[]; constraints: string[]; scoring: { condition: string; score: number }[]; bonus?: number }
    defense: { objective: string; signature: string; passCondition: string; scoring: { condition: string; score: number }[] }
  }
  /** 攻击/防御卡片副标题（可选，默认 Indirect Prompt Injection / Defender Middleware） */
  attackSubtitle?: string
  defenseSubtitle?: string
}

export default function RoleSelectCards({ mode, onModeChange, disabled, roleData, attackSubtitle, defenseSubtitle }: RoleSelectCardsProps) {
  const s = roleData

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {/* 攻击方 */}
      <RoleCard
        active={mode === 'solo_attack'}
        disabled={disabled}
        onClick={() => onModeChange('solo_attack')}
        accent="var(--danger)"
        accentDim="rgba(255, 107, 107, 0.1)"
        icon="⚔"
        title="加入攻击方"
        subtitle={attackSubtitle ?? 'Indirect Prompt Injection'}
        objective={s.attack.objective}
        api={s.attack.api}
        constraints={s.attack.constraints}
        scoring={s.attack.scoring}
        bonus={s.attack.bonus}
      />

      {/* 防御方 */}
      <RoleCard
        active={mode === 'solo_defense'}
        disabled={disabled}
        onClick={() => onModeChange('solo_defense')}
        accent="var(--brand-cyan)"
        accentDim="rgba(0, 212, 255, 0.1)"
        icon="🛡"
        title="加入防御方"
        subtitle={defenseSubtitle ?? 'Defender Middleware'}
        objective={s.defense.objective}
        api={[s.defense.signature]}
        constraints={[s.defense.passCondition]}
        scoring={s.defense.scoring}
      />
    </div>
  )
}

interface RoleCardProps {
  active: boolean
  disabled?: boolean
  onClick: () => void
  accent: string
  accentDim: string
  icon: string
  title: string
  subtitle: string
  objective: string
  api: string[]
  constraints: string[]
  scoring: { condition: string; score: number }[]
  bonus?: number
}

function RoleCard({
  active,
  disabled,
  onClick,
  accent,
  accentDim,
  icon,
  title,
  subtitle,
  objective,
  api,
  constraints,
  scoring,
  bonus,
}: RoleCardProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        padding: 14,
        borderRadius: 8,
        background: active ? accentDim : 'var(--bg-secondary)',
        border: active ? `1px solid ${accent}` : '1px solid var(--border-color)',
        color: 'var(--text-primary)',
        fontFamily: 'inherit',
        transition: 'all var(--transition-fast)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: active ? accent : 'var(--text-primary)' }}>
            {title}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {subtitle}
          </div>
        </div>
      </div>

      {/* Objective */}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
        {objective}
      </p>

      {/* API / Signature */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>API</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {api.map(a => (
            <code
              key={a}
              style={{
                fontSize: 11,
                color: accent,
                fontFamily: 'var(--font-mono)',
                background: 'var(--bg-primary)',
                padding: '2px 6px',
                borderRadius: 3,
              }}
            >
              {a}
            </code>
          ))}
        </div>
      </div>

      {/* Constraints */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>约束</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 11, color: 'var(--text-secondary)' }}>
          {constraints.map((c, i) => (
            <li key={i} style={{ padding: '1px 0' }}>· {c}</li>
          ))}
        </ul>
      </div>

      {/* Scoring */}
      <div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>评分</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {scoring.map((sc, i) => (
            <span
              key={i}
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                padding: '2px 6px',
                borderRadius: 3,
                border: '1px solid var(--border-color)',
                color: 'var(--text-secondary)',
              }}
            >
              {sc.condition} → <span style={{ color: 'var(--success)', fontWeight: 600 }}>{sc.score}</span>
            </span>
          ))}
          {bonus !== undefined && (
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                padding: '2px 6px',
                borderRadius: 3,
                border: '1px solid var(--warning)',
                color: 'var(--warning)',
              }}
            >
              bonus +{bonus}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
