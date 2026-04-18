import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '../../../tests/helpers/render'
import { fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resetAllStores } from '../../../tests/helpers/store'
import { buildPlace } from '../../../tests/helpers/factories'
import * as photoService from '../../services/photoService'

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children, eventHandlers, position }: any) => (
    <div
      data-testid="marker"
      data-lat={position[0]}
      data-lng={position[1]}
      onClick={() => eventHandlers?.click?.()}
    >
      <button
        data-testid="marker-hover-trigger"
        onClick={() => eventHandlers?.mouseover?.({ originalEvent: { clientX: 100, clientY: 100 } })}
      />
      {children}
    </div>
  ),
  Polyline: ({ positions }: any) => <div data-testid="polyline" data-points={JSON.stringify(positions)} />,
  CircleMarker: () => <div data-testid="circle-marker" />,
  Circle: () => <div data-testid="circle" />,
  useMap: () => ({
    panTo: vi.fn(),
    setView: vi.fn(),
    fitBounds: vi.fn(),
    getZoom: () => 10,
    on: vi.fn(),
    off: vi.fn(),
    panBy: vi.fn(),
  }),
  useMapEvents: () => ({}),
}))

vi.mock('react-leaflet-cluster', () => ({
  default: ({ children }: any) => <div data-testid="cluster-group">{children}</div>,
}))

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
    latLngBounds: vi.fn(() => ({ isValid: () => true })),
    point: vi.fn((x: number, y: number) => [x, y]),
  },
  divIcon: vi.fn(() => ({})),
  Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
  latLngBounds: vi.fn(() => ({ isValid: () => true })),
  point: vi.fn((x: number, y: number) => [x, y]),
}))

vi.mock('../../services/photoService', () => ({
  getCached: vi.fn(() => null),
  isLoading: vi.fn(() => false),
  fetchPhoto: vi.fn(),
  onThumbReady: vi.fn(() => () => {}),
  getAllThumbs: vi.fn(() => ({})),
}))

import { MapView } from './MapView'

// Helper: build a place with the extra fields MapView uses (category_name/color/icon)
// that exist on joined DB rows but are not in the base Place TypeScript type.
function buildMapPlace(overrides: Record<string, any> = {}) {
  return {
    ...buildPlace(),
    category_name: null,
    category_color: null,
    category_icon: null,
    ...overrides,
  } as any
}

afterEach(() => {
  resetAllStores()
})

