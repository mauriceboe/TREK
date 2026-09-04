import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { rtlTextAlias } from './rtlTextAlias.js';

// `npm run build:analyze` writes dist/stats.html — a treemap of what actually ended
// up in each chunk. The plain build only reports chunk sizes, which tells you a chunk
// is too big but not which dependency made it so.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode === 'analyze' &&
      visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true }),
    VitePWA({
      registerType: 'autoUpdate',
      // Serve the generated manifest (+ dev SW) in development too, so the installed
      // PWA can be tested against the dev server. Without this, dev ships no
      // <link rel="manifest">, so iOS falls back to legacy standalone
      // (apple-mobile-web-app-capable only) and pops the Safari chrome on every
      // in-app navigation away from the start URL. Prod already serves the manifest.
      devOptions: {
        enabled: true,
        type: 'module',
        suppressWarnings: true,
        /*
         * No navigation fallback from the dev service worker.
         *
         * `workbox.navigateFallback` below is right for production: offline, a
         * deep link has to be answered by the cached shell. In development it
         * means the worker answers a reload with the index.html it cached
         * earlier, whose <script> tags point at module URLs from before the last
         * restart — so the browser faithfully re-runs the previous version of
         * the app while the editor shows the new one, and every explanation for
         * that is wrong until someone thinks of the service worker. It cost
         * several rounds of "I don't see the change" to find.
         */
        navigateFallback: undefined,
      },
      workbox: {
        // Anything above this is dropped from the precache manifest. The build does
        // not fail over it, it only prints "won't be precached", so the ceiling has
        // to sit close to the real bundle or an accidental heavyweight goes
        // offline-broken unnoticed. Largest precached entry is the heic-to chunk at
        // 3.0 MB, which leaves about 670 kB of headroom; the entry chunk is 258 kB.
        maximumFileSizeToCacheInBytes: 3.5 * 1024 * 1024,
        // Every route chunk is precached alongside the shell, deliberately: for an
        // offline-first travel planner a route the user never opened before losing
        // signal still has to work. The trade is that splitting buys first paint and
        // not install size: 107 entries / 17,795 KiB before any of it, 463 /
        // 23,292 KiB now (measured, not estimated).
        //
        // Keep this figure honest. #2228 traced PWA boot failures to the browser
        // evicting this origin's whole bucket, precached shell included, and this
        // comment is the only record of what the install actually costs. Anything
        // matching the globs below is fetched at service-worker install by every
        // user, whether or not they ever reach the code.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}'],
        // build:analyze drops a treemap next to the app; it must never end up in a
        // precache manifest if someone ships that build by accident.
        globIgnores: ['**/stats.html'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/api/,
          /^\/uploads/,
          /^\/mcp/,
          /^\/oauth\//,
          /^\/.well-known\//,
          /^\/plugin-frame\//,
        ],
        runtimeCaching: [
          {
            // Carto map tiles (default provider)
            // maxEntries MUST stay >= MAX_TILES in src/sync/tilePrefetcher.ts
            // (both are 12288) so prefetched tiles aren't evicted on arrival.
            // The apex host counts too: a template without {s} points straight at
            // basemaps.cartocdn.com, and matching only the shards left those tiles
            // uncached, so the map went blank offline.
            urlPattern: /^https:\/\/(?:[a-d]\.)?basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap tiles (fallback / alternative)
            // Shares the 'map-tiles' cache; keep maxEntries equal to the Carto
            // rule above and MAX_TILES in src/sync/tilePrefetcher.ts (12288).
            // Both spellings have to stay in the pattern: templates are rewritten
            // onto the apex host (src/utils/tileUrl.ts), but caches filled before
            // that still hold a/b/c URLs and must keep serving offline.
            urlPattern: /^https:\/\/(?:[a-c]\.)?tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap DE — a shipped preset that matched no rule at all, so
            // "Store map tiles offline" fetched thousands of tiles and stored none
            // of them (#2180). Same cache, same limits as the rules above.
            urlPattern: /^https:\/\/tile\.openstreetmap\.de\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Stadia Smooth — the other shipped raster preset with the same hole (#2180).
            urlPattern: /^https:\/\/tiles\.stadiamaps\.com\/tiles\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The GL style DOCUMENT, for both providers. It has to be matched
            // before the tile rules below, because Workbox takes the first route
            // that matches and the broad tile patterns cover this URL too (#1924).
            //
            // A style is not a tile. It is one small document that changes the
            // moment the user edits it in Mapbox Studio, and it decides how every
            // tile is drawn — including which `name_*` field the labels read.
            // Under StaleWhileRevalidate the map was built from the PREVIOUS
            // revision on every load, with the refresh landing one load too late,
            // so a style republished with different label languages kept rendering
            // the old ones. The network tab showed a 200 throughout, because the
            // service worker's own answer is a real 200.
            //
            // NetworkFirst rather than NetworkOnly: the map still has to open
            // offline. Its own small cache rather than the tile cache: sharing
            // an LRU with thousands of tiles made eviction, and therefore the
            // staleness, look random.
            urlPattern: /^https:\/\/(api\.mapbox\.com\/styles\/v1\/|tiles\.openfreemap\.org\/styles\/)/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'gl-map-styles',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Mapbox GL glyphs, sprites and vector tiles (the style itself is
            // handled by the rule above). Best-effort offline only:
            // opportunistically caches what the user has already
            // viewed online. Full pre-download offline maps require the Leaflet
            // renderer (raster prefetch in tilePrefetcher.ts) — the GL vector
            // pipeline is not prefetched. StaleWhileRevalidate keeps the basemap
            // fresh online while still serving from cache when offline. Mapbox
            // sends CORS, so responses are non-opaque (real 200s, no quota pad).
            urlPattern: /^https:\/\/(api\.mapbox\.com|[a-d]\.tiles\.mapbox\.com)\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'mapbox-tiles',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // OpenFreeMap MapLibre glyphs, sprites and vector tiles (the style
            // itself is handled by the style rule above).
            //
            // CacheFirst, and sharing its cache with the prefetcher: OpenFreeMap
            // serves tiles under a versioned planet path, so a cached tile is
            // never stale — a new planet is a new URL. StaleWhileRevalidate
            // would revalidate every tile of a pre-downloaded region on the next
            // online visit for nothing.
            //
            // cacheName matches sync/glPrefetcher.ts, which writes here directly:
            // one cache means normal browsing tops the offline region up instead
            // of filling a second copy beside it. maxEntries is above the
            // prefetcher's own cap so a browsing session cannot evict a region
            // the user asked to keep.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gl-map-offline',
              expiration: { maxEntries: 6000, maxAgeSeconds: 90 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // API calls — network only. We deliberately do NOT cache API
            // responses in the Service Worker: Workbox keys entries by URL and
            // cannot vary on the httpOnly session cookie, so a shared device
            // could serve one user's cached data to the next (cross-user leak).
            // Offline reads are served from the per-user IndexedDB cache via the
            // repo layer instead. The urlPattern is kept so these requests still
            // bypass the SPA navigation fallback.
            urlPattern: /\/api\/(?!auth|admin|backup|settings|health).*/i,
            handler: 'NetworkOnly',
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
        categories: ['travel', 'navigation'],
        icons: [
          { src: 'icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
          { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          // Dedicated safe-zone renders: the full-bleed icon under a maskable
          // purpose filled the whole Android launcher tile without any padding.
          { src: 'icons/icon-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: { alias: [rtlTextAlias] },
  build: {
    // Pin the output level instead of inheriting whatever the current Vite default
    // is, so a toolchain bump can't silently change which browsers still work.
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: true },
    // Vite 8 bundles with rolldown, not rollup. `rollupOptions` is only an alias
    // onto `rolldownOptions`, and both `manualChunks` and `advancedChunks` are
    // deprecated in favour of `codeSplitting.groups` — a config mixing them still
    // builds green and simply has no effect.
    //
    // `tags: ['$initial']` is not optional here. Without it a group also collects
    // modules that today hang behind React.lazy, which turns the group chunk into
    // a static import of the entry: measured, that put the 2.8 MB GL chunk into
    // the index.html modulepreload and took eager JS from 1.48 MB to 4.61 MB.
    //
    // Deliberately no groups for mapbox-gl/maplibre-gl, leaflet or react-markdown.
    // Those already sit in async chunks of their own with hashes that survive a
    // release; a group would only rename them, and at worst make them eager.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              priority: 40,
              tags: ['$initial'],
              // react-dom/server is pulled dynamically by TripPDF and lives in an
              // async chunk. Excluding it keeps a later static import from lifting
              // ~170 kB of Fizz into the eager vendor chunk.
              test: (id) =>
                /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id) &&
                !/react-dom[\\/](server|static)|react-dom-server/.test(id),
            },
            {
              name: 'vendor-core',
              priority: 30,
              // zod and dompurify arrive through @trek/shared but live in
              // node_modules themselves, so they are caught here. @trek/shared is
              // not: it resolves to shared/dist without a node_modules segment,
              // and its contract code changes with every release anyway.
              tags: ['$initial'],
              test: /[\\/]node_modules[\\/](zustand|dexie|axios|zod|dompurify|isomorphic-dompurify)[\\/]/,
            },
          ],
        },
      },
    },
  },
  /*
   * Never pre-bundle the workspace's own contracts.
   *
   * `@trek/shared` resolves to shared/dist, which is a build output that changes
   * whenever a Zod schema does. Pre-bundled, the dev server keeps serving the
   * copy it optimised at startup: a field added to the document contract is
   * missing in the browser, `normalizeBookDocument` strips it on load, and the
   * change you just made vanishes on reload with nothing in the console. It
   * cost an afternoon twice before anyone worked out it was not the code.
   */
  optimizeDeps: {
    exclude: ['@trek/shared'],
  },
  server: {
    port: 5173,
    // And watch the build output, so rebuilding shared reloads the page rather
    // than leaving a stale module graph behind.
    watch: {
      ignored: ['!**/shared/dist/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/plugin-frame': {
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
      },
      // OAuth 2.1 endpoints handled by backend (SDK authorize handler + token/revoke)
      // /oauth/authorize goes to backend so the SDK can redirect to /oauth/consent
      // /oauth/consent is served by Vite as a SPA route (no proxy entry needed)
      '/oauth/authorize': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/oauth/token': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/oauth/register': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/oauth/revoke': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/.well-known': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
}));
