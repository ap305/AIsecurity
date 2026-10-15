import type { QuestionRecord } from './prdApi'
import { getArenaTeaching } from './arenaTeaching'

export interface LegacyUploadScope {
  scenario: string
  role: 'solo_attack' | 'solo_defense'
  query: string
}
export interface LegacyUploadRecord {
  fileName: string
  size: number | null
  uploadedAt: string | null
  version: number | null
  archived: boolean | null
}

export function legacyUploadScope(question: QuestionRecord): LegacyUploadScope | null {
  const teaching = getArenaTeaching(question)
  if (!teaching) return null
  const scenario = teaching.scenario.id
  const role = teaching.role === 'attack' ? 'solo_attack' : 'solo_defense'
  const params = new URLSearchParams({ scenario, role })
  return { scenario, role, query: `/matches/uploads?${params}` }
}

export function normalizeLegacyUploads(raw: unknown, scope: LegacyUploadScope): LegacyUploadRecord[] {
  if (!Array.isArray(raw)) throw new Error('历史上传记录格式异常')
  const records: LegacyUploadRecord[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    if (row.scenario !== scope.scenario || row.role !== scope.role || typeof row.fileName !== 'string')
      continue
    // Keep only display fields. A malformed legacy filename must not expose a
    // server work directory, even if an old record contains an absolute path.
    const fileName = (row.fileName.split(/[\\/]/).pop() || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 240)
    if (!fileName.trim()) continue
    const timestamp = typeof row.uploadedAt === 'string' ? Date.parse(row.uploadedAt) : NaN
    records.push({
      fileName,
      size: typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null,
      uploadedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      version:
        typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version > 0
          ? row.version
          : null,
      archived: typeof row.archived === 'boolean' ? row.archived : null,
    })
  }
  return records.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))
}

export function formatLegacyUploadSize(bytes: number | null): string {
  if (bytes == null) return '未记录'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
