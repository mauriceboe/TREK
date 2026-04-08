import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const enablePwa = env.VITE_ENABLE_PWA === 'true'

  const plugins = [react()]

  if (enablePwa) {
    plugins.push(
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api/, /^\/uploads/],
          runtimeCaching: [
            {
              // Carto map tiles (default provider)
              urlPattern: /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'map-tiles',
                expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // OpenStreetMap tiles (fallback / alternative)
              urlPattern: /^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'map-tiles',
                expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Leaflet CSS/JS from unpkg CDN
              urlPattern: /^https:\/\/unpkg\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'cdn-libs',
                expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        manifest: {
          name: 'TREK \u2014 Travel Planner',
          short_name: 'TREK',
          description: 'Travel Resource & Exploration Kit',
          theme_color: '#111827',
          background_color: '#0f172a',
          display: 'standalone',
          scope: '/',
          start_url: '/',
          orientation: 'any',
          categories: ['travel', 'navigation'],
          icons: [
            { src: 'icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
            { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
      })
    )
  }

  return {
    plugins,
    server: {
      port: 5173,
      // Express proxy removed — all APIs now go through Convex
    }
  }
})
