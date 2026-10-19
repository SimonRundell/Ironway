import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './state/authContext.js'
import LoginPage from './ui/LoginPage.jsx'
import RegisterPage from './ui/RegisterPage.jsx'
import SavesPage from './ui/SavesPage.jsx'
import InspectorPage from './ui/InspectorPage.jsx'

/**
 * Root component and route table.
 * @module App
 */

/**
 * Renders its children only when signed in, otherwise redirects to login.
 *
 * @param {{children: import('react').ReactNode}} props
 * @returns {JSX.Element|null}
 */
function RequireAuth({ children }) {
  const { user, loading } = useAuth()

  if (loading) {
    return null
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return children
}

/**
 * Root component.
 * @returns {JSX.Element} The route table.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <SavesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/island/:saveId"
        element={
          <RequireAuth>
            <InspectorPage />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
