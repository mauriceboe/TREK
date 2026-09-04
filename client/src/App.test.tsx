import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../tests/helpers/msw/server'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import { resetAllStores } from '../tests/helpers/store'
import { buildUser, buildSettings, buildTrip } from '../tests/helpers/factories'
import { offlineDb } from './db/offlineDb'
import { SETTINGS_WAIT_MS } from './utils/startDestination'
import App from './App'

// ── Mock page components ───────────────────────────────────────────────────────
vi.mock('./pages/LoginPage', () => ({ default: () => <div>Login</div> }))
vi.mock('./pages/DashboardPage', () => ({ default: () => <div>Dashboard</div> }))
vi.mock('./pages/TripPlannerPage', () => ({ default: () => <div>TripPlanner</div> }))
vi.mock('./pages/FilesPage', () => ({ default: () => <div>Files</div> }))
vi.mock('./pages/AdminPage', () => ({ default: () => <div>Admin</div> }))
vi.mock('./pages/SettingsPage', () => ({ default: () => <div>Settings</div> }))
vi.mock('./pages/VacayPage', () => ({ default: () => <div>Vacay</div> }))
vi.mock('./pages/AtlasPage', () => ({ default: () => <div>Atlas</div> }))
vi.mock('./pages/SharedTripPage', () => ({ default: () => <div>SharedTrip</div> }))
vi.mock('./pages/InAppNotificationsPage.tsx', () => ({ default: () => <div>Notifications</div> }))

// Prevent WebSocket side effects from the notification listener
vi.mock('./hooks/useInAppNotificationListener.ts', () => ({
  useInAppNotificationListener: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Reports the router's current location, so a test can assert where App sent it. */
function LocationProbe() {
  const loc = useLocation()
  return <span data-testid="loc">{loc.pathname + loc.search}</span>
}

const currentPath = () => screen.getByTestId('loc').textContent

function renderApp(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
      <LocationProbe />
    </MemoryRouter>
  )
}

/**
 * Seeds authStore with sensible defaults for a test, replacing loadUser with a
 * no-op spy so the MSW /api/auth/me response does not overwrite the seeded state.
 */
function seedAuth(overrides: Record<string, unknown> = {}) {
  useAuthStore.setState({
    isLoading: false,
    isAuthenticated: false,
    user: null,
    appRequireMfa: false,
    loadUser: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  })
}

beforeEach(() => {
  resetAllStores()
  vi.clearAllMocks()
  document.documentElement.classList.remove('dark')
})

// ── RootRedirect ───────────────────────────────────────────────────────────────

describe('RootRedirect', () => {
  it('FE-COMP-APP-001: / redirects to /login when not authenticated', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/')
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
  })

  it('FE-COMP-APP-002: / redirects to /dashboard when authenticated', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-003: / shows loading spinner while auth is loading', () => {
    seedAuth({ isLoading: true, isAuthenticated: false })
    renderApp('/')
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })
})

// ── RootRedirect — startup destination ────────────────────────────────────────

