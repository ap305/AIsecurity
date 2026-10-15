import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getAdapter } from './managedAdapters/index.js'
import { getGatewayMode, effectiveApiKey, effectiveModel } from './llmConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 受管判题（backend + blank 合并，跑 7z 自带 test.py）
 *
 * 资产目录：judge-assets/managed/<scenario>/vN/
 *   code/           7z 场景代码（dataset.py、test.py、backend/blank、data 等）
 *   version.json    版本元信息 + scoreMapping 评分换算
 * current 文件      当前默认启用版本（例如 v1）
 */

const MANAGED_ROOT = path.resolve(__dirname, '../../judge-assets/managed')
/** 真实 API 判题依赖（openai 等）的持久化安装目录（容器内 /app/... 与宿主机共享） */
const JUDGE_DEPS_DIR = path.resolve(MANAGED_ROOT, '..', '_pydeps')
/** 判题失败日志（放在 managed/ 之外，避免被当成一个“场景”） */
const JUDGE_LOG_DIR = path.resolve(MANAGED_ROOT, '..', '_logs')
const JUDGE_ERROR_LOG = path.join(JUDGE_LOG_DIR, 'judge-errors.log')
const MARKER = '# [IMPORTANT] Replace this line with real attack/defense code.'
const ROLE_FN: Record<string, string> = { solo_attack: 'attack', solo_defense: 'defend' }
const ROLE_FILE: Record<string, string> = {
  solo_attack: 'attack-blank.py',
  solo_defense: 'defense-blank.py',
}
/** 合并后写入的运行模块名：attack.py / defense.py */
const ROLE_MODULE: Record<string, string> = { solo_attack: 'attack.py', solo_defense: 'defense.py' }

/** 该场景/角色要求的 blank 符号：类契约题目（贴片/DeepFake）用 adapter，其余用顶层函数 */
export function blankRequiredSymbols(scenario: string, role: 'solo_attack' | 'solo_defense'): string[] {
  const adapter = getAdapter(scenario)
  if (adapter) return adapter.requiredSymbols[role]
  return [`def ${ROLE_FN[role]}(`]
}

/** 判题模式：题目 version.json 的 judge 字段声明 api 且平台网关可用时才走真实大模型 */
function resolveJudgeMode(manifest: Record<string, unknown>): 'mock' | 'api' {
  const judge = (manifest.judge ?? {}) as { default?: string; api?: boolean }
  const wantsApi = judge.default === 'api' || judge.api === true
  if (!wantsApi) return 'mock'
  if (getGatewayMode() !== 'proxy') {
    console.warn('[judge] 题目配置为 api 判题，但平台 LLM 网关未启用，回退 mock')
    return 'mock'
  }
  return 'api'
}

