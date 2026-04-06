import type { TripPhoto } from './types'

const MEMORIES_ADDON_PREFIX = '/integrations/memories'

export function buildUnifiedMemoriesUrl(tripId: number, endpoint: string, lastParam?: string): string {
  return `${MEMORIES_ADDON_PREFIX}/unified/trips/${tripId}/${endpoint}${lastParam ? `/${lastParam}` : ''}`
}

export function buildProviderMemoriesUrl(tripId: number, provider: string, endpoint: string, item?: string): string {
  let resolvedEndpoint = endpoint
  if (resolvedEndpoint === 'album-link-sync') {
    resolvedEndpoint = `trips/${tripId}/album-links/${item?.toString() || ''}/sync`
  }
  return `${MEMORIES_ADDON_PREFIX}/${provider}/${resolvedEndpoint}`
}

export function buildProviderAssetMemoriesUrl(tripId: number, photo: TripPhoto, what: string): string {
  return `${MEMORIES_ADDON_PREFIX}/${photo.provider}/assets/${tripId}/${photo.asset_id}/${photo.user_id}/${what}`
}

export function createMemoriesUrlBuilders(tripId: number) {
  return {
    buildUnifiedUrl: (endpoint: string, lastParam?: string) => buildUnifiedMemoriesUrl(tripId, endpoint, lastParam),
    buildProviderUrl: (provider: string, endpoint: string, item?: string) => buildProviderMemoriesUrl(tripId, provider, endpoint, item),
    buildProviderAssetUrl: (photo: TripPhoto, what: string) => buildProviderAssetMemoriesUrl(tripId, photo, what),
  }
}
