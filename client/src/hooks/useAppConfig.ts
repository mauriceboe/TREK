import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { convexClient } from '../convex/provider'
import type { AppConfig } from '../types'

export function useAppConfig(): AppConfig | null {
  const config = useQuery(api.users.getAppConfig)
  if (!config) return null
  return config as unknown as AppConfig
}

/**
 * Imperative fetch for app config (for use outside React components).
 * Uses the Convex client directly.
 */
export async function fetchAppConfig(): Promise<AppConfig | null> {
  if (!convexClient) return null
  try {
    const config = await convexClient.query(api.users.getAppConfig, {})
    return config as unknown as AppConfig
  } catch {
    return null
  }
}
