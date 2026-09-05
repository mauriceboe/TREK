import { describe, it, expect } from 'vitest'
import {
  computeMapViewport,
  MAX_ZOOM_GL,
  MAX_ZOOM_RASTER,
  SINGLE_PLACE_ZOOM_RASTER,
  TILE_SIZE_GL,
  TILE_SIZE_RASTER,
} from './mapViewport'

// Pin the container size so no assertion depends on jsdom's window dimensions.
const VIEW = { width: 1000, height: 800 } as const

const PARIS = { lat: 48.8566, lng: 2.3522 }
const LYON = { lat: 45.764, lng: 4.8357 }

/**
 * The invariant that actually matters: every place must land inside the container at the
 * returned camera. Mirrors the Mercator projection the map uses.
 */
function screenPosition(
  point: { lat: number; lng: number },
  viewport: { center: [number, number]; zoom: number },
  tileSize: number,
  size = VIEW,
  // Only MapLibre/Mapbox redraw a marker on the nearest copy of the world. Leaflet places it
  // at its absolute projected position, so assuming a wrap here would hide exactly the bug
  // that puts a marker off-screen in the real app.
  wrapsWorld = false,
): { x: number; y: number } {
  const project = (lat: number, lng: number) => {
    const scale = tileSize * Math.pow(2, viewport.zoom)
    const sin = Math.sin((lat * Math.PI) / 180)
    return {
      x: scale * (lng / 360 + 0.5),
      y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
    }
  }
  const p = project(point.lat, point.lng)
  const c = project(viewport.center[0], viewport.center[1])

  const worldWidth = tileSize * Math.pow(2, viewport.zoom)
  const raw = p.x - c.x
  const dx = wrapsWorld
    ? ((raw + worldWidth / 2) % worldWidth + worldWidth) % worldWidth - worldWidth / 2
    : raw

  return { x: dx + size.width / 2, y: p.y - c.y + size.height / 2 }
}

