import { create } from 'zustand'
import { convexClient } from '../convex/provider'
import { api } from '../../convex/_generated/api'

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
      if (!convexClient) { set({ loaded: true }); return; }
      const data = await convexClient.query(api.addons.enabled, {})
      set({ addons: data.addons as Addon[] || [], loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  isEnabled: (id: string) => {
    return get().addons.some(a => a.id === id && a.enabled)
  },
}))
