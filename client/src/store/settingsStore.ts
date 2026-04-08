import { create } from 'zustand'
import { convexClient } from '../convex/provider'
import { api } from '../../convex/_generated/api'
import type { Settings } from '../types'

interface SettingsState {
  settings: Settings
  isLoaded: boolean

  loadSettings: () => Promise<void>
  updateSetting: (key: keyof Settings, value: Settings[keyof Settings]) => Promise<void>
  setLanguageLocal: (lang: string) => void
  updateSettings: (settingsObj: Partial<Settings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: {
    map_tile_url: '',
    default_lat: 48.8566,
    default_lng: 2.3522,
    default_zoom: 10,
    dark_mode: false,
    default_currency: 'USD',
    language: localStorage.getItem('app_language') || 'en',
    temperature_unit: 'fahrenheit',
    time_format: '12h',
    show_place_description: false,
  },
  isLoaded: false,

  loadSettings: async () => {
    try {
      if (!convexClient) { set({ isLoaded: true }); return; }
      const data = await convexClient.query(api.settings.getSettings, {})
      set((state) => ({
        settings: { ...state.settings, ...data.settings },
        isLoaded: true,
      }))
    } catch {
      set({ isLoaded: true })
    }
  },

  updateSetting: async (key: keyof Settings, value: Settings[keyof Settings]) => {
    set((state) => ({
      settings: { ...state.settings, [key]: value },
    }))
    if (key === 'language') localStorage.setItem('app_language', value as string)
    if (!convexClient) return
    await convexClient.mutation(api.settings.setSetting, { key, value })
  },

  setLanguageLocal: (lang: string) => {
    localStorage.setItem('app_language', lang)
    set((state) => ({ settings: { ...state.settings, language: lang } }))
  },

  updateSettings: async (settingsObj: Partial<Settings>) => {
    set((state) => ({
      settings: { ...state.settings, ...settingsObj },
    }))
    if (!convexClient) return
    await convexClient.mutation(api.settings.setBulk, { settings: settingsObj })
  },
}))