describe('RootRedirect — startup destination', () => {
  /** Serves GET /api/trips/active and reports whether it was asked at all. */
  function stubActiveTrip(trip: { id: number; title: string } | null) {
    const calls: string[] = []
    server.use(
      http.get('/api/trips/active', ({ request }) => {
        calls.push(request.url)
        return HttpResponse.json({ trip })
      }),
    )
    return calls
  }

  it('FE-COMP-APP-026: opens the active trip on the chosen tab', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip', start_trip_tab: 'finanzplan' }),
    })
    stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })

  it('FE-COMP-APP-027: falls back to the dashboard when the user has no trip', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip', start_trip_tab: 'finanzplan' }),
    })
    stubActiveTrip(null)

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-028: falls back to the dashboard when the lookup fails', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip' }),
    })
    server.use(http.get('/api/trips/active', () => HttpResponse.error()))

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-028b: opens the cached active trip when the launch is offline', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip' }),
    })
    const today = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    await offlineDb.trips.put(buildTrip({ id: 42, title: 'Japan', start_date: iso(today), end_date: iso(today) }))
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    // navigator and the Dexie table are shared with every other test in the
    // file, so a failed assertion must not leave the rest of them offline.
    try {
      renderApp('/')
      await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
    } finally {
      if (onLine) Object.defineProperty(Navigator.prototype, 'onLine', onLine)
      delete (navigator as unknown as { onLine?: boolean }).onLine
      await offlineDb.trips.clear()
    }
  })

  // The whole point of the localStorage mirror: the default launch must not pay
  // for a lookup it doesn't need.
  it('FE-COMP-APP-029: never asks for the active trip when starting on the dashboard', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ isLoaded: true, settings: buildSettings({ start_page: 'dashboard' }) })
    const calls = stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
    expect(calls).toHaveLength(0)
  })

  it('FE-COMP-APP-030: reads the preference from localStorage before settings have loaded', async () => {
    localStorage.setItem('trek_start_page', 'active_trip')
    localStorage.setItem('trek_start_trip_tab', 'finanzplan')
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ isLoaded: false })
    stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })
})

// ── ProtectedRoute — unauthenticated ──────────────────────────────────────────

describe('ProtectedRoute — unauthenticated', () => {
  it('FE-COMP-APP-004: /dashboard redirects to /login with redirect param when not authenticated', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
  })

  // A session that ran out should return you to the page you were on. Pressing
  // "log out" should not: clearing isAuthenticated re-renders this route for the
  // page still on screen, and the ?redirect= it stamped there beat the user's
  // startup destination on every login after the first.
  it('FE-COMP-APP-034: keeps the return ticket when the session merely ended', async () => {
    seedAuth({ isAuthenticated: false, loggingOut: false })
    renderApp('/trips/1/files')
    await waitFor(() => expect(currentPath()).toBe('/login?redirect=%2Ftrips%2F1%2Ffiles'))
  })

  it('FE-COMP-APP-035: drops it on a deliberate sign-out, so the startup destination decides', async () => {
    seedAuth({ isAuthenticated: false, loggingOut: true })
    renderApp('/dashboard')
    await waitFor(() => expect(currentPath()).toBe('/login'))
  })

  it('FE-COMP-APP-005: /trips/42 redirects to /login when not authenticated', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/trips/42')
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
  })
})

// ── ProtectedRoute — loading ───────────────────────────────────────────────────

describe('ProtectedRoute — loading state', () => {
  it('FE-COMP-APP-006: protected route shows loading spinner while isLoading is true', () => {
    seedAuth({ isLoading: true, isAuthenticated: false })
    renderApp('/dashboard')
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
  })
})

// ── ProtectedRoute — MFA enforcement ──────────────────────────────────────────

describe('ProtectedRoute — MFA enforcement', () => {
  it('FE-COMP-APP-007: redirects to /settings?mfa=required when appRequireMfa is true and MFA is disabled', async () => {
    seedAuth({
      isAuthenticated: true,
      appRequireMfa: true,
      user: buildUser({ mfa_enabled: false }),
    })
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument())
  })

  it('FE-COMP-APP-008: does NOT redirect when already on /settings even with MFA required', async () => {
    seedAuth({
      isAuthenticated: true,
      appRequireMfa: true,
      user: buildUser({ mfa_enabled: false }),
    })
    renderApp('/settings')
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument())
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it('FE-COMP-APP-009: does NOT redirect when user has MFA enabled', async () => {
    seedAuth({
      isAuthenticated: true,
      appRequireMfa: true,
      user: buildUser({ mfa_enabled: true }),
    })
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })
})

// ── ProtectedRoute — admin role ────────────────────────────────────────────────

