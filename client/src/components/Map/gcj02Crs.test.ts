import { describe, expect, it } from 'vitest'
import L from 'leaflet'
import { crsForBasemap, getCrsGcj02 } from './gcj02Crs'

const CRS_GCJ02 = getCrsGcj02()

/**
 * What these guard is the one failure that cannot be seen in a screenshot review
 * of a map full of Chinese labels: a marker drawn a few hundred metres from where
 * it belongs still looks like a perfectly plausible map.
 */
describe('CRS_GCJ02', () => {
  it('projects a WGS-84 coordinate onto the GCJ-02 tile grid', () => {
    const wgs = L.latLng(39.90869, 116.39124)
    const shifted = CRS_GCJ02.latLngToPoint(wgs, 15)
    const unshifted = L.CRS.EPSG3857.latLngToPoint(wgs, 15)

    // At zoom 15 the GCJ-02 offset is worth several hundred pixels, so a map that
    // silently kept EPSG3857 would fail here rather than being off by a rounding.
    const dx = Math.abs(shifted.x - unshifted.x)
    const dy = Math.abs(shifted.y - unshifted.y)
    expect(Math.hypot(dx, dy)).toBeGreaterThan(20)
  })

  it('round-trips a coordinate through the pixel plane', () => {
    const wgs = L.latLng(31.2304, 121.4737)
    const back = CRS_GCJ02.pointToLatLng(CRS_GCJ02.latLngToPoint(wgs, 18), 18)
    // Sub-metre at zoom 18, i.e. the click handler and the marker agree.
    expect(back.lat).toBeCloseTo(wgs.lat, 6)
    expect(back.lng).toBeCloseTo(wgs.lng, 6)
  })

  it('leaves a coordinate outside China exactly where EPSG3857 puts it', () => {
    // Otherwise choosing an Amap basemap would move every foreign trip in the
    // account, which is a far bigger failure than the one this file prevents.
    const paris = L.latLng(48.8566, 2.3522)
    const shifted = CRS_GCJ02.latLngToPoint(paris, 15)
    const plain = L.CRS.EPSG3857.latLngToPoint(paris, 15)
    expect(shifted.x).toBeCloseTo(plain.x, 6)
    expect(shifted.y).toBeCloseTo(plain.y, 6)
  })

  it('keeps the Web Mercator tile grid, because Amap uses the standard one', () => {
    // Same scale and same transformation as EPSG3857: only the datum differs. If
    // this drifts, tiles are requested at the wrong zoom or the wrong origin and
    // the map is visibly broken rather than subtly offset.
    expect(CRS_GCJ02.scale(12)).toBe(L.CRS.EPSG3857.scale(12))
    expect(CRS_GCJ02.code).toBe('TREK:GCJ02')
  })

  it('measures distance in WGS-84, since that is what it is handed', () => {
    const a = L.latLng(39.90869, 116.39124)
    const b = L.latLng(39.91869, 116.39124)
    expect(CRS_GCJ02.distance(a, b)).toBeCloseTo(L.CRS.EPSG3857.distance(a, b), 6)
  })
})

describe('crsForBasemap', () => {
  it('returns undefined for a WGS-84 basemap so the map keeps Leaflet\u2019s default', () => {
    // Not L.CRS.EPSG3857: passing the prop at all pins the CRS, and the point is
    // that a map on an ordinary basemap is constructed exactly as it was before.
    expect(crsForBasemap(false)).toBeUndefined()
  })

  it('returns the shifted CRS for a GCJ-02 basemap', () => {
    expect(crsForBasemap(true)).toBe(getCrsGcj02())
  })
})
