import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react'
import { useAuthStore } from '../store/authStore'
import { authClient } from '../auth/client'
import { convexUrl, isConvexConfigured } from './config'

const convexClient = isConvexConfigured() ? new ConvexReactClient(convexUrl) : null

/** Exported for direct mutation calls from Zustand store slices */
export { convexClient }

function useTrekConvexAuth() {
  const isLoading = useAuthStore((state) => state.isLoading)
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)

  const fetchAccessToken = useCallback(async () => {
    if (!useAuthStore.getState().isAuthenticated) return null
    const betterAuthCookie = (authClient as any).getCookie()
    const response = await fetch('/api/auth/convex/token', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(betterAuthCookie ? { 'Better-Auth-Cookie': betterAuthCookie } : {}),
      },
    })

    if (response.status === 401) return null
    if (!response.ok) {
      throw new Error('Failed to fetch Convex token')
    }

    const data = await response.json()
    return data?.token || null
  }, [])

  return useMemo(() => ({
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  }), [fetchAccessToken, isAuthenticated, isLoading])
}

interface OptionalConvexProviderProps {
  children: ReactNode
}

export function OptionalConvexProvider({ children }: OptionalConvexProviderProps) {
  if (!convexClient) return <>{children}</>
  return (
    <ConvexProviderWithAuth client={convexClient} useAuth={useTrekConvexAuth}>
      {children}
    </ConvexProviderWithAuth>
  )
}