describe('ProtectedRoute — admin role check', () => {
  it('FE-COMP-APP-010: /admin redirects to /dashboard for non-admin user', async () => {
    seedAuth({
      isAuthenticated: true,
      user: buildUser({ role: 'user' }),
    })
    renderApp('/admin')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('FE-COMP-APP-011: /admin is accessible for admin user', async () => {
    seedAuth({
      isAuthenticated: true,
      user: buildUser({ role: 'admin' }),
    })
    renderApp('/admin')
    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument())
  })
})

// ── Public routes ──────────────────────────────────────────────────────────────

describe('Public routes', () => {
  // Synchronous on purpose: LoginPage is the one page still statically imported,
  // so this also holds the line against someone making it lazy later.
  it('FE-COMP-APP-012: /login is accessible without authentication', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/login')
    expect(screen.getByText('Login')).toBeInTheDocument()
  })

  it('FE-COMP-APP-013: /shared/:token is accessible without authentication', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/shared/sometoken')
    expect(await screen.findByText('SharedTrip')).toBeInTheDocument()
  })

  it('FE-COMP-APP-014: unknown routes redirect to / which then redirects to /login', async () => {
    seedAuth({ isAuthenticated: false })
    renderApp('/does-not-exist')
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
  })
})

// ── PublicRoute — redirect already-authenticated visitors ─────────────────────

describe('PublicRoute — already authenticated', () => {
  /**
   * The bounce goes to START_DESTINATION_ROUTE, so RootRedirect resolves where
   * it actually lands — which needs settings, exactly like the cases above.
   */
  function seedAuthedOnDashboard() {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'dashboard' }),
    })
  }

  it('FE-COMP-APP-012a: /login sends an authenticated visitor to the start destination', async () => {
    seedAuthedOnDashboard()
    renderApp('/login')
    await waitFor(() => expect(currentPath()).toBe('/dashboard'))
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it('FE-COMP-APP-012b: /register does the same', async () => {
    seedAuthedOnDashboard()
    renderApp('/register')
    await waitFor(() => expect(currentPath()).toBe('/dashboard'))
    expect(screen.queryByText('Login')).not.toBeInTheDocument()
  })

  it('FE-COMP-APP-012c: /login with a ?redirect= target is left to useLogin (OAuth consent handoff), not bounced', async () => {
    // The consent page parks its URL in ?redirect= when it needs a login; that
    // flow must reach the form even for an authenticated visitor, so the guard
    // stays out of the way whenever a redirect target is present.
    seedAuthedOnDashboard()
    const target = '/login?redirect=' + encodeURIComponent('/oauth/consent?client_id=x')
    renderApp(target)
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
    expect(currentPath()).toBe(target)
  })

  it('FE-COMP-APP-012d: /register?invite= reaches the form so the token can be validated', async () => {
    // An invite link is the one way someone joins a trip they were invited to
    // from an account they are already signed into; bouncing it would swallow
    // the token silently.
    seedAuthedOnDashboard()
    renderApp('/register?invite=abc123')
    await waitFor(() => expect(screen.getByText('Login')).toBeInTheDocument())
    expect(currentPath()).toBe('/register?invite=abc123')
  })
})

// ── App — on-mount effects ─────────────────────────────────────────────────────

