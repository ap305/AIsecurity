import fs from 'fs'
import path from 'path'
import { getGithubArchiveConfig } from './githubArchiveConfig.js'

/**
 * GitHub 作品归档 + 贡献者机制
 *
 * 机制说明（基于 GitHub 开源贡献规则）：
 * - GitHub 按「提交作者邮箱」归属提交到用户账户（推送时解析）；
 *   2017-07-18 后注册账号的官方 noreply 邮箱格式为 <user_id>+<login>@users.noreply.github.com，
 *   该邮箱自动与账号关联，因此以该邮箱作为 commit author 的提交会记入学生本人的贡献图谱，
 *   并出现在归档仓库的 Contributors 列表 —— 学生由此成为该公开项目的贡献者。
 * - 平台以机器人身份（GITHUB_ARCHIVE_TOKEN）提交，committer 为机器人，author 为学生本人。
 * - 标准开源贡献路径（fork → 分支 → PR → merge）用于主平台仓库，见 docs/GITHUB_ARCHIVE.md。
 *
 * 配置（环境变量）：
 *   GITHUB_ARCHIVE_ENABLED        true/1 启用归档（默认关闭）
 *   GITHUB_ARCHIVE_TOKEN          机器人 PAT（需要 repo 写入；如需自动建仓库再加 public_repo）
 *   GITHUB_ARCHIVE_REPO           归档仓库，格式 owner/repo
 *   GITHUB_ARCHIVE_BRANCH         默认 main
 *   GITHUB_ARCHIVE_BASE_PATH      默认 submissions
 *   GITHUB_ARCHIVE_CREATE_REPO    true 时仓库不存在则自动创建（公开）
 *   GITHUB_ARCHIVE_COMMIT_AS_STUDENT  默认 true：以学生身份作为 commit author
 *   GITHUB_ARCHIVE_MAX_FILE_BYTES 单文件大小上限（默认 95MB，GitHub API 限制 100MB）
 */

export interface ArchiveOptions {
  workDirId: string
  workDir: string
  githubAccount: string
  displayName?: string
  scenario?: string
  role?: string
  userId?: string
  /** 上传版本号（同一场景+角色下第 N 次成功上传，从 1 开始） */
  version?: number
  /** 自动命名模式：在题目仓库中为上传者创建「平台用户名」分支，作品按上传ID归档到该分支 */
  uploaderBranch?: boolean
  /** 原始上传 zip 路径（multer 保存后保留），存在则一并归档 */
  zipPath?: string
  /** 原始上传文件名（*.zip） */
  originalZipName?: string
  /** 按场景绑定的归档仓库（owner/repo），覆盖全局仓库 */
  repoOverride?: string
  /** 按场景绑定的分支，缺省用全局分支 */
  branchOverride?: string
}

export interface ArchiveResult {
  archived: boolean
  url?: string
  reason?: string
  error?: string
  studentLogin?: string
}

interface GithubIdentity {
  id: number
  login: string
  name: string | null
  noreplyEmail: string
}

const API_BASE = 'https://api.github.com'
const DEFAULT_MAX_FILE_BYTES = 95 * 1024 * 1024

function isEnabled(): boolean {
  return getGithubArchiveConfig().enabled === true
}

interface ArchiveConfig {
  token: string
  owner: string
  repo: string
  branch: string
  basePath: string
  createRepo: boolean
  commitAsStudent: boolean
  maxFileBytes: number
}

function getConfig(): ArchiveConfig {
  const c = getGithubArchiveConfig()
  const repo = (c.repo || '').trim().replace(/\/$/, '')
  const [owner, repoName] = repo.split('/')
  return {
    token: (c.token || '').trim(),
    owner: owner || '',
    repo: repoName || '',
    branch: (c.branch || 'main').trim(),
    basePath: (c.basePath || 'submissions').trim().replace(/^\/+|\/+$/g, ''),
    createRepo: c.createRepo === true,
    commitAsStudent: c.commitAsStudent !== false,
    maxFileBytes: c.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
  }
}

/** 平台用户名 → Git 个人分支名（平台用户名限 3-32 位字母/数字，此处二次校验 Git ref 安全字符） */
export function sanitizeUploaderBranch(name: string): string {
  const s = (name || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,253}$/.test(s) ? s : ''
}

