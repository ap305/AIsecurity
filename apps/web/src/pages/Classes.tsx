import React from 'react'
import { classroomsApi, type ClassroomDetail, type ClassroomList } from '../lib/classrooms'

export default function Classes() {
  const [data, setData] = React.useState<ClassroomList | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const [invite, setInvite] = React.useState('')
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [selectedId, setSelectedId] = React.useState('')
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

  return (
    <div className="prd-page">
      <div className="prd-split">
        <div>
          <h1>班级</h1>
          <p className="prd-muted">通过邀请码加入多个班级；教师可管理自己的班级，管理员可管理全部班级。</p>
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
      {loading && <p role="status">正在加载班级…</p>}
      {data && (
        <>
          <section className="prd-panel">
            <h2>已加入的班级</h2>
            {!data.joined.length && <p className="prd-muted">尚未加入班级，请向教师获取邀请码。</p>}
            <ul>
              {data.joined.map((c) => (
                <li key={c.id} style={{ marginBottom: 12 }}>
                  <strong>{c.name}</strong>
                  {c.archivedAt && '（已归档）'}{' '}
                  <button
                    className="prd-button"
                    onClick={() => setSelectedId(c.id)}
                  >{`查看${c.name}`}</button>
                  <p className="prd-muted">{c.description}</p>
                </li>
              ))}
            </ul>
          </section>
          {data.canTeach && (
            <>
              <section className="prd-panel">
                <h2>创建班级</h2>
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
                        setSelectedId(created.id)
                      }
                      changed('班级已创建，可将邀请码提供给学生。')
                    })
                  }
                >
                  {busy.includes('create') ? '创建中…' : '创建班级'}
                </button>
              </section>
              <section className="prd-panel">
                <h2>可管理的班级</h2>
                <p className="prd-muted">
                  单班导出 CSV，多班导出 ZIP，每班一份
                  CSV；排除测试账号。逐题列为当前已发布题目，基础总分沿用平台口径（包括下架基础题的有效分）。Excel
                  导入时请将学号列设置为文本，以保留开头的 0。
                </p>
                {!data.owned.length && <p>尚无可管理的班级。</p>}
                <ul>
                  {data.owned.map((c) => (
                    <li key={c.id} style={{ marginBottom: 12 }}>
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
                      </label>{' '}
                      <button
                        className="prd-button"
                        onClick={() => setSelectedId(c.id)}
                      >{`管理${c.name}`}</button>
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
                      const url = URL.createObjectURL(file.blob)
                      const link = document.createElement('a')
                      link.href = url
                      link.download = file.filename
                      document.body.appendChild(link)
                      link.click()
                      link.remove()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                      setNotice('成绩文件已生成。0 为有效零分，未提交和无有效成绩会单独标注。')
                    })
                  }
                >
                  {busy.includes('export') ? '导出中…' : '导出所选班级'}
                </button>
              </section>
            </>
          )}
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
              {current.canManage && (
                <>
                  <p>
                    邀请码：<code>{current.inviteCode}</code>
                  </p>
                  <button
                    className="prd-button"
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
                    className="prd-button"
                    disabled={busy.includes(`archive:${current.id}`)}
                    onClick={() =>
                      run(`archive:${current.id}`, current.archivedAt ? '恢复班级' : '归档班级', async () => {
                        await classroomsApi.update(current.id, { archived: !current.archivedAt })
                        changed(current.archivedAt ? '班级已恢复。' : '班级已归档，已有成员和成绩保留。')
                      })
                    }
                  >
                    {current.archivedAt ? '恢复班级' : '归档班级'}
                  </button>
                  <div style={{ marginTop: 16 }}>
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
                      className="prd-button"
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
                          ) editDraft.current.dirty = false
                          changed('班级资料已保存。')
                        })
                      }
                    >
                      保存班级资料
                    </button>
                  </div>
                  <h3>班级成员（{current.members?.length || 0}）</h3>
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
                        {current.members?.map((member) => (
                          <tr key={member.userId}>
                            <td>{member.username}</td>
                            <td>{member.displayName}</td>
                            <td>{member.studentId || '未填写'}</td>
                            <td>{member.isTestAccount ? '测试账号（不导出）' : '正式账号'}</td>
                            <td>
                              <button
                                className="prd-button"
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
                </>
              )}
              {current.isMember && (
                <button
                  className="prd-button"
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
          <div style={{ marginTop: 12 }}>
            <button
              className="prd-button"
              disabled={detailLoading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              刷新详情
            </button>{' '}
            <button className="prd-button" onClick={() => setSelectedId('')}>
              关闭详情
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