describe('App — on-mount effects', () => {
  it('FE-COMP-APP-015: loadUser is called on mount for non-shared paths', async () => {
    const loadUser = vi.fn().mockResolvedValue(undefined)
    useAuthStore.setState({ isLoading: false, isAuthenticated: false, loadUser })
    renderApp('/dashboard')
    expect(loadUser).toHaveBeenCalled()
  })

  it('FE-COMP-APP-016: loadUser is NOT called on /shared/ paths', async () => {
    const loadUser = vi.fn().mockResolvedValue(undefined)
    useAuthStore.setState({ isLoading: false, isAuthenticated: false, loadUser })
    renderApp('/shared/token123')
    expect(loadUser).not.toHaveBeenCalled()
  })

  it('FE-COMP-APP-017: GET /api/auth/app-config is called on mount', async () => {
    let configCalled = false
    server.use(
      http.get('/api/auth/app-config', () => {
        configCalled = true
        return HttpResponse.json({})
      })
    )
    seedAuth()
    renderApp('/')
    await waitFor(() => expect(configCalled).toBe(true))
  })

  it('FE-COMP-APP-018: setDemoMode(true) is called when config returns demo_mode: true', async () => {
    server.use(
      http.get('/api/auth/app-config', () => HttpResponse.json({ demo_mode: true }))
    )
    const setDemoMode = vi.fn()
    useAuthStore.setState({
      isLoading: false,
      isAuthenticated: false,
      loadUser: vi.fn().mockResolvedValue(undefined),
      setDemoMode,
    })
    renderApp('/')
    await waitFor(() => expect(setDemoMode).toHaveBeenCalledWith(true))
  })

  it('FE-COMP-APP-018b: setManaged mirrors the config flag, and defaults to false when it is absent', async () => {
    server.use(
      http.get('/api/auth/app-config', () => HttpResponse.json({ managed: true }))
    )
    const setManaged = vi.fn()
    useAuthStore.setState({
      isLoading: false,
      isAuthenticated: false,
      loadUser: vi.fn().mockResolvedValue(undefined),
      setManaged,
    })
    renderApp('/')
    await waitFor(() => expect(setManaged).toHaveBeenCalledWith(true))

    // An older server that does not send the field must not leave the flag
    // stuck on from a previous install in the same browser profile.
    setManaged.mockClear()
    server.use(
      http.get('/api/auth/app-config', () => HttpResponse.json({}))
    )
    renderApp('/')
    await waitFor(() => expect(setManaged).toHaveBeenCalledWith(false))
  })

  it('FE-COMP-APP-019: loadSettings is called once the user is authenticated', async () => {
    const loadSettings = vi.fn().mockResolvedValue(undefined)
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ loadSettings })
    renderApp('/dashboard')
    await waitFor(() => expect(loadSettings).toHaveBeenCalled())
  })
})

// ── Dark mode effects ──────────────────────────────────────────────────────────

describe('Dark mode effects', () => {
  it('FE-COMP-APP-020: adds dark class to documentElement when dark_mode is true', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: true }) })
    renderApp('/dashboard')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    )
  })

  it('FE-COMP-APP-021: removes dark class when dark_mode is false', async () => {
    document.documentElement.classList.add('dark')
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: false }) })
    renderApp('/dashboard')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    )
  })

  it('FE-COMP-APP-022: forces light mode on /shared/ path even when dark_mode is true', async () => {
    document.documentElement.classList.add('dark')
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: true }) })
    seedAuth({ isAuthenticated: false, loadUser: vi.fn().mockResolvedValue(undefined) })
    renderApp('/shared/tok')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    )
  })

  it('FE-COMP-APP-023: auto mode applies dark based on matchMedia result', async () => {
    // matchMedia stub returns matches: false by default (from setup.ts)
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: 'auto' as any }) })
    renderApp('/dashboard')
    // With matches: false, dark should NOT be added
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    )
  })
})

// ── Version cache-busting ──────────────────────────────────────────────────────

