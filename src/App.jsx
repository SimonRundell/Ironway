import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './state/authContext.js'
import LoginPage from './ui/LoginPage.jsx'
import RegisterPage from './ui/RegisterPage.jsx'

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
 * Placeholder landing page for a signed-in player. Replaced by the
 * inspector UI in T1.26.
 *
 * @returns {JSX.Element}
 */
function HomePage() {
  const { user, logout } = useAuth()

  return (
    <main className="page">
      <div className="card">
        <h1 className="brand">
          <img className="brand-logo" src="/favicon.png" alt="Ironway" />
        </h1>
        <p>An economic and logistics sandbox on a generated island.</p>
        <p className="muted">Phase 0: foundations. Signed in as {user.username}.</p>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </div>
    </main>
  )
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
            <HomePage />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
