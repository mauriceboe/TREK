import { wgs84ToGcj02 } from '@trek/shared'
import type { AssignmentPlace, Place } from '../../types'

type PlaceLike = Pick<Place | AssignmentPlace, 'name' | 'lat' | 'lng'>

/**
 * Open a place in Amap (高德地图), which is what a phone in China has installed.
 *
 * `uri.amap.com` is Amap's own cross-platform handover endpoint: it opens the app
 * when it is present and falls back to Amap's web map when it is not, which is
 * the same property that made the https form the right choice for CoMaps. The
 * `src` and `callnative` parameters are what Amap documents for this: `callnative=1`
 * asks it to hand over to the app rather than staying on the web page.
 *
 * The coordinate is converted to GCJ-02 first. Amap reads `position` in its own
 * datum, and TREK stores WGS-84, so handing the stored value over unconverted
 * drops the pin a few hundred metres away — far enough, in a city, to be the
 * wrong block. This is the mirror image of what the server does when it reads an
 * Amap result (see server/src/nest/maps/providers/amap.provider.ts).
 *
 * Longitude first, unlike every other coordinate pair in this codebase: that is
 * the order Amap's URI API specifies.
 */
export function getAmapUrlForPlace(place: PlaceLike | null | undefined): string | null {
  if (!place || place.lat == null || place.lng == null) return null
  const gcj = wgs84ToGcj02(place.lat, place.lng)
  const position = `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`
  const name = place.name?.trim()
  // Amap labels the marker from `name` and refuses the request without one, so an
  // unnamed place gets its coordinates as the label rather than no link at all.
  const label = encodeURIComponent(name || position)
  return `https://uri.amap.com/marker?position=${position}&name=${label}&src=trek&coordinate=gaode&callnative=1`
}
