import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { OptionalConvexProvider } from './convex/provider'

const pwaEnabled = import.meta.env.VITE_ENABLE_PWA === 'true'
const PWA_CLEANUP_FLAG = 'trek_pwa_cleanup_reloaded'

async function cleanupLegacyServiceWorkers(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false

  let changed = false

  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => [])
  if (registrations.length > 0) {
    const results = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)))
    changed = results.some(Boolean) || changed
  }

  if ('caches' in window) {
    const cacheNames = await window.caches.keys().catch(() => [])
    if (cacheNames.length > 0) {
      await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName).catch(() => false)))
      changed = true
    }
  }

  return changed || Boolean(navigator.serviceWorker.controller)
}

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <OptionalConvexProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </OptionalConvexProvider>
    </React.StrictMode>,
  )
}

async function bootstrap(): Promise<void> {
  if (!pwaEnabled) {
    const cleaned = await cleanupLegacyServiceWorkers()
    if (cleaned && !sessionStorage.getItem(PWA_CLEANUP_FLAG)) {
      sessionStorage.setItem(PWA_CLEANUP_FLAG, 'true')
      window.location.reload()
      return
    }
    sessionStorage.removeItem(PWA_CLEANUP_FLAG)
  }

  renderApp()
}

void bootstrap()