/** 从「用户名 / @用户名 / github.com/用户名 / https://github.com/用户名」中提取 GitHub 用户名。 */
export function normalizeGithubAccount(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const m = s.match(/(?:github\.com\/|@)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)/)
  const login = (m ? m[1] : s).replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '').replace(/^@/, '').trim()
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login : ''
}

function encPath(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/')
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 80)
}

async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  })
}

const identityCache = new Map<string, GithubIdentity>()

async function resolveIdentity(username: string, token: string): Promise<GithubIdentity | null> {
  const cached = identityCache.get(username)
  if (cached) return cached
  try {
    const res = await githubFetch(`${API_BASE}/users/${encodeURIComponent(username)}`, token)
    if (!res.ok) return null
    const data = (await res.json()) as { id?: number; login?: string; name?: string | null }
    if (!data.id || !data.login) return null
    const ident: GithubIdentity = {
      id: data.id,
      login: data.login,
      name: data.name ?? data.login,
      noreplyEmail: `${data.id}+${data.login}@users.noreply.github.com`,
    }
    identityCache.set(username, ident)
    return ident
  } catch {
    return null
  }
}

async function resolveBotIdentity(token: string): Promise<GithubIdentity | null> {
  try {
    const res = await githubFetch(`${API_BASE}/user`, token)
    if (!res.ok) return null
    const data = (await res.json()) as { id?: number; login?: string; name?: string | null }
    if (!data.id || !data.login) return null
    return {
      id: data.id,
      login: data.login,
      name: data.name ?? data.login,
      noreplyEmail: `${data.id}+${data.login}@users.noreply.github.com`,
    }
  } catch {
    return null
  }
}

interface RepoInfo {
  url: string
  defaultBranch: string
  /** 仓库数字 ID：API 用 /repositories/{id} 访问，避免仓库改名导致 307 跳转/失败 */
  id: number
  /** 规范化 full_name（owner/当前仓库名），用于展示链接 */
  fullName: string
}

async function ensureRepo(cfg: ArchiveConfig): Promise<RepoInfo | null> {
  const repoUrl = `${API_BASE}/repos/${cfg.owner}/${cfg.repo}`
  const res = await githubFetch(repoUrl, cfg.token)
  if (res.ok) {
    const d = (await res.json()) as { default_branch?: string; id?: number; full_name?: string }
    return {
      url: repoUrl,
      defaultBranch: d.default_branch || 'main',
      id: Number(d.id),
      fullName: d.full_name || `${cfg.owner}/${cfg.repo}`,
    }
  }
  if (res.status === 404 && cfg.createRepo) {
    const create = await githubFetch(`${API_BASE}/user/repos`, cfg.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cfg.repo,
        description: 'AI 安全教学实验平台 · 学生作品归档仓库（submissions/）',
        private: false,
        auto_init: true,
      }),
    })
    if (create.ok) {
      const created = (await create.json()) as { default_branch?: string; id?: number; full_name?: string }
      return {
        url: `${API_BASE}/repos/${cfg.owner}/${cfg.repo}`,
        defaultBranch: created.default_branch || 'main',
        id: Number(created.id),
        fullName: created.full_name || `${cfg.owner}/${cfg.repo}`,
      }
    }
    return null
  }
  return null
}

