import React, { useEffect, ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import TripPlannerPage from './pages/TripPlannerPage'
import FilesPage from './pages/FilesPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import VacayPage from './pages/VacayPage'
import AtlasPage from './pages/AtlasPage'
import SharedTripPage from './pages/SharedTripPage'
import { ToastContainer } from './components/shared/Toast'
import { TranslationProvider, useTranslation } from './i18n'
import { authApi } from './api/client'
import { usePermissionsStore, PermissionLevel } from './store/permissionsStore'

interface ProtectedRouteProps {
  children: ReactNode
  adminRequired?: boolean
}

function ProtectedRoute({ children, adminRequired = false }: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const appRequireMfa = useAuthStore((s) => s.appRequireMfa)
  const { t } = useTranslation()
  const location = useLocation()

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
    return <Navigate to="/login" replace />
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

  return <>{children}</>
}

function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
      </div>
    )
  }

  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
}

export default function App() {
  const { loadUser, isAuthenticated, demoMode, setDemoMode, setHasMapsKey, setServerTimezone, setAppRequireMfa, setTripRemindersEnabled } = useAuthStore()
  const { loadSettings } = useSettingsStore()

  useEffect(() => {
    loadUser()
    authApi.getAppConfig().then(async (config: { demo_mode?: boolean; has_maps_key?: boolean; version?: string; timezone?: string; require_mfa?: boolean; trip_reminders_enabled?: boolean; permissions?: Record<string, PermissionLevel> }) => {
      if (config?.demo_mode) setDemoMode(true)
      if (config?.has_maps_key !== undefined) setHasMapsKey(config.has_maps_key)
      if (config?.timezone) setServerTimezone(config.timezone)
      if (config?.require_mfa !== undefined) setAppRequireMfa(!!config.require_mfa)
      if (config?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(config.trip_reminders_enabled)
      if (config?.permissions) usePermissionsStore.getState().setPermissions(config.permissions)

      if (config?.version) {
        const storedVersion = localStorage.getItem('trek_app_version')
        if (storedVersion && storedVersion !== config.version) {
          try {
            if ('caches' in window) {
              const names = await caches.keys()
              await Promise.all(names.map(n => caches.delete(n)))
            }
            if ('serviceWorker' in navigator) {
              const regs = await navigator.serviceWorker.getRegistrations()
              await Promise.all(regs.map(r => r.unregister()))
            }
          } catch {}
          localStorage.setItem('trek_app_version', config.version)
          window.location.reload()
          return
        }
        localStorage.setItem('trek_app_version', config.version)
      }
    }).catch(() => {})
  }, [])

  const { settings } = useSettingsStore()

  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated])

  const location = useLocation()
  const isSharedPage = location.pathname.startsWith('/shared/')

  useEffect(() => {
    // Shared page always forces light mode
    if (isSharedPage) {
      document.documentElement.classList.remove('dark')
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', '#ffffff')
      return
    }

    const mode = settings.dark_mode
    const applyDark = (isDark: boolean) => {
      document.documentElement.classList.toggle('dark', isDark)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', isDark ? '#09090b' : '#ffffff')
    }

    if (mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(mq.matches)
      const handler = (e: MediaQueryListEvent) => applyDark(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    applyDark(mode === true || mode === 'dark')
  }, [settings.dark_mode, isSharedPage])

  return (
    <TranslationProvider>
      <ToastContainer />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/shared/:token" element={<SharedTripPage />} />
        <Route path="/register" element={<LoginPage />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <ProtectedRoute>
              <TripPlannerPage />
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
              <AdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vacay"
          element={
            <ProtectedRoute>
              <VacayPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/atlas"
          element={
            <ProtectedRoute>
              <AtlasPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TranslationProvider>
  )
}
