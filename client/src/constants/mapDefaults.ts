export const DEFAULT_MAP_LAT = 0
export const DEFAULT_MAP_LNG = 0
export const DEFAULT_MAP_ZOOM = 2
export const DEFAULT_MAP_CENTER: [number, number] = [DEFAULT_MAP_LAT, DEFAULT_MAP_LNG]

/**
 * Zoom ceiling for a Leaflet map, set on the map rather than on its base layer.
 *
 * Leaflet answers `getMaxZoom()` from the map options first and only then from a
 * layer that carried one, and only a GridLayer ever contributes: a vector
 * basemap is a GL canvas, so a map drawn by one has no ceiling from anywhere.
 * `MarkerClusterGroup.onAdd` refuses an infinite ceiling by throwing, which is
 * how a basemap choice could take down the whole planner. Matches the raster and
 * satellite layers so nothing changes for the maps that already had one.
 */
export const MAP_MAX_ZOOM = 19

// Tokenless satellite base layer (ESRI World Imagery) — works without an API key.
export const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const SATELLITE_TILE_ATTRIBUTION =
  'Imagery &copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics'
export const SATELLITE_TILE_MAXZOOM = 19

// OpenFreeMap, the default basemap since CARTO began watermarking keyless tiles
// on 26.08.2026 and moved its key behind a request by mail. No key, no
// registration, no request limits, commercial use allowed, attribution required.
//
// These are MapLibre STYLE documents, not {z}/{x}/{y} templates: OpenFreeMap
// serves vector tiles only. Leaflet draws them through VectorBasemap. Positron
// is the same design CARTO's light basemap was, so the maps look like they did.
export const OFM_POSITRON = 'https://tiles.openfreemap.org/styles/positron'
export const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark'
export const OFM_ATTRIBUTION =
  '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/**
 * Amap (高德) raster basemaps.
 *
 * The reason to offer these at all: OpenStreetMap and OpenFreeMap are thin
 * inside mainland China, and every foreign tile CDN is slow or unreachable from
 * a Chinese network. These are the tiles a Chinese user expects to see.
 *
 * `style=7` is the road map, `style=6` is satellite imagery. `lang=zh_cn`
 * because these are the labels the tiles exist for; an install that wants
 * English labels is better served by OpenFreeMap.
 *
 * A single host rather than the `webrd0{1..4}` shard family Amap also serves:
 * `{s}` in a Leaflet template is substituted from `subdomains`, which defaults
 * to a/b/c and would produce `webrd0a`. Every consumer of a stored template
 * would have to pass digits instead, and over HTTP/2 the sharding buys nothing.
 *
 * IMPORTANT: these tiles are drawn in GCJ-02, not WGS-84. Everything else in
 * TREK — every marker, route and bounding box — is WGS-84, and dropping one
 * datum on top of the other puts markers a few hundred metres off the street
 * they belong to. isGcj02Basemap() in utils/tileUrl.ts spots these URLs and the
 * map switches to the shifted CRS in components/Map/gcj02Crs.ts. Anything added
 * here that serves GCJ-02 tiles must be recognised by that predicate too.
 */
export const AMAP_ROAD = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}'
export const AMAP_SATELLITE = 'https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'
export const AMAP_ATTRIBUTION = '&copy; <a href="https://amap.com">高德地图</a>'

/**
 * Attribution for whatever basemap a map ended up with. OpenFreeMap asks for a
 * credit of its own, and printing OpenStreetMap alone under its tiles is both
 * wrong and a licence problem, so the URL decides rather than a flag at the
 * call site.
 */
export function attributionForTile(url: string | null | undefined): string {
  if (!url) return OSM_ATTRIBUTION
  if (url.includes('openfreemap.org')) return OFM_ATTRIBUTION
  if (url.includes('arcgisonline.com')) return SATELLITE_TILE_ATTRIBUTION
  if (url.includes('autonavi.com')) return AMAP_ATTRIBUTION
  return OSM_ATTRIBUTION
}

// CARTO basemaps. Keyless tiles carry an "API KEY REQUIRED" watermark since
// 26.08.2026, so these are always passed through withTileApiKey() (#2054).
// Kept as an opt-in for operators who hold a key; nothing defaults to them.
export const CARTO_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
export const CARTO_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
export const CARTO_LIGHT_NOLABELS = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png'
export const CARTO_DARK_NOLABELS = 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
export const CARTO_VOYAGER = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
