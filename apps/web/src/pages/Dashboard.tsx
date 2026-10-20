import { useAuth } from '../contexts/AuthContext'
import QuestionHall from './QuestionHall'
import AdminDashboard from './admin/AdminDashboard'

// Retained for old imports; all entry points use the live question libraries.
export default function Dashboard() {
  const { isAdmin } = useAuth()
  return isAdmin ? <AdminDashboard /> : <QuestionHall category="basic" />
}
