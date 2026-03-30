import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/uploads/, /^\/mcp/],
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
          {
            // API calls — prefer network, fall back to cache
            // Exclude sensitive endpoints (auth, admin, backup, settings)
            urlPattern: /\/api\/(?!auth|admin|backup|settings).*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-data',
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Uploaded files (photos, covers — public assets only)
            urlPattern: /\/uploads\/(?:covers|avatars)\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'user-uploads',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
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
    }),
  ],
  build: {
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
