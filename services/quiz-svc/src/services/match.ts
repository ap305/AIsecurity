import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { getGatewayMode, effectiveBaseUrl, effectiveApiKey, effectiveModel } from '../lib/llmConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 判题子进程降权：官方 node 镜像内置 node 用户 uid/gid=1000
const JUDGE_UID = Number(process.env.JUDGE_UID) || 1000
const JUDGE_GID = Number(process.env.JUDGE_GID) || 1000
const JUDGE_ASSETS = path.resolve(__dirname, '../../judge-assets')
const COMMON_DIR = path.resolve(JUDGE_ASSETS, '_common')
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads')
const MATCH_UPLOADS_DIR = path.resolve(UPLOADS_DIR, 'matches')

/** workDirId = uploads/matches/<id>/ 下的目录名（无状态，容器重启不丢失）。
 *  workDirId 合法性：仅允许字母数字下划线，防止路径遍历。 */
const WORK_DIR_ID_RE = /^[a-zA-Z0-9_]+$/

/** 由 workDirId 解析作品目录绝对路径：根目录或单一顶层子目录含 solution.py。 */
export function resolveWorkDir(workDirId: string | undefined | null): string | null {
  if (!workDirId || !WORK_DIR_ID_RE.test(workDirId)) return null
  const root = path.join(MATCH_UPLOADS_DIR, workDirId)
  if (!fs.existsSync(root)) return null
  // 优先：根目录直接含 solution.py
  if (fs.existsSync(path.join(root, 'solution.py'))) return root
  // 兼容 zip 套一层目录的情况：单一顶层子目录含 solution.py
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    if (dirs.length === 1) {
      const candidate = path.join(root, dirs[0].name)
      if (fs.existsSync(path.join(candidate, 'solution.py'))) return candidate
    }
  } catch { /* ignore */ }
  // 兜底：返回根目录（校验时会给出"缺少 solution.py"的明确错误）
  return root
}

export const MATCH_UPLOADS_DIR_VALUE = MATCH_UPLOADS_DIR
const ENGINE_PATHS: Record<string, string> = {
  bankbot: path.resolve(JUDGE_ASSETS, 'bankbot/bankbot_engine.py'),
  safellm: path.resolve(JUDGE_ASSETS, 'safellm/safellm_engine.py'),
  // 三个 Agent 间接注入场景共用通用 Agent 注入引擎（按 stdin scenario 选配置）
  mailmate: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  chatops: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  tripbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  // 提示词注入（与越狱互补的独立攻击面）
  prompt_injection: path.resolve(JUDGE_ASSETS, 'prompt_injection/prompt_injection_engine.py'),
  // RankGuard：大模型评分系统排序偏移攻防（prompt injection 变体，纯标准库）
  rankguard: path.resolve(JUDGE_ASSETS, 'rankguard/rankguard_engine.py'),
  // DeepFake 语音隐匿与反欺骗（numpy 音频仿真）
  deepfake_audio: path.resolve(JUDGE_ASSETS, 'deepfake_audio/deepfake_audio_engine.py'),
  // 图片水印消除与鲁棒检测（numpy DCT 仿真）
  watermark_image: path.resolve(JUDGE_ASSETS, 'watermark_image/watermark_image_engine.py'),
  // MNIST 局部触发器后门攻防（numpy 伪模型仿真）
  mnist_backdoor: path.resolve(JUDGE_ASSETS, 'mnist_backdoor/mnist_backdoor_engine.py'),
  // 0813 补充：DeepFake 图像痕迹隐匿 / MNIST 数据投毒 / LLM 文本水印 / RAG 投毒
  deepfake_image: path.resolve(JUDGE_ASSETS, 'deepfake_image/deepfake_image_engine.py'),
  mnist_poison: path.resolve(JUDGE_ASSETS, 'mnist_poison/mnist_poison_engine.py'),
  text_watermark: path.resolve(JUDGE_ASSETS, 'text_watermark/text_watermark_engine.py'),
  poisoned_rag: path.resolve(JUDGE_ASSETS, 'poisoned_rag/poisoned_rag_engine.py'),
  // 0816 补充：MNIST 黑盒模型蒸馏 / 目标检测对抗贴片
  mnist_distill: path.resolve(JUDGE_ASSETS, 'mnist_distill/mnist_distill_engine.py'),
  patch_attack: path.resolve(JUDGE_ASSETS, 'patch_attack/patch_attack_engine.py'),
  // 0824 补充：题目五~十二 8 道 Agent 新题（SupportBot/ProjectBot/VendorBot/
  // AgendaBot/WebBot/CodeReviewBot/HRBot/SearchBot）——全部复用通用 Agent 注入引擎
  supportbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  projectbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  vendorbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  agendabot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  webbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  codereviewbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  hrbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
  searchbot: path.resolve(JUDGE_ASSETS, 'agent_injection/agent_injection_engine.py'),
}

