import { create } from 'zustand'
import { authApi } from '../api/client'
import { connect, disconnect } from '../api/websocket'
import type { User } from '../types'
import { getApiErrorMessage } from '../types'

interface AuthResponse {
  user: User
  token: string
}

export type LoginResult = AuthResponse | { mfa_required: true; mfa_token: string }

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

  login: (email: string, password: string) => Promise<LoginResult>
  completeMfaLogin: (mfaToken: string, code: string) => Promise<AuthResponse>
  register: (username: string, email: string, password: string) => Promise<AuthResponse>
  logout: () => void
  /** Pass `{ silent: true }` to refresh the user without toggling global loading (avoids unmounting protected pages). */
  loadUser: (opts?: { silent?: boolean }) => Promise<void>
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
  isAuthenticated: !!localStorage.getItem('auth_token'),
  isLoading: false,
  error: null,
  demoMode: localStorage.getItem('demo_mode') === 'true',
  hasMapsKey: false,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.login({ email, password }) as AuthResponse & { mfa_required?: boolean; mfa_token?: string }
      if (data.mfa_required && data.mfa_token) {
        set({ isLoading: false, error: null })
        return { mfa_required: true as const, mfa_token: data.mfa_token }
      }
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(data.token)
      return data as AuthResponse
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  completeMfaLogin: async (mfaToken: string, code: string) => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.verifyMfaLogin({ mfa_token: mfaToken, code: code.replace(/\s/g, '') })
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(data.token)
      return data as AuthResponse
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Verification failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  register: async (username: string, email: string, password: string, invite_token?: string) => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.register({ username, email, password, invite_token })
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(data.token)
      return data
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Registration failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  logout: () => {
    disconnect()
    localStorage.removeItem('auth_token')
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      error: null,
    })
  },

  loadUser: async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true
    const token = get().token
    if (!token) {
      if (!silent) set({ isLoading: false })
      return
    }
    if (!silent) {
      set({ isLoading: true })
    }
    try {
      const data = await authApi.me()
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
      connect(token)
    } catch {
      localStorage.removeItem('auth_token')
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
