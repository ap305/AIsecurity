// 从 ArenaTerminal.tsx 抽出的工具调用输出格式化函数（共享）

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
  output: string
}

export function formatToolOutput(tc: ToolCall): string {
  const { tool, input } = tc
  switch (tool) {
    case 'read_file':
      return `file=${input.file_path}`
    case 'get_balance':
      return ''
    case 'get_most_recent_transactions':
      return ''
    case 'get_scheduled_transactions':
      return ''
    case 'send_money':
      return `amount=${input.amount}, to=${String(input.recipient).slice(0, 8)}...`
    case 'update_scheduled_transaction':
      return `id=${input.transaction_id}, recipient=${String(input.recipient).slice(0, 8)}...`
    default:
      return ''
  }
}
