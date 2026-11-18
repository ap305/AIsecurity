import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTeaching } from '../contexts/TeachingContext'
const MAIN = [
  ['/', '基础题库'],
  ['/arena?role=attack', '攻击题库'],
  ['/arena?role=defense', '防御题库'],
  ['/leaderboard', '排行榜'],
  ['/classes', '我加入的班级'],
  ['/achievements', '成就'],
  ['/profile', '个人资料'],
  ['/help', '使用帮助'],
]
const TEACHING = [
  ['/teaching', '管理的班级'],
  ['/teaching/solutions', '我的讲解'],
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
  ['/admin/model-usage', '模型用量与告警'],
  ['/admin/teacher-leases', '临时 API 管理'],
  ['/admin/github', 'GitHub 归档'],
]
export default function Sidebar() {
  const { isAdmin } = useAuth()
  const { canTeach, status, refresh } = useTeaching()
  const { pathname, search } = useLocation()
  const teachingSpace = pathname.startsWith('/teaching')
  const items = (rows: string[][]) =>
    rows.map(([path, label]) => {
      const role = new URLSearchParams(search).get('role')
      const active = path.includes('?role=')
        ? pathname.startsWith('/arena') && role === path.split('=')[1]
        : path === '/'
          ? pathname === '/' || pathname.startsWith('/question/')
          : path === '/admin' || path === '/teaching'
            ? pathname === path || (path === '/teaching' && pathname.startsWith('/teaching/classes/'))
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
        <div className="prd-muted sidebar-caption">{teachingSpace && canTeach ? '教学空间' : '练习空间'}</div>
        {items(teachingSpace && canTeach ? TEACHING : MAIN)}
      </nav>
      {status === 'unavailable' && (
        <div className="sidebar-access-notice">
          <p role="status">教学权限暂不可用</p>
          <button
            type="button"
            className="prd-button"
            onClick={() => {
              void refresh()
            }}
          >
            重新验证
          </button>
        </div>
      )}
      {isAdmin && (
        <nav aria-label="管理员功能" className="sidebar-admin">
          <div className="prd-muted sidebar-caption">平台管理</div>
          {items(ADMIN)}
        </nav>
      )}
    </aside>
  )
}