describe('computeMapViewport', () => {
  it('frames a set of places so all of them are on screen', () => {
    const viewport = computeMapViewport([PARIS, LYON], { ...VIEW, tileSize: TILE_SIZE_RASTER })!

    // Latitude is the midpoint in projected space, so it sits near — but not exactly on —
    // the arithmetic mean; Mercator stretches towards the poles. Longitude is linear.
    expect(viewport.center[0]).toBeCloseTo((PARIS.lat + LYON.lat) / 2, 1)
    expect(viewport.center[1]).toBeCloseTo((PARIS.lng + LYON.lng) / 2, 6)

    for (const place of [PARIS, LYON]) {
      const { x, y } = screenPosition(place, viewport, TILE_SIZE_RASTER)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(VIEW.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(VIEW.height)
    }
  })

  it('opens at city level for a single place', () => {
    const viewport = computeMapViewport([PARIS], { ...VIEW, tileSize: TILE_SIZE_RASTER })!

    expect(viewport.center[0]).toBeCloseTo(PARIS.lat, 6)
    expect(viewport.center[1]).toBeCloseTo(PARIS.lng, 6)
    expect(viewport.zoom).toBe(SINGLE_PLACE_ZOOM_RASTER)
  })

  it('treats several places stacked on one spot as a single place, without dividing by zero', () => {
    const viewport = computeMapViewport([PARIS, { ...PARIS }, { ...PARIS }], {
      ...VIEW,
      tileSize: TILE_SIZE_RASTER,
    })!

    expect(Number.isFinite(viewport.zoom)).toBe(true)
    expect(viewport.zoom).toBe(SINGLE_PLACE_ZOOM_RASTER)
  })

  it('frames places sharing a latitude, using the longitude span alone', () => {
    const viewport = computeMapViewport(
      [{ lat: 48.8566, lng: 2.0 }, { lat: 48.8566, lng: 4.0 }],
      { ...VIEW, tileSize: TILE_SIZE_RASTER },
    )!

    expect(Number.isFinite(viewport.zoom)).toBe(true)
    expect(viewport.zoom).toBeLessThan(MAX_ZOOM_RASTER)
    expect(viewport.center[1]).toBeCloseTo(3.0, 3)
  })

  it('returns null when nothing has usable coordinates', () => {
    expect(computeMapViewport([], VIEW)).toBeNull()
    expect(computeMapViewport([{ lat: null, lng: null }], VIEW)).toBeNull()
    expect(computeMapViewport([{ lat: 48.85, lng: null }], VIEW)).toBeNull()
    expect(computeMapViewport([{ lat: NaN, lng: 2.35 }], VIEW)).toBeNull()
    expect(computeMapViewport([{ lat: 200, lng: 2.35 }], VIEW)).toBeNull()
    expect(computeMapViewport([{ lat: 48.85, lng: 999 }], VIEW)).toBeNull()
  })

  it('treats 0,0 as a real coordinate rather than a missing one', () => {
    const viewport = computeMapViewport([{ lat: 0, lng: 0 }], { ...VIEW, tileSize: TILE_SIZE_RASTER })

    expect(viewport).not.toBeNull()
    expect(viewport!.center[0]).toBeCloseTo(0, 6)
    expect(viewport!.center[1]).toBeCloseTo(0, 6)
  })

  const FIJI = { lat: -18.14, lng: 178.44 }
  const SAMOA = { lat: -13.76, lng: -172.1 }

  it('takes the short way round the antimeridian on a renderer that wraps the world', () => {
    // Fiji and Samoa are 10 degrees apart, not 350 — MapLibre/Mapbox draw each marker on the
    // copy of the world nearest the camera, so this centre is safe there.
    const viewport = computeMapViewport([FIJI, SAMOA], { ...VIEW, tileSize: TILE_SIZE_GL })!

    expect(viewport.center[1]).toBeCloseTo(-176.83, 1)
    // A 350-degree span would have collapsed the zoom to the world view.
    expect(viewport.zoom).toBeGreaterThan(3)
  })

  it('goes the long way round on Leaflet, which does not wrap markers', () => {
    // Leaflet draws a single world and places markers at their absolute position. Centring on
    // the antimeridian would leave one of these two outside it entirely — so span the 350
    // degrees instead, as L.latLngBounds would.
    const viewport = computeMapViewport([FIJI, SAMOA], { ...VIEW, tileSize: TILE_SIZE_RASTER })!

    expect(viewport.center[1]).toBeCloseTo(3.17, 1)
    // Nearly the whole globe: zoomed right out, not framed tight on the Pacific.
    expect(viewport.zoom).toBeLessThanOrEqual(2)

    for (const place of [FIJI, SAMOA]) {
      const { x } = screenPosition(place, viewport, TILE_SIZE_RASTER)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(VIEW.width)
    }
  })

  it('clamps latitude at the poles instead of projecting to infinity', () => {
    const viewport = computeMapViewport(
      [{ lat: 90, lng: 0 }, { lat: 80, lng: 10 }],
      { ...VIEW, tileSize: TILE_SIZE_RASTER },
    )!

    expect(Number.isFinite(viewport.zoom)).toBe(true)
    expect(viewport.center[0]).toBeLessThanOrEqual(85.0511)
  })

  it('returns a GL zoom exactly one level below the raster zoom for the same view', () => {
    const raster = computeMapViewport([PARIS, LYON], { ...VIEW, tileSize: TILE_SIZE_RASTER })!
    const gl = computeMapViewport([PARIS, LYON], { ...VIEW, tileSize: TILE_SIZE_GL })!

    expect(gl.zoom).toBeCloseTo(raster.zoom - 1, 6)
    expect(gl.center).toEqual(raster.center)
  })

  it('never zooms past the renderer maxZoom for two nearly identical places', () => {
    const almost = { lat: PARIS.lat + 0.00001, lng: PARIS.lng + 0.00001 }

    expect(computeMapViewport([PARIS, almost], { ...VIEW, tileSize: TILE_SIZE_RASTER })!.zoom)
      .toBe(MAX_ZOOM_RASTER)
    expect(computeMapViewport([PARIS, almost], { ...VIEW, tileSize: TILE_SIZE_GL })!.zoom)
      .toBe(MAX_ZOOM_GL)
  })

  // Sydney, Reykjavik and Santiago: the narrowest arc containing all three crosses the
  // antimeridian. On Leaflet that centre put Sydney outside the one world it draws — the
  // marker simply vanished. Assert against each renderer's real wrapping behaviour.
  const GLOBE = [
    { lat: -33.87, lng: 151.21 },  // Sydney
    { lat: 64.15, lng: -21.94 },   // Reykjavik
    { lat: -33.45, lng: -70.67 },  // Santiago
  ]

  it('keeps a globe-spanning trip on screen in Leaflet, which does not wrap', () => {
    const viewport = computeMapViewport(GLOBE, { ...VIEW, tileSize: TILE_SIZE_RASTER })!

    expect(viewport.zoom).toBeGreaterThanOrEqual(0)
    expect(viewport.zoom).toBeLessThan(5)

    for (const place of GLOBE) {
      const { x, y } = screenPosition(place, viewport, TILE_SIZE_RASTER)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(VIEW.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(VIEW.height)
    }
  })

  it('keeps a globe-spanning trip on screen in GL, which does wrap', () => {
    const viewport = computeMapViewport(GLOBE, { ...VIEW, tileSize: TILE_SIZE_GL })!

    for (const place of GLOBE) {
      const { x, y } = screenPosition(place, viewport, TILE_SIZE_GL, VIEW, true)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(VIEW.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(VIEW.height)
    }
  })

  it('shifts the center so places clear a left-hand panel', () => {
    const unpadded = computeMapViewport([PARIS, LYON], { ...VIEW, tileSize: TILE_SIZE_RASTER })!
    const padded = computeMapViewport([PARIS, LYON], {
      ...VIEW,
      tileSize: TILE_SIZE_RASTER,
      padding: { left: 400 },
    })!

    // The camera pulls west so the places sit right of the panel, in the visible area.
    expect(padded.center[1]).toBeLessThan(unpadded.center[1])

    // And they still fit: the panel eats 400px, so check against the visible width.
    for (const place of [PARIS, LYON]) {
      const { x } = screenPosition(place, padded, TILE_SIZE_RASTER)
      expect(x).toBeGreaterThanOrEqual(400)
      expect(x).toBeLessThanOrEqual(VIEW.width)
    }
  })

  // Two 300px planner panels on an 860px foldable left the framing window 140px
  // wide, and the camera then opened on half of East Asia instead of the trip
  // (#2247). The layout fix stops it happening; this stops it mattering.
  it('never frames the camera for less than a third of the box, however wide the padding', () => {
    const sane = computeMapViewport([PARIS, LYON], {
      ...VIEW,
      tileSize: TILE_SIZE_RASTER,
      padding: { left: 380, right: 340 },
    })!
    const absurd = computeMapViewport([PARIS, LYON], {
      ...VIEW,
      tileSize: TILE_SIZE_RASTER,
      padding: { left: 480, right: 480 },
    })!
    // 1000 - 960 = 40px of window would zoom ~2.5 levels further out than the
    // third the clamp guarantees.
    const floored = computeMapViewport([PARIS, LYON], {
      width: VIEW.width / 3,
      height: VIEW.height,
      tileSize: TILE_SIZE_RASTER,
    })!
    expect(absurd.zoom).toBe(floored.zoom)
    expect(absurd.zoom).toBeGreaterThan(sane.zoom - 3)
  })

  it('leaves a sane padding untouched', () => {
    const withPadding = computeMapViewport([PARIS, LYON], {
      ...VIEW,
      tileSize: TILE_SIZE_RASTER,
      padding: { left: 200, right: 100 },
    })!
    const equivalent = computeMapViewport([PARIS, LYON], {
      width: VIEW.width - 300,
      height: VIEW.height,
      tileSize: TILE_SIZE_RASTER,
    })!
    expect(withPadding.zoom).toBe(equivalent.zoom)
  })
})
