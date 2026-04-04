import { create } from 'zustand'
import { addonsApi } from '../api/client'

interface Addon {
  id: string
  name: string
  type: string
  icon: string
  enabled: boolean
}

interface AddonState {
  addons: Addon[]
  loaded: boolean
  loadAddons: () => Promise<void>
  isEnabled: (id: string) => boolean
}

export const useAddonStore = create<AddonState>((set, get) => ({
  addons: [],
  loaded: false,

  loadAddons: async () => {
    try {
      const data = await addonsApi.enabled()
      set({ addons: data.addons || [], loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  isEnabled: (id: string) => {
    return get().addons.some(a => a.id === id && a.enabled)
  },
}))
