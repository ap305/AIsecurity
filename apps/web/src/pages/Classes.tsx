import React from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  classroomsApi,
  type ClassroomDetail,
  type ClassroomList,
  type ClassroomScores,
  type ClassroomScoreFilters,
  type ClassroomScoreCell,
} from '../lib/classrooms'

export default function Classes({ workspace = 'practice' }: { workspace?: 'practice' | 'teaching' } = {}) {
  const { classId } = useParams()
  const navigate = useNavigate()
  const teaching = workspace === 'teaching'
  const [tab, setTab] = React.useState<'members' | 'scores' | 'settings'>('members')
  const [statusFilter, setStatusFilter] = React.useState<'active' | 'archived' | 'all'>('active')
  const [copyFallback, setCopyFallback] = React.useState('')
  const [memberSearch, setMemberSearch] = React.useState('')
  const [data, setData] = React.useState<ClassroomList | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const [invite, setInvite] = React.useState('')
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [localId, setSelectedId] = React.useState('')
  const selectedId = teaching ? classId || '' : localId
  function selectClass(id: string) {
    setSelectedId(id)
    setCopyFallback('')
    setMemberSearch('')
    if (teaching) navigate(id ? `/teaching/classes/${encodeURIComponent(id)}` : '/teaching')
  }
  const [detail, setDetail] = React.useState<ClassroomDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailError, setDetailError] = React.useState('')
  const [editName, setEditName] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')
  const editDraft = React.useRef({ classId: '', revision: 0, dirty: false })
  const [busy, setBusy] = React.useState<string[]>([])
  const pending = React.useRef(new Set<string>())
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setData(null)
    classroomsApi
      .list()
      .then((value) => {
        if (!active) return
        setData(value)
        setSelected((ids) => ids.filter((id) => value.owned.some((c) => c.id === id)))
      })
      .catch(() => {
        if (active) setError('班级加载失败，请刷新班级重试。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [refresh])

  React.useEffect(() => {
    let active = true
    if (editDraft.current.classId !== selectedId) {
      editDraft.current = { classId: selectedId, revision: editDraft.current.revision + 1, dirty: false }
    }
    setDetail(null)
    setDetailError('')
    if (!selectedId) {
      setDetailLoading(false)
      return () => {
        active = false
      }
    }
    setDetailLoading(true)
    classroomsApi
      .get(selectedId)
      .then((value) => {
        if (!active) return
        setDetail(value)
        // Membership/invite updates and late saves must not erase the current form draft.
        if (!editDraft.current.dirty) {
          setEditName(value.name)
          setEditDescription(value.description)
        }
      })
      .catch(() => {
        if (active) setDetailError('班级详情加载失败，可能已退出或管理权限已变化。请重试。')
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedId, refresh])

  async function run(key: string, label: string, operation: () => Promise<void>) {
    if (pending.current.has(key)) return
    pending.current.add(key)
    setBusy([...pending.current])
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (reason) {
      if (mounted.current)
        setError(`${label}失败：${reason instanceof Error ? reason.message : '请稍后重试'}`)
    } finally {
      pending.current.delete(key)
      if (mounted.current) setBusy([...pending.current])
    }
  }
  const changed = (message: string) => {
    if (mounted.current) {
      setNotice(message)
      setRefresh((value) => value + 1)
    }
  }
  const current = detail?.id === selectedId ? detail : null

  const canManage = teaching && !!data?.canTeach && !!current?.canManage
  const visibleMembers =
    current?.members?.filter((member) =>
      [member.username, member.displayName, member.studentId || ''].some((value) =>
        value.toLocaleLowerCase().includes(memberSearch.trim().toLocaleLowerCase()),
      ),
    ) || []
  const visibleOwned =
    data?.owned.filter(
      (c) => statusFilter === 'all' || (statusFilter === 'archived' ? !!c.archivedAt : !c.archivedAt),
    ) || []

  return (
    <div className="prd-page class-workbench">
      <div className="prd-split">
        <div>
          <h1>{teaching ? '教学工作台' : '我的班级'}</h1>
          <p className="prd-muted">
            {teaching
              ? '管理班级、查看成员和当前成绩。教师仅管理自己的班级，管理员可管理全部班级。'
              : '通过邀请码加入课程班级。加入班级不影响自由练习和已有成绩。'}
          </p>
        </div>
        <button className="prd-button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          刷新班级
        </button>
      </div>
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="prd-notice" role="status">
          {notice}
        </div>
      )}
      {!teaching && (
        <section className="prd-panel" aria-label="加入班级">
          <h2>加入班级</h2>
          <div className="prd-toolbar">
            <label htmlFor="class-invite">邀请码</label>
            <input
              id="class-invite"
              name="inviteCode"
              className="prd-input"
              maxLength={100}
              autoComplete="off"
              value={invite}
              disabled={busy.includes('join')}
              onChange={(event) => setInvite(event.target.value)}
            />
            <button
              className="prd-button primary"
              disabled={!invite.trim() || busy.includes('join')}
              onClick={() =>
                run('join', '加入', async () => {
                  await classroomsApi.join(invite)
                  if (mounted.current) setInvite('')
                  changed('已加入班级；重复加入不会增加成员记录。')
                })
              }
            >
              {busy.includes('join') ? '加入中…' : '加入班级'}
            </button>
          </div>
        </section>
      )}
      {loading && <p role="status">正在加载班级…</p>}
      {data && !teaching && (
        <section className="prd-panel">
          <h2>已加入的班级</h2>
          {!data.joined.length && <p className="prd-muted">尚未加入班级，请向教师获取邀请码。</p>}
          <ul className="class-list">
            {data.joined.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  {c.archivedAt && '（已归档）'}
                  <p className="prd-muted">{c.description}</p>
                </div>
                <button className="prd-button" onClick={() => selectClass(c.id)}>{`查看${c.name}`}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && teaching && !data.canTeach && (
        <p className="prd-error" role="alert">
          当前账号没有教师管理权限，请联系管理员。
        </p>
      )}
      {data && teaching && data.canTeach && (
        <>
          <section className="prd-panel">
            <div className="prd-split">
              <h2>可管理的班级</h2>
              <label>
                班级状态{' '}
                <select
                  className="prd-input"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value as typeof statusFilter)
                    setSelected([])
                  }}
                >
                  <option value="active">进行中</option>
                  <option value="archived">已归档</option>
                  <option value="all">全部班级</option>
                </select>
              </label>
            </div>
            {!visibleOwned.length && <p className="prd-muted">当前状态下没有可管理的班级。</p>}
            <ul className="class-list">
              {visibleOwned.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={(event) =>
                        setSelected((ids) =>
                          event.target.checked
                            ? [...new Set([...ids, c.id])]
                            : ids.filter((id) => id !== c.id),
                        )
                      }
                    />{' '}
                    {c.name}
                    {c.archivedAt && '（已归档）'}
                  </label>
                  <button className="prd-button" onClick={() => selectClass(c.id)}>{`管理${c.name}`}</button>
                </li>
              ))}
            </ul>
            <button
              className="prd-button"
              disabled={!selected.length || busy.includes('export')}
              onClick={() =>
                run('export', '导出', async () => {
                  const file = await classroomsApi.export(selected)
                  if (!mounted.current) return
                  downloadClassFile(file)
                  setNotice('成绩文件已生成。0 为有效零分，未提交和无有效成绩会单独标注。')
                })
              }
            >
              {busy.includes('export') ? '导出中…' : '导出所选班级'}
            </button>
            <p className="prd-muted">
              单班导出 CSV，多班导出 ZIP，每班一份
              CSV；排除测试账号。逐题列为当前已发布题目，基础总分沿用平台口径（包括下架基础题的有效分）。Excel
              导入时请将学号列设置为文本，以保留开头的 0。
            </p>
          </section>
          <section className="prd-panel">
            <h2>创建班级</h2>
            <div className="class-form">
              <label htmlFor="class-name">班级名称</label>
              <input
                id="class-name"
                name="className"
                className="prd-input"
                maxLength={80}
                value={name}
                disabled={busy.includes('create')}
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="class-description">班级说明</label>
              <textarea
                id="class-description"
                className="prd-input"
                maxLength={1000}
                value={description}
                disabled={busy.includes('create')}
                onChange={(event) => setDescription(event.target.value)}
              />
              <button
                className="prd-button primary"
                disabled={!name.trim() || busy.includes('create')}
                onClick={() =>
                  run('create', '创建', async () => {
                    const created = await classroomsApi.create({ name, description })
                    if (mounted.current) {
                      setName('')
                      setDescription('')
                      selectClass(created.id)
                    }
                    changed('班级已创建，可将邀请码提供给学生。')
                  })
                }
              >
                {busy.includes('create') ? '创建中…' : '创建班级'}
              </button>
            </div>
          </section>
        </>
      )}
      {selectedId && (
        <section className="prd-panel" aria-label="班级详情">
          {detailLoading && <p role="status">正在加载班级详情…</p>}
          {detailError && (
            <p className="prd-error" role="alert">
              {detailError}
            </p>
          )}
          {current && (
            <>
              <h2>班级详情：{current.name}</h2>
              <p>{current.description}</p>
              {current.archivedAt && <p className="prd-muted">已归档，暂停加入。</p>}
              {canManage && (
                <>
                  <div className="class-invite">
                    <span>
                      邀请码：<code>{current.inviteCode}</code>
                    </span>
                    <button
                      className="prd-button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(current.inviteCode || '')
                          if (mounted.current) setNotice('邀请码已复制。')
                        } catch {
                          if (mounted.current) setCopyFallback(current.id)
                        }
                      }}
                    >
                      复制邀请码
                    </button>
                  </div>
                  {copyFallback === current.id && (
                    <label className="class-copy-fallback">
                      无法自动复制，请选中邀请码手动复制。
                      <input
                        className="prd-input"
                        readOnly
                        value={current.inviteCode || ''}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </label>
                  )}
                  <div className="class-tabs" aria-label="班级详情分区">
                    <button
                      className="prd-button"
                      aria-pressed={tab === 'members'}
                      onClick={() => setTab('members')}
                    >
                      班级成员
                    </button>
                    <button
                      className="prd-button"
                      aria-pressed={tab === 'scores'}
                      onClick={() => setTab('scores')}
                    >
                      班级成绩
                    </button>
                    <button
                      className="prd-button"
                      aria-pressed={tab === 'settings'}
                      onClick={() => setTab('settings')}
                    >
                      班级设置
                    </button>
                  </div>
                  {tab === 'members' && (
                    <>
                      <h3>班级成员（{current.members?.length || 0}）</h3>
                      <label className="class-form">
                        查找成员
                        <input
                          className="prd-input"
                          name="memberSearch"
                          placeholder="账号、姓名或学号"
                          maxLength={100}
                          value={memberSearch}
                          onChange={(event) => setMemberSearch(event.target.value)}
                        />
                      </label>
                      {!!current.members?.length && !visibleMembers.length && (
                        <p className="prd-muted">没有匹配的成员。</p>
                      )}
                      {!current.members?.length && (
                        <p className="prd-muted">还没有成员，请将邀请码提供给学生。</p>
                      )}
                      {!!visibleMembers.length && (
                        <div className="prd-table-wrap">
                          <table className="prd-table">
                            <thead>
                              <tr>
                                <th>账号</th>
                                <th>姓名</th>
                                <th>学号</th>
                                <th>类型</th>
                                <th>操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleMembers.map((member) => (
                                <tr key={member.userId}>
                                  <td>{member.username}</td>
                                  <td>{member.displayName}</td>
                                  <td>{member.studentId || '未填写'}</td>
                                  <td>
                                    {member.isTestAccount ? '测试账号（不计入成绩和导出）' : '正式账号'}
                                  </td>
                                  <td>
                                    <button
                                      className="prd-button class-danger"
                                      disabled={busy.includes(`remove:${member.userId}`)}
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            `确认将 ${member.displayName || member.username} 移出班级？其提交和成绩保留。`,
                                          )
                                        )
                                          void run(`remove:${member.userId}`, '移出成员', async () => {
                                            await classroomsApi.removeMember(current.id, member.userId)
                                            changed('成员已移出，提交和成绩保留。')
                                          })
                                      }}
                                    >
                                      移出成员
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                  {tab === 'scores' && (
                    <ClassScores key={current.id} classId={current.id} refresh={refresh} />
                  )}
                  {tab === 'settings' && (
                    <>
                      <div className="class-form">
                        <label htmlFor="class-edit-name">班级名称</label>
                        <input
                          id="class-edit-name"
                          className="prd-input"
                          maxLength={80}
                          value={editName}
                          disabled={busy.includes(`edit:${current.id}`)}
                          onChange={(event) => {
                            editDraft.current.dirty = true
                            editDraft.current.revision += 1
                            setEditName(event.target.value)
                          }}
                        />
                        <label htmlFor="class-edit-description">班级说明</label>
                        <textarea
                          id="class-edit-description"
                          className="prd-input"
                          maxLength={1000}
                          value={editDescription}
                          disabled={busy.includes(`edit:${current.id}`)}
                          onChange={(event) => {
                            editDraft.current.dirty = true
                            editDraft.current.revision += 1
                            setEditDescription(event.target.value)
                          }}
                        />
                        <button
                          className="prd-button primary"
                          disabled={!editName.trim() || busy.includes(`edit:${current.id}`)}
                          onClick={() =>
                            run(`edit:${current.id}`, '保存班级', async () => {
                              const savedRevision = editDraft.current.revision
                              await classroomsApi.update(current.id, {
                                name: editName,
                                description: editDescription,
                              })
                              if (
                                editDraft.current.classId === current.id &&
                                editDraft.current.revision === savedRevision
                              )
                                editDraft.current.dirty = false
                              changed('班级资料已保存。')
                            })
                          }
                        >
                          保存班级资料
                        </button>
                      </div>
                      <div className="class-secondary-actions">
                        <h3>班级维护</h3>
                        <p className="prd-muted">
                          重置邀请码会使旧码失效；归档暂停新成员加入，已有成员和成绩保留。
                        </p>
                        <button
                          className="prd-button class-danger"
                          disabled={busy.includes(`invite:${current.id}`)}
                          onClick={() => {
                            if (window.confirm('重置邀请码后，旧邀请码立即失效。确认重置？'))
                              void run(`invite:${current.id}`, '重置邀请码', async () => {
                                await classroomsApi.rotateInvite(current.id)
                                changed('邀请码已重置。')
                              })
                          }}
                        >
                          重置邀请码
                        </button>{' '}
                        <button
                          className="prd-button class-danger"
                          disabled={busy.includes(`archive:${current.id}`)}
                          onClick={() => {
                            if (
                              current.archivedAt ||
                              window.confirm('归档后暂停加入，已有成员和成绩保留。确认归档？')
                            )
                              void run(
                                `archive:${current.id}`,
                                current.archivedAt ? '恢复班级' : '归档班级',
                                async () => {
                                  await classroomsApi.update(current.id, { archived: !current.archivedAt })
                                  changed(
                                    current.archivedAt ? '班级已恢复。' : '班级已归档，已有成员和成绩保留。',
                                  )
                                },
                              )
                          }}
                        >
                          {current.archivedAt ? '恢复班级' : '归档班级'}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {current.isMember && !teaching && (
                <button
                  className="prd-button class-danger"
                  disabled={busy.includes(`leave:${current.id}`)}
                  onClick={() => {
                    if (window.confirm('确认退出班级？提交和成绩会保留。'))
                      void run(`leave:${current.id}`, '退出班级', async () => {
                        await classroomsApi.leave(current.id)
                        if (mounted.current)
                          setSelectedId((selected) => (selected === current.id ? '' : selected))
                        changed('已退出班级，提交和成绩保留。')
                      })
                  }}
                >
                  退出班级
                </button>
              )}
            </>
          )}
          <div className="class-detail-footer">
            <button
              className="prd-button"
              disabled={detailLoading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              刷新详情
            </button>{' '}
            <button className="prd-button" onClick={() => selectClass('')}>
              关闭详情
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

function downloadClassFile(file: { blob: Blob; filename: string }) {
  const url = URL.createObjectURL(file.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ClassScores({ classId, refresh = 0 }: { classId: string; refresh?: number }) {
  const emptyFilters: ClassroomScoreFilters = { search: '', questionId: '', category: '' }
  const [draft, setDraft] = React.useState(emptyFilters)
  const [filters, setFilters] = React.useState(emptyFilters)
  const [page, setPage] = React.useState(1)
  const [reload, setReload] = React.useState(0)
  const [loaded, setLoaded] = React.useState<{ key: string; data: ClassroomScores } | null>(null)
  const [questions, setQuestions] = React.useState<ClassroomScores['questions']>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [exporting, setExporting] = React.useState<string[]>([])
  const exportPending = React.useRef(new Set<string>())
  const readVersion = React.useRef(0)
  const liveClass = React.useRef(classId)
  liveClass.current = classId
  const mounted = React.useRef(true)
  const key = JSON.stringify([classId, filters, page, reload, refresh])
  const data = loaded?.key === key ? loaded.data : null
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  React.useEffect(() => {
    const version = ++readVersion.current
    let active = true
    setLoading(true)
    setLoaded(null)
    setError('')
    classroomsApi
      .scores(classId, { ...filters, page, pageSize: 20 })
      .then((value) => {
        if (!active || version !== readVersion.current) return
        setLoaded({ key, data: value })
        if (!filters.questionId && !filters.category) setQuestions(value.questions)
      })
      .catch((reason) => {
        if (active && version === readVersion.current)
          setError(`成绩加载失败：${reason instanceof Error ? reason.message : '请稍后重试'}`)
      })
      .finally(() => {
        if (active && version === readVersion.current) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [key])
  function invalidate() {
    readVersion.current += 1
    setLoaded(null)
    setError('')
    setNotice('')
  }
  async function exportScores(scope: 'all' | 'filtered') {
    if (exportPending.current.has(scope)) return
    exportPending.current.add(scope)
    setExporting([...exportPending.current])
    setError('')
    setNotice('')
    try {
      const file = await classroomsApi.export([classId], scope === 'filtered' ? filters : undefined)
      if (!mounted.current || liveClass.current !== classId) return
      downloadClassFile(file)
      setNotice(scope === 'filtered' ? '当前筛选的全部学生已导出（包含其他分页）。' : '全班成绩已导出。')
    } catch (reason) {
      if (mounted.current && liveClass.current === classId)
        setError(`导出失败：${reason instanceof Error ? reason.message : '请稍后重试'}`)
    } finally {
      exportPending.current.delete(scope)
      if (mounted.current) setExporting([...exportPending.current])
    }
  }
  return (
    <div className="class-scores">
      <div className="prd-split">
        <h3>班级成绩</h3>
        <button
          className="prd-button"
          disabled={loading}
          onClick={() => {
            invalidate()
            setReload((n) => n + 1)
          }}
        >
          刷新成绩
        </button>
      </div>
      <p className="prd-muted">
        基础题显示当前版本最高有效分，攻防题显示当前有效算法成绩。最近一次提交状态单独展示，失败不会覆盖已有有效成绩。测试账号不参与；基础总分包含下架基础题有效分，不随题目筛选改变。
      </p>
      <div className="class-score-filters">
        <label>
          学生
          <input
            className="prd-input"
            name="scoreSearch"
            placeholder="账号、姓名或学号"
            maxLength={100}
            value={draft.search}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
          />
        </label>
        <label>
          题型
          <select
            className="prd-input"
            name="scoreCategory"
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value as ClassroomScoreFilters['category'] })
            }
          >
            <option value="">全部题型</option>
            <option value="basic">基础</option>
            <option value="attack">攻击</option>
            <option value="defense">防御</option>
          </select>
        </label>
        <label>
          题目
          <select
            className="prd-input"
            name="scoreQuestion"
            value={draft.questionId}
            onChange={(event) => setDraft({ ...draft, questionId: event.target.value })}
          >
            <option value="">全部题目</option>
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.moduleCode}-{q.number} {q.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="prd-button primary"
          onClick={() => {
            invalidate()
            setFilters({ ...draft, search: draft.search?.trim() || '' })
            setPage(1)
            setReload((n) => n + 1)
          }}
        >
          应用筛选
        </button>
        <button
          className="prd-button"
          onClick={() => {
            invalidate()
            setDraft(emptyFilters)
            setFilters(emptyFilters)
            setPage(1)
            setReload((n) => n + 1)
          }}
        >
          清空筛选
        </button>
      </div>
      <div className="class-export-actions">
        <button
          className="prd-button"
          disabled={!data || exporting.includes('all')}
          onClick={() => exportScores('all')}
        >
          {exporting.includes('all') ? '正在导出全班…' : '导出全班成绩'}
        </button>
        <button
          className="prd-button"
          disabled={!data || exporting.includes('filtered')}
          onClick={() => exportScores('filtered')}
        >
          {exporting.includes('filtered') ? '正在导出筛选…' : '导出当前筛选'}
        </button>
      </div>
      {error && (
        <p className="prd-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="prd-notice" role="status">
          {notice}
        </p>
      )}
      {loading && <p role="status">正在加载成绩…</p>}
      {data && (
        <>
          {!data.questions.length && <p className="prd-muted">当前筛选没有已发布题目。</p>}
          {!data.students.length && <p className="prd-muted">当前筛选没有正式学生。</p>}
          {!!data.students.length && (
            <div className="prd-table-wrap" role="region" aria-label="班级成绩表，可横向滚动" tabIndex={0}>
              <table className="prd-table class-score-table">
                <thead>
                  <tr>
                    <th>学生 / 学号</th>
                    {data.questions.map((q) => (
                      <th key={q.id}>
                        {q.moduleCode}-{q.number}
                        <br />
                        {q.title}
                        <small>
                          {q.category === 'basic' ? '基础' : q.role === 'attack' ? '攻击' : '防御'}
                        </small>
                      </th>
                    ))}
                    <th>基础总分</th>
                  </tr>
                </thead>
                <tbody>
                  {data.students.map((student) => (
                    <tr key={student.userId}>
                      <th scope="row">
                        {student.displayName || student.username}
                        <small>
                          {student.username} / {student.studentId || '未填写学号'}
                        </small>
                      </th>
                      {student.scores.map((cell) => (
                        <td key={cell.questionId}>
                          <div>
                            当前成绩：
                            <strong>{cell.score !== null ? cell.score : scoreStateText[cell.state]}</strong>
                          </div>
                          <small>
                            最近提交：
                            {cell.latestSubmission
                              ? submissionOutcomeText[cell.latestSubmission.outcome] || '状态待确认'
                              : '未提交'}
                          </small>
                          {cell.latestSubmission && (
                            <small>{new Date(cell.latestSubmission.createdAt).toLocaleString('zh-CN')}</small>
                          )}
                          {cell.updating && <small>成绩更新中</small>}
                        </td>
                      ))}
                      <td>
                        <strong>{student.basicTotalScore}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="class-pagination">
            <span>
              共 {data.total} 名学生，第 {data.page} 页 / {Math.max(1, Math.ceil(data.total / data.pageSize))}{' '}
              页
            </span>
            <button
              className="prd-button"
              disabled={data.page <= 1 || loading}
              onClick={() => {
                invalidate()
                setPage((n) => n - 1)
              }}
            >
              上一页
            </button>
            <button
              className="prd-button"
              disabled={data.page * data.pageSize >= data.total || loading}
              onClick={() => {
                invalidate()
                setPage((n) => n + 1)
              }}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const scoreStateText: Record<ClassroomScoreCell['state'], string> = {
  scored: '已计分',
  pending: '评测中',
  no_score: '无有效成绩',
  outdated: '旧版本已失效',
  not_submitted: '未提交',
}
const submissionOutcomeText: Record<NonNullable<ClassroomScoreCell['latestSubmission']>['outcome'], string> =
  {
    pending: '评测中',
    completed: '已完成',
    baseline_failed: '未过基线',
    student_error: '提交错误',
    timeout: '评测超时',
    system_error: '评测环境异常',
    error: '评测异常',
    outdated: '旧版本',
    unknown: '状态待确认',
  }
