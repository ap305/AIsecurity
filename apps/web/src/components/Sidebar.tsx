import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
const MAIN = [
  ['/', '基础题库'],
  ['/arena?role=attack', '攻击题库'],
  ['/arena?role=defense', '防御题库'],
  ['/leaderboard', '排行榜'],
  ['/achievements', '成就'],
  ['/profile', '个人资料'],
  ['/help', '使用帮助'],
]
const ADMIN = [
  ['/admin', '管理面板'],
  ['/admin/questions', '题目管理'],
  ['/admin/operations', '评测运行管理'],
  ['/admin/review', '题目审核'],
  ['/admin/users', '用户管理'],
  ['/admin/student-scores', '学生成绩'],
  ['/admin/api-pool', '平台 API 池'],
  ['/admin/teacher-leases', '临时 API 管理'],
  ['/admin/github', 'GitHub 归档'],
]
export default function Sidebar() {
  const { isAdmin } = useAuth()
  const { pathname, search } = useLocation()
  const items = (rows: string[][]) =>
    rows.map(([path, label]) => {
      const role = new URLSearchParams(search).get('role')
      const active = path.includes('?role=')
        ? pathname.startsWith('/arena') && role === path.split('=')[1]
        : path === '/'
          ? pathname === '/' || pathname.startsWith('/question/')
          : path === '/admin'
            ? pathname === '/admin'
            : pathname.startsWith(path)
      return (
        <Link
          key={path}
          to={path}
          aria-current={active ? 'page' : undefined}
          style={{
            display: 'block',
            padding: '11px 14px',
            marginBottom: 4,
            borderRadius: 6,
            fontSize: 13,
            color: active ? 'var(--brand-cyan)' : 'var(--text-secondary)',
            background: active ? 'var(--brand-cyan-dim)' : 'transparent',
          }}
        >
          {label}
        </Link>
      )
    })
  return (
    <aside
      className="app-sidebar"
      style={{
        position: 'fixed',
        top: 'var(--topbar-height)',
        left: 0,
        width: 'var(--sidebar-width)',
        bottom: 30,
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-color)',
        padding: 14,
        overflowY: 'auto',
        zIndex: 50,
      }}
    >
      <nav aria-label="主要功能">{items(MAIN)}</nav>
      {isAdmin && (
        <nav aria-label="管理员功能" style={{ marginTop: 24 }}>
          <div className="prd-muted" style={{ padding: '0 14px 10px' }}>
            管理
          </div>
          {items(ADMIN)}
        </nav>
      )}
    </aside>
  )
}
