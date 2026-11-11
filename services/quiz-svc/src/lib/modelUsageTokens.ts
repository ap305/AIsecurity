/** Only provider-reported integer usage is evidence; missing usage stays unknown. */
export function modelUsageTokens(value: unknown) {
  const usage = value && typeof value === 'object' ? (value as any).usage : null
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null
  return {
    inputTokens: count(usage?.prompt_tokens ?? usage?.input_tokens),
    outputTokens: count(usage?.completion_tokens ?? usage?.output_tokens),
    totalTokens: count(usage?.total_tokens),
  }
}
