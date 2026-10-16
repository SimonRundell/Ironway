import { createContext, useContext } from 'react'

/**
 * Context object and hook for the signed-in user and auth actions. Kept
 * in its own non-component module (separate from AuthProvider.jsx) so
 * Vite's Fast Refresh can treat the provider component and this hook as
 * independent boundaries.
 *
 * @module state/authContext
 */

export const AuthContext = createContext(null)

/**
 * Reads the current auth state and actions. Must be used within an
 * AuthProvider.
 *
 * @returns {{
 *   user: {id: number, username: string}|null,
 *   loading: boolean,
 *   login: (username: string, password: string) => Promise<object>,
 *   register: (username: string, password: string, email?: string) => Promise<object>,
 *   logout: () => Promise<void>,
 * }}
 */
export function useAuth() {
  const context = useContext(AuthContext)

  if (context === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }

  return context
}
