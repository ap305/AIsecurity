import crypto from 'node:crypto'
import {
  normalizeCategory,
  normalizeDefinition,
  type PoolBinding,
  type QuestionDefinition,
} from './prdContract.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Bind publication evidence to the exact question contract and frozen model revision. */
export function selfTestConfigurationKey(
  definition: QuestionDefinition,
  role: string | null,
  category: string,
  modelBinding?: PoolBinding,
): string {
  const normalized = normalizeDefinition(definition)
  const { packageDigest: _digest, ...evaluation } = normalized.evaluation
  const contract = {
    definition: { ...normalized, evaluation },
    category: normalizeCategory(category),
    role: role || null,
    modelBinding,
  }
  return crypto.createHash('sha256').update(canonical(contract)).digest('hex')
}
