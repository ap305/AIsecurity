import { requireAdminMw } from '../lib/auth.js';
import { prisma } from '../lib/db.js';
import { SCENARIO_QUESTION_PAIRS } from '../lib/scenarioQuestions.js';
import { Router, type Request, type Response } from 'express'
import {
  getGithubArchiveConfig,
  saveGithubArchiveConfig,
  resetGithubArchiveCache,
  maskToken,
  GITHUB_ARCHIVE_CONFIG_PATH,
  type GithubArchiveConfig,
} from '../lib/githubArchiveConfig.js'
import { listManagedScenarios, listReadyVersions } from '../lib/managedJudge.js'
import { SCENARIO_PAIR_BY_QUESTION_ID } from '../lib/scenarioQuestions.js'

/**
 * GitHub 作品归档配置管理（仅 admin）
 *
 * 端点：
 *   GET  /api/admin/github-archive/config  读取配置（token 脱敏）
 *   POST /api/admin/github-archive/config  保存配置，运行时立即生效（无需重启）
 *   POST /api/admin/github-archive/test    测试 Token / 仓库连通性（可传未保存的草稿值）
 *   GET  /api/admin/github-archive/bindings           场景×归档仓库绑定表
 *   POST /api/admin/github-archive/bindings/apply     保存指定对战场景的仓库配置（可批量）
 *   POST /api/admin/github-archive/test-all           批量测试全部已绑定仓库连通性
 */

const router = Router()
router.use('/admin/github-archive', requireAdminMw)
const API_BASE = 'https://api.github.com'

function isAdminReq(req: Request): boolean {
  return req.query.role === 'admin'
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,3}$/

function normalizeBindingConfig(raw: Record<string, unknown>): {
  repo: string | null
  branch: string
  autoBranch: boolean
  attackPrefix: string
  defensePrefix: string
  uploadMinScoreAttack: number | null
  uploadMinScoreDefense: number | null
} {
  const repoRaw = String(raw.repo ?? '').trim().replace(/\/+$/, '')
  const repo = repoRaw === '' ? null : repoRaw
  if (repo && !REPO_RE.test(repo)) {
    throw new Error('仓库格式应为 owner/repo（如 octocat/AI-Security-Submissions），不支持空格或中文')
  }
  const toScore = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  return {
    repo,
    branch: String(raw.branch ?? 'main').trim() || 'main',
    autoBranch: raw.autoBranch !== false && raw.autoBranch !== 'false',
    attackPrefix: String(raw.attackPrefix ?? raw.branchPrefix ?? '').trim(),
    defensePrefix: String(raw.defensePrefix ?? raw.branchPrefix ?? '').trim(),
    uploadMinScoreAttack: toScore(raw.uploadMinScoreAttack),
    uploadMinScoreDefense: toScore(raw.uploadMinScoreDefense),
  }
}

// ── GET /api/admin/github-archive/config ────────────────────────────────────
router.get('/admin/github-archive/config', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查看 GitHub 归档配置', data: null })
    return
  }
  const cfg = getGithubArchiveConfig()
  res.json({
    code: 0,
    message: 'ok',
    data: {
      enabled: cfg.enabled === true,
      tokenSet: !!(cfg.token || '').trim(),
      tokenMasked: maskToken(cfg.token),
      repo: cfg.repo || '',
      branch: cfg.branch || 'main',
      basePath: cfg.basePath || 'submissions',
      createRepo: cfg.createRepo === true,
      commitAsStudent: cfg.commitAsStudent !== false,
      maxFileBytes: cfg.maxFileBytes || 95 * 1024 * 1024,
      configPath: GITHUB_ARCHIVE_CONFIG_PATH,
    },
  })
})