/** 判题子进程环境：补充 openai 依赖路径；api 模式下注入平台网关地址与密钥 */
function buildJudgeEnv(judgeMode: 'mock' | 'api'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' }
  env.PYTHONPATH = [JUDGE_DEPS_DIR, env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  if (judgeMode === 'api') {
    const port = Number(process.env.PORT) || 4002
    const base = `http://127.0.0.1:${port}/api/v1`
    const key = effectiveApiKey()
    const model = effectiveModel()
    // supportbot / agendabot / webbot 读 JUDGE_*，chatops 读 AGENT_*，两套都注入
    env.JUDGE_BASE_URL = base
    env.JUDGE_API_KEY = key
    env.JUDGE_MODEL = model
    env.AGENT_BASE_URL = base
    env.AGENT_API_KEY = key
    env.AGENT_MODEL = model
  }
  return env
}

export interface ManagedVersionMeta {
  scenario: string
  version: string
  active: boolean
  ready: boolean
  judge?: { default?: string; api?: boolean }
  scoreMapping?: Record<string, string>
  files: string[]
  versionJson?: Record<string, unknown>
}

export interface ManagedJudgeInput {
  scenario: string
  role: 'solo_attack' | 'solo_defense'
  version?: string
  code?: string
  workDir?: string
  timeoutMs?: number
}

export interface ManagedJudgeResult {
  status: 'passed' | 'failed' | 'error'
  score: number | null
  message: string
  metrics?: Record<string, unknown>
}

/** 追加一条判题失败记录（含完整 stderr），便于事后定位模型/脚本问题 */
export function logJudgeError(scenario: string, role: string, detail: string): void {
  const line = `${new Date().toISOString()}\t${scenario}\t${role}\t${String(detail).replace(/\s+/g, ' ').slice(0, 4000)}\n`
  try {
    fs.mkdirSync(JUDGE_LOG_DIR, { recursive: true })
    fs.appendFileSync(JUDGE_ERROR_LOG, line, 'utf-8')
  } catch { /* 日志失败不影响判题结果 */ }
  console.error(`[judge] ${scenario}/${role} 失败: ${line.trim()}`)
}

function readJson(p: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
  try {
    // Python json.dump 允许写出 NaN/Infinity 字面量（如水印题 PSNR 恒等用例），
    // Node JSON.parse 视为非法；归一化后再解析，评分侧 num() 自带有限性保护。
    const safe = raw
      .replace(/(?<![A-Za-z0-9_."])-Infinity\b/g, '-1e308')
      .replace(/(?<![A-Za-z0-9_."])Infinity\b/g, '1e308')
      .replace(/(?<![A-Za-z0-9_."])NaN\b/g, 'null')
    return JSON.parse(safe) as Record<string, unknown>
  } catch {
    return null
  }
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

function scenarioRoot(scenario: string): string {
  return path.join(MANAGED_ROOT, scenario)
}

export function resolveManagedVersion(scenario: string, preferred?: string): { version: string; dir: string } | null {
  const root = scenarioRoot(scenario)
  const versions = listDir(root)
    .filter((v) => /^v\d/.test(v) && fs.existsSync(path.join(root, v, 'version.json')))
    .sort((a, b) => Number(a.replace(/^v/, '')) - Number(b.replace(/^v/, '')))
  if (versions.length === 0) return null
  let version = preferred && versions.includes(preferred) ? preferred : ''
  if (!version) {
    try {
      const cur = fs.readFileSync(path.join(root, 'current'), 'utf-8').trim()
      if (versions.includes(cur)) version = cur
    } catch { /* ignore */ }
  }
  if (!version) version = versions[versions.length - 1]
  return { version, dir: path.join(root, version) }
}

export function listManagedVersions(scenario: string): ManagedVersionMeta[] {
  const root = scenarioRoot(scenario)
  let active = ''
  try {
    active = fs.readFileSync(path.join(root, 'current'), 'utf-8').trim()
  } catch { /* ignore */ }
  return listDir(root)
    .filter((v) => /^v\d/.test(v) && fs.existsSync(path.join(root, v, 'version.json')))
    .map((v) => {
      const vd = path.join(root, v)
      const vj = readJson(path.join(vd, 'version.json'))
      const codeDir = path.join(vd, 'code')
      const files = listDir(codeDir)
      const manifestReady = vj?.ready !== false && vj?.scenario === scenario
      const ready = manifestReady &&
        files.includes('test.py') &&
        files.includes('attack-backend.py') &&
        files.includes('attack-blank.py') &&
        files.includes('defense-backend.py') &&
        files.includes('defense-blank.py')
      return {
        scenario,
        version: v,
        active: v === active,
        ready,
        judge: (vj?.judge as Record<string, unknown> | undefined) ?? undefined,
        scoreMapping: (vj?.scoreMapping as Record<string, string> | undefined) ?? undefined,
        files,
        versionJson: vj ?? undefined,
      }
    })
}

/** 该场景已就绪（可切换）的受管版本；无版本或未就绪返回空 */
export function listReadyVersions(scenario: string): ManagedVersionMeta[] {
  return listManagedVersions(scenario).filter((v) => v.ready)
}

export function listManagedScenarios(): { scenario: string; versions: ManagedVersionMeta[] }[] {
  return listDir(MANAGED_ROOT)
    .filter((s) => fs.existsSync(path.join(MANAGED_ROOT, s, 'current')) || listDir(path.join(MANAGED_ROOT, s)).length > 0)
    .map((s) => ({ scenario: s, versions: listManagedVersions(s) }))
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

/** 仅做合并（不运行）：供“网页 inline 代码 → 平台合并 → GitHub 归档”使用 */
export function buildManagedInline(
  scenario: string,
  role: 'solo_attack' | 'solo_defense',
  version: string | undefined,
  code: string,
): { ok: boolean; error?: string; merged?: string; version?: string } {
  const resolved = resolveManagedVersion(scenario, version)
  if (!resolved) return { ok: false, error: '该场景尚未部署可用的受管判题版本' }
  const codeDir = path.join(resolved.dir, 'code')
  const backend = readText(path.join(codeDir, role === 'solo_attack' ? 'attack-backend.py' : 'defense-backend.py'))
  const need = blankRequiredSymbols(scenario, role)
  if (!need.some((pt) => String(code ?? '').includes(pt))) {
    return { ok: false, error: `代码必须包含 ${need.join(' 或 ')}` }
  }
  const merged = mergeBlank(backend, code, role, need)
  if (!merged.ok) return { ok: false, error: merged.error }
  return { ok: true, merged: merged.merged, version: resolved.version }
}

export function mergeBlank(
  backendText: string,
  blankText: string,
  role: 'solo_attack' | 'solo_defense',
  requiredSymbols?: string[],
): { ok: boolean; error?: string; merged?: string } {
  const fn = ROLE_FN[role]
  const blank = String(blankText ?? '').trim()
  if (!blank) return { ok: false, error: '未收到学生代码（blank 为空）' }
  if (!backendText.includes(MARKER)) return { ok: false, error: 'backend 中缺少合并标记（版本资产异常）' }
  const need = requiredSymbols && requiredSymbols.length > 0 ? requiredSymbols : [`def ${fn}(`]
  if (!need.some((symbol) => blank.includes(symbol))) {
    return { ok: false, error: `blank 内容必须包含 ${need.join(' 或 ')}，当前内容无法合并` }
  }
  const merged = backendText.replace(MARKER, blank.replace(/\s+$/, '') + '\n')
  return { ok: true, merged }
}

function scoreFromMapping(expr: string | undefined, m: Record<string, unknown>): number {
  if (!expr) return 0
  try {
    const fn = new Function('m', 'Math', `return (${expr})`) as (m: Record<string, unknown>, math: Math) => number
    const v = Number(fn(m, Math))
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0
  } catch {
    return 0
  }
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name)
    const d = path.join(dst, name)
    if (name === 'results' || name === '__pycache__') continue
    if (fs.statSync(s).isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function runPython(cwd: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', args, {
      cwd,
      timeout: timeoutMs,
      env: extraEnv ?? { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export async function runManagedMatch(input: ManagedJudgeInput): Promise<ManagedJudgeResult> {
  const role = input.role
  const resolved = resolveManagedVersion(input.scenario, input.version)
  if (!resolved) {
    return { status: 'error', score: null, message: '该场景尚未部署受管判题版本，请在题目管理中回退到旧引擎或先导入版本' }
  }
  const codeDir = path.join(resolved.dir, 'code')
  const manifest = readJson(path.join(resolved.dir, 'version.json')) ?? {}
  const backend = readText(path.join(codeDir, role === 'solo_attack' ? 'attack-backend.py' : 'defense-backend.py'))

  let blankText = input.code ?? ''
  if (!blankText.trim() && input.workDir) {
    const blankPath = path.join(input.workDir, ROLE_FILE[role])
    blankText = readText(blankPath)
  }
  const adapter = getAdapter(input.scenario)
  const need = blankRequiredSymbols(input.scenario, role)
  if (!need.some((pt) => blankText.includes(pt))) {
    return { status: 'error', score: null, message: `blank 必须包含 ${need.join(' 或 ')}` }
  }
  const merged = mergeBlank(backend, blankText, role, need)
  if (!merged.ok) {
    return { status: 'error', score: null, message: merged.error ?? 'blank 合并失败' }
  }

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjudge-'))
  try {
    copyDir(codeDir, runDir)
    fs.writeFileSync(path.join(runDir, ROLE_MODULE[role]), merged.merged ?? '', 'utf-8')
    fs.mkdirSync(path.join(runDir, 'results'), { recursive: true })
    const roleKey = role === 'solo_attack' ? 'attack' : 'defense'
    const judgeMode = resolveJudgeMode(manifest)
    const timeoutCfg = manifest.timeoutMs as Record<string, number> | number | undefined
    const timeoutMs = input.timeoutMs
      || (typeof timeoutCfg === 'number' ? timeoutCfg : Number(timeoutCfg?.[roleKey]))
      || 120000
    const stageCfg = manifest.stage as Record<string, string[]> | string[] | undefined
    let stageArgs = Array.isArray(stageCfg)
      ? ['--stage', roleKey, '--judge', judgeMode]
      : (stageCfg?.[roleKey] ?? ['--stage', roleKey, '--judge', judgeMode])
    // 真实大模型判题慢：题目可在 version.json 用 apiMatches 指定 api 模式下的对阵场数
    if (judgeMode === 'api') {
      const apiMatches = Math.floor(Number(manifest.apiMatches))
      if (Number.isFinite(apiMatches) && apiMatches > 0) {
        stageArgs = [...stageArgs, '--matches', String(apiMatches)]
      }
    }
    const args = ['test.py', ...stageArgs, '--output', 'results/metrics.json']
    const run = await runPython(runDir, args, timeoutMs, buildJudgeEnv(judgeMode))
    if (run.code !== 0) {
      logJudgeError(input.scenario, role,
        `exit=${run.code} judge=${judgeMode} args=${args.join(' ')} stderr=${run.stderr.slice(-3000)} stdout=${run.stdout.slice(-500)}`)
      return { status: 'error', score: null, message: `受管评测脚本执行失败（exit=${run.code}）：${run.stderr.slice(-700) || run.stdout.slice(-300)}` }
    }
    const metricsPath = path.join(runDir, 'results', 'metrics.json')
    const metrics = readJson(metricsPath) as Record<string, unknown> | null
    if (!metrics) {
      const metricsExists = fs.existsSync(metricsPath)
      logJudgeError(input.scenario, role,
        `no-metrics exists=${metricsExists} judge=${judgeMode} stdout=${run.stdout.slice(-1500)} stderr=${run.stderr.slice(-800)}`)
      return {
        status: 'error',
        score: null,
        message: (metricsExists ? '受管评测 metrics.json 解析失败' : '受管评测未产出 metrics.json')
          + '（脚本输出尾部：' + run.stdout.slice(-200) + '）',
      }
    }
    let score: number
    let note = ''
    let status: 'passed' | 'failed'
    if (adapter) {
      const out = adapter.score(role, metrics as Record<string, unknown>)
      score = out.score
      status = out.status
      note = out.note
    } else {
      const mapping = (manifest.scoreMapping as Record<string, string> | undefined)?.[role === 'solo_attack' ? 'attack' : 'defense'] ?? ''
      score = scoreFromMapping(mapping, metrics)
      status = score > 0 ? 'passed' : 'failed'
    }
    const message = `受管评测完成（${resolved.version} · ${judgeMode}）得分 ${score}${note ? ' · ' + note : ''}`
    return { status, score, message, metrics }
  } catch (e) {
    return { status: 'error', score: null, message: e instanceof Error ? e.message : '受管评测内部错误' }
  } finally {
    // 回写真实 API 的参考与调用缓存，避免每次判题重复生成、重复消耗 token
    try {
      // 注意：agent_cache 是 agendaBot/webBot/chatOps 的 LLM 响应缓存目录，
      // 遗漏会导致每次判题都重新调用大模型（单场 ~1.5 分钟）。
      for (const sub of ['data/reference_api', 'data/judge_cache', 'data/agent_cache']) {
        const src = path.join(runDir, sub)
        if (fs.existsSync(src)) copyDir(src, path.join(codeDir, sub))
      }
    } catch { /* 缓存回写失败不影响判题结果 */ }
    fs.rmSync(runDir, { recursive: true, force: true })
  }
}
