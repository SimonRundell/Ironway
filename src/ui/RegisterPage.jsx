import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../state/authContext.js'

/**
 * Minimal registration page.
 *
 * @module ui/RegisterPage
 */

/**
 * Registration form. Redirects to the home page on success.
 *
 * @returns {JSX.Element}
 */
export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)

  /**
   * Submits the registration form.
   *
   * @param {import('react').FormEvent<HTMLFormElement>} event Form submit event.
   * @returns {Promise<void>}
   */
  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setFieldErrors({})
    setSubmitting(true)

    try {
      await register(username, password, email)
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error?.message ?? 'Registration failed.')
      setFieldErrors(err.response?.data?.error?.fields ?? {})
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
            {fieldErrors.username && <span className="field-error">{fieldErrors.username}</span>}
          </label>
          <label className="field">
            Email (optional)
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
            {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
            {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
          </label>
          {error && <p className="field-error">{error}</p>}
          <button type="submit" disabled={submitting}>
            Register
          </button>
        </form>
        <p className="muted">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </main>
  )
}
