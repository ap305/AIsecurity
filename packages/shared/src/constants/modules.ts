import type { ModuleCode } from '../types/task'

/** Spec #4 五大模块元数据 */
export interface ModuleMeta {
  code: ModuleCode
  title: string
  subtitle: string
  description: string
  color: string
  gradient: string
  icon: string
  basicCount: number
  securityCount: number
}

export const MODULES: ModuleMeta[] = [
  {
    code: 'M1',
    title: '对抗攻击与规避',
    subtitle: 'Adversarial Attack & Evasion',
    description: '学习对抗样本生成、白盒与黑盒攻击、物理域攻击等核心技术',
    color: '#00d4ff',
    gradient: 'linear-gradient(135deg, #00d4ff, #0066ff)',
    icon: '🎯',
    // 基础题 7（理论+模块编程）+ 3（编程实践：LeNet / 经典 CNN / 激活函数）
    basicCount: 10,
    securityCount: 7,
  },
  {
    code: 'M2',
    title: '数据投毒与后门',
    subtitle: 'Data Poisoning & Backdoor',
    description: '掌握数据投毒攻击、后门植入、供应链污染等攻击手法与防御',
    color: '#ff6b6b',
    gradient: 'linear-gradient(135deg, #ff6b6b, #ee5a24)',
    icon: '☠️',
    // 基础题 6 + 3（编程实践：Iris / PyTorch 训练流程 / 数据增强）
    basicCount: 9,
    securityCount: 6,
  },
  {
    code: 'M3',
    title: '模型窃取与隐私',
    subtitle: 'Model Extraction & Privacy',
    description: '探索模型窃取、成员推断、差分隐私攻击与联邦学习安全',
    color: '#48db80',
    gradient: 'linear-gradient(135deg, #48db80, #0abde3)',
    icon: '🔒',
    // 基础题 7 + 3（编程实践：DCGAN / GAN 稳定性 / GCN）
    basicCount: 10,
    securityCount: 7,
  },
  {
    code: 'M4',
    title: 'LLM 安全',
    subtitle: 'LLM Security',
    description: 'Prompt注入、越狱攻击、RAG安全、Agent安全等前沿议题',
    color: '#ffb84d',
    gradient: 'linear-gradient(135deg, #ffb84d, #ff6348)',
    icon: '🤖',
    // 基础题 6 + 4（编程实践：RNN / LSTM / Transformer / 多头注意力）
    basicCount: 10,
    securityCount: 6,
  },
  {
    code: 'M5',
    title: '公平性与审计',
    subtitle: 'Fairness & Audit',
    description: 'AI偏见检测与缓解、模型可解释性、安全审计与合规',
    color: '#a87cff',
    gradient: 'linear-gradient(135deg, #a87cff, #6c5ce7)',
    icon: '⚖️',
    // 基础题 6 + 3（编程实践：Q-Learning / DQN / 目标检测推理）
    basicCount: 9,
    securityCount: 6,
  },
]

/** 获取模块总数 */
export const getTotalQuestions = (): number =>
  MODULES.reduce((sum, m) => sum + m.basicCount + m.securityCount, 0)

/** 获取基础题总数 */
export const getTotalBasic = (): number =>
  MODULES.reduce((sum, m) => sum + m.basicCount, 0)

/** 获取安全题总数 */
export const getTotalSecurity = (): number =>
  MODULES.reduce((sum, m) => sum + m.securityCount, 0)
