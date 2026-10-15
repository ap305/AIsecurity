import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'

/**
 * GitHub 作品归档配置（仅 admin）
 *
 * 配置后（enabled=true）：
 * - 学生「工程上传」必须填写 GitHub 账号；
 * - 作品自动归档到指定仓库 submissions/<账号>/<上传ID>/；
 * - 归档提交以学生本人身份署名（Commit author = 学生 noreply 邮箱），
 *   学生自动成为该仓库 Contributors 贡献者；仓库自动维护 CONTRIBUTORS.md。
 * 保存后运行时立即生效，无需重启服务。
 */

interface ArchiveConfig {
  enabled: boolean
  tokenSet: boolean
  tokenMasked: string
  repo: string
  branch: string
  basePath: string
  createRepo: boolean
  commitAsStudent: boolean
  maxFileBytes: number
  configPath?: string
}

interface ExecutorInfo {
  ok: boolean
  login?: string
  name?: string
  url?: string
  error?: string
}

interface TestResult {
  ok: boolean
  error?: string
  step?: string
  botLogin?: string
  botName?: string
  repo?: string
  repoExists?: boolean
  repoCreated?: boolean
  repoUrl?: string
  branch?: string
  branchExists?: boolean
  defaultBranch?: string
  note?: string
}

interface BindingDraft {
  repo: string
  branch: string
  autoBranch: boolean
  attackPrefix: string
  defensePrefix: string
  uploadMinScoreAttack: string
  uploadMinScoreDefense: string
}

interface ScenarioBinding {
  key: string
  label: string
  attackId: string
  defenseId: string
  exists: boolean
  attackExists: boolean
  defenseExists: boolean
  config: {
    repo: string
    branch: string
    autoBranch: boolean
    attackPrefix: string
    defensePrefix: string
    uploadMinScoreAttack: number | null
    uploadMinScoreDefense: number | null
  } | null
}

interface TestAllResult {
  ok: boolean
  okCount: number
  total: number
  botLogin?: string
  results: Array<{
    repo: string
    branch: string
    ok: boolean
    defaultBranch?: string
    branchExists?: boolean | null
    url?: string
    error?: string
  }>
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
}
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--brand-cyan)',
  marginBottom: 10,
  letterSpacing: 0.5,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}
const fieldStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
  boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
}
const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

