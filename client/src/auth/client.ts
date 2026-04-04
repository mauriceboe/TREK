import { createAuthClient } from 'better-auth/react'
import { usernameClient } from 'better-auth/client/plugins'
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins'

const convexSiteUrl = String(import.meta.env.VITE_CONVEX_SITE_URL || '').trim()
const COOKIE_WAIT_TIMEOUT_MS = 1500
const COOKIE_WAIT_INTERVAL_MS = 50

export const authClient = createAuthClient({
  baseURL: convexSiteUrl,
  plugins: [
    convexClient(),
    crossDomainClient({ storagePrefix: 'trek' }),
    usernameClient(),
  ],
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function getStoredBetterAuthCookie(): string | null {
  try {
    const cookie = (authClient as any).getCookie()
    return cookie && cookie.trim() ? cookie : null
  } catch {
    return null
  }
}

export async function waitForBetterAuthCookie(timeoutMs = COOKIE_WAIT_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let cookie = getStoredBetterAuthCookie()

  while (!cookie && Date.now() < deadline) {
    await sleep(COOKIE_WAIT_INTERVAL_MS)
    cookie = getStoredBetterAuthCookie()
  }

  return cookie
}
