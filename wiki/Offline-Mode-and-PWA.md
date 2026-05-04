# Offline Mode and PWA

TREK can be installed as a Progressive Web App (PWA) and used without an internet connection for previously synced trips.

## Install as an app (PWA)

TREK must be served over **HTTPS** — the install prompt does not appear on plain HTTP.

**iOS (Safari):**
1. Open TREK in Safari.
2. Tap the Share button.
3. Select **Add to Home Screen**.

**Android (Chrome / Edge):**
1. Open TREK in the browser.
2. Tap the browser menu.
3. Select **Install app** or **Add to Home Screen**.

Once installed, TREK launches in **standalone** mode (fullscreen, no browser UI) using the TREK icon.

## How offline reads work

TREK uses **two independent offline layers**:

1. **IndexedDB (Dexie)** — the primary offline store. On login and whenever the network comes back online, TREK syncs full trip bundles into IndexedDB. All reads use a **stale-while-revalidate** strategy: cached data is returned instantly from IndexedDB, then a background network request updates the data when it completes. This means the UI is always instant regardless of connectivity — `navigator.onLine` is not used as a gate because it is unreliable on mobile (returns `true` whenever any network interface is active, even without actual internet access).

2. **Service-worker cache (Workbox)** — a secondary safety net for *degraded connectivity* (flaky Wi-Fi, captive portals). The SW intercepts API calls and serves cached responses if the network does not respond within the timeout.

This means a week-long offline trip works even if the SW cache has expired — the IndexedDB data has no time-based eviction (only stale trips older than 7 days are evicted on the next sync).

## What works offline

**Service-worker cache (Workbox)**

| Content | Cache name | Strategy | Default TTL | Default max entries |
|---------|------------|----------|-------------|---------------------|
| CartoDB / OpenStreetMap map tiles | `map-tiles` | CacheFirst | 30 days | 1 000 |
| Leaflet / CDN assets (unpkg) | `cdn-libs` | CacheFirst | 365 days | 30 |
| API responses (trips, places, bookings, etc.) | `api-data` | NetworkFirst (2 s timeout) | **7 days** | **500** |
| Cover images and avatars (`/uploads/covers`, `/uploads/avatars`) | `user-uploads` | CacheFirst | 7 days | 300 |
| App shell (HTML / JS / CSS) | precache | Precached | Until next deploy | — |

The `api-data` and `map-tiles` caches are **user-configurable at runtime** — see [Cache configuration](#cache-configuration) below.

> **Note:** The API cache excludes sensitive endpoints — `/api/auth`, `/api/admin`, `/api/backup`, and `/api/settings` are always fetched from the network.

**IndexedDB (Dexie) — structured trip data**

On login, when the network comes back online, and via the manual **Re-sync now** button, TREK runs a background sync that writes full trip bundles into IndexedDB:

- Trips, days, places, packing items, to-dos, budget items, reservations, accommodations, trip members, tags, and categories.
- Non-photo file attachments (PDFs, documents, etc.) are downloaded and stored as blobs in IndexedDB.
- Map tiles are pre-fetched into the service-worker `map-tiles` cache for zoom levels 10–16 across each trip's bounding box (capped at ~50 MB of tiles per sync).

**Sync scope and eviction**

- Only ongoing and future trips are cached (trips whose `end_date` is today or later, or has no end date).
- Trips that ended more than 7 days ago are automatically evicted from IndexedDB on the next sync.

## Offline Cache (Settings → Offline)

The **Offline Cache** section under Settings → Offline shows the current state of the local cache.

**Stats panel:**
- **Cached trips** — number of trips stored in IndexedDB (Dexie).
- **Pending changes** — number of actions taken offline that are queued to sync.

**Actions:**
- **Re-sync now** — forces a full sync with the server. Disabled when you are offline.
- **Clear cache** — removes all offline trip data from IndexedDB. You can re-sync any time while online.

Each cached trip entry shows the trip name, date range, place count, and file count, plus the time of the last successful sync.

## Cache configuration

The **Cache configuration** section in Settings → Offline lets you tune the service-worker cache limits without rebuilding TREK. Changes are saved to your browser's IndexedDB and sent to the active service worker immediately — no page reload required.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| API cache TTL (days) | 7 | 1–365 | How long API responses stay in the `api-data` cache |
| API max entries | 500 | 10–5 000 | Maximum number of API responses cached |
| Map tiles TTL (days) | 30 | 1–365 | How long map tiles stay in the `map-tiles` cache |
| Map tiles max entries | 1 000 | 10–5 000 | Maximum number of tiles cached across all trips |

> **Tip:** Existing cached entries follow their original TTL. New entries use the updated settings from the next request onwards.

> **Note on TTL and offline access:** Raising the API cache TTL extends coverage for *degraded connectivity* (flaky Wi-Fi). For a fully offline device, the primary data source is IndexedDB — always available regardless of TTL.

## Limitations

- New trips created while offline are queued and synced when connectivity is restored.
- Photo uploads require connectivity; non-photo file attachments are pre-cached automatically during sync.
- Real-time collaboration features require an active WebSocket connection.
- Mapbox GL tiles are not cached by the service worker (Mapbox manages its own tile cache internally).
- The map tile size cap (~50 MB) means very large trips spanning multiple countries may have tiles skipped entirely rather than partially cached.

## See also

- [User-Settings](User-Settings)
- [Display-Settings](Display-Settings)
