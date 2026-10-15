import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import Topbar from './components/Topbar'
import Sidebar from './components/Sidebar'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import Register from './pages/Register'
import QuestionHall from './pages/QuestionHall'
import Profile from './pages/Profile'
import Achievements from './pages/Achievements'
import Leaderboard from './pages/Leaderboard'
import Help from './pages/Help'
import AdminDashboard from './pages/admin/AdminDashboard'
import QuestionEditor from './pages/admin/QuestionEditor'
import QuestionReview from './pages/admin/QuestionReview'
import UserManager from './pages/admin/UserManager'
import StudentScores from './pages/admin/StudentScores'
import ApiPoolManager from './pages/admin/ApiPoolManager'
import TeacherLeaseManager from './pages/admin/TeacherLeaseManager'
import AdminOperations from './pages/admin/AdminOperations'
import GithubArchiveConfig from './pages/admin/GithubArchiveConfig'
import beianIcon from './assets/beian-icon.png'

const SolveQuestion = lazy(() => import('./pages/SolveQuestion'))
function SolveRoute() {
  return (
    <Suspense fallback={<div className="prd-loading">正在加载解题页面…</div>}>
      <SolveQuestion />
    </Suspense>
  )
}

function SiteFooter() {
  return (
    <footer
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        fontSize: 11,
        color: 'var(--text-muted)',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-color)',
        zIndex: 100,
      }}
    >
      <a
        href="https://beian.miit.gov.cn"
        target="_blank"
        rel="noreferrer"
        style={{ color: 'inherit', textDecoration: 'none' }}
      >
        京ICP备2026058886号
      </a>
      <a
        href="https://beian.mps.gov.cn/#/query/webSearch?code=11010802050211"
        target="_blank"
        rel="noreferrer"
        style={{
          color: 'inherit',
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <img src={beianIcon} alt="京公网安备图标" style={{ height: 16, width: 'auto' }} />
        京公网安备11010802050211号
      </a>
    </footer>
  )
}

function AppLayout() {
  return (
    <div className="app-layout">
      <Topbar />
      <div className="app-body">
        <Sidebar />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <>
      <SiteFooter />
      <Routes>
        {/* Login / Register — no shell */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* All authenticated routes — with shell */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<QuestionHall category="basic" />} />
            <Route path="/module/:moduleCode" element={<Navigate to="/" replace />} />
            <Route path="/question/:questionId" element={<SolveRoute />} />
            <Route path="/arena" element={<QuestionHall category="adversarial" />} />
            <Route path="/arena/:questionId" element={<SolveRoute />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/achievements" element={<Achievements />} />
            <Route path="/help" element={<Help />} />
            <Route path="/llm-config" element={<Navigate to="/help" replace />} />

            {/* Admin routes */}
            <Route element={<ProtectedRoute requireAdmin />}>
              <Route path="/admin" element={<AdminDashboard />} />
              <Route path="/admin/questions" element={<QuestionEditor />} />
              <Route path="/admin/review" element={<QuestionReview />} />
              <Route path="/admin/users" element={<UserManager />} />
              <Route path="/admin/student-scores" element={<StudentScores />} />
              <Route path="/admin/llm" element={<Navigate to="/admin/api-pool" replace />} />
              <Route path="/admin/api-pool" element={<ApiPoolManager />} />
              <Route path="/admin/teacher-leases" element={<TeacherLeaseManager />} />
              <Route path="/admin/operations" element={<AdminOperations />} />
              <Route path="/admin/github" element={<GithubArchiveConfig />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
