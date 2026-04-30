import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render } from '../../../tests/helpers/render'
import { act } from '@testing-library/react'
import { resetAllStores } from '../../../tests/helpers/store'
import { buildPlace } from '../../../tests/helpers/factories'
import { useSettingsStore } from '../../store/settingsStore'

// Stable fake map so fitBounds call counts survive re-renders.
const glMap = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  loaded: vi.fn().mockReturnValue(true),
  fitBounds: vi.fn(),
  flyTo: vi.fn(),
  jumpTo: vi.fn(),
  getZoom: vi.fn().mockReturnValue(10),
  addControl: vi.fn(),
  removeControl: vi.fn(),
  remove: vi.fn(),
  addSource: vi.fn(),
  getSource: vi.fn().mockReturnValue(null),
  addLayer: vi.fn(),
  setLayoutProperty: vi.fn(),
  getStyle: vi.fn().mockReturnValue({ layers: [] }),
  isStyleLoaded: vi.fn().mockReturnValue(true),
  getCanvasContainer: vi.fn(() => document.createElement('div')),
}))

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: vi.fn(() => glMap),
    Marker: vi.fn(() => ({
      setLngLat: vi.fn().mockReturnThis(),
      addTo: vi.fn().mockReturnThis(),
      remove: vi.fn(),
      getElement: vi.fn(() => document.createElement('div')),
    })),
    LngLatBounds: vi.fn(() => ({ extend: vi.fn().mockReturnThis() })),
    NavigationControl: vi.fn(),
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

vi.mock('./mapboxSetup', () => ({
  isStandardFamily: vi.fn(() => false),
  supportsCustom3d: vi.fn(() => false),
  wantsTerrain: vi.fn(() => false),
  addCustom3dBuildings: vi.fn(),
  addTerrainAndSky: vi.fn(),
}))

vi.mock('./locationMarkerMapbox', () => ({
  attachLocationMarker: vi.fn(() => ({ update: vi.fn() })),
}))

vi.mock('./reservationsMapbox', () => ({
  ReservationMapboxOverlay: vi.fn().mockImplementation(() => ({ update: vi.fn() })),
}))

vi.mock('../../hooks/useGeolocation', () => ({
  useGeolocation: vi.fn(() => ({
    position: null,
    mode: 'off',
    error: null,
    cycleMode: vi.fn(),
    setMode: vi.fn(),
  })),
}))

vi.mock('../../services/photoService', () => ({
  getCached: vi.fn(() => null),
  isLoading: vi.fn(() => false),
  fetchPhoto: vi.fn(),
  onThumbReady: vi.fn(() => () => {}),
  getAllThumbs: vi.fn(() => ({})),
}))

import { MapViewGL } from './MapViewGL'

function buildMapPlace(overrides: Record<string, any> = {}) {
  return {
    ...buildPlace(),
    category_name: null,
    category_color: null,
    category_icon: null,
    ...overrides,
  } as any
}

beforeEach(() => {
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      map_provider: 'mapbox-gl',
      mapbox_access_token: 'pk.test_token',
      mapbox_style: 'mapbox://styles/mapbox/streets-v12',
      mapbox_3d_enabled: false,
    },
  } as any)
})

afterEach(() => {
  vi.clearAllMocks()
  resetAllStores()
})

describe('MapViewGL', () => {
  it('FE-COMP-MAPVIEWGL-001: opening place inspector does not refit bounds (issue #921)', async () => {
    const places = [
      buildMapPlace({ id: 1, lat: 48.8584, lng: 2.2945 }),
      buildMapPlace({ id: 2, lat: 48.86, lng: 2.337 }),
    ]

    const { rerender } = render(
      <MapViewGL places={places} fitKey={1} selectedPlaceId={null} hasInspector={false} />,
    )
    await act(async () => {})
    const after_initial = glMap.fitBounds.mock.calls.length

    // Selecting a place flips hasInspector → paddingOpts memo changes.
    // fitBounds must NOT fire again (this was the bug).
    rerender(
      <MapViewGL places={places} fitKey={1} selectedPlaceId={1} hasInspector={true} />,
    )
    await act(async () => {})
    expect(glMap.fitBounds).toHaveBeenCalledTimes(after_initial)
  })

  it('FE-COMP-MAPVIEWGL-002: closing inspector does not refit bounds (issue #921)', async () => {
    const places = [
      buildMapPlace({ id: 1, lat: 48.8584, lng: 2.2945 }),
    ]

    const { rerender } = render(
      <MapViewGL places={places} fitKey={1} selectedPlaceId={1} hasInspector={true} />,
    )
    await act(async () => {})
    const after_initial = glMap.fitBounds.mock.calls.length

    // Closing inspector (X button) clears selectedPlaceId → hasInspector=false → new paddingOpts.
    rerender(
      <MapViewGL places={places} fitKey={1} selectedPlaceId={null} hasInspector={false} />,
    )
    await act(async () => {})
    expect(glMap.fitBounds).toHaveBeenCalledTimes(after_initial)
  })

  it('FE-COMP-MAPVIEWGL-003: bumping fitKey triggers a new fitBounds call', async () => {
    const places = [
      buildMapPlace({ id: 1, lat: 48.8584, lng: 2.2945 }),
    ]

    const { rerender } = render(<MapViewGL places={places} fitKey={1} />)
    await act(async () => {})
    const after_first = glMap.fitBounds.mock.calls.length

    rerender(<MapViewGL places={places} fitKey={2} />)
    await act(async () => {})
    expect(glMap.fitBounds.mock.calls.length).toBeGreaterThan(after_first)
  })
})
