import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../../lib/api'
interface Stats {
  totalQuestions: number
  published: number
  draft: number
  submissions: number
}
const links = [
  ['/admin/questions', '题目管理', '编辑题面、填空模板、提交能力、环境包及评分规则。'],
  ['/admin/operations', '评测运行管理', '查看提交与动态重评队列、异常及资源清理状态。'],
  ['/admin/api-pool', '平台 API 池', '维护统一模型和教师服务，题目发布时冻结配置。'],
  ['/admin/teacher-leases', '临时 API 管理', '查询教师服务租约、有效期、调用数并执行维护。'],
  ['/admin/users', '用户管理', '管理学生账号；成绩与提交历史保留审计。'],
  ['/admin/student-scores', '学生成绩', '按学生查询基础总分，以及每道已提交题目的成绩和评测状态。'],
  ['/admin/review', '题目审核', '查看待审核题目，发布仍须通过完整配置与自测门禁。'],
]
export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    apiGet<Stats>('/admin/stats')
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : '运行统计加载失败。'))
  }, [])
  return (
    <div className="prd-page">
      <h1>管理面板</h1>
      <p className="prd-muted">从完整出题到评测、动态评分和教师 API 的管理入口。</p>
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      <div className="prd-toolbar">
        {[
          ['题目', stats?.totalQuestions],
          ['已发布', stats?.published],
          ['草稿', stats?.draft],
          ['提交记录', stats?.submissions],
        ].map(([name, value]) => (
          <div className="prd-panel" key={name}>
            <div className="prd-muted">{name}</div>
            <strong className="prd-score">{value ?? '—'}</strong>
          </div>
        ))}
      </div>
      <div className="prd-grid">
        {links.map(([path, title, description]) => (
          <Link className="prd-panel" key={path} to={path}>
            <h2>{title}</h2>
            <p className="prd-muted">{description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
