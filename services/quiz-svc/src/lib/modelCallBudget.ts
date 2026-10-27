export const ORIGINAL_D02_EXECUTION_PROFILE = 'd02-original300-v12'
export const ORIGINAL_D02_TIMEOUT_MS = 86400000

export function isOriginalD02Evaluation(evaluation: Record<string, unknown> = {}): boolean {
  // Match the Python runtime: explicit top-level frozen fields override nested compatibility fields.
  const frozen = { ...(evaluation.parameters as Record<string, unknown> | undefined), ...evaluation }
  return evaluation.version === 'v3-261012-d02-original300-v12' &&
    frozen.number === '02' && frozen.role === 'defense' && frozen.samples === 300
}

/** Original D02 has 1200 requests; each explicit 503 may consume three attempts. */
export function evaluationModelCallLimit(evaluation: Record<string, unknown> = {}, role?: string): number {
  const originalD02 = role === 'defense' && isOriginalD02Evaluation(evaluation)
  const budget = Number(evaluation.maxModelCalls)
  return Number.isSafeInteger(budget) && budget > 0 ? Math.min(budget, originalD02 ? 3600 : 1000) : 32
}
