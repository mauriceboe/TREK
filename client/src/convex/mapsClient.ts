/**
 * Client-side wrapper for Convex maps and weather actions.
 * Drop-in replacement for the Express mapsApi/weatherApi.
 */
import { convexClient } from './provider'
import { api } from '../../convex/_generated/api'

function getClient() {
  if (!convexClient) throw new Error('Convex is not configured')
  return convexClient
}

export const convexMapsApi = {
  autocomplete: async (query: string, lang?: string, sessionToken?: string, options?: Record<string, unknown>) => {
    return getClient().action(api.maps.autocomplete, {
      query, lang, sessionToken, mode: (options as any)?.mode,
    })
  },

  search: async (query: string, lang?: string) => {
    return getClient().action(api.maps.search, { query, lang })
  },

  details: async (placeId: string, lang?: string, sessionToken?: string) => {
    return getClient().action(api.maps.details, { placeId, lang, sessionToken })
  },

  placePhoto: async (placeId: string, lat?: number, lng?: number, name?: string) => {
    return getClient().action(api.maps.placePhoto, { placeId, lat, lng, name })
  },

  reverse: async (lat: number, lng: number, lang?: string) => {
    return getClient().action(api.maps.reverse, { lat, lng, lang })
  },
}

export const convexWeatherApi = {
  get: async (lat: number, lng: number, date: string) => {
    return getClient().action(api.weather.get, { lat, lng, date })
  },

  getDetailed: async (lat: number, lng: number, date: string, lang?: string) => {
    return getClient().action(api.weather.getDetailed, { lat, lng, date, lang })
  },
}
