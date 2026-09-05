import React, { useEffect, useState, useRef, ReactNode, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import { applyAppearance } from './theme/applyAppearance'
import { useAddonStore } from './store/addonStore'
import { usePluginStore } from './store/pluginStore'
// The one page that stays in the entry chunk. Anyone logged out lands here, and
// every other route redirects here first — a chunk round trip in front of the login
// form would slow down the single screen that has to be there immediately.
import LoginPage from './pages/LoginPage'
import { ToastContainer } from './components/shared/Toast'
import SaveToCollectionModal from './components/Collections/SaveToCollectionModal'
import MSaveToCollectionSheet from './components/Collections/MSaveToCollectionSheet'
import BackgroundTasksWidget from './components/BackgroundTasks/BackgroundTasksWidget'
import MobileShell from './mobile/MobileShell'
import MRouteFallback from './mobile/components/MRouteFallback'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { lazyWithRetry } from './utils/lazyWithRetry'
import { useIsPhone } from './mobile/useIsPhone'
import { TranslationProvider, useTranslation } from './i18n'
import { authApi } from './api/client'
import { tripRepo } from './repo/tripRepo'
import { readStartDestination, tripStartPath, DEFAULT_START_PAGE, DEFAULT_START_TRIP_TAB, SETTINGS_WAIT_MS, START_DESTINATION_ROUTE } from './utils/startDestination'
import { usePermissionsStore, PermissionLevel } from './store/permissionsStore'
import { useInAppNotificationListener } from './hooks/useInAppNotificationListener.ts'
import { registerSyncTriggers, unregisterSyncTriggers } from './sync/syncTriggers'
import OfflineBanner from './components/Layout/OfflineBanner'
import { SystemNoticeHost } from './components/SystemNotices/SystemNoticeHost.js'
// Notice action registrations (side-effect imports):
import './pages/Trips/noticeActions.js'
import { managedRoutes } from './managed'

// Every page below loads on demand. The entry chunk used to carry all twenty of
// them eagerly, so opening /dashboard also paid for the planner, the journal, the
// atlas and the vacation planner. lazyWithRetry rather than lazy: a chunk that
// fails once gets a second, cache-busted attempt before the route boundary reaches
// for a reload.
const PluginPage = lazyWithRetry(() => import('./pages/PluginPage'))
const ForgotPasswordPage = lazyWithRetry(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage'))
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage'))
const TripPlannerPage = lazyWithRetry(() => import('./pages/TripPlannerPage'))
const FilesPage = lazyWithRetry(() => import('./pages/FilesPage'))
const AdminPage = lazyWithRetry(() => import('./pages/AdminPage'))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage'))
const VacayPage = lazyWithRetry(() => import('./pages/VacayPage'))
const HelpPage = lazyWithRetry(() => import('./pages/HelpPage'))
const AtlasPage = lazyWithRetry(() => import('./pages/AtlasPage'))
const JourneyPage = lazyWithRetry(() => import('./pages/JourneyPage'))
const JourneyDetailPage = lazyWithRetry(() => import('./pages/JourneyDetailPage'))
const JourneyStudioPage = lazyWithRetry(() => import('./pages/JourneyStudioPage'))
const CollectionsPage = lazyWithRetry(() => import('./pages/CollectionsPage'))
const JourneyPublicPage = lazyWithRetry(() => import('./pages/JourneyPublicPage'))
const SharedTripPage = lazyWithRetry(() => import('./pages/SharedTripPage'))
const JoinTripPage = lazyWithRetry(() => import('./pages/JoinTripPage'))
const InAppNotificationsPage = lazyWithRetry(() => import('./pages/InAppNotificationsPage.tsx'))
const OAuthAuthorizePage = lazyWithRetry(() => import('./pages/OAuthAuthorizePage'))

// The ten phone screens are chunks of their own, alongside the desktop pages
// rather than inside them. Each page used to import its M screen statically and
// decide while rendering, so the route chunk always carried both trees and the
// viewport only picked which half stayed dark. Here the branch decides the
// chunk: a phone never loads the desktop planner, a desktop never the mobile
// shell.
const MDashboardScreen = lazyWithRetry(() => import('./mobile/screens/dashboard/MDashboard'))
const MTripScreen = lazyWithRetry(() => import('./mobile/screens/trip/MTripShell'))
const MAdminScreen = lazyWithRetry(() => import('./mobile/screens/admin/MAdmin'))
const MSettingsScreen = lazyWithRetry(() => import('./mobile/screens/settings/MSettings'))
const MVacayScreen = lazyWithRetry(() => import('./mobile/screens/vacay/MVacay'))
const MAtlasScreen = lazyWithRetry(() => import('./mobile/screens/atlas/MAtlas'))
const MJourneyScreen = lazyWithRetry(() => import('./mobile/screens/journey/MJourney'))
const MJourneyDetailScreen = lazyWithRetry(() => import('./mobile/screens/journey/MJourneyDetail'))
const MCollectionsScreen = lazyWithRetry(() => import('./mobile/screens/collections/MCollections'))
const MNotificationsScreen = lazyWithRetry(() => import('./mobile/screens/notifications/MNotifications'))

interface ProtectedRouteProps {
  children: ReactNode
  adminRequired?: boolean
  addonId?: string
}

function ProtectedRoute({ children, adminRequired = false, addonId }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const appRequireMfa = useAuthStore((s) => s.appRequireMfa)
  const loggingOut = useAuthStore((s) => s.loggingOut)
  const addonStore = useAddonStore()
  const { t } = useTranslation()
  const location = useLocation()
  const isPhone = useIsPhone()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
          <p className="text-slate-500 text-sm">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    // A session that ended on its own should come back to where it left off; a
    // deliberate sign-out is a fresh start and gets no return ticket, so the
    // startup destination decides where the next login lands.
    if (loggingOut) return <Navigate to="/login" replace state={{ noRedirect: true }} />
    const redirectParam = encodeURIComponent(location.pathname + location.search + location.hash)
    return <Navigate to={`/login?redirect=${redirectParam}`} replace />
  }

  if (
    appRequireMfa &&
    user &&
    !user.mfa_enabled &&
    location.pathname !== '/settings'
  ) {
    return <Navigate to="/settings?mfa=required" replace />
  }

  if (adminRequired && user && user.role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }

  if (addonId && addonStore.loaded && !addonStore.isEnabled(addonId)) {
    return <Navigate to="/dashboard" replace />
  }

  // Below the md breakpoint the new mobile shell owns chrome (tokens, dock,
  // sheets, toasts); from 768px up the legacy wrapper stays untouched. The
  // shell branches internally so pages keep their state when the viewport
  // crosses the breakpoint.
  // The boundary sits inside the shell so a broken page keeps the navigation the
  // user needs to leave it — outside, the route would be a dead end, and the
  // mobile --m-* tokens live on the shell's .m-root anyway.
  //
  // key, not resetKeys: ProtectedRoute is the same component at the same position
  // for all 16 protected routes, so without it React could keep the failed
  // instance across a navigation and the error would follow the user around.
  return (
    <MobileShell isPhone={isPhone}>
      <ErrorBoundary
        key={location.pathname}
        boundaryId="route"
        level="route"
        variant={isPhone ? 'mobile' : 'desktop'}
      >
        {children}
      </ErrorBoundary>
    </MobileShell>
  )
}

/**
 * The public routes render outside ProtectedRoute, so the route boundary above
 * never sees them — including /login, where someone lands when everything else
 * failed, and the two anonymous share pages.
 */
function PublicRoute({ children, redirectAuthed = false }: { children: React.ReactNode; redirectAuthed?: boolean }) {
  const location = useLocation()
  // redirectAuthed (only /login and /register) bounces a visitor who is already
  // authenticated when they land here — manual URL, browser back button (#1810).
  // Only on a bare URL, because every parameter this page takes is a flow that
  // has to reach useLogin intact: ?redirect= carries the OAuth consent handoff
  // (bouncing drops it, or loops if the server still reports login_required),
  // ?invite= puts the form into register mode against a validated token, and
  // ?oidc_code= / ?oidc_error= complete an external login. A visitor with any of
  // those in the URL asked for this page on purpose.
  // Capture the flag at mount so a fresh login is left alone: it flips
  // isAuthenticated to true while the takeoff animation still plays here, before
  // useLogin navigates away.
  // The target is START_DESTINATION_ROUTE, not /dashboard, so the bounce honours
  // the start-page preference the same way useLogin does.
  const wasAuthenticated = useRef(useAuthStore.getState().isAuthenticated)
  if (redirectAuthed && wasAuthenticated.current && !location.search) {
    return <Navigate to={START_DESTINATION_ROUTE} replace />
  }
  return (
    <ErrorBoundary key={location.pathname} boundaryId="public-route" level="route">
      {children}
    </ErrorBoundary>
  )
}

/**
 * Picks the chunk, not just the branch. Both sides come through lazyWithRetry,
 * so exactly one of them is fetched for a given viewport — which is the whole
 * point: the ternary that used to sit in each page only ran once the browser
 * had already paid for both trees.
 */
function ViewportRoute({ phone: Phone, desktop: Desktop }: {
  phone: React.ComponentType
  desktop: React.ComponentType
}): React.ReactElement {
  const isPhone = useIsPhone()
  return isPhone ? <Phone /> : <Desktop />
}

/**
 * The entry point every shortcut, bookmark and the installed PWA share
 * (manifest start_url is '/'), which is why the startup destination is decided
 * here rather than on /dashboard — landing on the dashboard directly has to keep
 * working, or there would be no way back to it.
 *
 * Once this device has seen the preference it comes from the localStorage
 * mirror, so the common launch waits for nothing. A device that has never seen
 * it waits for the settings instead of assuming the default — the preference
 * lives on the server, and guessing here would ignore it on every browser that
 * didn't set it. Only 'active_trip' costs the one lookup that finds the trip,
 * and any failure along the way lands on the dashboard.
 */
function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuthStore()
  const settingsLoaded = useSettingsStore((s) => s.isLoaded)
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const [target, setTarget] = useState<string | null>(null)
  // Bounds the wait below: loadSettings deliberately leaves isLoaded false on a
  // failed request so it can retry, which would otherwise strand a launch that
  // started offline on the spinner.
  const [settingsGaveUp, setSettingsGaveUp] = useState(false)

  useEffect(() => {
    if (settingsLoaded) return
    const timer = setTimeout(() => setSettingsGaveUp(true), SETTINGS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [settingsLoaded])

  useEffect(() => {
    if (isLoading || !isAuthenticated || target) return
    const mirrored = readStartDestination()
    if (!mirrored && !settingsLoaded && !settingsGaveUp) {
      // Ask for the settings instead of waiting for whoever else might. The
      // store de-dupes concurrent loads, so this is free when one is already in
      // flight — and it stops the decision from riding on where that request
      // happens to land in the queue behind everything else a launch fires off.
      loadSettings()
      return
    }
    // Loaded settings are the truth; the mirror is what we knew last time.
    const { page, tab } = settingsLoaded
      ? { page: settings.start_page ?? DEFAULT_START_PAGE, tab: settings.start_trip_tab ?? DEFAULT_START_TRIP_TAB }
      : (mirrored ?? { page: DEFAULT_START_PAGE, tab: DEFAULT_START_TRIP_TAB })
    if (page !== 'active_trip') { setTarget('/dashboard'); return }
    let cancelled = false
    // Through the repo, not the api: offline this answers from Dexie instead of
    // bouncing a cached trip to the dashboard.
    tripRepo.active()
      .then(({ trip }) => { if (!cancelled) setTarget(trip ? tripStartPath(trip.id, tab) : '/dashboard') })
      .catch(() => { if (!cancelled) setTarget('/dashboard') })
    return () => { cancelled = true }
  }, [isLoading, isAuthenticated, settingsLoaded, settingsGaveUp, settings, target])

  if (isLoading || (isAuthenticated && !target)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
      </div>
    )
  }

  return <Navigate to={isAuthenticated ? (target ?? '/dashboard') : '/login'} replace />
}

/**
 * Shown while a route chunk is in flight. Same geometry as the auth spinner above,
 * but on theme tokens — that one predates the styleguide and a new surface does not
 * get to inherit its raw slate.
 */
function RouteFallback() {
  // The fallback renders above MobileShell, so it has to pick its own palette —
  // on a phone the desktop spinner on bg-surface would be a foreign white sheet
  // in front of the mobile screen.
  const isPhone = useIsPhone()
  if (isPhone) return <MRouteFallback />
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="w-10 h-10 border-4 border-edge border-t-content rounded-full animate-spin"></div>
    </div>
  )
}

