import L from 'leaflet'
import { gcj02ToWgs84, wgs84ToGcj02 } from '@trek/shared'

/**
 * A Leaflet CRS that draws WGS-84 coordinates on GCJ-02 tiles.
 *
 * Amap's raster tiles are rendered in GCJ-02 — the datum Chinese law requires
 * published maps to use — while every coordinate in TREK is WGS-84: the database
 * columns, the search results, the routes from OSRM, an imported GPX track. Put
 * one on the other untouched and every marker sits a few hundred metres from the
 * building it names, which around a city block is the wrong street.
 *
 * The fix could live in three places, and two of them are worse:
 *
 *  - Converting each marker at the call site means every component that draws
 *    anything on a map has to know which basemap is loaded — MapView,
 *    JourneyMap, CollectionMap, the cluster group, the route polylines, the
 *    bounds fitting, the click handler that turns a pixel back into a place.
 *    Miss one and it is off by 300 m with no error anywhere.
 *  - A constant offset is not a fix at all: the shift is a function of position,
 *    ranging from roughly 100 m to 800 m across the country.
 *
 * So it goes into the projection, which is the one place every coordinate
 * already passes through. `project` shifts WGS-84 → GCJ-02 before the standard
 * Web Mercator maths, `unproject` shifts back, and everything above it —
 * markers, polylines, `getBounds`, `containerPointToLatLng` — keeps speaking
 * WGS-84 without knowing this exists.
 *
 * Everything else is inherited from EPSG3857 on purpose: Amap's tile grid IS
 * standard Web Mercator (same zoom levels, same 256 px tiles, same origin), so
 * the scale and the transformation must not change. Only the datum does.
 * `distance()` also stays as it is and stays correct, because it is handed
 * WGS-84 latitudes.
 */
function buildCrs(): L.CRS {
  const mercator = L.Projection.SphericalMercator
  const projection: L.Projection = {
    project(latlng: L.LatLng): L.Point {
      const gcj = wgs84ToGcj02(latlng.lat, latlng.lng)
      return mercator.project(L.latLng(gcj.lat, gcj.lng))
    },
    unproject(point: L.Point): L.LatLng {
      const gcj = mercator.unproject(point)
      const wgs = gcj02ToWgs84(gcj.lat, gcj.lng)
      return L.latLng(wgs.lat, wgs.lng)
    },
    bounds: mercator.bounds,
  }
  return L.Util.extend({}, L.CRS.EPSG3857, { code: 'TREK:GCJ02', projection }) as L.CRS
}

/**
 * Built on first use, not at import.
 *
 * Reading `L.Projection.SphericalMercator` while the module graph loads means
 * every importer of MapView has to have a fully-formed Leaflet — which the map
 * component tests deliberately do not, they mock it down to the handful of
 * exports they assert on. A basemap nobody selected should not be able to break
 * an unrelated test file, or a build, by existing.
 */
let cached: L.CRS | null = null

export function getCrsGcj02(): L.CRS {
  if (!cached) cached = buildCrs()
  return cached
}

/**
 * The CRS a map should use for a given basemap.
 *
 * Returning `undefined` rather than `L.CRS.EPSG3857` matters: passing a `crs`
 * option to a MapContainer is what pins it, and Leaflet cannot change a map's
 * CRS after construction. Handing back undefined lets the component omit the
 * prop entirely for the 99% of installs on a WGS-84 basemap, which keeps their
 * map byte-identical to what it was.
 */
export function crsForBasemap(isGcj02: boolean): L.CRS | undefined {
  return isGcj02 ? getCrsGcj02() : undefined
}
