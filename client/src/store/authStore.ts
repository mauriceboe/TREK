import { create } from 'zustand'
import type { User } from '../types'
import { getApiErrorMessage } from '../types'
import { authClient, waitForBetterAuthCookie } from '../auth/client'
import { convexClient } from '../convex/provider'
import { api } from '../../convex/_generated/api'

interface AuthResponse {
  user: User
  token: string | null
}

interface AvatarResponse {
  avatar_url: string
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  demoMode: boolean
  hasMapsKey: boolean
  appRequireMfa?: boolean
  tripRemindersEnabled: boolean
  setTripRemindersEnabled: (val: boolean) => void

  login: (email: string, password: string) => Promise<AuthResponse>
  register: (username: string, email: string, password: string) => Promise<AuthResponse>
  logout: () => void
  loadUser: (options?: { silent?: boolean }) => Promise<void>
  updateMapsKey: (key: string | null) => Promise<void>
  updateApiKeys: (keys: Record<string, string | null>) => Promise<void>
  updateProfile: (profileData: Partial<User>) => Promise<void>
  uploadAvatar: (file: File) => Promise<AvatarResponse>
  deleteAvatar: () => Promise<void>
  setDemoMode: (val: boolean) => void
  setHasMapsKey: (val: boolean) => void
  demoLogin: () => Promise<AuthResponse>
}

function getConvexClient() {
  if (!convexClient) throw new Error('Convex is not configured')
  return convexClient
}

async function ensureConvexUser(): Promise<User> {
  const client = getConvexClient()
  const user = await client.mutation(api.users.ensureUser, {})
  return user as unknown as User
}

async function fetchConvexUser(): Promise<User | null> {
  const client = getConvexClient()
  const user = await client.query(api.users.me, {})
  return user as unknown as User | null
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  demoMode: false,
  hasMapsKey: false,
  tripRemindersEnabled: false,
  setTripRemindersEnabled: (val: boolean) => set({ tripRemindersEnabled: val }),

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const signIn = await authClient.signIn.email({ email, password })
      if (signIn.error) {
        throw new Error(signIn.error.message || 'Login failed')
      }
      if (!(await waitForBetterAuthCookie())) {
        throw new Error('Login session was not established. Please try again.')
      }
      // Wait a moment for Convex auth to sync
      await new Promise((r) => setTimeout(r, 500))
      const user = await ensureConvexUser()
      set({
        user,
        token: 'convex-auth',
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      return { user, token: null }
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  register: async (username: string, email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const signUp = await authClient.signUp.email({
        email,
        password,
        name: username.trim(),
        username: username.trim(),
        displayUsername: username.trim(),
      })
      if (signUp.error) {
        throw new Error(signUp.error.message || 'Registration failed')
      }
      if (!(await waitForBetterAuthCookie())) {
        throw new Error('Registration session was not established. Please try again.')
      }
      // Wait a moment for Convex auth to sync
      await new Promise((r) => setTimeout(r, 500))
      const user = await ensureConvexUser()
      set({
        user,
        token: 'convex-auth',
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      return { user, token: null }
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Registration failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  logout: () => {
    void authClient.signOut().catch(() => {})
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
  },

  loadUser: async (_options?: { silent?: boolean }) => {
    set({ isLoading: true })
    try {
      await waitForBetterAuthCookie(500)
      // Wait a moment for Convex auth to sync
      await new Promise((r) => setTimeout(r, 300))
      const user = await ensureConvexUser()
      set({
        user,
        token: 'convex-auth',
        isAuthenticated: true,
        isLoading: false,
      })
    } catch {
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
      })
    }
  },

  updateMapsKey: async (key: string | null) => {
    try {
      const client = getConvexClient()
      const updated = await client.mutation(api.users.updateApiKeys, {
        mapsApiKey: key,
      })
      set((state) => ({
        user: state.user
          ? { ...state.user, maps_api_key: (updated as any).maps_api_key }
          : null,
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error saving API key'))
    }
  },

  updateApiKeys: async (keys: Record<string, string | null>) => {
    try {
      const client = getConvexClient()
      const updated = await client.mutation(api.users.updateApiKeys, {
        mapsApiKey: keys.maps_api_key,
        openweatherApiKey: keys.openweather_api_key,
      })
      set({ user: updated as unknown as User })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error saving API keys'))
    }
  },

  updateProfile: async (profileData: Partial<User>) => {
    try {
      const client = getConvexClient()
      const updated = await client.mutation(api.users.updateProfile, {
        username: profileData.username,
        email: profileData.email,
      })
      set({ user: updated as unknown as User })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating profile'))
    }
  },

  uploadAvatar: async (_file: File) => {
    // TODO: Implement with Convex file storage
    throw new Error('Avatar upload not yet implemented with Convex')
  },

  deleteAvatar: async () => {
    // TODO: Implement with Convex file storage
    throw new Error('Avatar deletion not yet implemented with Convex')
  },

  setDemoMode: (val: boolean) => {
    if (val) localStorage.setItem('demo_mode', 'true')
    else localStorage.removeItem('demo_mode')
    set({ demoMode: val })
  },

  setHasMapsKey: (val: boolean) => set({ hasMapsKey: val }),

  demoLogin: async () => {
    throw new Error('Demo mode not available')
  },
}))
