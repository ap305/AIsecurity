import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * 统一 LLM 网关配置（共享模块）
 *
 * - llm.ts（网关路由）与 match.ts（判题引擎）共用同一份配置读取逻辑，
 *   保证「网关模式切换 == 判题模式切换」。
 * - 配置持久化于 llm-config.json（容器挂载目录，admin 界面写入，运行时生效），
 *   未配置时回退环境变量 MODEL_SERVER_URL / COMPETITION_API_KEY / MODEL_NAME。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LLM_CONFIG_PATH = path.resolve(__dirname, '../../llm-config.json')

export interface LlmGatewayConfig {
  /** 网关地址（含端口/路径），如 http://127.0.0.1:8000/v1 */
  baseUrl?: string
  /** 调用上游的 API Key（可选） */
  apiKey?: string
  /** 默认模型名（缺省 competition-model） */
  modelName?: string
  /** 是否启用代理模式（false = mock） */
  enabled?: boolean
  /** 默认采样温度（请求未指定时使用） */
  temperature?: number
  /** 默认最大输出 token 数（请求未指定时使用） */
  maxTokens?: number
}

let cached: LlmGatewayConfig | null = null

function loadConfig(): LlmGatewayConfig {
  try {
    if (fs.existsSync(LLM_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf-8')) as LlmGatewayConfig
      if (typeof raw === 'object' && raw !== null) return raw
    }
  } catch { /* 配置损坏时回退环境变量 */ }
  return {
    baseUrl: process.env.MODEL_SERVER_URL || '',
    apiKey: process.env.COMPETITION_API_KEY || '',
    modelName: process.env.MODEL_NAME || 'competition-model',
    enabled: !!process.env.MODEL_SERVER_URL,
  }
}

/** 读取当前配置（首次调用后内存缓存；llm.ts 保存配置时调用 resetCache 失效） */
export function getGatewayConfig(): LlmGatewayConfig {
  if (cached === null) cached = loadConfig()
  return cached
}

/** 配置变更后调用（llm.ts saveConfig 内） */
export function resetGatewayCache(): void {
  cached = null
}

/** 网关模式：proxy（转发真实模型）/ mock（仿真回显） */
export type GatewayMode = 'proxy' | 'mock'

export function getGatewayMode(): GatewayMode {
  const c = getGatewayConfig()
  if (c.enabled === false) return 'mock'
  return (c.baseUrl || '').trim() ? 'proxy' : 'mock'
}

/** 生效的网关地址（去尾斜杠） */
export function effectiveBaseUrl(): string {
  const c = getGatewayConfig()
  if (c.enabled === false) return ''
  return (c.baseUrl || '').trim().replace(/\/+$/, '')
}

export function effectiveApiKey(): string {
  return (getGatewayConfig().apiKey || '').trim()
}

export function effectiveModel(): string {
  return (getGatewayConfig().modelName || '').trim() || 'competition-model'
}

export function saveGatewayConfig(next: LlmGatewayConfig): void {
  cached = next
  try {
    fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
  } catch (e) {
    console.error('[llm] 配置写入失败:', e)
  }
}