/** 自动命名模式：确保学生个人分支存在，首次上传时从仓库默认分支创建（用仓库数字 ID 避免改名跳转） */
async function ensureBranch(cfg: ArchiveConfig, repoId: number, branch: string, defaultBranch: string): Promise<boolean> {
  if (!branch || branch === defaultBranch) return false
  const base = `${API_BASE}/repositories/${repoId}`
  const check = await githubFetch(`${base}/branches/${encodeURIComponent(branch)}`, cfg.token)
  if (check.ok) return true
  if (check.status !== 404) return false
  const refRes = await githubFetch(`${base}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, cfg.token)
  if (!refRes.ok) return false
  const refData = (await refRes.json()) as { object?: { sha?: string } }
  if (!refData.object?.sha) return false
  const create = await githubFetch(`${base}/git/refs`, cfg.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: refData.object.sha }),
  })
  return create.ok
}

interface CollectEntry {
  relPath: string
  absPath: string
  bytes: number
}

function collectFiles(workDir: string, maxFileBytes: number): { files: CollectEntry[]; skipped: string[] } {
  const files: CollectEntry[] = []
  const skipped: string[] = []
  const skipDirs = new Set(['__pycache__', '.git', 'node_modules', '.idea', '.vscode'])
  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue
      const full = path.join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(full, rel)
      } else if (e.isFile()) {
        if (e.name === 'meta.json') continue
        const stat = fs.statSync(full)
        if (stat.size > maxFileBytes) {
          skipped.push(`${rel} (${stat.size} bytes)`)
          continue
        }
        files.push({ relPath: rel, absPath: full, bytes: stat.size })
      }
    }
  }
  walk(workDir, '')
  return { files, skipped }
}

export async function archiveSubmission(opts: ArchiveOptions): Promise<ArchiveResult> {
  if (!isEnabled()) return { archived: false, reason: 'disabled' }
  const cfg = getConfig()
  if (!cfg.token) {
    return { archived: false, reason: 'not-configured' }
  }
  const account = normalizeGithubAccount(opts.githubAccount)
  if (!account) return { archived: false, error: 'GitHub 账号格式无效，无法归档' }

  // 按场景绑定的仓库覆盖全局仓库（repoOverride 来自题目配置）。
  // 支持两种写法：owner/repo（归档到仓库根目录），或 owner/repo/子目录（归档到该子目录，
  // 如 BIT-615/AI-Security-Submissions/m8 → m8/<GitHub账号>/<上传ID>/）。
  const effRepoRaw = (opts.repoOverride || cfg.repo || '').trim().replace(/\/+$/, '')
  const parts = effRepoRaw.split('/').filter(Boolean)
  const [effOwner, effRepo, ...subdirParts] = parts
  // 自动命名开启时仓库只取 owner/repo，忽略旧逻辑里的额外子目录段
  const effSubdir = opts.uploaderBranch
    ? ''
    : subdirParts.map((seg) => sanitizeSegment(seg)).filter(Boolean).join('/')
  const effBranch = (opts.branchOverride || cfg.branch || 'main').trim()
  if (!effOwner || !effRepo) {
    return { archived: false, reason: 'not-configured' }
  }
  const effCfg = { ...cfg, owner: effOwner, repo: effRepo, branch: effBranch }

  const repoInfo = await ensureRepo(effCfg)
  if (!repoInfo) return { archived: false, error: '归档仓库不存在或无权访问（可在 GITHUB_ARCHIVE_CREATE_REPO=true 时自动创建）' }
  // 后续所有写操作走 /repositories/{id}，避免仓库被改名后 owner/repo 路径 307 跳转导致失败
  const repoApiBase = `${API_BASE}/repositories/${repoInfo.id}`
  const canonicalRepo = repoInfo.fullName || `${effOwner}/${effRepo}`

  // 自动命名：作品提交到学生的个人分支（首次自动创建）；贡献者名单仍维护在仓库默认分支
  if (opts.uploaderBranch) {
    const branchOk = await ensureBranch(effCfg, repoInfo.id, effBranch, repoInfo.defaultBranch)
    if (!branchOk) {
      return { archived: false, error: `个人分支 ${effBranch} 创建/访问失败（请确认仓库存在且默认分支为 ${repoInfo.defaultBranch}）` }
    }
  }
  const contributorsCfg = {
    ...cfg,
    owner: effOwner,
    repo: effRepo,
    branch: opts.uploaderBranch ? repoInfo.defaultBranch : effBranch,
  }

  const bot = cfg.commitAsStudent ? await resolveBotIdentity(cfg.token) : null
  const student = cfg.commitAsStudent ? await resolveIdentity(account, cfg.token) : null
  const author = student
    ? { name: student.name || student.login, email: student.noreplyEmail }
    : undefined

  const { files, skipped } = collectFiles(opts.workDir, cfg.maxFileBytes)
  // 归档路径：自动命名 → 个人分支根目录（每次上传直接更新根目录文件，历史版本保留在 Git
  // 提交历史中，分支最新内容即最新版本）；否则 [题目绑定子目录(如 m8，可选)]/<GitHub账号>/<上传ID>/
  const prefix = opts.uploaderBranch
    ? ''
    : effSubdir
      ? `${effSubdir}/${sanitizeSegment(account)}/${opts.workDirId}`
      : `${sanitizeSegment(account)}/${opts.workDirId}`
  const relPaths = files.map((f) => f.relPath)

  // 原始上传 zip 一并归档（未超单文件上限时）
  const zipName = opts.originalZipName || `${opts.workDirId}.zip`
  let zipEntry: CollectEntry | null = null
  if (opts.zipPath && fs.existsSync(opts.zipPath)) {
    const st = fs.statSync(opts.zipPath)
    if (st.size <= cfg.maxFileBytes) {
      zipEntry = { relPath: zipName, absPath: opts.zipPath, bytes: st.size }
      relPaths.push(zipName)
    } else {
      skipped.push(`${zipName} (${st.size} bytes 超过单文件上限)`)
    }
  }

  const meta = {
    workDirId: opts.workDirId,
    branch: effBranch,
    uploaderBranch: opts.uploaderBranch === true,
    githubAccount: account,
    displayName: opts.displayName ?? '',
    scenario: opts.scenario ?? '',
    role: opts.role ?? '',
    userId: opts.userId ?? '',
    version: opts.version ?? 0,
    originalZipName: opts.originalZipName ?? '',
    archivedZip: !!zipEntry,
    uploadedAt: new Date().toISOString(),
    files: relPaths,
    skippedLargeFiles: skipped,
  }

  const putFile = async (relPath: string, content: Buffer) => {
    const body: Record<string, unknown> = {
      message: `作品归档 ${opts.workDirId} · ${account} · ${opts.scenario || '对战'}`,
      content: content.toString('base64'),
      branch: effBranch,
    }
    if (author) {
      body.author = author
      body.committer = bot ? { name: bot.name || bot.login, email: bot.noreplyEmail } : undefined
    }
    const contentPath = prefix ? `${prefix}/${relPath}` : relPath
    const putUrl = `${repoApiBase}/contents/${encPath(contentPath)}`
    let res = await githubFetch(
      putUrl,
      cfg.token,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    // 目标文件已存在（正常覆盖场景或上次上传中断残留）时，GitHub 要求携带 sha，自动取 sha 重试
    if (!res.ok && res.status === 422) {
      const getRes = await githubFetch(`${putUrl}?ref=${encodeURIComponent(effBranch)}`, cfg.token)
      if (getRes.ok) {
        const gd = (await getRes.json()) as { sha?: string }
        if (gd.sha) {
          body.sha = gd.sha
          res = await githubFetch(
            putUrl,
            cfg.token,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          )
        }
      }
    }
    if (!res.ok) {
      const txt = await res.text()
      const hint = res.status === 403
        ? '；Token 权限不足：fine-grained PAT 需勾选 Contents: Read and write（classic PAT 需 repo 权限）'
        : ''
      throw new Error(`GitHub 写入失败 ${prefix}/${relPath}: ${res.status} ${txt.slice(0, 200)}${hint}`)
    }
  }

  const markerName = '.ai-security-uploads.json'
  const markerFiles = [...relPaths, 'meta.json'] // relPaths 已包含原始 zip（zipEntry 时 push 过）
  try {
    // 自动命名模式：先清理本用户上一版上传到分支根目录的文件（旧版仍保留在 Git 提交历史中），
    // 再写入新版本，确保个人分支根目录只展示最新版本内容
    if (opts.uploaderBranch) {
      const markerGet = await githubFetch(
        `${repoApiBase}/contents/${markerName}?ref=${encodeURIComponent(effBranch)}`,
        cfg.token,
      )
      let staleFiles: string[] = []
      if (markerGet.ok) {
        const md = (await markerGet.json()) as { content?: string }
        if (md.content) {
          try {
            const prev = JSON.parse(Buffer.from(md.content, 'base64').toString('utf-8')) as { files?: string[] }
            if (Array.isArray(prev.files)) staleFiles = prev.files
          } catch { /* 标记损坏时跳过清理 */ }
        }
      }
      // 版本标记文件一并清理，保证每次都以全新文件写入（无 sha 冲突）
      if (staleFiles.indexOf(markerName) < 0) staleFiles.push(markerName)
      if (staleFiles.length > 0) {
        const treeRes = await githubFetch(
          `${repoApiBase}/git/trees/${encodeURIComponent(effBranch)}?recursive=1`,
          cfg.token,
        )
        if (treeRes.ok) {
          const treeData = (await treeRes.json()) as { tree?: Array<{ path?: string; sha?: string; type?: string }> }
          const shaByPath = new Map<string, string>()
          for (const t of treeData.tree || []) {
            if (t.type === 'blob' && t.path && t.sha) shaByPath.set(t.path, t.sha)
          }
          for (const stale of staleFiles) {
            const sha = shaByPath.get(stale)
            if (!sha) continue
            const delRes = await githubFetch(
              `${repoApiBase}/contents/${encPath(stale)}`,
              cfg.token,
              {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `清理旧版本 ${stale} · ${opts.workDirId}`, sha, branch: effBranch }),
              },
            )
            if (!delRes.ok) {
              console.error(`[github-archive] 旧版本清理失败 ${stale}: ${delRes.status}`)
            }
          }
        }
      }
    }
    for (const f of files) {
      await putFile(f.relPath, fs.readFileSync(f.absPath))
    }
    if (zipEntry) {
      await putFile(zipEntry.relPath, fs.readFileSync(zipEntry.absPath))
    }
    await putFile('meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'))
    if (opts.uploaderBranch) {
      await putFile(
        markerName,
        Buffer.from(
          JSON.stringify({
            workDirId: opts.workDirId,
            scenario: opts.scenario ?? '',
            role: opts.role ?? '',
            version: opts.version ?? 0,
            uploadedAt: new Date().toISOString(),
            files: markerFiles,
          }, null, 2),
          'utf-8',
        ),
      )
    }

    // 维护 CONTRIBUTORS.md（尽力而为，不因并发冲突失败）
    try {
      await updateContributors(contributorsCfg, repoInfo.id, account, opts)
    } catch { /* non-fatal */ }

    return {
      archived: true,
      url: `https://github.com/${canonicalRepo}/tree/${effCfg.branch}${prefix ? '/' + prefix : ''}`,
      studentLogin: account,
    }
  } catch (err) {
    return { archived: false, error: err instanceof Error ? err.message : '归档失败' }
  }
}

