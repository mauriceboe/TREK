import type { ReactNode } from 'react'
import { ConvexReactClient } from 'convex/react'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { authClient } from '../auth/client'
import { convexUrl, isConvexConfigured } from './config'

const convexClient = isConvexConfigured() ? new ConvexReactClient(convexUrl) : null

/** Exported for direct mutation calls from Zustand store slices */
export { convexClient }

interface OptionalConvexProviderProps {
  children: ReactNode
}

export function OptionalConvexProvider({ children }: OptionalConvexProviderProps) {
  if (!convexClient) return <>{children}</>
  return (
    <ConvexBetterAuthProvider client={convexClient} authClient={authClient}>
      {children}
    </ConvexBetterAuthProvider>
  )
}
