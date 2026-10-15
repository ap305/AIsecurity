import { Link } from 'react-router-dom'
import type { ModuleMeta } from '@ai-security/shared'

interface ModuleCardProps {
  module: ModuleMeta
  progress?: number // 0-100
}

export default function ModuleCard({ module: mod, progress = 0 }: ModuleCardProps) {
  const totalQuestions = mod.basicCount + mod.securityCount

  return (
    <Link
      to={`/module/${mod.code}`}
      style={{
        display: 'block',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 10,
        padding: '20px 24px',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'all var(--transition-normal)',
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = mod.color
        e.currentTarget.style.boxShadow = `0 0 20px ${mod.color}15`
        e.currentTarget.style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-color)'
        e.currentTarget.style.boxShadow = 'var(--shadow-card)'
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: mod.gradient,
        }}
      />

      {/* Module code + icon */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          marginTop: 4,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: mod.color,
            fontFamily: 'var(--font-mono)',
            letterSpacing: 1,
          }}
        >
          {mod.code}
        </span>
        <span style={{ fontSize: 24 }}>{mod.icon}</span>
      </div>

      {/* Title */}
      <h3
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 4,
        }}
      >
        {mod.title}
      </h3>
      <p
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          marginBottom: 14,
          lineHeight: 1.5,
          minHeight: 36,
        }}
      >
        {mod.description}
      </p>

      {/* Question counts */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          marginBottom: 14,
          fontSize: 12,
        }}
      >
        <span style={{ color: 'var(--text-secondary)' }}>
          基础 <strong style={{ color: mod.color, fontFamily: 'var(--font-mono)' }}>{mod.basicCount}</strong>
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          安全 <strong style={{ color: mod.color, fontFamily: 'var(--font-mono)' }}>{mod.securityCount}</strong>
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          共 {totalQuestions} 题
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 6,
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          <span>完成进度</span>
          <span>{progress}%</span>
        </div>
        <div
          style={{
            height: 4,
            background: 'var(--border-color)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: mod.gradient,
              borderRadius: 2,
              transition: 'width var(--transition-normal)',
            }}
          />
        </div>
      </div>
    </Link>
  )
}
