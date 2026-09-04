import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { authApi } from '../api/client'
import { connect, disconnect } from '../api/websocket'
import type { User } from '../types'
import { getApiErrorMessage } from '../types'
import { tripSyncManager } from '../sync/tripSyncManager'
import { reopenForUser, deleteCurrentUserDb } from '../db/offlineDb'
import { setAuthed } from '../sync/authGate'
import { registerSyncTriggers, unregisterSyncTriggers } from '../sync/syncTriggers'
import { useSystemNoticeStore } from './systemNoticeStore.js'
import { clearAppearanceSnapshot } from '../theme/applyAppearance'
import { clearAllPluginSessions } from './pluginStore'
import { forgetStartDestination } from '../utils/startDestination'
import { forgetServerLanguage } from './settingsStore'
import { markSignedOut, clearSignedOut } from '../utils/signedOut'

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
  isAuthenticated: boolean
  isLoading: boolean
  /** The auth check (loadUser) failed for a non-401 reason while we were online —
   *  the server was unreachable or erroring. Surfaced by the UI so a backend/IdP
   *  outage doesn't render as a blank, error-free page that looks like lost data.
   *  Transient, never persisted. #1283 */
  authCheckFailed: boolean
  /** The user pressed "log out" — as opposed to a session that simply ended.
   *  Read by ProtectedRoute: a deliberate sign-out should not leave a
   *  ?redirect= pointing back at the page they just left. Transient. */
  loggingOut: boolean
  error: string | null
  /** The operator of this install owns its configuration, not the admin. */
  managed: boolean
  demoMode: boolean
  devMode: boolean
  isPrerelease: boolean
  appVersion: string
  hasMapsKey: boolean
  serverTimezone: string
  /** Server policy: all users must enable MFA */
  appRequireMfa: boolean
  tripRemindersEnabled: boolean
  placesPhotosEnabled: boolean
  placesAutocompleteEnabled: boolean
  placesDetailsEnabled: boolean
  placesEnrichEnabled: boolean

  login: (email: string, password: string, rememberMe?: boolean) => Promise<LoginResult>
  completeMfaLogin: (mfaToken: string, code: string, rememberMe?: boolean) => Promise<AuthResponse>
  register: (username: string, email: string, password: string, invite_token?: string) => Promise<AuthResponse>
  logout: () => Promise<void>
  /** Pass `{ silent: true }` to refresh the user without toggling global isLoading (avoids unmounting protected routes). */
  loadUser: (opts?: { silent?: boolean }) => Promise<void>
  updateMapsKey: (key: string | null) => Promise<void>
  updateApiKeys: (keys: Record<string, string | null>) => Promise<void>
  updateProfile: (profileData: Partial<User>) => Promise<void>
  uploadAvatar: (file: File) => Promise<AvatarResponse>
  deleteAvatar: () => Promise<void>
  setManaged: (val: boolean) => void
  setDemoMode: (val: boolean) => void
  setDevMode: (val: boolean) => void
  setIsPrerelease: (val: boolean) => void
  setAppVersion: (val: string) => void
  setHasMapsKey: (val: boolean) => void
  setServerTimezone: (tz: string) => void
  setAppRequireMfa: (val: boolean) => void
  setTripRemindersEnabled: (val: boolean) => void
  setPlacesPhotosEnabled: (val: boolean) => void
  setPlacesAutocompleteEnabled: (val: boolean) => void
  setPlacesDetailsEnabled: (val: boolean) => void
  setPlacesEnrichEnabled: (val: boolean) => void
  demoLogin: () => Promise<AuthResponse>
}

// Sequence counter to prevent stale loadUser responses from overwriting fresh auth state
let authSequence = 0

/**
 * Mark the session authenticated and point the offline DB at this user's scoped
 * database before any background sync runs, so cached data never crosses users.
 */
async function onAuthSuccess(userId: number): Promise<void> {
  setAuthed(true)
  // Whatever brought them back in - password, SSO, MFA, demo, a restored
  // session - the tab is no longer "just signed out", so the login page may
  // auto-SSO again next time.
  clearSignedOut()
  try {
    await reopenForUser(userId)
  } catch (err) {
    console.error('[auth] failed to open user-scoped offline DB', err)
  }
  // logout() tears the triggers down, and App's mount effect never runs again in
  // an SPA session, so a second login in the same tab would leave the mutation
  // queue without a flush trigger. Re-registering is a no-op while they are up.
  registerSyncTriggers()
}

