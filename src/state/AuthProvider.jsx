import { useCallback, useEffect, useMemo, useState } from 'react'
import { login as apiLogin, logout as apiLogout, me as apiMe, register as apiRegister } from '../api/auth.js'
import { clearToken, getToken, setToken } from '../api/client.js'
import { AuthContext } from './authContext.js'

/**
 * Provides the signed-in user and auth actions to the component tree.
 *
 * @module state/AuthProvider
 */

/**
 * Restores a saved session on first load (so a page reload keeps the
 * player signed in) and exposes login, register and logout actions.
 *
 * @param {{children: import('react').ReactNode}} props
 * @returns {JSX.Element}
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!getToken()) {
      setLoading(false)
      return
    }

    apiMe()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (username, password) => {
    const data = await apiLogin(username, password)
    setToken(data.token)
    setUser(data.user)
    return data.user
  }, [])

  const register = useCallback(async (username, password, email) => {
    const data = await apiRegister(username, password, email)
    setToken(data.token)
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiLogout()
    } finally {
      clearToken()
      setUser(null)
    }
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