describe('Version cache-busting', () => {
  it('FE-COMP-APP-024: stores version in localStorage when config returns a version', async () => {
    server.use(
      http.get('/api/auth/app-config', () =>
        HttpResponse.json({ version: '2.9.10' })
      )
    )
    seedAuth()
    renderApp('/')
    await waitFor(() =>
      expect(localStorage.getItem('trek_app_version')).toBe('2.9.10')
    )
  })

  it('FE-COMP-APP-025: calls window.location.reload() when version changes', async () => {
    localStorage.setItem('trek_app_version', '2.9.9')
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, reload },
    })

    server.use(
      http.get('/api/auth/app-config', () =>
        HttpResponse.json({ version: '2.9.10' })
      )
    )
    seedAuth()
    renderApp('/')
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('FE-COMP-APP-026: a version bump never deletes the caches or unregisters the worker (#2228)', async () => {
    // The old handler wiped every Cache Storage bucket and every registration
    // here, which left the device with no app shell until a fresh ~22 MB
    // precache finished: anyone who closed the app or lost signal inside that
    // window could no longer start the PWA offline at all, and it also threw
    // away the map tiles and documents the user had downloaded on purpose.
    localStorage.setItem('trek_app_version', '2.9.9')
    const cachesDelete = vi.fn().mockResolvedValue(true)
    const unregister = vi.fn().mockResolvedValue(true)
    const update = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['workbox-precache-v2', 'map-tiles']), delete: cachesDelete })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({ update, unregister }),
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
        addEventListener: vi.fn(),
      },
    })

    server.use(
      http.get('/api/auth/app-config', () =>
        HttpResponse.json({ version: '2.9.10' })
      )
    )
    seedAuth()
    renderApp('/')

    // It asks the worker to fetch the new build; Workbox swaps the precache
    // atomically once that install completes.
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(cachesDelete).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('FE-COMP-APP-028: a version that does not look like a release tag is ignored', async () => {
    // The value arrives over the wire and is written to this device's storage,
    // so it is validated rather than trusted. An unusable one must also not be
    // compared against the stored marker, or every launch would see a mismatch
    // and try to update.
    localStorage.setItem('trek_app_version', '2.9.9')
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { writable: true, value: { ...window.location, reload } })

    server.use(
      http.get('/api/auth/app-config', () =>
        HttpResponse.json({ version: '<script>alert(1)</script>', managed: false })
      )
    )
    seedAuth()
    renderApp('/')

    await waitFor(() => expect(screen.queryByText('common.loading')).not.toBeInTheDocument())
    expect(localStorage.getItem('trek_app_version')).toBe('2.9.9')
    expect(reload).not.toHaveBeenCalled()
  })

  it('FE-COMP-APP-027: the version marker is written even if the update path throws (#2228)', async () => {
    // The marker used to be written after the purge and outside its try, so a
    // throwing step left it unwritten and the whole destructive path repeated on
    // every launch, for good.
    localStorage.setItem('trek_app_version', '2.9.9')
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockRejectedValue(new Error('no worker')), addEventListener: vi.fn() },
    })

    server.use(
      http.get('/api/auth/app-config', () =>
        HttpResponse.json({ version: '2.9.10' })
      )
    )
    seedAuth()
    renderApp('/')
    await waitFor(() => expect(localStorage.getItem('trek_app_version')).toBe('2.9.10'))
  })
})

// Regression: a device that has never mirrored the preference must not treat
// "nothing mirrored" as "user wants the dashboard".
describe('RootRedirect — preference not mirrored on this device', () => {
  it('FE-COMP-APP-031: honours the server setting when localStorage is empty', async () => {
    seedAuth({ isAuthenticated: true, user: buildUser() })
    // Cold start: settings are still in flight when RootRedirect first runs.
    useSettingsStore.setState({ isLoaded: false })
    server.use(http.get('/api/trips/active', () => HttpResponse.json({ trip: { id: 42, title: 'Japan' } })))

    renderApp('/')

    // ...and land a moment later, exactly as loadSettings() does.
    await act(async () => {
      useSettingsStore.setState({
        isLoaded: true,
        settings: buildSettings({ start_page: 'active_trip', start_trip_tab: 'finanzplan' }),
      })
    })

    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })

  // Waiting for someone else's effect to fetch the settings made the decision
  // ride on where that request landed in the queue — behind ~380 others on a
  // cold start, which is how the redirect silently lost the race and fell
  // through to the dashboard. It now asks for them itself.
  it('FE-COMP-APP-033: asks for the settings itself instead of waiting to be told', async () => {
    const loadSettings = vi.fn().mockResolvedValue(undefined)
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ isLoaded: false, loadSettings })

    renderApp('/')

    await waitFor(() => expect(loadSettings).toHaveBeenCalled())
  })

  // loadSettings leaves isLoaded false on a failed request so it can retry, so
  // the wait above needs a floor or a launch with no backend never resolves.
  it('FE-COMP-APP-032: gives up on the settings after the timeout and opens the dashboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    seedAuth({ isAuthenticated: true, user: buildUser() })
    useSettingsStore.setState({ isLoaded: false })

    renderApp('/')
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(SETTINGS_WAIT_MS + 100) })

    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
    vi.useRealTimers()
  })
})
