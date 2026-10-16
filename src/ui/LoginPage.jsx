import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../state/authContext.js'

/**
 * Minimal sign-in page.
 *
 * @module ui/LoginPage
 */

/**
 * Sign-in form. Redirects to the home page on success.
 *
 * @returns {JSX.Element}
 */
export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  /**
   * Submits the sign-in form.
   *
   * @param {import('react').FormEvent<HTMLFormElement>} event Form submit event.
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      await login(username, password)
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error?.message ?? 'Sign in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1 className="brand">
          <img className="brand-logo" src="/favicon.png" alt="Ironway" />
        </h1>
        <form onSubmit={handleSubmit}>
          <label className="field">
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="field-error">{error}</p>}
          <button type="submit" disabled={submitting}>
            Sign in
          </button>
        </form>
        <p className="muted">
          No account? <Link to="/register">Register</Link>
        </p>
      </div>
    </main>
  )
}