export default function GithubArchiveConfig() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [token, setToken] = useState('')
  const [createRepo, setCreateRepo] = useState(false)
  const [commitAsStudent, setCommitAsStudent] = useState(true)
  const [maxFileMB, setMaxFileMB] = useState('95')
  const [tokenSet, setTokenSet] = useState(false)
  const [tokenMasked, setTokenMasked] = useState('')
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [executor, setExecutor] = useState<ExecutorInfo | null>(null)

  // 场景×归档仓库集中管理
  const [bindings, setBindings] = useState<ScenarioBinding[]>([])
  const [bindingsLoading, setBindingsLoading] = useState(true)
  const [bindMsg, setBindMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [bindSavingKey, setBindSavingKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, BindingDraft>>({})
  const [batch, setBatch] = useState<BindingDraft>({
    repo: '',
    branch: 'main',
    autoBranch: true,
    attackPrefix: '',
    defensePrefix: '',
    uploadMinScoreAttack: '',
    uploadMinScoreDefense: '',
  })
  const [testingAll, setTestingAll] = useState(false)
  const [testAllResult, setTestAllResult] = useState<TestAllResult | null>(null)

  const toNum = (s: string): number | null => {
    const v = String(s ?? '').trim()
    if (v === '') return null
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const defaultDraft = (): BindingDraft => ({
    repo: '',
    branch: 'main',
    autoBranch: true,
    attackPrefix: '',
    defensePrefix: '',
    uploadMinScoreAttack: '',
    uploadMinScoreDefense: '',
  })
  const draftOf = (key: string): BindingDraft => drafts[key] ?? defaultDraft()
  const setDraft = (key: string, patch: Partial<BindingDraft>) =>
    setDrafts((prev) => {
      const cur = prev[key] ?? defaultDraft()
      return { ...prev, [key]: { ...cur, ...patch } }
    })
  const visibleKeys = bindings.filter((b) => b.exists).map((b) => b.key)
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k))

  const loadBindings = async () => {
    try {
      const d = await apiGet<{ bindings: ScenarioBinding[] }>('/admin/github-archive/bindings?role=admin')
      setBindings(d.bindings)
      const init: Record<string, BindingDraft> = {}
      for (const b of d.bindings) {
        if (!b.config) continue
        init[b.key] = {
          repo: b.config.repo,
          branch: b.config.branch,
          autoBranch: b.config.autoBranch,
          attackPrefix: b.config.attackPrefix,
          defensePrefix: b.config.defensePrefix,
          uploadMinScoreAttack: b.config.uploadMinScoreAttack == null ? '' : String(b.config.uploadMinScoreAttack),
          uploadMinScoreDefense: b.config.uploadMinScoreDefense == null ? '' : String(b.config.uploadMinScoreDefense),
        }
      }
      setDrafts(init)
    } catch (e) {
      setBindMsg({ type: 'err', text: e instanceof Error ? e.message : '加载仓库绑定失败' })
    } finally {
      setBindingsLoading(false)
    }
  }
  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleSelectAll = () =>
    setSelected((prev) => (allVisibleSelected ? new Set() : new Set(visibleKeys)))

  const saveBinding = async (key: string) => {
    const d = draftOf(key)
    setBindSavingKey(key)
    setBindMsg(null)
    try {
      const res = await apiPost<{ updated: number }>('/admin/github-archive/bindings/apply?role=admin', {
        scenarioKeys: [key],
        config: {
          repo: d.repo.trim(),
          branch: d.branch.trim() || 'main',
          autoBranch: d.autoBranch,
          attackPrefix: d.attackPrefix.trim(),
          defensePrefix: d.defensePrefix.trim(),
          uploadMinScoreAttack: toNum(d.uploadMinScoreAttack),
          uploadMinScoreDefense: toNum(d.uploadMinScoreDefense),
        },
      })
      setBindMsg({ type: 'ok', text: `“${bindings.find((b) => b.key === key)?.label ?? key}”已保存（更新 ${res.updated} 行题库配置）` })
      await loadBindings()
    } catch (e) {
      setBindMsg({ type: 'err', text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setBindSavingKey(null)
    }
  }

  const applyBatch = async (clearRepo = false) => {
    const keys = bindings.filter((b) => b.exists && selected.has(b.key)).map((b) => b.key)
    if (keys.length === 0) {
      setBindMsg({ type: 'err', text: '请先勾选要对战场景' })
      return
    }
    if (!clearRepo && !batch.repo.trim()) {
      setBindMsg({ type: 'err', text: '请填写仓库 owner/repo' })
      return
    }
    setBindSavingKey('__batch__')
    setBindMsg(null)
    try {
      const config = clearRepo
        ? { repo: '', branch: 'main', autoBranch: true, attackPrefix: '', defensePrefix: '', uploadMinScoreAttack: null, uploadMinScoreDefense: null }
        : {
            repo: batch.repo.trim(),
            branch: batch.branch.trim() || 'main',
            autoBranch: batch.autoBranch,
            attackPrefix: batch.attackPrefix.trim(),
            defensePrefix: batch.defensePrefix.trim(),
            uploadMinScoreAttack: toNum(batch.uploadMinScoreAttack),
            uploadMinScoreDefense: toNum(batch.uploadMinScoreDefense),
          }
      const res = await apiPost<{ updated: number }>('/admin/github-archive/bindings/apply?role=admin', {
        scenarioKeys: keys,
        config,
      })
      setBindMsg({ type: 'ok', text: clearRepo ? `已清除 ${keys.length} 个勾选场景的仓库绑定` : `已应用到 ${keys.length} 个勾选场景（更新 ${res.updated} 行题库配置）` })
      setSelected(new Set())
      await loadBindings()
    } catch (e) {
      setBindMsg({ type: 'err', text: e instanceof Error ? e.message : '应用失败' })
    } finally {
      setBindSavingKey(null)
    }
  }

  const runTestAll = async () => {
    setTestingAll(true)
    setBindMsg(null)
    setTestAllResult(null)
    try {
      const d = await apiPost<TestAllResult>('/admin/github-archive/test-all?role=admin', {})
      setTestAllResult(d)
      setBindMsg(
        d.ok
          ? { type: 'ok', text: `全部 ${d.total} 个已绑定仓库连通正常` }
          : { type: 'err', text: `${d.okCount}/${d.total} 个仓库可用，请展开下方结果查看失败原因` },
      )
    } catch (e) {
      setBindMsg({ type: 'err', text: e instanceof Error ? e.message : '批量测试失败' })
    } finally {
      setTestingAll(false)
    }
  }

  const repoOptions = [...new Set(Object.values(drafts).map((d) => d.repo.trim()).filter(Boolean))]

  useEffect(() => {
    apiGet<ExecutorInfo>('/admin/github-archive/executor?role=admin')
      .then(setExecutor)
      .catch(() => setExecutor({ ok: false, error: '查询 Push 执行账户失败' }))
  }, [])

  useEffect(() => {
    loadBindings()
  }, [])

  useEffect(() => {
    apiGet<ArchiveConfig>('/admin/github-archive/config?role=admin')
      .then((cfg) => {
        setEnabled(cfg.enabled)
        setCreateRepo(cfg.createRepo)
        setCommitAsStudent(cfg.commitAsStudent !== false)
        setMaxFileMB(String(Math.round((cfg.maxFileBytes || 95 * 1024 * 1024) / 1024 / 1024)))
        setTokenSet(cfg.tokenSet)
        setTokenMasked(cfg.tokenMasked ?? '')
      })
      .catch((e) => setMessage({ type: 'err', text: e instanceof Error ? e.message : '加载配置失败' }))
      .finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const mb = Number(maxFileMB)
      const data = await apiPost<ArchiveConfig>('/admin/github-archive/config?role=admin', {
        enabled,
        token: token.trim(),
        createRepo,
        commitAsStudent,
        maxFileBytes: Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 95 * 1024 * 1024,
      })
      setToken('')
      setTokenSet(data.tokenSet)
      setTokenMasked(data.tokenMasked ?? '')
      setMessage({
        type: 'ok',
        text: data.enabled
          ? '已保存并启用 GitHub 归档，上传作品将自动归档'
          : '已保存（归档当前为关闭状态）',
      })
    } catch (e) {
      setMessage({ type: 'err', text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>加载配置中…</div>
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>GitHub 作品归档</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
        学生提交作品按对战场景自动归档到各自绑定的 GitHub 仓库，提交作者自动计入贡献者
      </p>

      {/* 未启用提示 */}
      {!enabled && tokenSet && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 12,
            background: 'rgba(255,184,77,0.08)',
            border: '1px solid var(--warning)',
            color: 'var(--warning)',
          }}
        >
          ⚠ 已配置 Token，但「启用 GitHub 作品归档」开关未打开，当前上传不会归档。勾选启用并点击「保存配置」后立即生效。
        </div>
      )}

      {/* 对战场景 × 归档仓库集中管理 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>📦 对战场景 × 归档仓库（集中管理）</div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9, margin: '0 0 10px' }}>
          每个对战场景 = 一道对抗题（攻击/防御两行自动同步）。仓库留空并保存 = 该场景关闭 GitHub 提交；
          自动命名开启时作品归档到 <code>&lt;分支前缀&gt;-&lt;平台用户名&gt;</code> 个人分支，main 分支保留题目介绍。
        </p>

        {/* 批量操作区 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <label style={{ ...labelStyle, margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
            全选（共 {visibleKeys.length} 个对战场景）
          </label>
          <button
            onClick={() => applyBatch(false)}
            disabled={bindSavingKey !== null || selected.size === 0}
            style={{ ...btnStyle, background: 'var(--brand-cyan)', color: '#0a0e17' }}
          >
            {bindSavingKey === '__batch__' ? '应用中…' : `🚀 应用到勾选场景（${selected.size}）`}
          </button>
          <button
            onClick={() => { if (window.confirm(`清除勾选（${selected.size}）个场景的仓库绑定？清除后这些场景将无法 GitHub 提交。`)) applyBatch(true) }}
            disabled={bindSavingKey !== null || selected.size === 0}
            style={{ ...btnStyle, background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)' }}
          >
            清除勾选场景仓库
          </button>
          <button
            onClick={runTestAll}
            disabled={testingAll}
            style={{ ...btnStyle, background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}
          >
            {testingAll ? '测试中…' : '🧪 批量测试全部仓库'}
          </button>
        </div>

        {/* 批量应用表单 */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 90px 100px 90px 90px 90px 90px', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <div>
            <label style={labelStyle}>批量仓库（owner/repo）</label>
            <input
              list="gac-repo-options"
              value={batch.repo}
              onChange={(e) => setBatch({ ...batch, repo: e.target.value })}
              placeholder="octocat/AI-Security-Submissions"
              style={{ ...fieldStyle, padding: '6px 10px' }}
            />
          </div>
          <div>
            <label style={labelStyle}>分支</label>
            <input value={batch.branch} onChange={(e) => setBatch({ ...batch, branch: e.target.value })} style={{ ...fieldStyle, padding: '6px 10px' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'end', paddingBottom: 8 }}>
            <input type="checkbox" checked={batch.autoBranch} onChange={(e) => setBatch({ ...batch, autoBranch: e.target.checked })} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>自动命名</span>
          </div>
          <div>
            <label style={labelStyle}>攻击前缀</label>
            <input value={batch.attackPrefix} onChange={(e) => setBatch({ ...batch, attackPrefix: e.target.value })} placeholder="如 atk" style={{ ...fieldStyle, padding: '6px 10px' }} />
          </div>
          <div>
            <label style={labelStyle}>防御前缀</label>
            <input value={batch.defensePrefix} onChange={(e) => setBatch({ ...batch, defensePrefix: e.target.value })} placeholder="如 def" style={{ ...fieldStyle, padding: '6px 10px' }} />
          </div>
          <div>
            <label style={labelStyle}>攻击最低分</label>
            <input type="number" min={0} value={batch.uploadMinScoreAttack} onChange={(e) => setBatch({ ...batch, uploadMinScoreAttack: e.target.value })} style={{ ...fieldStyle, padding: '6px 10px' }} />
          </div>
          <div>
            <label style={labelStyle}>防御最低分</label>
            <input type="number" min={0} value={batch.uploadMinScoreDefense} onChange={(e) => setBatch({ ...batch, uploadMinScoreDefense: e.target.value })} style={{ ...fieldStyle, padding: '6px 10px' }} />
          </div>
        </div>
        <datalist id="gac-repo-options">
          {repoOptions.map((r) => <option key={r} value={r} />)}
        </datalist>

        {bindMsg && (
          <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12, background: bindMsg.type === 'ok' ? 'rgba(72,219,128,0.08)' : 'rgba(255,107,107,0.08)', border: `1px solid ${bindMsg.type === 'ok' ? 'var(--success)' : 'var(--danger)'}`, color: bindMsg.type === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
            {bindMsg.text}
          </div>
        )}

        {bindingsLoading ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>加载场景绑定中…</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1260 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', background: 'var(--bg-secondary)' }}>
                  <th style={{ padding: '8px', width: 34 }}></th>
                  <th style={{ padding: '8px' }}>对战场景</th>
                  <th style={{ padding: '8px', minWidth: 200 }}>归档仓库（owner/repo）</th>
                  <th style={{ padding: '8px', width: 90 }}>分支</th>
                  <th style={{ padding: '8px', width: 84 }}>自动命名</th>
                  <th style={{ padding: '8px', width: 90 }}>攻击前缀</th>
                  <th style={{ padding: '8px', width: 90 }}>防御前缀</th>
                  <th style={{ padding: '8px', width: 86 }}>攻击最低分</th>
                  <th style={{ padding: '8px', width: 86 }}>防御最低分</th>
                  <th style={{ padding: '8px', width: 80 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => {
                  const d = draftOf(b.key)
                  return (
                    <tr key={b.key} style={{ borderBottom: '1px solid var(--border-color)', fontSize: 13 }}>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        <input type="checkbox" checked={selected.has(b.key)} disabled={!b.exists} onChange={() => toggleSelect(b.key)} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <div style={{ fontWeight: 600 }}>{b.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {b.key} · {b.attackId} / {b.defenseId}
                        </div>
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input
                          list="gac-repo-options"
                          value={b.exists ? d.repo : ''}
                          disabled={!b.exists}
                          onChange={(e) => setDraft(b.key, { repo: e.target.value })}
                          placeholder={b.exists ? '留空 = 关闭该场景 GitHub 提交' : '题库中暂无该场景题目行'}
                          style={{ ...fieldStyle, padding: '4px 8px', minWidth: 190 }}
                        />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input value={b.exists ? d.branch : ''} disabled={!b.exists} onChange={(e) => setDraft(b.key, { branch: e.target.value })} style={{ ...fieldStyle, padding: '4px 8px' }} />
                      </td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        <input type="checkbox" checked={b.exists ? d.autoBranch : false} disabled={!b.exists} onChange={(e) => setDraft(b.key, { autoBranch: e.target.checked })} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input value={b.exists ? d.attackPrefix : ''} disabled={!b.exists} onChange={(e) => setDraft(b.key, { attackPrefix: e.target.value })} style={{ ...fieldStyle, padding: '4px 8px' }} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input value={b.exists ? d.defensePrefix : ''} disabled={!b.exists} onChange={(e) => setDraft(b.key, { defensePrefix: e.target.value })} style={{ ...fieldStyle, padding: '4px 8px' }} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input type="number" min={0} value={b.exists ? d.uploadMinScoreAttack : ''} disabled={!b.exists} onChange={(e) => setDraft(b.key, { uploadMinScoreAttack: e.target.value })} style={{ ...fieldStyle, padding: '4px 8px' }} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <input type="number" min={0} value={b.exists ? d.uploadMinScoreDefense : ''} disabled={!b.exists} onChange={(e) => setDraft(b.key, { uploadMinScoreDefense: e.target.value })} style={{ ...fieldStyle, padding: '4px 8px' }} />
                      </td>
                      <td style={{ padding: '8px' }}>
                        <button
                          onClick={() => saveBinding(b.key)}
                          disabled={!b.exists || bindSavingKey !== null}
                          style={{ ...btnStyle, padding: '5px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}
                        >
                          {bindSavingKey === b.key ? '保存中…' : '💾 保存本行'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {testAllResult && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              background: testAllResult.ok ? 'rgba(72,219,128,0.06)' : 'rgba(255,107,107,0.06)',
              border: `1px solid ${testAllResult.ok ? 'var(--success)' : 'var(--danger)'}`,
              color: testAllResult.ok ? 'var(--success)' : 'var(--danger)',
              lineHeight: 1.9,
              whiteSpace: 'pre-wrap',
            }}
          >
            {testAllResult.ok
              ? `✓ 已绑定仓库全部可用（${testAllResult.okCount}/${testAllResult.total}）\n执行账户：${testAllResult.botLogin || '-'}`
              : `✗ 有仓库不可用（${testAllResult.okCount}/${testAllResult.total} 可用）\n${testAllResult.results
                  .filter((r) => !r.ok)
                  .map((r) => `${r.repo} @ ${r.branch}：${r.error ?? '未知错误'}`)
                  .join('\n')}`}
          </div>
        )}
      </div>

      {/* 配置表单 */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>⚙️ 归档配置</div>

        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用 GitHub 作品归档（保存后立即生效）
        </label>
        {executor && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {executor.ok ? (
              <>
                Push 账户：
                <a href={executor.url} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-cyan)', fontWeight: 600 }}>
                  {executor.login}
                </a>
                （由 Token 决定；提交作者按学生 GitHub 账号自动署名）
              </>
            ) : (
              <span style={{ color: 'var(--danger)' }}>{executor.error ?? '无法获取 Push 执行账户'}</span>
            )}
          </div>
        )}

        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>GitHub Token（PAT）{tokenSet ? '（已保存：' + tokenMasked + '，留空保留原值）' : ''}*</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tokenSet ? '已保存，留空保留原 Token' : 'ghp_xxx（需 repo 写权限；自动建仓库再加 public_repo）'}
            style={fieldStyle}
            autoComplete="new-password"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={createRepo} onChange={(e) => setCreateRepo(e.target.checked)} />
            仓库不存在时自动创建（公开）
          </label>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={commitAsStudent} onChange={(e) => setCommitAsStudent(e.target.checked)} />
            以学生身份作为提交作者
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>单文件大小上限（MB，GitHub API 上限 100MB）</label>
          <input
            value={maxFileMB}
            onChange={(e) => setMaxFileMB(e.target.value.replace(/[^\d]/g, ''))}
            style={{ ...fieldStyle, width: 160 }}
          />
        </div>

        {message && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 12,
              background: message.type === 'ok' ? 'rgba(72,219,128,0.08)' : 'rgba(255,107,107,0.08)',
              border: `1px solid ${message.type === 'ok' ? 'var(--success)' : 'var(--danger)'}`,
              color: message.type === 'ok' ? 'var(--success)' : 'var(--danger)',
            }}
          >
            {message.text}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, background: 'var(--brand-cyan)', color: '#0a0e17' }}>
            {saving ? '保存中…' : '💾 保存配置'}
          </button>
        </div>
      </div>
    </div>
  )
} 
