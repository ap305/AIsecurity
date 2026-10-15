import { useState, useCallback, useRef, useEffect } from 'react'
import { apiGet, apiPost, apiPostMultipart } from '../../lib/api'

/**
 * 工程上传模式（需求二：参赛作品文件夹上传）
 *
 * 参赛者上传 .zip 工程压缩包，平台解压后按标准目录规范（根目录含 solution.py）
 * 预检 Solution 接口合法性，再交由评测引擎加载。
 *
 * 与「在线编辑」模式二选一：本组件只负责上传 + 预检，运行由 Arena 统一触发。
 */

export interface ValidationCheck {
  name: string
  label: string
  passed: boolean
  detail: string
}

export interface ValidationResult {
  valid: boolean
  checks: ValidationCheck[]
  error: string | null
  requiredMethods: string[]
}

interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  children?: TreeNode[]
}

export interface ArchiveResult {
  archived: boolean
  url?: string
  reason?: string
  error?: string
  studentLogin?: string
}

export interface UploadRecord {
  workDirId: string
  userId: string
  githubAccount: string
  displayName: string
  scenario: string
  role: string
  fileName: string
  size: number
  uploadedAt: string
  /** 同一场景+角色下的版本号（v1 起） */
  version?: number
  archived: boolean
}

interface UploadResponse {
  workDirId: string
  workDir: string
  solutionPyExists: boolean
  tree: TreeNode
  archive?: ArchiveResult
  record?: {
    fileName: string
    size: number
    uploadedAt: string
    version?: number
    archived: boolean
  }
}

interface ProjectUploadProps {
  scenario: string
  role: 'solo_attack' | 'solo_defense'
  disabled?: boolean
  /** 学生姓名（用于归档元数据与贡献者名单） */
  displayName?: string
  /** 学生 userId（用于「上传记录」归属） */
  userId?: string
  /** 平台用户名（自动命名模式：归档到该题仓库中以平台用户名为名的个人分支） */
  username?: string
  /** 是否教师/管理员：仅教师展示 GitHub 归档链接，学生不展示他人或本仓库链接 */
  isTeacher?: boolean
  /** 上传 + 预检完成后回调，通知 Arena 当前的 workDirId 与是否可运行 */
  onReadyChange: (workDirId: string | null, ready: boolean) => void
}