// ── GET /api/admin/github-archive/executor ─ Push 执行账户（由 Token 身份决定）──
router.get('/admin/github-archive/executor', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查看 GitHub 归档配置', data: null })
    return
  }
  const token = (getGithubArchiveConfig().token || '').trim()
  if (!token) {
    res.json({ code: 0, message: 'ok', data: { ok: false, error: '未配置 GitHub Token，无法确定 Push 执行账户' } })
    return
  }
  try {
    const userRes = await fetch(`${API_BASE}/user`, { headers: ghHeaders(token) })
    if (!userRes.ok) {
      const txt = await userRes.text()
      res.json({ code: 0, message: 'ok', data: { ok: false, step: 'token', error: `Token 无效或权限不足（HTTP ${userRes.status}）：${txt.slice(0, 200)}` } })
      return
    }
    const user = (await userRes.json()) as { login?: string; name?: string | null; html_url?: string }
    res.json({
      code: 0,
      message: 'ok',
      data: { ok: true, login: user.login || '', name: user.name || user.login || '', url: user.html_url || `https://github.com/${user.login || ''}` },
    })
  } catch (e) {
    res.json({ code: 0, message: 'ok', data: { ok: false, error: e instanceof Error ? e.message : '查询失败' } })
  }
})

// ── GET /api/admin/judge-managed/list ─ 受管判题版本清单（7z backend+blank）──
router.get('/admin/judge-managed/list', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查看判题版本', data: null })
    return
  }
  res.json({ code: 0, message: 'ok', data: listManagedScenarios() })
})

// ── GET /api/admin/judge-managed/for-question/:id ─ 某题目可用受管版本选项 ─
router.get('/admin/judge-managed/for-question/:id', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查询判题版本', data: null })
    return
  }
  const id = String(req.params.id ?? '')
  const pair = SCENARIO_PAIR_BY_QUESTION_ID.get(id)
  const versions = pair ? listReadyVersions(pair.key).map((v) => ({ version: v.version, active: v.active, files: v.files, scoreMapping: v.scoreMapping })) : []
  const q = await prisma.question.findUnique({ where: { id }, select: { judgeMode: true, judgeVersion: true } }).catch(() => null)
  res.json({
    code: 0,
    message: 'ok',
    data: {
      questionId: id,
      scenario: pair?.key ?? null,
      managedAvailable: versions.length > 0,
      versions,
      current: { judgeMode: q?.judgeMode === 'managed' ? 'managed' : 'legacy', judgeVersion: q?.judgeVersion || null },
    },
  })
})

// ── POST /api/admin/github-archive/config ───────────────────────────────────
router.post('/admin/github-archive/config', (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可配置 GitHub 归档', data: null })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const next: GithubArchiveConfig = { ...getGithubArchiveConfig() }

  if (body.enabled !== undefined) next.enabled = body.enabled === true || body.enabled === 'true'
  // Token：非空则覆盖；空串/空白 = 保留原值（避免每次保存都要重新粘贴 PAT）
  if (body.token !== undefined && String(body.token).trim() !== '') next.token = String(body.token).trim()
  if (body.repo !== undefined) next.repo = String(body.repo).trim()
  if (body.branch !== undefined) next.branch = String(body.branch).trim() || 'main'
  if (body.basePath !== undefined) next.basePath = String(body.basePath).trim().replace(/^\/+|\/+$/g, '') || 'submissions'
  if (body.createRepo !== undefined) next.createRepo = body.createRepo === true || body.createRepo === 'true'
  if (body.commitAsStudent !== undefined) next.commitAsStudent = body.commitAsStudent !== false && body.commitAsStudent !== 'false'
  if (body.maxFileBytes !== undefined) {
    const n = Number(body.maxFileBytes)
    next.maxFileBytes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 95 * 1024 * 1024
  }

  if (next.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(next.repo.trim())) {
    res.status(400).json({ code: 40001, message: '仓库格式应为 owner/repo（如 octocat/AI-Security-Submissions）', data: null })
    return
  }

  saveGithubArchiveConfig(next)
  resetGithubArchiveCache()
  res.json({
    code: 0,
    message: 'ok',
    data: {
      ok: true,
      enabled: next.enabled === true,
      tokenSet: !!(next.token || '').trim(),
      tokenMasked: maskToken(next.token),
      repo: next.repo || '',
      branch: next.branch || 'main',
      basePath: next.basePath || 'submissions',
      createRepo: next.createRepo === true,
      commitAsStudent: next.commitAsStudent !== false,
      maxFileBytes: next.maxFileBytes || 95 * 1024 * 1024,
      configPath: GITHUB_ARCHIVE_CONFIG_PATH,
    },
  })
})

