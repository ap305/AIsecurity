import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * GitHub 作品归档配置（共享模块）
 *
 * - 由 admin 通过 /api/admin/github-archive/config 界面管理，
 *   持久化于 github-archive-config.json（容器挂载目录），保存后运行时立即生效，无需重启。
 * - 未配置时回退环境变量 GITHUB_ARCHIVE_ENABLED / GITHUB_ARCHIVE_TOKEN /
 *   GITHUB_ARCHIVE_REPO / GITHUB_ARCHIVE_BRANCH / GITHUB_ARCHIVE_BASE_PATH /
 *   GITHUB_ARCHIVE_CREATE_REPO / GITHUB_ARCHIVE_COMMIT_AS_STUDENT / GITHUB_ARCHIVE_MAX_FILE_BYTES。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const GITHUB_ARCHIVE_CONFIG_PATH = path.resolve(__dirname, '../../github-archive-config.json')

export interface GithubArchiveConfig {
  /** 是否启用归档（true 后上传作品强制写入 GitHub 仓库，失败则上传失败） */
  enabled?: boolean
  /** 机器人 PAT（含 repo 写权限；如需自动建仓库再加 public_repo） */
  token?: string
  /** 归档仓库，格式 owner/repo */
  repo?: string
  /** 归档分支 */
  branch?: string
  /** 归档根目录 */
  basePath?: string
  /** 仓库不存在时自动创建（公开） */
  createRepo?: boolean
  /** 以学生 GitHub 身份作为 commit author（计入贡献者） */
  commitAsStudent?: boolean
  /** 单文件大小上限（GitHub API 100MB 限制） */
  maxFileBytes?: number
}

let cached: GithubArchiveConfig | null = null

function envDefault(): GithubArchiveConfig {
  const v = (process.env.GITHUB_ARCHIVE_ENABLED || '').toLowerCase()
  return {
    enabled: v === 'true' || v === '1',
    token: process.env.GITHUB_ARCHIVE_TOKEN || '',
    repo: process.env.GITHUB_ARCHIVE_REPO || '',
    branch: process.env.GITHUB_ARCHIVE_BRANCH || 'main',
    basePath: process.env.GITHUB_ARCHIVE_BASE_PATH || 'submissions',
    createRepo: (process.env.GITHUB_ARCHIVE_CREATE_REPO || '').toLowerCase() === 'true',
    commitAsStudent: (process.env.GITHUB_ARCHIVE_COMMIT_AS_STUDENT ?? 'true').toLowerCase() !== 'false',
    maxFileBytes: Number(process.env.GITHUB_ARCHIVE_MAX_FILE_BYTES) || 95 * 1024 * 1024,
  }
}

function loadConfig(): GithubArchiveConfig {
  try {
    if (fs.existsSync(GITHUB_ARCHIVE_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GITHUB_ARCHIVE_CONFIG_PATH, 'utf-8')) as GithubArchiveConfig
      if (typeof raw === 'object' && raw !== null) return raw
    }
  } catch { /* 配置损坏时回退环境变量 */ }
  return envDefault()
}

/** 读取当前配置（首次调用后内存缓存；保存配置时调用 resetGithubArchiveCache 失效） */
export function getGithubArchiveConfig(): GithubArchiveConfig {
  if (cached === null) cached = loadConfig()
  return cached
}

/** 配置变更后调用（routes 保存配置时） */
export function resetGithubArchiveCache(): void {
  cached = null
}

/** 保存配置并立即生效（写 JSON 文件，容器挂载目录持久化） */
export function saveGithubArchiveConfig(next: GithubArchiveConfig): void {
  cached = next
  try {
    fs.mkdirSync(path.dirname(GITHUB_ARCHIVE_CONFIG_PATH), { recursive: true })
    fs.writeFileSync(GITHUB_ARCHIVE_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf-8')
  } catch (e) {
    console.error('[github-archive] 配置写入失败:', e)
  }
}

/** Token 脱敏：仅显示前 4 位与后 4 位 */
export function maskToken(token: string | undefined): string {
  if (!token) return ''
  if (token.length <= 12) return '****'
  return `${token.slice(0, 4)}****${token.slice(-4)}`
}