export const useAuthStore = create<AuthState>()(
  persist(
  (set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  authCheckFailed: false,
  loggingOut: false,
  error: null,
  managed: false,
  demoMode: localStorage.getItem('demo_mode') === 'true',
  devMode: false,
  isPrerelease: false,
  appVersion: '',
  hasMapsKey: false,
  serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  appRequireMfa: false,
  tripRemindersEnabled: false,
  placesPhotosEnabled: true,
  placesAutocompleteEnabled: true,
  placesDetailsEnabled: true,
  placesEnrichEnabled: true,

  login: async (email: string, password: string, rememberMe?: boolean) => {
    authSequence++
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.login({ email, password, remember_me: rememberMe }) as AuthResponse & { mfa_required?: boolean; mfa_token?: string }
      if (data.mfa_required && data.mfa_token) {
        set({ isLoading: false, error: null })
        return { mfa_required: true as const, mfa_token: data.mfa_token }
      }
      set({
        user: data.user,
        isAuthenticated: true,
        loggingOut: false,
        isLoading: false,
        error: null,
      })
      await onAuthSuccess(data.user.id)
      connect()
      tripSyncManager.syncAll().catch(console.error)
      if (!data.user?.must_change_password) {
        useSystemNoticeStore.getState().fetch()
      }
      return data as AuthResponse
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  completeMfaLogin: async (mfaToken: string, code: string, rememberMe?: boolean) => {
    authSequence++
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.verifyMfaLogin({ mfa_token: mfaToken, code: code.replace(/\s/g, ''), remember_me: rememberMe })
      set({
        user: data.user,
        isAuthenticated: true,
        loggingOut: false,
        isLoading: false,
        error: null,
      })
      await onAuthSuccess(data.user.id)
      connect()
      tripSyncManager.syncAll().catch(console.error)
      if (!data.user?.must_change_password) {
        useSystemNoticeStore.getState().fetch()
      }
      return data as AuthResponse
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Verification failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  register: async (username: string, email: string, password: string, invite_token?: string) => {
    authSequence++
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.register({ username, email, password, invite_token })
      set({
        user: data.user,
        isAuthenticated: true,
        loggingOut: false,
        isLoading: false,
        error: null,
      })
      await onAuthSuccess(data.user.id)
      connect()
      tripSyncManager.syncAll().catch(console.error)
      useSystemNoticeStore.getState().fetch()
      return data
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Registration failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  logout: async () => {
    // 1. Gate first so any in-flight flush/syncAll bails before we wipe the DB.
    setAuthed(false)
    // Flagged in the same update that drops the session: clearing isAuthenticated
    // re-renders ProtectedRoute for whatever page is still on screen, and without
    // this it would stamp a ?redirect= back to it — which then beats the user's
    // startup destination on the next login.
    set({ isAuthenticated: false, loggingOut: true })
    // The same fact, in the one place that survives ProtectedRoute's stateless
    // <Navigate replace> and a full document load — without it an OIDC-only
    // install silently signs the user straight back in (#2123). Set here rather
    // than at the call sites so all seven are covered at once.
    markSignedOut()
    // 2. Stop background sync triggers (30s interval, WS pre-reconnect hook, listeners).
    unregisterSyncTriggers()
    // 3. Tear down the live connection.
    disconnect()
    useSystemNoticeStore.getState().reset()
    // Drop the per-device appearance snapshot so the next user on a shared
    // browser doesn't get a pre-paint flash of this user's theme.
    clearAppearanceSnapshot()
    // Same reason for the brokered plugin session state: it is keyed by user id,
    // but sessionStorage outlives a logout within the tab.
    clearAllPluginSessions()
    // And the startup-destination mirror, or the next account on this browser
    // gets bounced into a trip it may not even be able to see.
    forgetStartDestination()
    // Likewise the language mirror: the login page only overrides it when the
    // browser language is one TREK ships, so otherwise the next user here stays
    // in the previous account's language, launch after launch.
    forgetServerLanguage()
    // 4. Tell server to clear the httpOnly cookie (best-effort).
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
    // 5. Clear service worker caches containing sensitive data.
    if ('caches' in window) {
      await Promise.all([
        caches.delete('api-data').catch(() => {}),
        caches.delete('user-uploads').catch(() => {}),
      ])
    }
    // 6. Delete this user's scoped IndexedDB and return to the anonymous DB.
    await deleteCurrentUserDb().catch(console.error)
    // 7. Finish clearing auth state.
    set({
      user: null,
      isAuthenticated: false,
      authCheckFailed: false,
      error: null,
    })
  },

  loadUser: async (opts?: { silent?: boolean }) => {
    const seq = authSequence
    const silent = !!opts?.silent
    if (!silent) set({ isLoading: true })
    try {
      const data = await authApi.me()
      if (seq !== authSequence) return // stale response — a login/register happened meanwhile
      set({
        user: data.user,
        isAuthenticated: true,
        loggingOut: false,
        isLoading: false,
        authCheckFailed: false,
      })
      await onAuthSuccess(data.user.id)
      connect()
    } catch (err: unknown) {
      if (seq !== authSequence) return // stale response — ignore
      const status = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { status?: number } }).response?.status
        : undefined
      if (status === 401) {
        // Invalid/expired token — clear auth so the guard redirects to login.
        set({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          authCheckFailed: false,
        })
      } else if (status === undefined && typeof navigator !== 'undefined' && !navigator.onLine) {
        // Genuinely offline — keep the persisted session so the PWA serves cached
        // data without a scary error. This is the offline-first happy path.
        set({ isLoading: false })
        // ...but the session still has to be marked live. onAuthSuccess is the
        // only caller of setAuthed(true), and every repair path (the mutation
        // queue's flush, syncAll, prepareForOffline) is gated on it. Skipping
        // it here left a session that launched without network unable to sync
        // for the rest of its life, even after the signal came back: the offline
        // settings buttons spun and returned instantly having done nothing, and
        // queued edits never uploaded (#2228). It also points the offline DB at
        // this user's scoped database, so cached data is read from the right
        // one rather than the anonymous fallback.
        const cachedUser = get().user
        if (cachedUser && get().isAuthenticated) await onAuthSuccess(cachedUser.id)
      } else {
        // Server erroring (5xx) or unreachable while we're online: keep the session
        // (don't eject the user over a transient outage), but flag it so the UI can
        // say "couldn't reach the server" instead of showing a blank, error-free
        // page that looks like the user's trips were lost. #1283
        set({ isLoading: false, authCheckFailed: true })
        // Same reasoning as the offline branch: the session is kept, so it must
        // be marked live or the sync layer stays dead until the next full login.
        const cachedUser = get().user
        if (cachedUser && get().isAuthenticated) await onAuthSuccess(cachedUser.id)
      }
    }
  },

  updateMapsKey: async (key: string | null) => {
    try {
      await authApi.updateMapsKey(key)
      set((state) => ({
        user: state.user ? { ...state.user, maps_api_key: key || null } : null,
        hasMapsKey: !!key,
      }))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error saving API key'))
    }
  },

  updateApiKeys: async (keys: Record<string, string | null>) => {
    try {
      const data = await authApi.updateApiKeys(keys)
      set({ user: data.user })
      if ('maps_api_key' in keys) {
        set({ hasMapsKey: !!keys.maps_api_key })
      }
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

  // Not persisted, unlike demoMode above: two installs can share a browser
  // profile, and a stale 'this one is managed' would then take settings away
  // from an admin on an install that never set the flag. Re-read on every boot
  // from app-config, which is one request the app makes anyway.
  setManaged: (val: boolean) => set({ managed: val }),

  setDemoMode: (val: boolean) => {
    if (val) localStorage.setItem('demo_mode', 'true')
    else localStorage.removeItem('demo_mode')
    set({ demoMode: val })
  },

  setDevMode: (val: boolean) => set({ devMode: val }),
  setIsPrerelease: (val: boolean) => set({ isPrerelease: val }),
  setAppVersion: (val: string) => set({ appVersion: val }),
  setHasMapsKey: (val: boolean) => set({ hasMapsKey: val }),
  setServerTimezone: (tz: string) => set({ serverTimezone: tz }),
  setAppRequireMfa: (val: boolean) => set({ appRequireMfa: val }),
  setTripRemindersEnabled: (val: boolean) => set({ tripRemindersEnabled: val }),
  setPlacesPhotosEnabled: (val: boolean) => set({ placesPhotosEnabled: val }),
  setPlacesAutocompleteEnabled: (val: boolean) => set({ placesAutocompleteEnabled: val }),
  setPlacesDetailsEnabled: (val: boolean) => set({ placesDetailsEnabled: val }),
  setPlacesEnrichEnabled: (val: boolean) => set({ placesEnrichEnabled: val }),

  demoLogin: async () => {
    authSequence++
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.demoLogin()
      set({
        user: data.user,
        isAuthenticated: true,
        loggingOut: false,
        isLoading: false,
        demoMode: true,
        error: null,
      })
      await onAuthSuccess(data.user.id)
      connect()
      return data
    } catch (err: unknown) {
      const error = getApiErrorMessage(err, 'Demo login failed')
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },
  }),
  {
    name: 'trek_auth_snapshot',
    // Only persist the minimal user snapshot needed to avoid redirecting to
    // login when the PWA reopens offline. The JWT remains in the httpOnly
    // cookie and is still validated by the server on every request.
    // maps_api_key is intentionally excluded — it's an API key that should
    // not sit in localStorage any longer than the active session requires.
    partialize: (state) => ({
      isAuthenticated: state.isAuthenticated,
      user: state.user ? {
        id: state.user.id,
        username: state.user.username,
        email: state.user.email,
        role: state.user.role,
        avatar_url: state.user.avatar_url,
        mfa_enabled: state.user.mfa_enabled,
        must_change_password: state.user.must_change_password,
      } : null,
    }),
  }
))