async function updateContributors(cfg: ArchiveConfig, repoId: number, account: string, opts: ArchiveOptions): Promise<void> {
  const filePath = 'CONTRIBUTORS.md'
  const base = `${API_BASE}/repositories/${repoId}`
  const getUrl = `${base}/contents/${filePath}`
  let existing = ''
  let sha: string | undefined
  const get = await githubFetch(getUrl, cfg.token)
  if (get.ok) {
    const d = (await get.json()) as { content?: string; sha?: string }
    if (d.content) existing = Buffer.from(d.content, 'base64').toString('utf-8')
    sha = d.sha
  } else if (get.status !== 404) {
    return
  }
  const displayName = opts.displayName ? `（${opts.displayName}）` : ''
  const line = `- @${account}${displayName} · ${opts.scenario || '对战'} 作品 · ${opts.workDirId} · ${new Date().toISOString().slice(0, 10)}`
  if (new RegExp(`^[-*]\\s+@${account}\\b`, 'm').test(existing)) return
  const header = existing || '# Contributors\n\n本仓库记录通过 AI 安全教学实验平台提交作品的 GitHub 贡献者。\n'
  const body = {
    message: `CONTRIBUTORS: 添加 ${account}`,
    content: Buffer.from(`${header.replace(/\n*$/, '\n')}${line}\n`, 'utf-8').toString('base64'),
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  }
  const res = await githubFetch(
    `${base}/contents/${filePath}`,
    cfg.token,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!res.ok) throw new Error(`CONTRIBUTORS.md 更新失败: ${res.status}`)
}