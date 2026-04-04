import { create } from 'zustand'
import { authApi, clearSessionCaches } from '../api/client'
import { connect, disconnect } from '../api/websocket'
import type { User } from '../types'
import { getApiErrorMessage } from '../types'
import { authClient, waitForBetterAuthCookie } from '../auth/client'

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

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('auth_token') || null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  demoMode: localStorage.getItem('demo_mode') === 'true',
  hasMapsKey: false,
  tripRemindersEnabled: false,
  setTripRemindersEnabled: (val: boolean) => set({ tripRemindersEnabled: val }),

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      localStorage.removeItem('auth_token')
      const signIn = await authClient.signIn.email({
        email,
        password,
      })
      if (signIn.error) {
        const bridge = await authApi.bridgeLegacyLogin({ email, password }).catch(() => null)
        if (!bridge?.migrated) {
          throw new Error(signIn.error.message || 'Login failed')
        }
        const retry = await authClient.signIn.email({
          email,
          password,
        })
        if (retry.error) {
          throw new Error(retry.error.message || 'Login failed')
        }
      }
      if (!(await waitForBetterAuthCookie())) {
        throw new Error('Login session was not established. Please try again.')
      }
      const data = await authApi.me()
      const token = await authApi.getConvexToken().then((result: { token?: string | null }) => result.token || null).catch(() => localStorage.getItem('auth_token'))
      set({
        user: data.user,
        token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(token)
      return { user: data.user, token }
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  register: async (username: string, email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      localStorage.removeItem('auth_token')
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
      let data: { user: User }
      try {
        data = await authApi.me()
      } catch {
        const signIn = await authClient.signIn.email({
          email,
          password,
        })
        if (signIn.error) {
          throw new Error(signIn.error.message || 'Registration failed')
        }
        if (!(await waitForBetterAuthCookie())) {
          throw new Error('Registration session was not established. Please try again.')
        }
        data = await authApi.me()
      }
      const token = await authApi.getConvexToken().then((result: { token?: string | null }) => result.token || null).catch(() => localStorage.getItem('auth_token'))
      set({
        user: data.user,
        token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(token)
      return { user: data.user, token }
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Registration failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  logout: () => {
    void authClient.signOut().catch(() => {})
    void authApi.logout().catch(() => {})
    disconnect()
    localStorage.removeItem('auth_token')
    void clearSessionCaches().catch(() => {})
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
      if (!localStorage.getItem('auth_token')) {
        await waitForBetterAuthCookie(500)
      }
      const data = await authApi.me()
      const token = await authApi.getConvexToken().then((result: { token?: string | null }) => result.token || null).catch(() => localStorage.getItem('auth_token'))
      set({
        user: data.user,
        token,
        isAuthenticated: true,
        isLoading: false,
      })
      connect(token)
    } catch (err: unknown) {
      localStorage.removeItem('auth_token')
      void clearSessionCaches().catch(() => {})
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
      await authApi.updateMapsKey(key)
      set((state) => ({
        user: state.user ? { ...state.user, maps_api_key: key || null } : null,
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error saving API key'))
    }
  },

  updateApiKeys: async (keys: Record<string, string | null>) => {
    try {
      const data = await authApi.updateApiKeys(keys)
      set({ user: data.user })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error saving API keys'))
    }
  },

  updateProfile: async (profileData: Partial<User>) => {
    try {
      const data = await authApi.updateSettings(profileData)
      set({ user: data.user })
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating profile'))
    }
  },

  uploadAvatar: async (file: File) => {
    const formData = new FormData()
    formData.append('avatar', file)
    const data = await authApi.uploadAvatar(formData)
    set((state) => ({ user: state.user ? { ...state.user, avatar_url: data.avatar_url } : null }))
    return data
  },

  deleteAvatar: async () => {
    await authApi.deleteAvatar()
    set((state) => ({ user: state.user ? { ...state.user, avatar_url: null } : null }))
  },

  setDemoMode: (val: boolean) => {
    if (val) localStorage.setItem('demo_mode', 'true')
    else localStorage.removeItem('demo_mode')
    set({ demoMode: val })
  },

  setHasMapsKey: (val: boolean) => set({ hasMapsKey: val }),

  demoLogin: async () => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.demoLogin()
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        demoMode: true,
        error: null,
      })
      connect(data.token)
      return data
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Demo login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },
}))
