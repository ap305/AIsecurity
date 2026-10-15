/**
 * 对战场景 → 题目行映射（用于 GitHub 归档按场景绑定仓库）
 *
 * key = 前端 Arena 场景标识（ScenarioKey）；attackId/defenseId = 题库中对应题目行。
 * 同一场景的攻/防两行在题目管理中同步同一份仓库配置。
 */

export interface ScenarioQuestionPair {
  key: string
  attackId: string
  defenseId: string
  label: string
}

export const SCENARIO_QUESTION_PAIRS: ScenarioQuestionPair[] = [
  { key: 'bankbot', attackId: 'AGENT-AD-ATK', defenseId: 'AGENT-AD-DEF', label: 'BankBot 注入' },
  { key: 'mailmate', attackId: 'MAILMATE-AD-ATK', defenseId: 'MAILMATE-AD-DEF', label: 'MailMate 邮件' },
  { key: 'chatops', attackId: 'CHATOPS-AD-ATK', defenseId: 'CHATOPS-AD-DEF', label: 'ChatOps 运维' },
  { key: 'tripbot', attackId: 'TRIPBOT-AD-ATK', defenseId: 'TRIPBOT-AD-DEF', label: 'TripBot 行程' },
  { key: 'safellm', attackId: 'SAFELLM-AD-ATK', defenseId: 'SAFELLM-AD-DEF', label: 'SafeLLM 越狱' },
  { key: 'prompt_injection', attackId: 'PINJ-AD-ATK', defenseId: 'PINJ-AD-DEF', label: '提示词注入' },
  { key: 'rankguard', attackId: 'RANKGUARD-AD', defenseId: 'RANKGUARD-AD-DEF', label: 'RankGuard 排序' },
  { key: 'deepfake_audio', attackId: 'DEEPFAKE-AD', defenseId: 'DEEPFAKE-AD-DEF', label: 'DeepFake 语音' },
  { key: 'watermark_image', attackId: 'WATERMARK-AD', defenseId: 'WATERMARK-AD-DEF', label: '图片水印' },
  { key: 'mnist_backdoor', attackId: 'MNIST-BD', defenseId: 'MNIST-BD-DEF', label: 'MNIST 后门' },
  { key: 'deepfake_image', attackId: 'DEEPFAKE-IMG', defenseId: 'DEEPFAKE-IMG-DEF', label: 'DeepFake 图像' },
  { key: 'mnist_poison', attackId: 'MNIST-POISON', defenseId: 'MNIST-POISON-DEF', label: 'MNIST 投毒' },
  { key: 'text_watermark', attackId: 'TEXT-WM', defenseId: 'TEXT-WM-DEF', label: '文本水印' },
  { key: 'poisoned_rag', attackId: 'POISONED-RAG', defenseId: 'POISONED-RAG-DEF', label: 'RAG 投毒' },
  { key: 'mnist_distill', attackId: 'MNIST-EXTRACT', defenseId: 'MNIST-EXTRACT-DEF', label: '模型蒸馏' },
  { key: 'patch_attack', attackId: 'PATCH-AD', defenseId: 'PATCH-AD-DEF', label: '对抗贴片' },
  { key: 'supportbot', attackId: 'SUPPORTBOT-AD-ATK', defenseId: 'SUPPORTBOT-AD-DEF', label: 'SupportBot 检索投毒' },
  { key: 'projectbot', attackId: 'PROJECTBOT-AD-ATK', defenseId: 'PROJECTBOT-AD-DEF', label: 'ProjectBot 状态投毒' },
  { key: 'vendorbot', attackId: 'VENDORBOT-AD-ATK', defenseId: 'VENDORBOT-AD-DEF', label: 'VendorBot 第三方注入' },
  { key: 'agendabot', attackId: 'AGENDABOT-AD-ATK', defenseId: 'AGENDABOT-AD-DEF', label: 'AgendaBot 议程投毒' },
  { key: 'webbot', attackId: 'WEBBOT-AD-ATK', defenseId: 'WEBBOT-AD-DEF', label: 'WebBot 页面注入' },
  { key: 'codereviewbot', attackId: 'CODEREVIEWBOT-AD-ATK', defenseId: 'CODEREVIEWBOT-AD-DEF', label: 'CodeReviewBot 供应链' },
  { key: 'hrbot', attackId: 'HRBOT-AD-ATK', defenseId: 'HRBOT-AD-DEF', label: 'HRBot 身份冒充' },
  { key: 'searchbot', attackId: 'SEARCHBOT-AD-ATK', defenseId: 'SEARCHBOT-AD-DEF', label: 'SearchBot 间接注入' },
]

export const SCENARIO_PAIR_BY_KEY = new Map(SCENARIO_QUESTION_PAIRS.map((p) => [p.key, p]))
export const SCENARIO_PAIR_BY_QUESTION_ID = new Map<string, ScenarioQuestionPair>()

for (const p of SCENARIO_QUESTION_PAIRS) {
  SCENARIO_PAIR_BY_QUESTION_ID.set(p.attackId, p)
  SCENARIO_PAIR_BY_QUESTION_ID.set(p.defenseId, p)
}