export default function ProjectUpload({ scenario, role, disabled, displayName, userId, username, isTeacher, onReadyChange }: ProjectUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [workDirId, setWorkDirId] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [solutionPyExists, setSolutionPyExists] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [githubAccount, setGithubAccount] = useState('')
  const [archive, setArchive] = useState<ArchiveResult | null>(null)
  const [records, setRecords] = useState<UploadRecord[]>([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const requiredMethods = role === 'solo_attack' ? ['attack'] : scenario === 'watermark_image' ? ['embed', 'detect'] : ['defend']

  // 记录上次加载记录的「场景+角色」，切换时清空当前选择并按新场景重新加载版本
  const lastScenarioRoleRef = useRef<string>('')

  const fetchRecords = useCallback(async () => {
    const key = userId?.trim() || githubAccount.trim()
    if (!key) {
      setRecords([])
      return
    }
    setRecordsLoading(true)
    setRecords([])
    try {
      const params = new URLSearchParams()
      params.set(userId?.trim() ? 'userId' : 'githubAccount', key)
      params.set('scenario', scenario)
      params.set('role', role)
      const data = await apiGet<UploadRecord[]>(`/matches/uploads?${params.toString()}`)
      setRecords(data)
    } catch {
      setRecords([])
    } finally {
      setRecordsLoading(false)
    }
  }, [userId, githubAccount, scenario, role])

  // 场景/角色/账号变化：清空当前选择，然后加载该「场景+角色」的版本记录
  useEffect(() => {
    const key = `${scenario}|${role}`
    if (lastScenarioRoleRef.current && lastScenarioRoleRef.current !== key) {
      setWorkDirId(null)
      setSelectedRecordId(null)
      setTree(null)
      setSolutionPyExists(false)
      setValidation(null)
      setArchive(null)
      setError(null)
      onReadyChange(null, false)
    }
    lastScenarioRoleRef.current = key
    fetchRecords()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, role, fetchRecords])

  // 默认选中最新版本：进入页面/切换场景后，若当前「场景+角色」已有记录，自动预检最新一条
  useEffect(() => {
    if (!uploading && !validating && records.length > 0 && !workDirId) {
      const latest = records[0]
      setSelectedRecordId(latest.workDirId)
      setWorkDirId(latest.workDirId)
      runValidate(latest.workDirId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, workDirId, uploading, validating])

  const runValidate = useCallback(
    async (wId: string) => {
      setValidating(true)
      setError(null)
      try {
        const data = await apiPost<ValidationResult>('/matches/validate', {
          workDirId: wId,
          scenario,
          role,
        })
        setValidation(data)
        onReadyChange(wId, !!data.valid)
      } catch (e) {
        setError(e instanceof Error ? e.message : '校验失败')
        setValidation(null)
        onReadyChange(null, false)
      } finally {
        setValidating(false)
      }
    },
    [scenario, role, onReadyChange],
  )

  // 点击历史记录切换到此版本（重新预检，供运行使用）
  const selectVersion = useCallback(
    async (rec: UploadRecord) => {
      if (uploading || validating) return
      if (rec.workDirId === workDirId && validation?.valid) return
      setSelectedRecordId(rec.workDirId)
      setWorkDirId(rec.workDirId)
      setArchive(null)
      setTree(null)
      setSolutionPyExists(false)
      setError(null)
      await runValidate(rec.workDirId)
    },
    [uploading, validating, workDirId, validation, runValidate],
  )

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        setError('仅支持 .zip 压缩包')
        return
      }
      const account = githubAccount.trim()
      if (!account) {
        setError('请先填写 GitHub 账号（作品将归档到平台指定的 GitHub 仓库）')
        return
      }
      setUploading(true)
      setError(null)
      setValidation(null)
      setTree(null)
      setWorkDirId(null)
      setArchive(null)
      onReadyChange(null, false)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('githubAccount', account)
        fd.append('scenario', scenario)
        fd.append('role', role)
        if (displayName) fd.append('displayName', displayName)
        if (username) fd.append('username', username)
        const data = await apiPostMultipart<UploadResponse>('/matches/upload', fd)
        setWorkDirId(data.workDirId)
        setSelectedRecordId(data.workDirId)
        setTree(data.tree)
        setSolutionPyExists(data.solutionPyExists)
        setArchive(data.archive ?? null)
        // 上传后自动预检
        await runValidate(data.workDirId)
        // 刷新上传记录
        await fetchRecords()
      } catch (e) {
        setError(e instanceof Error ? e.message : '上传失败')
      } finally {
        setUploading(false)
      }
    },
    [runValidate, onReadyChange, githubAccount, scenario, role, displayName, fetchRecords],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (disabled || uploading) return
      const file = e.dataTransfer.files?.[0]
      if (file) handleFile(file)
    },
    [disabled, uploading, handleFile],
  )

  const ready = !!workDirId && !!validation?.valid

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      {/* GitHub 账号（必填，用于作品归档与贡献者记录） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
          GitHub 账号 <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <input
          value={githubAccount}
          onChange={(e) => setGithubAccount(e.target.value)}
          placeholder="GitHub 用户名或主页链接，如 https://github.com/yourname"
          disabled={disabled || uploading}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          作品将自动归档到该题 GitHub 仓库中以你平台用户名为名的个人分支；开启自动命名时
          main 分支保留题目介绍与 demo，上传历史版本默认展示最新版，并以你的 GitHub 身份计入项目贡献者
        </div>
      </div>

      {/* 拖拽上传区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !disabled && !uploading && inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--brand-cyan)' : 'var(--border-color)'}`,
          borderRadius: 8,
          padding: '20px 16px',
          textAlign: 'center',
          cursor: disabled || uploading ? 'not-allowed' : 'pointer',
          background: dragOver ? 'rgba(0,212,255,0.06)' : 'var(--bg-secondary)',
          opacity: disabled || uploading ? 0.6 : 1,
          transition: 'all var(--transition-fast)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
        {uploading ? (
          <div style={{ color: 'var(--brand-cyan)', fontSize: 13 }}>⏳ 上传解压中…</div>
        ) : (
          <>
            <div style={{ fontSize: 24, marginBottom: 6 }}>📦</div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
              点击或拖拽 .zip 工程压缩包到此上传
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              受管 7z 模式根目录须含 <code style={{ color: 'var(--brand-cyan)' }}>attack-blank.py / defense-blank.py</code>；
              旧引擎模式须含 <code style={{ color: 'var(--brand-cyan)' }}>solution.py</code>
            </div>
          </>
        )}
      </div>

      {/* 接口规范提示 */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 6,
          padding: '8px 10px',
          lineHeight: 1.6,
        }}
      >
        <span style={{ color: 'var(--warning)', fontWeight: 600 }}>接口规范：</span>
        受管 7z：blank 内容即题目给出的标准模板（在线编辑模板已更新为 v2 blank 契约）；
        旧引擎：<code style={{ color: 'var(--brand-cyan)' }}>solution.py</code> 实现标准类，平台以{' '}
        <code style={{ color: 'var(--brand-cyan)' }}>Solution(work_dir)</code> 实例化后调用{' '}
        <code style={{ color: 'var(--brand-cyan)' }}>{requiredMethods.map((m) => `${m}(...)`).join(' / ')}</code>。
        可携带 model/、config/、requirements.txt 等资源。
      </div>

      {/* 错误 */}
      {error && (
        <div style={{ fontSize: 12, color: 'var(--danger)', background: 'rgba(255,107,107,0.08)', border: '1px solid var(--danger)', borderRadius: 6, padding: '8px 10px' }}>
          {error}
        </div>
      )}

      {/* 目录树 */}
      {tree && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, maxHeight: 160, overflow: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span>📁 目录结构</span>
            <span>{solutionPyExists ? <span style={{ color: 'var(--success)' }}>✓ solution.py</span> : <span style={{ color: 'var(--danger)' }}>✗ 缺 solution.py</span>}</span>
          </div>
          <TreeRenderer node={tree} depth={0} />
        </div>
      )}

      {/* 预检结果 */}
      {workDirId && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, flex: 1, overflow: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-cyan)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>🔍 接口预检</span>
            {validation && !validating && (
              <span style={{ color: validation.valid ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>
                {validation.valid ? '✓ 预检通过' : '✗ 预检未通过'}
              </span>
            )}
          </div>
          {validating && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>⏳ 正在预检…</div>}
          {validation && !validating && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {validation.checks.map((c, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start' }}>
                  <span style={{ color: c.passed ? 'var(--success)' : 'var(--danger)', fontWeight: 700, flexShrink: 0 }}>
                    {c.passed ? '✓' : '✗'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: c.passed ? 'var(--text-secondary)' : 'var(--text-primary)', fontWeight: c.passed ? 400 : 600 }}>
                      {c.label}
                    </div>
                    {!c.passed && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{c.detail}</div>}
                  </div>
                </div>
              ))}
              {validation.error && !validation.valid && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, padding: '6px 8px', background: 'rgba(255,107,107,0.06)', borderRadius: 4 }}>
                  {validation.error}
                </div>
              )}
            </div>
          )}
          {!validation && !validating && (
            <button
              onClick={() => workDirId && runValidate(workDirId)}
              disabled={disabled}
              style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}
            >
              重新预检
            </button>
          )}
        </div>
      )}

      {/* GitHub 归档状态 */}
      {archive && (
        <div
          style={{
            fontSize: 11,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid',
            borderColor: archive.archived ? 'var(--success)' : 'var(--border-color)',
            background: archive.archived ? 'rgba(72,219,128,0.06)' : 'var(--bg-secondary)',
            color: archive.archived ? 'var(--success)' : 'var(--text-muted)',
          }}
        >
          {archive.archived ? (
            isTeacher && archive.url ? (
              <a href={archive.url} target="_blank" rel="noreferrer" style={{ color: 'var(--success)' }}>
                ✓ 已归档到 GitHub{archive.studentLogin ? `（${archive.studentLogin}）` : ''}，点击查看
              </a>
            ) : (
              <span style={{ color: 'var(--success)' }}>
                ✓ 已归档（归档仓库对学生不可见，学生之间无法查看他人代码）
              </span>
            )
          ) : archive.error ? (
            <span style={{ color: 'var(--danger)' }}>✗ 归档失败：{archive.error}</span>
          ) : (
            <span>作品已暂存到平台本地（GitHub 归档尚未启用）</span>
          )}
        </div>
      )}

      {/* 上传记录（版本归档：同一场景+角色的多次上传即 v1/v2/...，最新版本默认选中） */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
          📋 版本记录（当前场景 · {role === 'solo_attack' ? '攻击' : '防御'}）
          {records.length > 0 && (
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
              共 {records.length} 个版本，最新版本默认选中
            </span>
          )}
        </div>
        {recordsLoading ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>加载中…</div>
        ) : records.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>暂无上传记录（上传后自动生成 v1 并归档）</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {records.map((r, i) => {
              const isLatest = i === 0
              const isSelected = r.workDirId === (selectedRecordId ?? workDirId)
              return (
                <div
                  key={r.workDirId}
                  onClick={() => selectVersion(r)}
                  title={isLatest ? '最新版本（默认使用，点击可重新预检）' : '点击切换到该版本'}
                  style={{
                    display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-secondary)', alignItems: 'center',
                    padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid',
                    borderColor: isSelected ? 'var(--brand-cyan)' : 'transparent',
                    background: isSelected ? 'rgba(0,212,255,0.08)' : 'transparent',
                  }}
                >
                  <span style={{ color: 'var(--brand-cyan)', fontWeight: 700, flexShrink: 0, width: 34 }}>
                    v{r.version ?? '?'}
                  </span>
                  <span
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}
                    title={r.fileName}
                  >
                    {r.fileName}
                  </span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatTime(r.uploadedAt)}</span>
                  {r.archived && <span style={{ color: 'var(--success)', flexShrink: 0 }}>✓归档</span>}
                  {isLatest && <span style={{ color: 'var(--warning)', flexShrink: 0 }}>最新</span>}
                  {isSelected && <span style={{ color: 'var(--brand-cyan)', flexShrink: 0 }}>使用中</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 就绪状态 */}
      {ready && (
        <div style={{ fontSize: 11, color: 'var(--success)', textAlign: 'center', padding: '4px 0' }}>
          ✓ 工程预检通过，可点击「执行{role === 'solo_attack' ? '攻击' : '防御'}」开始对战
        </div>
      )}
    </div>
  )
}

// ── 目录树渲染（递归，带深度缩进与文件大小）────────────────────────────────────
function TreeRenderer({ node, depth }: { node: TreeNode; depth: number }) {
  const isDir = node.type === 'dir'
  const sizeLabel = !isDir && node.size != null ? formatSize(node.size) : ''
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '1px 0', color: isDir ? 'var(--text-secondary)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        <span style={{ paddingLeft: depth * 12 }}>
          {isDir ? '📁 ' : '📄 '}
          {node.name}
          {node.name === 'solution.py' && <span style={{ color: 'var(--brand-cyan)', marginLeft: 6 }}>·入口</span>}
        </span>
        {sizeLabel && <span style={{ color: 'var(--text-muted)' }}>{sizeLabel}</span>}
      </div>
      {isDir && node.children?.map((c, i) => <TreeRenderer key={i} node={c} depth={depth + 1} />)}
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  } catch {
    return iso
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