// ── POST /api/admin/github-archive/test ─ 测试 Token / 仓库 / 分支连通性 ─────
router.post('/admin/github-archive/test', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可测试 GitHub 归档', data: null })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const cur = getGithubArchiveConfig()
  const token = String(body.token ?? '').trim() || (cur.token || '').trim()
  const repoRaw = String(body.repo ?? '').trim() || (cur.repo || '').trim()
  const createRepo = body.createRepo === true || body.createRepo === 'true' || cur.createRepo === true
  const branch = String(body.branch ?? '').trim() || (cur.branch || 'main').trim()

  if (!token) {
    res.json({ code: 0, message: 'ok', data: { ok: false, error: '未配置 GitHub Token，请先在下方填写' } })
    return
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoRaw)) {
    res.json({ code: 0, message: 'ok', data: { ok: false, error: '仓库格式应为 owner/repo（如 octocat/AI-Security-Submissions）' } })
    return
  }
  const [owner, repo] = repoRaw.split('/')

  try {
    // 1. Token 有效性 + 机器人身份
    const userRes = await fetch(`${API_BASE}/user`, { headers: ghHeaders(token) })
    if (!userRes.ok) {
      const txt = await userRes.text()
      res.json({ code: 0, message: 'ok', data: { ok: false, step: 'token', error: `Token 无效或权限不足（HTTP ${userRes.status}）：${txt.slice(0, 200)}` } })
      return
    }
    const user = (await userRes.json()) as { login?: string; name?: string | null }

    // 2. 仓库存在性（不存在且允许自动创建则创建）
    let repoExists = true
    let defaultBranch = ''
    const repoRes = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers: ghHeaders(token) })
    if (!repoRes.ok) {
      if (repoRes.status === 404 && createRepo) {
        const created = await fetch(`${API_BASE}/user/repos`, {
          method: 'POST',
          headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: repo, description: 'AI 安全教学实验平台 · 学生作品归档仓库', private: false, auto_init: true }),
        })
        if (!created.ok) {
          const ctxt = await created.text()
          res.json({ code: 0, message: 'ok', data: { ok: false, step: 'repo', error: `仓库创建失败（HTTP ${created.status}）：${ctxt.slice(0, 200)}` } })
          return
        }
        const createdData = (await created.json()) as { default_branch?: string }
        defaultBranch = createdData.default_branch || 'main'
      } else {
        const rtxt = await repoRes.text()
        res.json({ code: 0, message: 'ok', data: { ok: false, step: 'repo', error: `仓库 ${owner}/${repo} 不存在或无权访问（HTTP ${repoRes.status}）：${rtxt.slice(0, 200)}` } })
        return
      }
    } else {
      const repoData = (await repoRes.json()) as { default_branch?: string }
      defaultBranch = repoData.default_branch || 'main'
      repoExists = true
    }

    // 3. 分支存在性
    let branchExists = true
    const branchRes = await fetch(`${API_BASE}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { headers: ghHeaders(token) })
    if (!branchRes.ok && branchRes.status !== 404) {
      const btxt = await branchRes.text()
      res.json({ code: 0, message: 'ok', data: { ok: false, step: 'branch', error: `分支检查失败（HTTP ${branchRes.status}）：${btxt.slice(0, 200)}` } })
      return
    }
    branchExists = branchRes.ok

    // 4. 写权限探测：创建并删除一个临时文件，验证 Token 具备 Contents 写权限
    const probePath = `.test-write-${Date.now()}`
    const probe = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '归档写权限探测', content: Buffer.from('ok').toString('base64'), branch }),
    })
    if (!probe.ok) {
      res.json({
        code: 0,
        message: 'ok',
        data: {
          ok: false,
          step: 'write',
          error: `Token 缺少 Contents 写权限（HTTP ${probe.status}）：fine-grained PAT 需勾选 Contents: Read and write；classic PAT 需勾选 repo 权限。`,
        },
      })
      return
    }
    const probeData = (await probe.json()) as { content?: { sha?: string } }
    await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
      method: 'DELETE',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '清理写权限探测文件', sha: probeData.content?.sha }),
    }).catch(() => { /* 清理失败不影响结果 */ })

    res.json({
      code: 0,
      message: 'ok',
      data: {
        ok: true,
        botLogin: user.login || '',
        botName: user.name || user.login || '',
        repo: `${owner}/${repo}`,
        repoExists,
        repoCreated: !repoExists && createRepo,
        repoUrl: `https://github.com/${owner}/${repo}`,
        branch,
        branchExists,
        defaultBranch,
        note: branchExists ? undefined : `分支 ${branch} 不存在（仓库默认分支为 ${defaultBranch}），归档将失败，请改用 ${defaultBranch}`,
      },
    })
  } catch (e) {
    res.json({ code: 0, message: 'ok', data: { ok: false, error: e instanceof Error ? e.message : '测试失败' } })
  }
})