interface MatchInput {
  role: 'solo_attack' | 'solo_defense'
  attackCode: string
  defenseCode: string
  scenario?: string
  task?: unknown
  /** 工程上传模式：作品目录绝对路径。非空时引擎从 solution.py 加载 Solution 类。 */
  workDir?: string | null
  /** LLM 网关模式（由 runMatch 自动注入）：proxy=真实 LLM 判题 / mock=仿真 */
  llmMode?: 'mock' | 'proxy'
  llmBaseUrl?: string
  llmApiKey?: string
  llmModel?: string
}

export interface MatchResult {
  win?: boolean
  status?: string
  score?: number | null
  message?: string
  queries_used?: number
  fbr?: number
  task?: { sample_id?: string; goal?: string; risk_category?: string }
  interaction_log?: Array<Record<string, unknown>>
}

interface EngineOutput {
  id: string
  status: string
  score: number | null
  result: {
    message: string
    details: MatchResult
  }
}

export async function runMatch(input: MatchInput): Promise<EngineOutput> {
  const pythonBin = process.env.PYTHON_BIN || 'python3'
  const scenario = input.scenario || 'bankbot'
  const enginePath = ENGINE_PATHS[scenario] || ENGINE_PATHS.bankbot

  return new Promise((resolve) => {
    const proc = spawn(pythonBin, [enginePath], {
      timeout: 60000,
      // 判题子进程降权（非 root） + 环境白名单（不继承 DATABASE_URL / Token 等敏感变量）
      uid: JUDGE_UID,
      gid: JUDGE_GID,
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        // 强制 Python UTF-8 模式：容器 locale 可能非 UTF-8，中文载荷经 stdin/stdout 会乱码
        PYTHONUTF8: '1',
        // 让引擎可直接 import solution_loader（_common 已在各引擎 sys.path 兜底）
        PYTHONPATH: [COMMON_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      resolve({
        id: 'error',
        status: 'error',
        score: null,
        result: {
          message: `引擎启动失败: ${err.message}`,
          details: {
            win: false, status: 'error', score: null,
            message: stderr.slice(0, 500),
            queries_used: 0, fbr: 0, interaction_log: [],
          },
        },
      })
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({
          id: 'error',
          status: 'error',
          score: null,
          result: {
            message: `引擎异常退出 (code=${code}): ${stderr.slice(0, 300)}`,
            details: {
              win: false, status: 'error', score: null,
              message: stderr.slice(0, 500),
              queries_used: 0, fbr: 0, interaction_log: [],
            },
          },
        })
        return
      }

      try {
        const trimmed = stdout.trim()
        const result = JSON.parse(trimmed) as EngineOutput
        resolve(result)
      } catch {
        // Try to find JSON in output
        const jsonMatch = stdout.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            resolve(JSON.parse(jsonMatch[0]) as EngineOutput)
            return
          } catch { /* fall through */ }
        }
        resolve({
          id: 'error',
          status: 'error',
          score: null,
          result: {
            message: `引擎输出解析失败: ${stdout.slice(0, 200)}`,
            details: {
              win: false, status: 'error', score: null,
              message: stdout.slice(0, 500),
              queries_used: 0, fbr: 0, interaction_log: [],
            },
          },
        })
      }
    })

    // Write input to stdin and close it
    // 注入 LLM 网关模式：proxy=真实 LLM 判题 / mock=仿真（引擎按需使用）
    const stdinPayload = {
      ...input,
      llmMode: getGatewayMode(),
      llmBaseUrl: effectiveBaseUrl(),
      llmApiKey: effectiveApiKey(),
      llmModel: effectiveModel(),
    }
    const inputJson = JSON.stringify(stdinPayload)
    proc.stdin.write(inputJson)
    proc.stdin.end()
  })
}
