import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet } from '../../lib/api'
import { isCurrentLibraryQuestion } from '../../lib/hallFilters'
import type { QuestionRecord } from '../../lib/prdApi'
import './AdminDashboard.css'
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
  ['/admin/users', '用户管理', '管理学生与测试账号，查看账号状态和提交历史。'],
  ['/admin/student-scores', '学生成绩', '按学生查询基础总分，以及每道已提交题目的成绩和评测状态。'],
  ['/admin/review', '题目审核', '查看待审核题目，发布仍须通过完整配置与自测门禁。'],
]
export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    Promise.all([apiGet<Stats>('/admin/stats'), apiGet<QuestionRecord[]>('/admin/questions')])
      .then(([all, rows]) => {
        const current = rows.filter(isCurrentLibraryQuestion)
        setStats({
          ...all,
          totalQuestions: current.length,
          published: current.filter((q) => q.status === 'published').length,
          draft: current.filter((q) => q.status === 'draft' || q.status === 'review').length,
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : '运行统计加载失败。'))
  }, [])
  return (
    <div className="prd-page admin-dashboard">
      <header className="admin-dashboard-heading">
        <span className="admin-dashboard-eyebrow">教学管理</span>
        <h1>管理面板</h1>
        <p className="prd-muted">查看题库与提交概况，管理题目、学生和评测服务。</p>
      </header>
      {error && (
        <div className="prd-error" role="alert">
          {error}
        </div>
      )}
      <dl className="admin-dashboard-stats">
        {[
          ['题库题目', stats?.totalQuestions],
          ['已发布', stats?.published],
          ['草稿', stats?.draft],
          ['提交记录', stats?.submissions],
        ].map(([name, value]) => (
          <div className="admin-dashboard-stat" key={name}>
            <dt>{name}</dt>
            <dd>{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <section className="admin-dashboard-section" aria-labelledby="admin-library-heading">
        <h2 id="admin-library-heading">题库分类</h2>
        <div className="admin-dashboard-libraries">
          {[
            ['basic', '基础题库', '管理基础实验、算法与模型练习。'],
            ['attack', '攻击题库', '管理攻击方题目、提交接口和评分条件。'],
            ['defense', '防御题库', '管理防御方题目、提交接口和评分条件。'],
          ].map(([type, title, description]) => (
            <Link className="admin-dashboard-link" key={type} to={`/admin/questions?library=${type}`}>
              <div className="admin-dashboard-link-heading">
                <h3>{title}</h3>
                <span aria-hidden="true">→</span>
              </div>
              <p className="prd-muted">{description}</p>
            </Link>
          ))}
        </div>
      </section>
      <section className="admin-dashboard-section" aria-labelledby="admin-tools-heading">
        <h2 id="admin-tools-heading">平台管理</h2>
        <div className="admin-dashboard-tools">
          {links.map(([path, title, description]) => (
            <Link className="admin-dashboard-link" key={path} to={path}>
              <div className="admin-dashboard-link-heading">
                <h3>{title}</h3>
                <span aria-hidden="true">→</span>
              </div>
              <p className="prd-muted">{description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