// POST /api/admin/github-archive/apply-to-questions — 把当前全局仓库应用到所有对战题目（迁移工具）
router.post('/admin/github-archive/apply-to-questions', async (req: Request, res: Response) => {
  try {
    const cfg = getGithubArchiveConfig()
    const repo = (cfg.repo || '').trim()
    if (!repo) {
      res.status(400).json({ code: 40001, message: '请先在全局配置中填写归档仓库', data: null })
      return
    }
    const branch = (cfg.branch || 'main').trim()
    const ids: string[] = []
    for (const p of SCENARIO_QUESTION_PAIRS) {
      ids.push(p.attackId, p.defenseId)
    }
    const result = await prisma.question.updateMany({
      where: { id: { in: ids } },
      data: { githubRepo: repo, githubBranch: branch },
    })
    res.json({ code: 0, message: 'ok', data: { updated: result.count, repo, branch } })
  } catch (e) {
    console.error('[github-archive] apply-to-questions failed:', e)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// ── GET /api/admin/github-archive/bindings ─ 场景×归档仓库绑定表 ───────────
router.get('/admin/github-archive/bindings', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可查看归档仓库绑定', data: null })
    return
  }
  try {
    const ids = SCENARIO_QUESTION_PAIRS.flatMap((p) => [p.attackId, p.defenseId])
    const rows = await prisma.question.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        githubRepo: true,
        githubBranch: true,
        autoBranch: true,
        branchPrefix: true,
        uploadMinScoreAttack: true,
        uploadMinScoreDefense: true,
      },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const bindings = SCENARIO_QUESTION_PAIRS.map((p) => {
      const atk = byId.get(p.attackId)
      const def = byId.get(p.defenseId)
      const row = (atk?.githubRepo && atk.githubRepo.trim()) ? atk : (def || atk)
      return {
        key: p.key,
        label: p.label,
        attackId: p.attackId,
        defenseId: p.defenseId,
        exists: !!atk || !!def,
        attackExists: !!atk,
        defenseExists: !!def,
        config: row
          ? {
              repo: row.githubRepo || '',
              branch: row.githubBranch || 'main',
              autoBranch: row.autoBranch !== false,
              attackPrefix: (atk?.branchPrefix || def?.branchPrefix || '').trim(),
              defensePrefix: (def?.branchPrefix || atk?.branchPrefix || '').trim(),
              uploadMinScoreAttack: atk?.uploadMinScoreAttack ?? row.uploadMinScoreAttack ?? null,
              uploadMinScoreDefense: def?.uploadMinScoreDefense ?? row.uploadMinScoreDefense ?? null,
            }
          : null,
      }
    })
    res.json({ code: 0, message: 'ok', data: { bindings } })
  } catch (e) {
    console.error('[github-archive] bindings failed:', e)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

// ── POST /api/admin/github-archive/bindings/apply ─ 保存场景仓库配置（可多选批量）──
router.post('/admin/github-archive/bindings/apply', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可配置归档仓库绑定', data: null })
    return
  }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const keysRaw = Array.isArray(body.scenarioKeys) ? body.scenarioKeys.map(String) : []
    if (keysRaw.length === 0) {
      res.status(400).json({ code: 40001, message: '请至少选择一个对战场景', data: null })
      return
    }
    const cfgMap = new Map(SCENARIO_QUESTION_PAIRS.map((p) => [p.key, p]))
    const keys = [...new Set(keysRaw.filter((k) => cfgMap.has(k)))]
    if (keys.length === 0) {
      res.status(400).json({ code: 40001, message: '所选对战场景不存在', data: null })
      return
    }
    const config = normalizeBindingConfig((body.config ?? {}) as Record<string, unknown>)
    const ids = keys.flatMap((k) => [cfgMap.get(k)!.attackId, cfgMap.get(k)!.defenseId])
    const result = await prisma.question.updateMany({
      where: { id: { in: ids } },
      data: {
        githubRepo: config.repo,
        githubBranch: config.branch,
        autoBranch: config.autoBranch,
        uploadMinScoreAttack: config.uploadMinScoreAttack,
        uploadMinScoreDefense: config.uploadMinScoreDefense,
      },
    })
    const attackIds = keys.map((k) => cfgMap.get(k)!.attackId)
    const defenseIds = keys.map((k) => cfgMap.get(k)!.defenseId)
    await prisma.question.updateMany({
      where: { id: { in: attackIds } },
      data: { branchPrefix: config.attackPrefix },
    })
    await prisma.question.updateMany({
      where: { id: { in: defenseIds } },
      data: { branchPrefix: config.defensePrefix },
    })
    res.json({
      code: 0,
      message: 'ok',
      data: { updated: result.count, keys, config },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : '保存失败'
    res.status(400).json({ code: 40001, message: msg, data: null })
  }
})

// ── POST /api/admin/github-archive/test-all ─ 批量测试全部已绑定仓库 ───────
router.post('/admin/github-archive/test-all', async (req: Request, res: Response) => {
  if (!isAdminReq(req)) {
    res.status(403).json({ code: 40300, message: '仅管理员可测试归档仓库', data: null })
    return
  }
  try {
    const cfg = getGithubArchiveConfig()
    const token = (cfg.token || '').trim()
    if (!token) {
      res.json({ code: 0, message: 'ok', data: { ok: false, results: [], error: '未配置 GitHub Token' } })
      return
    }
    const userRes = await fetch(`${API_BASE}/user`, { headers: ghHeaders(token) })
    const botLogin = userRes.ok
      ? (((await userRes.json()) as { login?: string }).login ?? '')
      : ''
    // 汇总当前所有已绑定仓库（自动命名场景以仓库默认分支探测写权限）
    const ids = SCENARIO_QUESTION_PAIRS.flatMap((p) => [p.attackId, p.defenseId])
    const rows = await prisma.question.findMany({
      where: { id: { in: ids }, githubRepo: { not: '' } },
      select: { githubRepo: true, githubBranch: true, autoBranch: true },
    })
    const repos = new Map<string, { branch: string; autoBranch: boolean }>()
    for (const r of rows) {
      const repo = (r.githubRepo || '').trim().replace(/\/+$/, '')
      if (!repo) continue
      const [owner, name] = repo.split('/')
      if (!owner || !name) continue
      repos.set(`${owner}/${name}`, {
        branch: (r.githubBranch || cfg.branch || 'main').trim() || 'main',
        autoBranch: r.autoBranch !== false,
      })
    }
    const results: Array<Record<string, unknown>> = []
    let index = 0
    for (const [repoRaw, conf] of repos) {
      index += 1
      const branch = conf.branch
      const item: Record<string, unknown> = { repo: repoRaw, branch, autoBranch: conf.autoBranch, ok: false }
      try {
        const [owner, repo] = repoRaw.split('/')
        const repoRes = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers: ghHeaders(token) })
        if (!repoRes.ok) {
          const rtxt = (await repoRes.text()).slice(0, 160)
          item.error = `仓库不存在或无权访问（HTTP ${repoRes.status}）：${rtxt}`
          results.push(item)
          continue
        }
        const repoData = (await repoRes.json()) as { default_branch?: string }
        const defaultBranch = repoData.default_branch || 'main'
        item.defaultBranch = defaultBranch
        const probePath = `.test-write-${Date.now()}-${index}`
        if (conf.autoBranch) {
          // 自动命名模式：真实提交是「创建 <前缀>-<用户名> 分支后写入」，用临时分支完整模拟
          const tmpBranch = `platform-check-${Date.now()}-${index}`
          const refRes = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers: ghHeaders(token) })
          if (!refRes.ok) {
            item.error = `无法读取默认分支 ${defaultBranch}（HTTP ${refRes.status}）`
            results.push(item)
            continue
          }
          const refData = (await refRes.json()) as { object?: { sha?: string } }
          const createRes = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs`, {
            method: 'POST',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${tmpBranch}`, sha: refData.object?.sha }),
          })
          if (!createRes.ok) {
            const ctxt = (await createRes.text()).slice(0, 200)
            item.error = `无法创建分支（HTTP ${createRes.status}）：${ctxt}`
            results.push(item)
            continue
          }
          const probe = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
            method: 'PUT',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '平台归档连通性探测', content: Buffer.from('ok').toString('base64'), branch: tmpBranch }),
          })
          let probeSha: string | undefined
          if (probe.ok) {
            const pd = (await probe.json()) as { content?: { sha?: string } }
            probeSha = pd.content?.sha
          } else {
            const ptxt = (await probe.text()).slice(0, 200)
            item.error = `临时分支写入失败（HTTP ${probe.status}）：${ptxt}`
          }
          if (probeSha) {
            await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
              method: 'DELETE',
              headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: '清理连通性探测文件', sha: probeSha, branch: tmpBranch }),
            }).catch(() => { /* 清理失败不影响结果 */ })
          }
          await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs/heads/${tmpBranch}`, {
            method: 'DELETE',
            headers: ghHeaders(token),
          }).catch(() => { /* 清理失败不影响结果 */ })
          if (!probe.ok) {
            results.push(item)
            continue
          }
          item.note = '自动命名模式：已验证可在该仓库创建个人分支并写入文件'
        } else {
          // 目录归档模式：直接写入配置分支（分支可能受保护）
          const probe = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
            method: 'PUT',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '平台归档连通性探测', content: Buffer.from('ok').toString('base64'), branch }),
          })
          if (!probe.ok) {
            const ptxt = (await probe.text()).slice(0, 200)
            const hint = probe.status === 409
              ? '（目标分支受仓库规则保护，请改用自动命名模式或允许平台推送该分支）'
              : '：fine-grained PAT 需包含该仓库且 Contents: Read and write'
            item.error = `分支写入失败（HTTP ${probe.status}）${probe.status === 409 ? hint : ptxt}`
            results.push(item)
            continue
          }
          const pd = (await probe.json()) as { content?: { sha?: string } }
          await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${probePath}`, {
            method: 'DELETE',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '清理连通性探测文件', sha: pd.content?.sha, branch }),
          }).catch(() => { /* 清理失败不影响结果 */ })
        }
        item.ok = true
        item.url = `https://github.com/${owner}/${repo}`
      } catch (e) {
        item.error = e instanceof Error ? e.message : '测试失败'
      }
      results.push(item)
    }
    const okCount = results.filter((r) => r.ok === true).length
    res.json({
      code: 0,
      message: 'ok',
      data: { ok: okCount === results.length, okCount, total: results.length, botLogin, results },
    })
  } catch (e) {
    console.error('[github-archive] test-all failed:', e)
    res.status(500).json({ code: 50000, message: 'Internal server error', data: null })
  }
})

export default router
