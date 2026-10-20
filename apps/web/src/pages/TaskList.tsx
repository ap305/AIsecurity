import { Navigate } from 'react-router-dom'

// Old module bookmarks open the published library instead of synthetic tasks.
export default function TaskList() {
  return <Navigate to="/" replace />
}
