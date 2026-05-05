/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  matchPrecache,
} from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import {
  DEFAULT_SW_CONFIG,
  readSwConfigFromIDB,
  validateSwConfig,
  type SwCacheConfig,
} from './sync/swConfig';

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();

// Inject precache manifest (replaced by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Static routes (not user-configurable) ─────────────────────────────────────

// Network-first navigations so reverse-proxy auth redirects (Cloudflare Zero
// Trust, Pangolin, etc.) reach the browser instead of being swallowed by the
// precached app shell. `redirect: 'manual'` produces an opaqueredirect Response
// which, per Fetch spec, the browser follows for navigation requests returned
// from FetchEvent.respondWith. Falls back to precached app shell offline.
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      try {
        return await fetch(request, { redirect: 'manual' });
      } catch {
        const cached = await matchPrecache('index.html');
        return cached ?? Response.error();
      }
    },
    { denylist: [/^\/api/, /^\/uploads/, /^\/mcp/] },
  ),
);

registerRoute(
  /^https:\/\/unpkg\.com\/.*/i,
  new CacheFirst({
    cacheName: 'cdn-libs',
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  }),
  'GET',
);

registerRoute(
  /\/uploads\/(?:covers|avatars)\/.*/i,
  new CacheFirst({
    cacheName: 'user-uploads',
    plugins: [
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 }),
      new CacheableResponsePlugin({ statuses: [200] }),
    ],
  }),
  'GET',
);

// ── Configurable routes ────────────────────────────────────────────────────────
// Routes are registered once. Strategy instances are replaced on config change
// so the stable handler wrapper always delegates to the current instance.

const DAY = 24 * 60 * 60;

// Detects when an upstream reverse-proxy auth gate (Cloudflare Zero Trust,
// Pangolin, etc.) redirects a mid-session API call to an external SSO login
// page. Uses redirect:'manual' so the response stays as opaqueredirect instead
// of being silently followed; converts it to a 401 that the Axios interceptor
// in api/client.ts already handles (→ window.location.href = '/login').
const authRedirectPlugin = {
  async requestWillFetch({ request }: { request: Request }): Promise<Request> {
    return new Request(request, { redirect: 'manual' });
  },
  async fetchDidSucceed({ response }: { response: Response }): Promise<Response> {
    if (response.type === 'opaqueredirect') {
      return new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return response;
  },
};

function buildApiStrategy(cfg: SwCacheConfig): NetworkFirst {
  return new NetworkFirst({
    cacheName: 'api-data',
    networkTimeoutSeconds: 2,
    plugins: [
      authRedirectPlugin,
      new ExpirationPlugin({
        maxEntries: cfg.apiMaxEntries,
        maxAgeSeconds: cfg.apiTtlDays * DAY,
      }),
      new CacheableResponsePlugin({ statuses: [200] }),
    ],
  });
}

function buildTilesStrategy(cfg: SwCacheConfig): CacheFirst {
  return new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new ExpirationPlugin({
        maxEntries: cfg.tilesMaxEntries,
        maxAgeSeconds: cfg.tilesTtlDays * DAY,
      }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  });
}

let apiStrategy = buildApiStrategy(DEFAULT_SW_CONFIG);
let cartoStrategy = buildTilesStrategy(DEFAULT_SW_CONFIG);
let osmStrategy = buildTilesStrategy(DEFAULT_SW_CONFIG);

function applyConfig(cfg: SwCacheConfig): void {
  apiStrategy    = buildApiStrategy(cfg);
  cartoStrategy  = buildTilesStrategy(cfg);
  osmStrategy    = buildTilesStrategy(cfg);
}

// Apply authRedirectPlugin to the public app-config endpoint so a ZT redirect
// surfaces as AUTH_REQUIRED (401) instead of causing a silent JSON parse failure
// on the login page, which would hide the SSO button.
registerRoute(
  /\/api\/auth\/app-config$/i,
  new NetworkOnly({ plugins: [authRedirectPlugin] }),
  'GET',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerRoute(/\/api\/(?!auth|admin|backup|settings).*/i,  { handle: (o: any) => apiStrategy.handle(o) },   'GET');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerRoute(/^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/.*/i, { handle: (o: any) => cartoStrategy.handle(o) }, 'GET');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerRoute(/^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/i, { handle: (o: any) => osmStrategy.handle(o) },  'GET');

// Load persisted config asynchronously; replaces defaults if user has saved settings
readSwConfigFromIDB()
  .then(cfg => { if (cfg) applyConfig(cfg); })
  .catch(() => {});

// ── Message handler ────────────────────────────────────────────────────────────

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; config?: unknown };
  if (data?.type !== 'UPDATE_CACHE_CONFIG' || !data.config) return;

  const validated = validateSwConfig(data.config as Partial<SwCacheConfig>);
  applyConfig(validated);

  // Acknowledge back to the sending client
  (event.source as WindowClient | null)?.postMessage({ type: 'CACHE_CONFIG_APPLIED' });
});
