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
        <Link key={path} to={path} aria-current={active ? 'page' : undefined} className="sidebar-link">
          {label}
        </Link>
      )
    })
  return (
    <aside className="app-sidebar">
      <nav aria-label="主要功能">
        <div className="prd-muted sidebar-caption">题库与账户</div>
        {items(MAIN)}
      </nav>
      {isAdmin && (
        <nav aria-label="管理员功能" className="sidebar-admin">
          <div className="prd-muted sidebar-caption">平台管理</div>
          {items(ADMIN)}
        </nav>
      )}
    </aside>
  )
}
