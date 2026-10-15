import type { ReactNode } from 'react'

/**
 * 对战大厅统一引导横幅（所有场景 Briefing 共用）
 * 渐变背景 + 大图标 + 标题 + 描述 + PDF 下载按钮
 */

interface BriefingHeroProps {
  icon: string
  title: string
  /** 描述内容（可含 React 节点） */
  description: ReactNode
  /** PDF 下载链接 */
  pdfHref: string
  /** PDF 按钮文案（默认「下载完整题目说明 PDF」） */
  pdfLabel?: string
}

export default function BriefingHero({ icon, title, description, pdfHref, pdfLabel }: BriefingHeroProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.08), rgba(255, 107, 107, 0.06))',
        border: '1px solid var(--border-color)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ fontSize: 22, lineHeight: 1.2, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {description}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <a
              href={pdfHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 12px',
                borderRadius: 4,
                border: '1px solid var(--brand-cyan)',
                background: 'rgba(0, 212, 255, 0.08)',
                color: 'var(--brand-cyan)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              {'\u{1F4D1}'} {pdfLabel ?? '下载完整题目说明 PDF'}
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