export default function App() {
  const { loadUser, isAuthenticated, demoMode, setManaged, setDemoMode, setDevMode, setIsPrerelease, setAppVersion, setHasMapsKey, setServerTimezone, setAppRequireMfa, setTripRemindersEnabled, setPlacesPhotosEnabled, setPlacesAutocompleteEnabled, setPlacesDetailsEnabled, setPlacesEnrichEnabled } = useAuthStore()
  const { loadSettings } = useSettingsStore()
  const { loadAddons } = useAddonStore()
  const { loadPlugins } = usePluginStore()

  useEffect(() => {
    if (!location.pathname.startsWith('/shared/') && !location.pathname.startsWith('/public/') && !location.pathname.startsWith('/login')) {
      // If the persist snapshot already has an authenticated user, validate
      // silently so the PWA shell renders immediately without a spinner.
      const alreadyAuthenticated = useAuthStore.getState().isAuthenticated
      if (alreadyAuthenticated) {
        useAuthStore.setState({ isLoading: false })
        loadUser({ silent: true })
      } else {
        loadUser()
      }
    }
    authApi.getAppConfig().then(async (config: { managed?: boolean; demo_mode?: boolean; dev_mode?: boolean; is_prerelease?: boolean; has_maps_key?: boolean; version?: string; timezone?: string; require_mfa?: boolean; trip_reminders_enabled?: boolean; places_photos_enabled?: boolean; places_autocomplete_enabled?: boolean; places_details_enabled?: boolean; places_enrich_enabled?: boolean; permissions?: Record<string, PermissionLevel> }) => {
      setManaged(!!config?.managed)
      setDemoMode(!!config?.demo_mode)
      if (config?.dev_mode) setDevMode(true)
      if (config?.is_prerelease !== undefined) setIsPrerelease(config.is_prerelease)
      if (config?.version) setAppVersion(config.version)
      if (config?.has_maps_key !== undefined) setHasMapsKey(config.has_maps_key)
      if (config?.timezone) setServerTimezone(config.timezone)
      if (config?.require_mfa !== undefined) setAppRequireMfa(!!config.require_mfa)
      if (config?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(config.trip_reminders_enabled)
      if (config?.places_photos_enabled !== undefined) setPlacesPhotosEnabled(config.places_photos_enabled)
      if (config?.places_autocomplete_enabled !== undefined) setPlacesAutocompleteEnabled(config.places_autocomplete_enabled)
      if (config?.places_details_enabled !== undefined) setPlacesDetailsEnabled(config.places_details_enabled)
      if (config?.places_enrich_enabled !== undefined) setPlacesEnrichEnabled(config.places_enrich_enabled)
      if (config?.permissions) usePermissionsStore.getState().setPermissions(config.permissions)

      // A version is a short release tag and nothing else. It arrives over the
      // wire and is written to this device's storage, so it is rebuilt from the
      // characters a tag may contain and kept only when nothing had to be
      // stripped. Anything else is ignored, which also keeps a malformed value
      // from being compared against the stored marker and starting an update on
      // every launch.
      const reportedVersion = typeof config?.version === 'string' ? config.version : ''
      const version = reportedVersion.replace(/[^\w.+-]/g, '').slice(0, 64)
      if (version && version === reportedVersion) {
        const storedVersion = localStorage.getItem('trek_app_version')
        // Record the version BEFORE acting on it. The old code wrote the marker
        // after the purge and outside its try, so a throwing setItem (private
        // mode, blocked site data, quota) left the caches deleted, the marker
        // unwritten and the reload unreached, and the purge then repeated on
        // every single launch, permanently (#2228).
        try { localStorage.setItem('trek_app_version', version) } catch { /* site data blocked */ }
        if (storedVersion && storedVersion !== version) {
          // A newer build is deployed. Ask the service worker to fetch it and
          // hand over; Workbox ('autoUpdate' + skipWaiting + clientsClaim)
          // installs the new precache and only then drops the outdated one, so
          // there is never a moment without an app shell.
          //
          // This used to delete EVERY Cache Storage bucket and unregister EVERY
          // worker instead. That left the device with no shell and no worker
          // until a fresh ~22 MB precache finished (minutes on mobile data),
          // and anyone who closed the app or lost signal in that window was
          // left with a PWA that could no longer start offline at all. It also
          // threw away the map tiles and file blobs the user had deliberately
          // downloaded for offline use (#2228).
          try {
            const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
            if (reg) {
              navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
              await reg.update()
              return
            }
          } catch { /* fall through to a plain reload */ }
          window.location.reload()
          return
        }
      }
    }).catch(() => {})
  }, [])

  const { settings } = useSettingsStore()

  useInAppNotificationListener()

  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
      loadAddons()
      loadPlugins()
    }
  }, [isAuthenticated])

  useEffect(() => {
    registerSyncTriggers()
    return () => unregisterSyncTriggers()
  }, [])

  const location = useLocation()
  const isSharedPage = location.pathname.startsWith('/shared/')

  useEffect(() => {
    const run = () =>
      applyAppearance({
        darkMode: settings.dark_mode,
        appearance: settings.appearance,
        isSharedPage,
      })
    run()
    // Re-resolve on OS theme change while in auto mode.
    if (!isSharedPage && settings.dark_mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => run()
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings.dark_mode, settings.appearance, isSharedPage])

  const isPhone = useIsPhone()
  const isAuthPage = location.pathname.startsWith('/login')
    || location.pathname.startsWith('/register')
    || location.pathname.startsWith('/forgot-password')
    || location.pathname.startsWith('/reset-password')
  // Anonymous visitor routes: no session, so authenticated-only widgets (system
  // notices, background tasks, save-to-collection) have nothing to do here and
  // would otherwise fire a doomed authenticated request on mount.
  const isPublicVisitorPage = isSharedPage || location.pathname.startsWith('/public/journey/')
  const hideAuthedWidgets = isAuthPage || isPublicVisitorPage

  return (
    <TranslationProvider>
      {!hideAuthedWidgets && <ErrorBoundary boundaryId="widget:system-notice" fallback={null}><SystemNoticeHost /></ErrorBoundary>}
      <ErrorBoundary boundaryId="widget:toast" fallback={null}><ToastContainer /></ErrorBoundary>
      {!hideAuthedWidgets && <ErrorBoundary boundaryId="widget:background-tasks" fallback={null}><BackgroundTasksWidget /></ErrorBoundary>}
      {!hideAuthedWidgets && (isPhone ? <MSaveToCollectionSheet /> : <SaveToCollectionModal />)}
      <ErrorBoundary boundaryId="widget:offline-banner" fallback={null}><OfflineBanner /></ErrorBoundary>
      {/* One boundary for all route chunks, above <Routes> so it stays mounted
          across navigations. react-router runs location updates inside a transition,
          so a mounted boundary keeps the current page on screen instead of flashing
          a spinner on every jump — the spinner is for the first paint of a deep link. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/login" element={<PublicRoute redirectAuthed><LoginPage /></PublicRoute>} />
          <Route path="/shared/:token" element={<PublicRoute><SharedTripPage /></PublicRoute>} />
          <Route path="/public/journey/:token" element={<PublicRoute><JourneyPublicPage /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute redirectAuthed><LoginPage /></PublicRoute>} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPasswordPage /></PublicRoute>} />
          <Route path="/reset-password" element={<PublicRoute><ResetPasswordPage /></PublicRoute>} />
          {/* OAuth 2.1 consent page — intentionally outside ProtectedRoute */}
          <Route path="/oauth/consent" element={<PublicRoute><OAuthAuthorizePage /></PublicRoute>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MDashboardScreen} desktop={DashboardPage} />
              </ProtectedRoute>
            }
          />
          {/* Trip invite link (#1143) — behind ProtectedRoute so an anonymous
              visitor is redirected to /login (never registration) and returns here. */}
          <Route
            path="/join/:token"
            element={
              <ProtectedRoute>
                <JoinTripPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/help"
            element={
              <ProtectedRoute>
                <HelpPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/help/:slug"
            element={
              <ProtectedRoute>
                <HelpPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/trips/:id"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MTripScreen} desktop={TripPlannerPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/trips/:id/files"
            element={
              <ProtectedRoute>
                <FilesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute adminRequired>
                <ViewportRoute phone={MAdminScreen} desktop={AdminPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MSettingsScreen} desktop={SettingsPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/plugins/:pluginId"
            element={
              <ProtectedRoute>
                <PluginPage />
              </ProtectedRoute>
            }
          />
          {/* Empty in this repository, and read unconditionally so the public
              build walks the same path as any other. See client/src/managed. */}
          {managedRoutes.map(r => (
            <Route
              key={r.path}
              path={r.path}
              element={<ProtectedRoute adminRequired={r.adminOnly}>{r.element}</ProtectedRoute>}
            />
          ))}
          <Route
            path="/vacay"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MVacayScreen} desktop={VacayPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/atlas"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MAtlasScreen} desktop={AtlasPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/journey"
            element={
              <ProtectedRoute addonId="journey">
                <ViewportRoute phone={MJourneyScreen} desktop={JourneyPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/journey/:id"
            element={
              <ProtectedRoute addonId="journey">
                <ViewportRoute phone={MJourneyDetailScreen} desktop={JourneyDetailPage} />
              </ProtectedRoute>
            }
          >
            {/* Studio is nested so the journey stays mounted underneath it and
                shows through the panel's margin — it is opened on top of the
                journey, not navigated away to. */}
            <Route path="studio" element={<JourneyStudioPage />} />
          </Route>
          <Route
            path="/collections"
            element={
              <ProtectedRoute addonId="collections">
                <ViewportRoute phone={MCollectionsScreen} desktop={CollectionsPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/collections/:id"
            element={
              <ProtectedRoute addonId="collections">
                <ViewportRoute phone={MCollectionsScreen} desktop={CollectionsPage} />
              </ProtectedRoute>
            }
          />
          <Route
            path="/notifications"
            element={
              <ProtectedRoute>
                <ViewportRoute phone={MNotificationsScreen} desktop={InAppNotificationsPage} />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </TranslationProvider>
  )
}