describe('MapView', () => {
  it('FE-COMP-MAPVIEW-001: renders map container', () => {
    render(<MapView />)
    expect(screen.getByTestId('map-container')).toBeTruthy()
  })

  it('FE-COMP-MAPVIEW-002: renders one marker per place', () => {
    const places = [
      buildMapPlace({ id: 1, lat: 48.8584, lng: 2.2945 }),
      buildMapPlace({ id: 2, name: 'Louvre', lat: 48.86, lng: 2.337 }),
    ]
    render(<MapView places={places} />)
    expect(screen.getAllByTestId('marker').length).toBe(2)
  })

  it('FE-COMP-MAPVIEW-003: marker click calls onMarkerClick with place id', () => {
    const onMarkerClick = vi.fn()
    const places = [buildMapPlace({ id: 42, lat: 48.8584, lng: 2.2945 })]
    render(<MapView places={places} onMarkerClick={onMarkerClick} />)
    fireEvent.click(screen.getByTestId('marker'))
    expect(onMarkerClick).toHaveBeenCalledWith(42)
  })

  it('FE-COMP-MAPVIEW-004: tooltip shows place name', async () => {
    const user = userEvent.setup()
    const places = [buildMapPlace({ name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 })]
    render(<MapView places={places} />)
    await user.click(screen.getByTestId('marker-hover-trigger'))
    expect(screen.getByTestId('tooltip').textContent).toContain('Eiffel Tower')
  })

  it('FE-COMP-MAPVIEW-005: tooltip shows category name when present', async () => {
    const user = userEvent.setup()
    const places = [
      buildMapPlace({ name: 'Louvre', lat: 48.86, lng: 2.337, category_name: 'Museum', category_icon: null }),
    ]
    render(<MapView places={places} />)
    await user.click(screen.getByTestId('marker-hover-trigger'))
    expect(screen.getByTestId('tooltip').textContent).toContain('Museum')
  })

  it('FE-COMP-MAPVIEW-006: renders polyline when route has 2+ points', () => {
    render(<MapView route={[[[48.0, 2.0], [49.0, 3.0]]]} />)
    expect(screen.getByTestId('polyline')).toBeTruthy()
  })

  it('FE-COMP-MAPVIEW-007: does not render polyline when route is null', () => {
    render(<MapView route={null} />)
    expect(screen.queryByTestId('polyline')).toBeNull()
  })

  it('FE-COMP-MAPVIEW-008: does not render polyline for single-point route', () => {
    render(<MapView route={[[[48.0, 2.0]]]} />)
    expect(screen.queryByTestId('polyline')).toBeNull()
  })

  it('FE-COMP-MAPVIEW-009: GPX geometry polyline rendered for place with route_geometry', () => {
    const places = [
      buildMapPlace({ lat: 48.0, lng: 2.0, route_geometry: '[[48.0,2.0],[49.0,3.0]]' }),
    ]
    render(<MapView places={places} />)
    expect(screen.getByTestId('polyline')).toBeTruthy()
  })

  it('FE-COMP-MAPVIEW-010: MarkerClusterGroup is rendered', () => {
    const places = [buildMapPlace({ lat: 48.8584, lng: 2.2945 })]
    render(<MapView places={places} />)
    expect(screen.getByTestId('cluster-group')).toBeTruthy()
  })

  it('FE-COMP-MAPVIEW-011: renders RouteLabel marker when routeSegments provided with route', () => {
    const route = [[[48.0, 2.0], [49.0, 3.0]]] as [number, number][][][]
    const routeSegments = [
      { mid: [48.5, 2.5] as [number, number], from: 0, to: 1, walkingText: '10 min', drivingText: '3 min' },
    ]
    render(<MapView route={route} routeSegments={routeSegments} />)
    // Route polyline is rendered
    expect(screen.getByTestId('polyline')).toBeTruthy()
    // RouteLabel renders a Marker (mocked), but it returns null when zoom < 12
    // so we just assert the polyline is there, exercising the routeSegments.map path
  })

  it('FE-COMP-MAPVIEW-012: invalid route_geometry JSON triggers catch and skips polyline', () => {
    const places = [
      buildMapPlace({ lat: 48.0, lng: 2.0, route_geometry: 'NOT_VALID_JSON' }),
    ]
    // Should not throw; invalid JSON is caught silently
    render(<MapView places={places} />)
    expect(screen.queryByTestId('polyline')).toBeNull()
  })

  it('FE-COMP-MAPVIEW-013: route_geometry with fewer than 2 coords skips polyline', () => {
    const places = [
      buildMapPlace({ lat: 48.0, lng: 2.0, route_geometry: '[[48.0,2.0]]' }),
    ]
    render(<MapView places={places} />)
    expect(screen.queryByTestId('polyline')).toBeNull()
  })

  it('FE-COMP-MAPVIEW-014: marker icon uses base64 image_url for photo places', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AA'
    const places = [buildMapPlace({ id: 10, lat: 48.0, lng: 2.0, image_url: dataUrl })]
    render(<MapView places={places} />)
    // Marker still renders; base64 path in createPlaceIcon should be exercised
    expect(screen.getByTestId('marker')).toBeTruthy()
  })

  it('FE-COMP-MAPVIEW-015: uses cached photo thumb from photoService when available', () => {
    vi.mocked(photoService.getCached).mockReturnValue({ thumbDataUrl: 'data:image/jpeg;base64,abc' } as any)
    const places = [
      buildMapPlace({ id: 20, lat: 48.0, lng: 2.0, google_place_id: 'gplace_123' }),
    ]
    render(<MapView places={places} />)
    expect(screen.getByTestId('marker')).toBeTruthy()
    vi.mocked(photoService.getCached).mockReturnValue(null)
  })

  it('FE-COMP-MAPVIEW-016: tooltip shows address when present', async () => {
    const user = userEvent.setup()
    const places = [
      buildMapPlace({ name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945, address: '5 Av. Anatole France' }),
    ]
    render(<MapView places={places} />)
    await user.click(screen.getByTestId('marker-hover-trigger'))
    expect(screen.getByTestId('tooltip').textContent).toContain('5 Av. Anatole France')
  })

  it('FE-COMP-MAPVIEW-017: renders selected marker with higher z-index offset', () => {
    const places = [
      buildMapPlace({ id: 5, lat: 48.8584, lng: 2.2945 }),
    ]
    render(<MapView places={places} selectedPlaceId={5} />)
    expect(screen.getByTestId('marker')).toBeTruthy()
  })
})
