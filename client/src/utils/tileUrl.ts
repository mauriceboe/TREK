/**
 * OpenStreetMap has not needed the a/b/c.tile.openstreetmap.org subdomains
 * since 2022 — tile.openstreetmap.org serves the whole grid on its own — and
 * d.tile.openstreetmap.org has meanwhile lost its DNS record entirely. A
 * template that still carries the `{s}` placeholder therefore depends on which
 * letters the renderer substitutes: everything that lands on `d` fails with
 * ERR_NAME_NOT_RESOLVED, which is console noise plus holes in the offline tile
 * cache (#1733).
 *
 * The presets ship the single-host form now, but a template the user (or an
 * admin default) saved earlier is still in the database. Rewriting it on read
 * fixes those instances without a migration; the settings store rewrites it on
 * save as well, so a legacy URL typed by hand converges on the same host
 * instead of coming back on the next load. Other providers are left untouched.
 */

/** `{s}.` or a bare shard letter in front of tile.openstreetmap.org. */
const OSM_SHARD = /^((?:https?:)?\/\/)(?:\{s\}|[a-d])\.tile\.openstreetmap\.org(?=[/:]|$)/i

/** Collapse a sharded OSM tile template onto the single supported host. */
export function normalizeTileUrl(url: string): string {
  if (!url) return url
  return url.replace(OSM_SHARD, '$1tile.openstreetmap.org')
}

/**
 * CARTO started watermarking keyless basemap tiles on 26.08.2026 (#2054). The
 * key rides along as a `?key=` query parameter, which every template engine in
 * the client passes through untouched, so it is appended here rather than baked
 * into the stored template: a saved URL stays portable and survives a key
 * change. Only CARTO hosts are touched; OSM and self-hosted templates are not.
 */
const CARTO_HOST = /^(?:\{s\}|[a-d])?\.?basemaps\.cartocdn\.com$/i

function templateHost(url: string): string {
  return url.replace(/^\w*:?\/\//, '').split(/[/?#]/)[0]
}

export function withTileApiKey(url: string, key?: string | null): string {
  if (!url || !key) return url
  if (!CARTO_HOST.test(templateHost(url))) return url
  if (/[?&]key=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`
}

/** Keeps the key out of anything we persist: stored templates, book documents. */
export function stripTileApiKey(url: string): string {
  if (!url || !/[?&]key=/.test(url)) return url
  return url.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, '')
}

/**
 * A CARTO template with no key behind it. Those tiles come back with "API KEY
 * REQUIRED" burned into them since 26.08.2026 (#2054), which is worse than any
 * basemap, so they are not drawn at all — the map falls back to the app default
 * until a key is entered.
 *
 * Checked on the resolved URL rather than on the stored template, because that
 * is where the key has been appended: one rule, and it cannot disagree with
 * itself between call sites. The stored setting is deliberately left alone, so
 * the Map settings tab still shows what the user picked and its existing warning
 * still explains why.
 */
function isKeylessCarto(url: string): boolean {
  return CARTO_HOST.test(templateHost(url)) && !/[?&]key=/.test(url)
}

/**
 * A blank template means "not configured", not "no tiles": the settings
 * previews save an empty string and would otherwise render grey.
 */
export function resolveTileUrl(template: string | null | undefined, fallback: string, cartoKey?: string | null): string {
  const chosen = withTileApiKey(normalizeTileUrl(template?.trim() || fallback), cartoKey)
  return isKeylessCarto(chosen) ? fallback : chosen
}

/**
 * The basemap a map should draw, in the one shape every caller can act on.
 *
 * Two kinds exist since the move off CARTO. A raster template goes into a
 * Leaflet TileLayer as before; a vector style is a MapLibre style document that
 * Leaflet cannot render on its own and that VectorBasemap hangs into the tile
 * pane instead. Callers switch on `kind` rather than sniffing the URL, so a
 * self-hosted raster template keeps working exactly as it did.
 */
export type Basemap =
  | { kind: 'raster'; url: string }
  | { kind: 'vector'; style: string }

/** A MapLibre style document rather than a `{z}/{x}/{y}` tile template. */
export function isVectorStyle(url: string | null | undefined): boolean {
  if (!url) return false
  const u = url.trim()
  if (!u) return false
  // A tile template always carries its placeholders; a style URL never does.
  if (/\{[zxy]\}/i.test(u)) return false
  return /^https?:\/\//i.test(u) || u.startsWith('mapbox://')
}

/**
 * Tiles drawn in GCJ-02 rather than WGS-84.
 *
 * Amap serves its raster tiles from `*.is.autonavi.com`, and they are shifted
 * from the WGS-84 coordinates everything else in TREK uses — by 100 to 800 m
 * depending on where in China you are. A map on one of these has to project
 * through components/Map/gcj02Crs.ts or every marker lands on the wrong street.
 *
 * Matched on the host, not on the preset constants, so a self-hosted proxy in
 * front of the same tiles still gets the right CRS as long as the hostname
 * survives — and so a template a user typed in by hand does too.
 */
const GCJ02_TILE_HOST = /(^|\.)is\.autonavi\.com$/i

export function isGcj02Basemap(url: string | null | undefined): boolean {
  if (!url) return false
  return GCJ02_TILE_HOST.test(templateHost(url))
}

/**
 * What a map should draw, given the user's template and the app's default.
 *
 * `template` is the user's own choice and wins whenever they made one.
 * `fallback` is the app default and is a vector style now, so an unconfigured
 * map — and one left on a keyless CARTO template — gets OpenFreeMap.
 */
export function resolveBasemap(
  template: string | null | undefined,
  fallback: string,
  cartoKey?: string | null,
): Basemap {
  const chosen = resolveTileUrl(template, fallback, cartoKey)
  if (isVectorStyle(chosen)) return { kind: 'vector', style: chosen }
  return { kind: 'raster', url: chosen }
}
