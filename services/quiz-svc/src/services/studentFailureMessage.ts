import { preflightMessages, preservationSuffix } from './submissionPreflight.js'

const messages: Record<string, string> = {
  '防御检索接口不符合题目要求': 'guard_retrieval 必须返回 (guarded, masked)，两项都必须是列表，不能是 None',
  '防御检索结果改变了固定结果数量': 'guard_retrieval 必须保留检索条目数量，masked 必须是文档编号字符串列表',
  '防御检索结果格式无效': 'guard_retrieval 的 guarded 每项必须包含 doc 对象及原有 score、rank',
  '防御检索结果改变了固定排序或文档编号': 'guard_retrieval 不得改变原有 rank、score 或文档 id',
  '防御输出接口不符合题目要求': 'guard_response 必须返回规定字典：response 为字符串，filtered 为布尔值，mode 为 None/refuse/redact',
  '学生返回的文本格式不合法，本次不计分': '返回文本必须是字符串且不超过题目允许长度，不能是 None',
  '学生返回的数值指标不合法，本次不计分': '返回数值必须在题目规定范围内，不能是 None、NaN 或无穷大',
  '学生入口没有返回有效对象': '题目要求的类入口必须构造并返回有效对象',
  '水印生成接口必须返回text字段': '水印生成接口必须返回包含 text 字段的字典',
  '水印攻击接口必须返回text字段': '水印攻击接口必须返回包含 text 字段的字典',
  '水印检测接口返回格式无效': '水印检测接口返回格式错误，请核对题目规定的字段和类型',
}
const fallback = '代码或模型运行失败，请核对题目接口、依赖及模型结构后重新提交' + preservationSuffix
/** Never forward raw exception text or arbitrary grader messages to a student. */
export function studentFailureMessage(value: unknown): string {
  if (typeof value !== 'string') return fallback
  if (Object.hasOwn(messages, value)) return messages[value] + preservationSuffix
  if (Object.values(messages).some(message => value === message + preservationSuffix)) return value
  for (const [reason, message] of Object.entries(preflightMessages)) {
    const where = reason === 'missing_entry' ? '题目模板' : '提交代码'
    const prefix = new RegExp(`^${where}第 ([1-9][0-9]{0,5}) 行：`)
    const matched: RegExpMatchArray | null = value.match(prefix)
    if (matched && Number(matched[1]) <= 100000 && value === `${matched[0]}${message}${preservationSuffix}`) return value
  }
  return fallback
}
