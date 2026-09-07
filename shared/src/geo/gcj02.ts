/**
 * WGS-84 ⇄ GCJ-02 conversion.
 *
 * Everything TREK stores and draws is WGS-84: the database columns, Nominatim,
 * Overpass, OSRM, GPX and KML, and every Leaflet/MapLibre coordinate. Chinese
 * providers are not allowed to publish that datum — Amap (高德) returns and
 * expects GCJ-02, the "Mars coordinates" obfuscation, which is offset from
 * WGS-84 by roughly 300–800 m depending on where you are.
 *
 * So this file exists to keep exactly one datum inside the app. It is used at
 * two boundaries and nowhere else:
 *
 *   - server/src/nest/maps/providers/amap.provider.ts converts on the way out
 *     and back in, so a place that reaches the database is always WGS-84.
 *   - client/src/components/Map/gcj02Crs.ts folds the shift into a Leaflet
 *     projection, so GCJ-02 raster tiles line up with WGS-84 markers without
 *     any component having to know which basemap is loaded.
 *
 * The algorithm is the widely used published approximation (the same one every
 * `coordtransform`-style library implements). It is not the state secret itself
 * and is accurate to a metre or two, which is well inside the precision a POI
 * search result carries. `gcj02ToWgs84` inverts it numerically rather than with
 * the common one-shot "subtract the same offset" trick: the offset is a function
 * of position, so subtracting it at the wrong position leaves a few metres of
 * error, and a round trip through a search result and back into a share link
 * would drift visibly.
 */

/** Krasovsky 1940 semi-major axis, the ellipsoid the published offset uses. */
const A = 6378245;
/** Its first eccentricity squared. */
const EE = 0.006_693_421_622_965_943;
const PI = Math.PI;

/**
 * True when GCJ-02 does not apply and the coordinate must pass through
 * untouched.
 *
 * Without this every foreign trip in TREK would move: the offset formula is
 * happy to evaluate anywhere on earth, so applying it to Paris shifts Paris.
 * The bounding box is deliberately the crude one every implementation uses —
 * it over-covers, reaching into the sea and into neighbouring countries, but
 * erring that way only means a coordinate in the border area gets a shift of a
 * few hundred metres applied consistently in both directions, which round-trips
 * cleanly. A tighter polygon would risk the far worse failure of converting one
 * way and not the other.
 *
 * Hong Kong, Macau and Taiwan are inside the box. That matches what Amap
 * actually serves for them, so it is not an oversight.
 */
export function isOutsideChina(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}

/** The position-dependent offset added to a WGS-84 point to get GCJ-02. */
function offset(lat: number, lng: number): { dLat: number; dLng: number } {
  const x = lng - 105;
  const y = lat - 35;
  let dLat = transformLat(x, y);
  let dLng = transformLng(x, y);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { dLat, dLng };
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** WGS-84 → GCJ-02. Outside China the input is returned unchanged. */
export function wgs84ToGcj02(lat: number, lng: number): LatLng {
  if (isOutsideChina(lat, lng)) return { lat, lng };
  const { dLat, dLng } = offset(lat, lng);
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * GCJ-02 → WGS-84, solved rather than approximated.
 *
 * The forward offset is a function of the *WGS-84* position, so the usual
 * `wgs - (gcj_of_gcj - gcj)` shortcut evaluates it at the wrong point and
 * leaves several metres of error. Newton would need the Jacobian of a sum of
 * sines; a fixed-point iteration converges just as fast here because the offset
 * varies slowly with position, and it cannot diverge. Three or four passes reach
 * the double-precision floor; the loop below stops as soon as a pass moves the
 * answer by less than ~1e-9° (about 0.1 mm) and is capped so a pathological
 * input cannot spin.
 */
export function gcj02ToWgs84(lat: number, lng: number): LatLng {
  if (isOutsideChina(lat, lng)) return { lat, lng };
  let guessLat = lat;
  let guessLng = lng;
  for (let i = 0; i < 10; i++) {
    const forward = wgs84ToGcj02(guessLat, guessLng);
    const errLat = forward.lat - lat;
    const errLng = forward.lng - lng;
    if (Math.abs(errLat) < 1e-9 && Math.abs(errLng) < 1e-9) break;
    guessLat -= errLat;
    guessLng -= errLng;
  }
  return { lat: guessLat, lng: guessLng };
}

/**
 * Amap spells a coordinate `lng,lat` in a single string, with six decimals, and
 * rejects more than that on some endpoints. Longitude first is the opposite of
 * every other coordinate in this codebase, so the ordering lives here once
 * instead of at each call site.
 */
export function toAmapLocation(lat: number, lng: number): string {
  const gcj = wgs84ToGcj02(lat, lng);
  return `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`;
}

/**
 * Parse Amap's `"lng,lat"` back into a WGS-84 pair, or null when the field is
 * missing or unparseable — which Amap does do: a POI with no geometry comes
 * back with `location: []` rather than with the key absent.
 */
export function fromAmapLocation(location: unknown): LatLng | null {
  if (typeof location !== 'string') return null;
  const parts = location.split(',');
  if (parts.length !== 2) return null;
  // Destructured with a default rather than indexed: under noUncheckedIndexedAccess
  // an index into a length-checked array is still `string | undefined`.
  const [lngText = '', latText = ''] = parts;
  const lng = Number.parseFloat(lngText);
  const lat = Number.parseFloat(latText);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return gcj02ToWgs84(lat, lng);
}
