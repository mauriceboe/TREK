// FE-TP-HOOK-001 to FE-TP-HOOK-115
import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { TranslationProvider } from '../../i18n/TranslationContext'
import { useTripPlanner } from './useTripPlanner'
import { useTripStore, type TripStoreState } from '../../store/tripStore'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { usePermissionsStore } from '../../store/permissionsStore'
import { usePluginStore } from '../../store/pluginStore'
import { useBackgroundTasksStore } from '../../store/backgroundTasksStore'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildUser, buildTrip, buildDay, buildPlace, buildAssignment, buildReservation } from '../../../tests/helpers/factories'
import {
  addonsApi, accommodationsApi, authApi, tripsApi, assignmentsApi,
  healthApi, airtrailApi, mapsApi,
} from '../../api/client'
import { accommodationRepo } from '../../repo/accommodationRepo'
import { offlineDb } from '../../db/offlineDb'
import { getCached, fetchPhoto } from '../../services/photoService'
import type { Place, Reservation, Settings } from '../../types'

// ── Router ────────────────────────────────────────────────────────────────────
// Only useParams/useNavigate/useSearchParams are consumed by the hook, so the
// whole module is replaced — that keeps the ?create=… intents fully controllable.
const navigate = vi.fn()
let routeParams: { id?: string } = { id: '42' }
let searchParams = new URLSearchParams()
const setSearchParams = vi.fn((updater: (p: URLSearchParams) => URLSearchParams) => {
  const next = new URLSearchParams(searchParams)
  searchParams = typeof updater === 'function' ? updater(next) : next
})

vi.mock('react-router', () => ({
  useParams: () => routeParams,
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
}))

vi.mock('../../hooks/useTripWebSocket', () => ({ useTripWebSocket: vi.fn() }))

const updateRouteForDay = vi.fn(async (_dayId: number | null) => {})
vi.mock('../../hooks/useRouteCalculation', () => ({
  useRouteCalculation: () => ({
    route: null,
    routeSegments: [],
    routeVias: [],
    routeInfo: null,
    setRoute: vi.fn(),
    setRouteInfo: vi.fn(),
    updateRouteForDay,
  }),
}))

// Hoisted so the module mocks below can read them at module-evaluation time.
const env = vi.hoisted(() => ({ airTrailAvailable: false, forcedOffline: false }))

vi.mock('../../hooks/useAirtrailConnection', () => ({
  useAirtrailConnection: () => ({
    airtrailEnabled: env.airTrailAvailable,
    connected: env.airTrailAvailable,
    available: env.airTrailAvailable,
    loading: false,
  }),
}))

vi.mock('../../sync/networkMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/networkMode')>()
  return {
    ...actual,
    isEffectivelyOffline: () => env.forcedOffline,
    isEffectivelyOnline: () => !env.forcedOffline,
  }
})

vi.mock('../../repo/accommodationRepo', () => ({
  accommodationRepo: { list: vi.fn(async () => ({ accommodations: [] })) },
}))

vi.mock('../../services/photoService', () => ({
  getCached: vi.fn(() => undefined),
  fetchPhoto: vi.fn(),
}))

// ── Store fixtures ────────────────────────────────────────────────────────────

interface PlannerActions {
  loadTrip: ReturnType<typeof vi.fn>
  loadReservations: ReturnType<typeof vi.fn>
  loadBudgetItems: ReturnType<typeof vi.fn>
  loadFiles: ReturnType<typeof vi.fn>
  refreshDays: ReturnType<typeof vi.fn>
  addPlace: ReturnType<typeof vi.fn>
  updatePlace: ReturnType<typeof vi.fn>
  deletePlace: ReturnType<typeof vi.fn>
  deletePlacesMany: ReturnType<typeof vi.fn>
  updatePlacesMany: ReturnType<typeof vi.fn>
  addFile: ReturnType<typeof vi.fn>
  assignPlaceToDay: ReturnType<typeof vi.fn>
  removeAssignment: ReturnType<typeof vi.fn>
  reorderAssignments: ReturnType<typeof vi.fn>
  reorderDays: ReturnType<typeof vi.fn>
  insertDay: ReturnType<typeof vi.fn>
  updateDayTitle: ReturnType<typeof vi.fn>
  addReservation: ReturnType<typeof vi.fn>
  updateReservation: ReturnType<typeof vi.fn>
  deleteReservation: ReturnType<typeof vi.fn>
  setSelectedDay: ReturnType<typeof vi.fn>
}

let actions: PlannerActions

function makeActions(): PlannerActions {
  return {
    loadTrip: vi.fn(async () => undefined),
    loadReservations: vi.fn(async () => undefined),
    loadBudgetItems: vi.fn(async () => undefined),
    loadFiles: vi.fn(async () => undefined),
    refreshDays: vi.fn(async () => undefined),
    addPlace: vi.fn(async () => ({ id: 900, name: 'New' })),
    updatePlace: vi.fn(async () => undefined),
    deletePlace: vi.fn(async () => undefined),
    deletePlacesMany: vi.fn(async () => undefined),
    updatePlacesMany: vi.fn(async () => undefined),
    addFile: vi.fn(async () => undefined),
    assignPlaceToDay: vi.fn(async () => ({ id: 555 })),
    removeAssignment: vi.fn(async () => undefined),
    reorderAssignments: vi.fn(async () => undefined),
    reorderDays: vi.fn(async () => undefined),
    insertDay: vi.fn(async () => undefined),
    updateDayTitle: vi.fn(async () => undefined),
    addReservation: vi.fn(async () => ({ id: 77 })),
    updateReservation: vi.fn(async () => ({ id: 77 })),
    deleteReservation: vi.fn(async () => undefined),
    setSelectedDay: vi.fn(() => undefined),
  }
}

const toasts: Array<{ message: string; type: string }> = []

function wrapper({ children }: { children: React.ReactNode }) {
  return <TranslationProvider>{children}</TranslationProvider>
}

/** Mount the hook and let the bootstrap effects (addons, config, roster, …) settle. */
async function renderPlanner() {
  const rendered = renderHook(() => useTripPlanner(), { wrapper })
  await act(async () => { await Promise.resolve() })
  return rendered
}

/** Patch settings without dropping the defaults the providers read (language, …). */
function setSettings(patch: Partial<Settings>) {
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ...patch } })
}

/** Seed the trip store with a trip + the mocked actions the hook snapshots on mount. */
function seedTrip(extra: Partial<TripStoreState> = {}) {
  const trip = buildTrip({ id: 42, title: 'Kyoto' })
  useTripStore.setState({
    trip,
    isLoading: false,
    days: [],
    places: [],
    assignments: {},
    reservations: [],
    ...(actions as unknown as Partial<TripStoreState>),
    ...extra,
  } as Partial<TripStoreState>)
  return trip
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAllStores()
  routeParams = { id: '42' }
  searchParams = new URLSearchParams()
  env.airTrailAvailable = false
  env.forcedOffline = false
  toasts.length = 0
  actions = makeActions()
  usePluginStore.setState({ plugins: [], loaded: true })
  useBackgroundTasksStore.setState({ tasks: [] })
  window.__addToast = ((message: string, type: string) => {
    toasts.push({ message, type })
    return 1
  }) as unknown as typeof window.__addToast
  seedStore(useAuthStore, { user: buildUser({ id: 1 }), isAuthenticated: true, placesPhotosEnabled: false })

  vi.spyOn(addonsApi, 'enabled').mockResolvedValue({ addons: [] })
  vi.spyOn(authApi, 'getAppConfig').mockResolvedValue({})
  vi.spyOn(healthApi, 'features').mockResolvedValue({ bookingImport: false, aiParsing: false })
  vi.spyOn(tripsApi, 'getMembers').mockResolvedValue({ owner: null, members: [] })
  vi.spyOn(accommodationsApi, 'list').mockResolvedValue({ accommodations: [] })
  vi.spyOn(assignmentsApi, 'updateTime').mockResolvedValue({})
  vi.spyOn(assignmentsApi, 'updateNotes').mockResolvedValue({})
  vi.spyOn(airtrailApi, 'sync').mockResolvedValue({ changed: 0 })
  vi.spyOn(mapsApi, 'reverse').mockResolvedValue({ name: '', address: '' } as never)
  vi.spyOn(mapsApi, 'search').mockResolvedValue({ places: [] } as never)
  vi.mocked(accommodationRepo.list).mockResolvedValue({ accommodations: [] })
  vi.mocked(getCached).mockReturnValue(undefined)
})

afterEach(() => {
  delete window.__addToast
  vi.restoreAllMocks()
})

describe('useTripPlanner — bootstrap', () => {
  it('FE-TP-HOOK-001: loads the trip, its accommodations and its roster for the route id', async () => {
    seedTrip()
    vi.mocked(accommodationRepo.list).mockResolvedValue({
      accommodations: [{ id: 5, trip_id: 42 }] as never,
    })
    vi.mocked(tripsApi.getMembers).mockResolvedValue({
      owner: { user_id: 1, username: 'owner' },
      members: [{ user_id: 2, username: 'bob' }],
    })

    const { result } = await renderPlanner()

    expect(result.current.tripId).toBe(42)
    expect(actions.loadTrip).toHaveBeenCalledWith(42)
    expect(actions.loadReservations).toHaveBeenCalledWith(42)
    await waitFor(() => expect(result.current.tripAccommodations).toHaveLength(1))
    await waitFor(() => expect(result.current.tripMembers).toHaveLength(2))
  })

  it('FE-TP-HOOK-002: a failing loadTrip toasts and bounces back to the dashboard', async () => {
    seedTrip()
    actions.loadTrip.mockRejectedValue(new Error('gone'))

    await renderPlanner()

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard'))
    expect(toasts.some(t => t.type === 'error')).toBe(true)
  })

  it('FE-TP-HOOK-003: an id-less route yields NaN and skips every trip-scoped load', async () => {
    routeParams = {}
    seedTrip()

    const { result } = await renderPlanner()

    expect(Number.isNaN(result.current.tripId)).toBe(true)
    expect(actions.loadTrip).not.toHaveBeenCalled()
    expect(accommodationRepo.list).not.toHaveBeenCalled()
  })

  it('FE-TP-HOOK-004: offline reads the roster from the Dexie cache instead of the API', async () => {
    env.forcedOffline = true
    seedTrip()
    await offlineDb.tripMembers.bulkPut([
      { tripId: 42, id: 9, user_id: 9, username: 'cached', role: 'member' } as never,
    ])

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.tripMembers).toHaveLength(1))
    expect(result.current.tripMembers[0].username).toBe('cached')
    expect(tripsApi.getMembers).not.toHaveBeenCalled()
    await offlineDb.tripMembers.clear()
  })

  it('FE-TP-HOOK-005: refreshMembers is a no-op while offline', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    await waitFor(() => expect(tripsApi.getMembers).toHaveBeenCalledTimes(1))

    env.forcedOffline = true
    act(() => { result.current.refreshMembers() })

    expect(tripsApi.getMembers).toHaveBeenCalledTimes(1)
  })

  it('FE-TP-HOOK-006: enabled addons and collab feature flags reach the returned state', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({
      addons: [{ id: 'packing' }, { id: 'budget' }, { id: 'collab' }],
      collabFeatures: { chat: true, notes: false, polls: false, whatsnext: true },
    })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.enabledAddons.collab).toBe(true))
    expect(result.current.enabledAddons.documents).toBe(false)
    expect(result.current.collabFeatures.notes).toBe(false)
  })

  it('FE-TP-HOOK-007: the app config supplies the allowed upload types', async () => {
    vi.mocked(authApi.getAppConfig).mockResolvedValue({ allowed_file_types: 'pdf,png' })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.allowedFileTypes).toBe('pdf,png'))
  })

  it('FE-TP-HOOK-008: the booking-import feature flag comes from /health/features', async () => {
    vi.mocked(healthApi.features).mockResolvedValue({ bookingImport: true, aiParsing: false })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.bookingImportAvailable).toBe(true))
  })

  it('FE-TP-HOOK-009: opening the trip pulls AirTrail changes once and reloads bookings', async () => {
    env.airTrailAvailable = true
    vi.mocked(airtrailApi.sync).mockResolvedValue({ changed: 3 })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(actions.loadReservations).toHaveBeenCalledTimes(2))
    expect(airtrailApi.sync).toHaveBeenCalledTimes(1)

    // A re-render must not fire a second sync for the same trip.
    act(() => { result.current.setFitKey(9) })
    expect(airtrailApi.sync).toHaveBeenCalledTimes(1)
  })

  it('FE-TP-HOOK-010: an AirTrail sync with no changes leaves the bookings alone', async () => {
    env.airTrailAvailable = true
    seedTrip()

    await renderPlanner()

    await waitFor(() => expect(airtrailApi.sync).toHaveBeenCalled())
    expect(actions.loadReservations).toHaveBeenCalledTimes(1)
  })

  it('FE-TP-HOOK-011: the accommodations:refresh event reloads the accommodation list', async () => {
    seedTrip()
    await renderPlanner()
    await waitFor(() => expect(accommodationRepo.list).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(new Event('accommodations:refresh'))
    })

    await waitFor(() => expect(accommodationRepo.list).toHaveBeenCalledTimes(2))
  })

  it('FE-TP-HOOK-012: the splash gate opens once the trip finished loading', async () => {
    vi.useFakeTimers()
    seedTrip()

    const { result } = await renderPlanner()
    expect(result.current.splashDone).toBe(false)

    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(result.current.splashDone).toBe(true)

    vi.useRealTimers()
  })

  it('FE-TP-HOOK-013: place photos are prefetched only for places without an image', async () => {
    seedStore(useAuthStore, { placesPhotosEnabled: true })
    const withImage = buildPlace({ id: 1, image_url: '/uploads/a.jpg', lat: 1, lng: 2 })
    const withOsm = buildPlace({ id: 2, image_url: null, osm_id: 'node/7', lat: 3, lng: 4 })
    const coordsOnly = buildPlace({ id: 3, image_url: null, osm_id: null, google_place_id: null, lat: 5, lng: 6 })
    seedTrip({ places: [withImage, withOsm, coordsOnly] })

    await renderPlanner()

    await waitFor(() => expect(fetchPhoto).toHaveBeenCalledTimes(2))
    expect(vi.mocked(fetchPhoto).mock.calls[0][0]).toBe('node/7')
    expect(vi.mocked(fetchPhoto).mock.calls[1][1]).toBe('coords:5:6')
  })

  it('FE-TP-HOOK-014: an already cached photo is not fetched again', async () => {
    seedStore(useAuthStore, { placesPhotosEnabled: true })
    vi.mocked(getCached).mockReturnValue({ url: '/x.jpg' } as never)
    seedTrip({ places: [buildPlace({ id: 2, image_url: null, osm_id: 'node/7', lat: 3, lng: 4 })] })

    await renderPlanner()

    await waitFor(() => expect(getCached).toHaveBeenCalled())
    expect(fetchPhoto).not.toHaveBeenCalled()
  })
})

describe('useTripPlanner — tabs', () => {
  it('FE-TP-HOOK-015: addon tabs appear only for enabled addons', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'packing' }, { id: 'documents' }] })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => {
      expect(result.current.TRIP_TABS.map(t => t.id)).toEqual(
        ['plan', 'transports', 'buchungen', 'listen', 'dateien'],
      )
    })
  })

  it('FE-TP-HOOK-016: switching to the Costs tab loads the budget items and persists the tab', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'budget' }] })
    seedTrip()
    const { result } = await renderPlanner()
    await waitFor(() => expect(result.current.TRIP_TABS.map(t => t.id)).toContain('finanzplan'))

    act(() => { result.current.handleTabChange('finanzplan') })

    expect(result.current.activeTab).toBe('finanzplan')
    expect(sessionStorage.getItem('trip-tab-42')).toBe('finanzplan')
    expect(actions.loadBudgetItems).toHaveBeenCalledWith(42)
  })

  it('FE-TP-HOOK-017: the Files tab loads files only while none are cached', async () => {
    seedTrip()
    const { result } = await renderPlanner()

    act(() => { result.current.handleTabChange('dateien') })
    expect(actions.loadFiles).toHaveBeenCalledTimes(1)

    act(() => { useTripStore.setState({ files: [{ id: 1 }] as never }) })
    act(() => { result.current.handleTabChange('dateien') })
    expect(actions.loadFiles).toHaveBeenCalledTimes(1)
  })

  it('FE-TP-HOOK-018: a saved tab that no addon backs falls back to plan', async () => {
    sessionStorage.setItem('trip-tab-42', 'listen')
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.activeTab).toBe('plan'))
    expect(sessionStorage.getItem('trip-tab-42')).toBe('plan')
  })

  it('FE-TP-HOOK-018b: a tab set programmatically is re-validated on the spot', async () => {
    usePluginStore.setState({ plugins: [], loaded: true })
    seedTrip()

    const { result } = await renderPlanner()

    act(() => { result.current.setActiveTab('plugin:ghost') })

    await waitFor(() => expect(result.current.activeTab).toBe('plan'))
    expect(sessionStorage.getItem('trip-tab-42')).toBe('plan')
  })

  it('FE-TP-HOOK-019: a positioned trip-page plugin splices its tab and can replace a core tab', async () => {
    usePluginStore.setState({
      plugins: [
        { id: 'transit-pro', name: 'Transit Pro', type: 'trip-page', icon: null, tripPage: { replaces: ['transports'], position: 1 } },
        { id: 'tail', name: 'Tail', type: 'trip-page', icon: null, tripPage: {} },
      ] as never,
      loaded: true,
    })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => {
      expect(result.current.TRIP_TABS.map(t => t.id))
        .toEqual(['plan', 'plugin:transit-pro', 'buchungen', 'plugin:tail'])
    })
  })

  it('FE-TP-HOOK-019b: two positioned plugin tabs keep their relative order', async () => {
    usePluginStore.setState({
      plugins: [
        { id: 'late', name: 'Late', type: 'trip-page', icon: null, tripPage: { position: 3 } },
        { id: 'early', name: 'Early', type: 'trip-page', icon: 'Map', tripPage: { position: 1 } },
      ] as never,
      loaded: true,
    })
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => {
      expect(result.current.TRIP_TABS.map(t => t.id))
        .toEqual(['plan', 'plugin:early', 'transports', 'plugin:late', 'buchungen'])
    })
  })

  it('FE-TP-HOOK-020: jumping to a plugin-replaced core tab lands on plan instead', async () => {
    usePluginStore.setState({
      plugins: [{ id: 'transit-pro', name: 'Transit Pro', type: 'trip-page', icon: null, tripPage: { replaces: ['buchungen'] } }] as never,
      loaded: true,
    })
    seedTrip()

    const { result } = await renderPlanner()

    act(() => { result.current.handleTabChange('buchungen') })
    expect(result.current.activeTab).toBe('plan')
    expect(sessionStorage.getItem('trip-tab-42')).toBe('plan')
  })

  it('FE-TP-HOOK-021: a saved plugin tab survives until the plugin feed has loaded', async () => {
    sessionStorage.setItem('trip-tab-42', 'plugin:late')
    usePluginStore.setState({ plugins: [], loaded: false })
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.activeTab).toBe('plugin:late')
  })

  // ── ?tab= deep link (startup destination, shortcuts, wrapper apps) ──────────

  it('FE-TP-HOOK-104: ?tab= opens that tab on the very first render and clears the param', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'budget' }] })
    searchParams = new URLSearchParams('tab=finanzplan')
    seedTrip()

    const { result } = await renderPlanner()

    // No frame on 'plan' first — the tab is right from the initial state.
    expect(result.current.activeTab).toBe('finanzplan')
    await waitFor(() => expect(searchParams.get('tab')).toBeNull())
  })

  it('FE-TP-HOOK-105: ?tab= beats the tab the last session ended on', async () => {
    sessionStorage.setItem('trip-tab-42', 'buchungen')
    searchParams = new URLSearchParams('tab=transports')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.activeTab).toBe('transports')
    await waitFor(() => expect(sessionStorage.getItem('trip-tab-42')).toBe('transports'))
  })

  it('FE-TP-HOOK-106: a junk ?tab= is ignored rather than rendering a dead panel', async () => {
    searchParams = new URLSearchParams('tab=../../etc/passwd')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.activeTab).toBe('plan')
  })

  // The lazy loads live in handleTabChange, which a deep link never goes through.
  it('FE-TP-HOOK-107: starting on Costs still loads the budget items', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'budget' }] })
    searchParams = new URLSearchParams('tab=finanzplan')
    seedTrip()

    await renderPlanner()

    await waitFor(() => expect(actions.loadBudgetItems).toHaveBeenCalledWith(42))
  })

  it('FE-TP-HOOK-108: starting on Files still loads the files', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'documents' }] })
    searchParams = new URLSearchParams('tab=dateien')
    seedTrip()

    await renderPlanner()

    await waitFor(() => expect(actions.loadFiles).toHaveBeenCalledWith(42))
  })

  // enabledAddons is an optimistic guess until the feed answers, and 'collab'
  // is guessed off — evicting on that guess would drop a requested tab.
  it('FE-TP-HOOK-109: a requested collab tab survives until the addon feed answers', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [{ id: 'collab' }] })
    searchParams = new URLSearchParams('tab=collab')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.activeTab).toBe('collab')
    await waitFor(() => expect(result.current.TRIP_TABS.map(t => t.id)).toContain('collab'))
    expect(result.current.activeTab).toBe('collab')
  })

  it('FE-TP-HOOK-110: but a tab whose addon really is off still falls back to plan', async () => {
    vi.mocked(addonsApi.enabled).mockResolvedValue({ addons: [] })
    searchParams = new URLSearchParams('tab=finanzplan')
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.activeTab).toBe('plan'))
  })
})

describe('useTripPlanner — ?create intents', () => {
  it('FE-TP-HOOK-022: ?create=place opens an empty place form and clears the param', async () => {
    searchParams = new URLSearchParams('create=place')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.showPlaceForm).toBe(true)
    expect(result.current.editingPlace).toBeNull()
    expect(setSearchParams).toHaveBeenCalled()
    expect(searchParams.get('create')).toBeNull()
  })

  it('FE-TP-HOOK-023: ?create=reservation opens the booking modal', async () => {
    searchParams = new URLSearchParams('create=reservation')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.showReservationModal).toBe(true)
    expect(result.current.editingReservation).toBeNull()
  })

  it('FE-TP-HOOK-024: ?create=transport opens the transport modal', async () => {
    searchParams = new URLSearchParams('create=transport')
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.showTransportModal).toBe(true)
    expect(result.current.transportModalDayId).toBeNull()
  })
})

describe('useTripPlanner — map derivations', () => {
  const geo = (id: number, extra: Partial<Place> = {}) =>
    buildPlace({ id, lat: 10 + id, lng: 20 + id, ...extra })

  it('FE-TP-HOOK-025: places without coordinates never reach the map', async () => {
    seedTrip({ places: [geo(1), buildPlace({ id: 2, lat: null, lng: null })] })

    const { result } = await renderPlanner()

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1])
  })

  it('FE-TP-HOOK-026: the tracks filter keeps only places with a route geometry', async () => {
    seedTrip({
      places: [geo(1), geo(2, { route_geometry: '[[1,2]]' })],
      placesFilter: 'tracks',
    })

    const { result } = await renderPlanner()

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([2])
  })

  it('FE-TP-HOOK-027: the category filter honours the uncategorized bucket', async () => {
    seedTrip({
      places: [geo(1, { category_id: 3 }), geo(2, { category_id: null })],
      placesCategoryFilter: new Set(['uncategorized']),
    })

    const { result } = await renderPlanner()

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([2])

    act(() => { useTripStore.setState({ placesCategoryFilter: new Set(['3']) }) })
    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1])
  })

  it('FE-TP-HOOK-028: the unplanned filter drops places that sit on a day', async () => {
    const planned = geo(1)
    seedTrip({
      places: [planned, geo(2)],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place: planned })] },
      placesFilter: 'unplanned',
    })

    const { result } = await renderPlanner()

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([2])
  })

  it('FE-TP-HOOK-029: the planned filter keeps a collapsed day\'s stops on the map', async () => {
    const planned = geo(1)
    seedTrip({
      places: [planned, geo(2)],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place: planned })] },
      placesFilter: 'planned',
    })

    const { result } = await renderPlanner()
    act(() => { result.current.setExpandedDayIds(new Set([999])) })

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1])
  })

  it('FE-TP-HOOK-111: the planned filter follows the selected day when one is selected', async () => {
    const onDay7 = geo(1)
    const onDay8 = geo(2)
    seedTrip({
      places: [onDay7, onDay8, geo(3)],
      assignments: {
        '7': [buildAssignment({ id: 10, day_id: 7, place: onDay7 })],
        '8': [buildAssignment({ id: 11, day_id: 8, place: onDay8 })],
      },
      placesFilter: 'planned',
      selectedDayId: 7,
    })

    const { result } = await renderPlanner()

    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1])

    // No day selected → back to the whole plan
    act(() => { useTripStore.setState({ selectedDayId: null }) })
    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1, 2])
  })

  it('FE-TP-HOOK-030: collapsing a day hides its stops unless another expanded day shows them', async () => {
    const shared = geo(1)
    seedTrip({
      places: [shared],
      assignments: {
        '7': [buildAssignment({ id: 10, day_id: 7, place: shared })],
        '8': [buildAssignment({ id: 11, day_id: 8, place: shared })],
      },
    })

    const { result } = await renderPlanner()

    act(() => { result.current.setExpandedDayIds(new Set([999])) })
    expect(result.current.mapPlaces).toHaveLength(0)

    act(() => { result.current.setExpandedDayIds(new Set([8])) })
    expect(result.current.mapPlaces.map(p => p.id)).toEqual([1])
  })

  it('FE-TP-HOOK-031: the selected day drives the marker order map and the fit list', async () => {
    const a = geo(1)
    const b = geo(2)
    seedTrip({
      places: [a, b],
      selectedDayId: 7,
      assignments: {
        '7': [
          buildAssignment({ id: 11, day_id: 7, place: b, order_index: 1 }),
          buildAssignment({ id: 10, day_id: 7, place: a, order_index: 0 }),
          buildAssignment({ id: 12, day_id: 7, place: a, order_index: 2 }),
        ],
      },
    })

    const { result } = await renderPlanner()

    expect(result.current.dayOrderMap).toEqual({ 1: [1, 3], 2: [2] })
    expect(result.current.dayPlaces).toHaveLength(3)
  })

  it('FE-TP-HOOK-031b: an assignment whose place vanished is skipped in the order map', async () => {
    seedTrip({
      places: [],
      selectedDayId: 7,
      assignments: { '7': [{ id: 10, day_id: 7, place_id: 1, order_index: 0, notes: null }] as never },
    })

    const { result } = await renderPlanner()

    expect(result.current.dayOrderMap).toEqual({})
    expect(result.current.dayPlaces).toEqual([])
  })

  it('FE-TP-HOOK-032: without a selected day both day derivations stay empty', async () => {
    seedTrip({ places: [geo(1)] })

    const { result } = await renderPlanner()

    expect(result.current.dayOrderMap).toEqual({})
    expect(result.current.dayPlaces).toEqual([])
  })

  it('FE-TP-HOOK-033: the first trip with geo places bumps the map fit key exactly once', async () => {
    seedTrip({ places: [geo(1)] })

    const { result } = await renderPlanner()

    expect(result.current.fitKey).toBe(1)
    act(() => { useTripStore.setState({ places: [geo(1), geo(2)] }) })
    expect(result.current.fitKey).toBe(1)
  })
})

describe('useTripPlanner — connection visibility', () => {
  const routable = (id: number) =>
    buildReservation({ id, endpoints: [{ role: 'from' }, { role: 'to' }] as never })

  it('FE-TP-HOOK-034: with no stored preference the account default decides the mode', async () => {
    setSettings({ map_always_show_routes: true })
    seedTrip({ reservations: [routable(1), routable(2)] })

    const { result } = await renderPlanner()

    expect(result.current.allConnectionsShown).toBe(true)
    expect(result.current.visibleConnections).toEqual([1, 2])
  })

  it('FE-TP-HOOK-035: toggling one leg writes the trip preference to localStorage', async () => {
    seedTrip({ reservations: [routable(1), routable(2)] })

    const { result } = await renderPlanner()
    expect(result.current.visibleConnections).toEqual([])

    act(() => { result.current.toggleConnection(2) })

    expect(result.current.visibleConnections).toEqual([2])
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('trek:visible-connections:42') || 'null'))
        .toEqual({ mode: 'only', ids: [2] })
    })
  })

  it('FE-TP-HOOK-036: the bulk toggle flips the whole trip and drops per-leg overrides', async () => {
    localStorage.setItem('trek:visible-connections:42', JSON.stringify({ mode: 'only', ids: [1] }))
    seedTrip({ reservations: [routable(1), routable(2)] })

    const { result } = await renderPlanner()
    expect(result.current.visibleConnections).toEqual([1])

    act(() => { result.current.toggleAllConnections() })

    expect(result.current.allConnectionsShown).toBe(true)
    expect(result.current.visibleConnections).toEqual([1, 2])
  })

  it('FE-TP-HOOK-037: non-routable bookings are excluded from the visible set', async () => {
    setSettings({ map_always_show_routes: true })
    seedTrip({ reservations: [routable(1), buildReservation({ id: 2, endpoints: [] })] })

    const { result } = await renderPlanner()

    expect(result.current.visibleConnections).toEqual([1])
  })

  it('FE-TP-HOOK-115: a persisted route toggle keeps transit routes off the map until a day is selected (#2019)', async () => {
    localStorage.setItem('trek:day-route:42', 'true')
    // The fixture action is a no-op; the derivation reads the store, so this
    // one has to write the selection like the real slice does.
    actions.setSelectedDay.mockImplementation(dayId => {
      useTripStore.setState({ selectedDayId: dayId as number | null })
    })
    seedTrip()

    const { result } = await renderPlanner()

    // Trip re-entry: the toggle rehydrated but nothing selected a day yet.
    expect(result.current.routeShown).toBe(true)
    expect(result.current.transitRoutesShown).toBe(false)

    act(() => { result.current.handleSelectDay(7) })
    expect(result.current.transitRoutesShown).toBe(true)

    // Clicking the selected day's header again deselects it — the whole trip's
    // automated transports must not flood back.
    act(() => { result.current.handleSelectDay(null) })
    expect(result.current.transitRoutesShown).toBe(false)

    localStorage.removeItem('trek:day-route:42')
  })
})

describe('useTripPlanner — selection handlers', () => {
  it('FE-TP-HOOK-038: clicking a planned stop selects its assignment and reopens both panels', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({ places: [place] })

    const { result } = await renderPlanner()
    act(() => { result.current.setLeftCollapsed(true); result.current.setRightCollapsed(true) })

    act(() => { result.current.handlePlaceClick(1, 10) })

    expect(result.current.selectedAssignmentId).toBe(10)
    expect(result.current.selectedPlaceId).toBe(1)
    expect(result.current.leftCollapsed).toBe(false)
    expect(result.current.rightCollapsed).toBe(false)
  })

  it('FE-TP-HOOK-039: clicking a pool place selects the place alone', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    act(() => { result.current.handlePlaceClick(1) })

    expect(result.current.selectedPlaceId).toBe(1)
    expect(result.current.selectedAssignmentId).toBeNull()
  })

  it('FE-TP-HOOK-040: an undefined marker id clears the selection', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    act(() => { result.current.handlePlaceClick(1) })
    act(() => { result.current.handleMarkerClick(undefined) })

    expect(result.current.selectedPlaceId).toBeNull()
  })

  it('FE-TP-HOOK-041: an unplanned marker toggles its own selection', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedPlaceId).toBe(1)

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedPlaceId).toBeNull()
  })

  it('FE-TP-HOOK-042: a marker with one assignment selects it, a second click clears it', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] },
    })

    const { result } = await renderPlanner()

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedAssignmentId).toBe(10)

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedPlaceId).toBeNull()
  })

  it('FE-TP-HOOK-043: repeated marker clicks cycle through every occurrence, then clear', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: {
        '7': [buildAssignment({ id: 10, day_id: 7, place })],
        '8': [buildAssignment({ id: 11, day_id: 8, place })],
      },
    })

    const { result } = await renderPlanner()

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedAssignmentId).toBe(10)

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedAssignmentId).toBe(11)

    act(() => { result.current.handleMarkerClick(1) })
    expect(result.current.selectedPlaceId).toBeNull()
  })

  it('FE-TP-HOOK-044: a map background click drops the selection', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    act(() => { result.current.handlePlaceClick(1) })
    act(() => { result.current.handleMapClick() })

    expect(result.current.selectedPlaceId).toBeNull()
  })

  it('FE-TP-HOOK-045: selecting a day resets the mobile drawer and recomputes the route', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    act(() => { result.current.setMobileSidebarOpen('left') })
    act(() => { result.current.handleSelectDay(7) })

    expect(actions.setSelectedDay).toHaveBeenCalledWith(7)
    expect(updateRouteForDay).toHaveBeenCalledWith(7)
    expect(result.current.mobileSidebarOpen).toBeNull()
  })

  it('FE-TP-HOOK-046: skipFit selects the day without bumping the map fit key', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    const before = result.current.fitKey

    act(() => { result.current.handleSelectDay(7, true) })
    expect(result.current.fitKey).toBe(before)

    act(() => { result.current.handleSelectDay(8) })
    expect(result.current.fitKey).toBe(before + 1)
  })
})

describe('useTripPlanner — add place entry points', () => {
  it('FE-TP-HOOK-047: a map right-click prefills the form and enriches it by reverse geocoding', async () => {
    vi.mocked(mapsApi.reverse).mockResolvedValue({ name: 'Fushimi Inari', address: 'Kyoto' } as never)
    seedTrip()

    const { result } = await renderPlanner()
    const preventDefault = vi.fn()

    await act(async () => {
      await result.current.handleMapContextMenu({
        originalEvent: { preventDefault },
        latlng: { lat: 34.9, lng: 135.7 },
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.showPlaceForm).toBe(true)
    await waitFor(() => expect(result.current.prefillCoords?.name).toBe('Fushimi Inari'))
    expect(result.current.prefillCoords?.address).toBe('Kyoto')
  })

  it('FE-TP-HOOK-048: a failing reverse geocode still leaves the bare coordinates prefilled', async () => {
    vi.mocked(mapsApi.reverse).mockRejectedValue(new Error('offline'))
    seedTrip()

    const { result } = await renderPlanner()

    await act(async () => {
      await result.current.handleMapContextMenu({ latlng: { lat: 1, lng: 2 } })
    })

    expect(result.current.prefillCoords).toEqual({ lat: 1, lng: 2 })
    expect(result.current.showPlaceForm).toBe(true)
  })

  it('FE-TP-HOOK-049: a POI marker prefills the form without a reverse-geocode round trip', async () => {
    seedTrip()

    const { result } = await renderPlanner()

    act(() => {
      result.current.openAddPlaceFromPoi({
        lat: 1, lng: 2, name: 'Cafe', address: null, website: null, phone: null, osm_id: 'node/1',
      })
    })

    expect(result.current.prefillCoords).toEqual({
      lat: 1, lng: 2, name: 'Cafe', address: '', website: undefined, phone: undefined, osm_id: 'node/1',
    })
    expect(result.current.showPlaceForm).toBe(true)
    expect(mapsApi.reverse).not.toHaveBeenCalled()
  })

  it('FE-TP-HOOK-050: the pool editor resolves a place\'s lone assignment for its times', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    expect(result.current.editingAssignmentId).toBe(10)
    expect(result.current.editingPlace?.id).toBe(1)
  })
})

describe('useTripPlanner — place CRUD', () => {
  it('FE-TP-HOOK-051: adding a place uploads its pending files and registers an undo', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    const file = new File(['x'], 'ticket.pdf')

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', _pendingFiles: [file] })
    })

    expect(actions.addPlace).toHaveBeenCalledWith(42, { name: 'Nara' })
    expect(actions.addFile).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(true)

    await act(async () => { await result.current.undo() })
    expect(actions.deletePlace).toHaveBeenCalledWith(42, 900)
  })

  it('FE-TP-HOOK-052: a failing attachment upload only toasts, the place still saves', async () => {
    seedTrip()
    actions.addFile.mockRejectedValue(new Error('too large'))

    const { result } = await renderPlanner()

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', _pendingFiles: [new File(['x'], 'a.pdf')] })
    })

    expect(toasts.some(t => t.type === 'error')).toBe(true)
    expect(toasts.some(t => t.type === 'success')).toBe(true)
  })

  it('FE-TP-HOOK-053: editing from a day strips the times off the place and writes them per assignment', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', place_time: '09:00', end_time: '10:00' })
    })

    expect(actions.updatePlace).toHaveBeenCalledWith(42, 1, { name: 'Nara' })
    expect(assignmentsApi.updateTime).toHaveBeenCalledWith(42, 10, { place_time: '09:00', end_time: '10:00' })
    expect(actions.refreshDays).toHaveBeenCalledWith(42)
  })

  it('FE-TP-HOOK-053b: a changed assignment note is stripped off the place and PUT per assignment (#2163)', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', assignment_notes: 'Book the 10:00 entry' })
    })

    expect(actions.updatePlace).toHaveBeenCalledWith(42, 1, { name: 'Nara' })
    expect(assignmentsApi.updateNotes).toHaveBeenCalledWith(42, 10, { notes: 'Book the 10:00 entry' })
    expect(actions.refreshDays).toHaveBeenCalledWith(42)
  })

  it('FE-TP-HOOK-053c: without assignment_notes in the payload no notes write happens; an empty string clears (#2163)', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    // The form strips an untouched note, so the key is simply absent.
    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara' })
    })
    expect(assignmentsApi.updateNotes).not.toHaveBeenCalled()

    // An empty string is an explicit clear and goes out as null.
    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', assignment_notes: '' })
    })
    expect(assignmentsApi.updateNotes).toHaveBeenCalledWith(42, 10, { notes: null })
  })

  it('FE-TP-HOOK-054: editing an unassigned place skips the per-assignment time write', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({ places: [place] })

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', _pendingFiles: [new File(['x'], 'a.pdf')] })
    })

    expect(assignmentsApi.updateTime).not.toHaveBeenCalled()
    expect(actions.addFile).toHaveBeenCalledTimes(1)
  })

  it('FE-TP-HOOK-054b: an attachment that fails on the edit path toasts but keeps the update', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({ places: [place] })
    actions.addFile.mockRejectedValue(new Error('unsupported type'))

    const { result } = await renderPlanner()
    act(() => { result.current.openPlaceEditor(place) })

    await act(async () => {
      await result.current.handleSavePlace({ name: 'Nara', _pendingFiles: [new File(['x'], 'a.exe')] })
    })

    expect(actions.updatePlace).toHaveBeenCalledWith(42, 1, { name: 'Nara' })
    expect(toasts.some(t => t.type === 'error')).toBe(true)
    expect(toasts.some(t => t.type === 'success')).toBe(true)
  })

  it('FE-TP-HOOK-055: confirming a delete removes the place and can restore it with its days', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2, route_geometry: '[[1,2]]', route_color: '#ff0000' })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place, order_index: 2 })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.handleDeletePlace(1) })
    act(() => { result.current.handlePlaceClick(1) })
    await act(async () => { await result.current.confirmDeletePlace() })

    expect(actions.deletePlace).toHaveBeenCalledWith(42, 1)
    expect(result.current.selectedPlaceId).toBeNull()

    await act(async () => { await result.current.undo() })
    expect(actions.addPlace).toHaveBeenCalledWith(42, expect.objectContaining({ route_geometry: '[[1,2]]', route_color: '#ff0000' }))
    expect(actions.assignPlaceToDay).toHaveBeenCalledWith(42, 7, 900, 2)
  })

  it('FE-TP-HOOK-056: confirmDeletePlace is a no-op until a place is queued', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => { await result.current.confirmDeletePlace() })

    expect(actions.deletePlace).not.toHaveBeenCalled()
  })

  it('FE-TP-HOOK-057: a failing delete surfaces the server message', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })
    actions.deletePlace.mockRejectedValue(new Error('place is locked'))

    const { result } = await renderPlanner()
    act(() => { result.current.handleDeletePlace(1) })
    await act(async () => { await result.current.confirmDeletePlace() })

    expect(toasts.some(t => t.message === 'place is locked' && t.type === 'error')).toBe(true)
  })

  it('FE-TP-HOOK-058: a bulk delete restores every place with its assignments on undo', async () => {
    const a = buildPlace({ id: 1, lat: 1, lng: 2 })
    const b = buildPlace({ id: 2, lat: 3, lng: 4 })
    seedTrip({
      places: [a, b],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place: a, order_index: 0 })] },
    })

    const { result } = await renderPlanner()
    act(() => { result.current.setDeletePlaceIds([1, 2]) })
    act(() => { result.current.handlePlaceClick(1) })
    await act(async () => { await result.current.confirmDeletePlaces() })

    expect(actions.deletePlacesMany).toHaveBeenCalledWith(42, [1, 2])
    expect(result.current.deletePlaceIds).toBeNull()
    expect(result.current.selectedPlaceId).toBeNull()

    await act(async () => { await result.current.undo() })
    expect(actions.addPlace).toHaveBeenCalledTimes(2)
    expect(actions.assignPlaceToDay).toHaveBeenCalledWith(42, 7, 900, 0)
  })

  it('FE-TP-HOOK-059: an explicit id list leaves the queued bulk selection untouched', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    act(() => { result.current.setDeletePlaceIds([9]) })
    await act(async () => { await result.current.confirmDeletePlaces([1]) })

    expect(actions.deletePlacesMany).toHaveBeenCalledWith(42, [1])
    expect(result.current.deletePlaceIds).toEqual([9])
  })

  it('FE-TP-HOOK-060: an empty bulk delete does nothing and a failing one toasts', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })
    actions.deletePlacesMany.mockRejectedValue(new Error('nope'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.confirmDeletePlaces([]) })
    expect(actions.deletePlacesMany).not.toHaveBeenCalled()

    await act(async () => { await result.current.confirmDeletePlaces([1]) })
    expect(toasts.some(t => t.message === 'nope')).toBe(true)
  })

  it('FE-TP-HOOK-061: a bulk category change restores each previous category group on undo', async () => {
    seedTrip({
      places: [
        buildPlace({ id: 1, lat: 1, lng: 2, category_id: 3 }),
        buildPlace({ id: 2, lat: 3, lng: 4, category_id: null }),
        buildPlace({ id: 3, lat: 5, lng: 6, category_id: 3 }),
      ],
    })

    const { result } = await renderPlanner()
    await act(async () => { await result.current.confirmChangeCategory([1, 2, 3], 9) })

    expect(actions.updatePlacesMany).toHaveBeenCalledWith(42, [1, 2, 3], { category_id: 9 })

    await act(async () => { await result.current.undo() })
    expect(actions.updatePlacesMany).toHaveBeenCalledWith(42, [1, 3], { category_id: 3 })
    expect(actions.updatePlacesMany).toHaveBeenCalledWith(42, [2], { category_id: null })
  })

  it('FE-TP-HOOK-062: an empty category change is skipped and a failing one toasts', async () => {
    seedTrip({ places: [buildPlace({ id: 1, lat: 1, lng: 2 })] })
    actions.updatePlacesMany.mockRejectedValue(new Error('denied'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.confirmChangeCategory([], 1) })
    expect(actions.updatePlacesMany).not.toHaveBeenCalled()

    await act(async () => { await result.current.confirmChangeCategory([1], 1) })
    expect(toasts.some(t => t.message === 'denied')).toBe(true)
  })
})

describe('useTripPlanner — day plan CRUD', () => {
  it('FE-TP-HOOK-063: assigning to the selected day registers an undo that removes it again', async () => {
    seedTrip({ selectedDayId: 7 })

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleAssignToDay(1) })

    expect(actions.assignPlaceToDay).toHaveBeenCalledWith(42, 7, 1, undefined)
    expect(updateRouteForDay).toHaveBeenCalledWith(7)

    await act(async () => { await result.current.undo() })
    expect(actions.removeAssignment).toHaveBeenCalledWith(42, 7, 555)
  })

  it('FE-TP-HOOK-064: assigning without any day asks the user to pick one', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleAssignToDay(1) })

    expect(actions.assignPlaceToDay).not.toHaveBeenCalled()
    expect(toasts.some(t => t.type === 'error')).toBe(true)
  })

  it('FE-TP-HOOK-065: a failing assignment surfaces the server message', async () => {
    seedTrip()
    actions.assignPlaceToDay.mockRejectedValue(new Error('day is full'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleAssignToDay(1, 7, 2) })

    expect(toasts.some(t => t.message === 'day is full')).toBe(true)
  })

  it('FE-TP-HOOK-066: removing an assignment can be undone back to its old position', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2 })
    seedTrip({
      places: [place],
      assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place, order_index: 4 })] },
    })

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleRemoveAssignment(7, 10) })

    expect(actions.removeAssignment).toHaveBeenCalledWith(42, 7, 10)

    await act(async () => { await result.current.undo() })
    expect(actions.assignPlaceToDay).toHaveBeenCalledWith(42, 7, 1, 4)
  })

  it('FE-TP-HOOK-067: a failing removal toasts and registers no undo', async () => {
    seedTrip({ assignments: {} })
    actions.removeAssignment.mockRejectedValue(new Error('gone'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleRemoveAssignment(7, 10) })

    expect(toasts.some(t => t.message === 'gone')).toBe(true)
    expect(result.current.canUndo).toBe(false)
  })

  it('FE-TP-HOOK-068: reordering a day can be undone to the previous order', async () => {
    const a = buildPlace({ id: 1, lat: 1, lng: 2 })
    const b = buildPlace({ id: 2, lat: 3, lng: 4 })
    seedTrip({
      places: [a, b],
      assignments: {
        '7': [
          buildAssignment({ id: 11, day_id: 7, place: b, order_index: 1 }),
          buildAssignment({ id: 10, day_id: 7, place: a, order_index: 0 }),
        ],
      },
    })

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleReorder(7, [11, 10]) })

    expect(actions.reorderAssignments).toHaveBeenCalledWith(42, 7, [11, 10])
    await waitFor(() => expect(result.current.canUndo).toBe(true))

    await act(async () => { await result.current.undo() })
    expect(actions.reorderAssignments).toHaveBeenLastCalledWith(42, 7, [10, 11])
  })

  it('FE-TP-HOOK-069: a rejected reorder toasts the server message', async () => {
    seedTrip()
    actions.reorderAssignments.mockRejectedValue(new Error('conflict'))

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleReorder(7, [1, 2]) })

    await waitFor(() => expect(toasts.some(t => t.message === 'conflict')).toBe(true))
  })

  it('FE-TP-HOOK-069b: a reorder that throws synchronously falls back to the generic message', async () => {
    seedTrip()
    actions.reorderAssignments.mockImplementation(() => { throw new Error('boom') })

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleReorder(7, [1, 2]) })

    expect(toasts.some(t => t.type === 'error' && t.message !== 'boom')).toBe(true)
  })

  it('FE-TP-HOOK-070: reordering days can be undone to the previous day order', async () => {
    seedTrip({
      days: [buildDay({ id: 2, day_number: 2 }), buildDay({ id: 1, day_number: 1 })],
    })

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleReorderDays([2, 1]) })

    expect(actions.reorderDays).toHaveBeenCalledWith(42, [2, 1])
    await waitFor(() => expect(result.current.canUndo).toBe(true))

    await act(async () => { await result.current.undo() })
    expect(actions.reorderDays).toHaveBeenLastCalledWith(42, [1, 2])
  })

  it('FE-TP-HOOK-071: a rejected day reorder toasts', async () => {
    seedTrip()
    actions.reorderDays.mockRejectedValue(new Error('locked'))

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleReorderDays([1]) })

    await waitFor(() => expect(toasts.some(t => t.message === 'locked')).toBe(true))
  })

  it('FE-TP-HOOK-072: inserting a day forwards the position and toasts on failure', async () => {
    seedTrip()
    actions.insertDay.mockRejectedValueOnce(new Error('no room'))

    const { result } = await renderPlanner()
    await act(async () => { result.current.handleAddDay(2) })

    expect(actions.insertDay).toHaveBeenCalledWith(42, 2)
    await waitFor(() => expect(toasts.some(t => t.message === 'no room')).toBe(true))
  })

  it('FE-TP-HOOK-073: a failing day-title rename toasts', async () => {
    seedTrip()
    actions.updateDayTitle.mockRejectedValue(new Error('too long'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleUpdateDayTitle(7, 'x') })

    expect(toasts.some(t => t.message === 'too long')).toBe(true)
  })

  it('FE-TP-HOOK-074: undo announces the label of the action it reversed', async () => {
    seedTrip({ selectedDayId: 7 })

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleAssignToDay(1) })
    expect(result.current.lastActionLabel).toBeTruthy()

    await act(async () => { await result.current.handleUndo() })
    expect(toasts.some(t => t.type === 'info')).toBe(true)
  })
})

describe('useTripPlanner — bookings and transports', () => {
  it('FE-TP-HOOK-075: a new booking is saved on the selected day and closes the modal', async () => {
    seedTrip({ selectedDayId: 7 })

    const { result } = await renderPlanner()
    act(() => { result.current.setShowReservationModal(true) })

    await act(async () => {
      await result.current.handleSaveReservation({ title: 'Dinner', type: 'restaurant' })
    })

    expect(actions.addReservation).toHaveBeenCalledWith(42, { title: 'Dinner', type: 'restaurant', day_id: 7 })
    expect(result.current.showReservationModal).toBe(false)
  })

  it('FE-TP-HOOK-076: a booking with a linked cost reloads the budget items', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({ title: 'Dinner', type: 'restaurant', create_budget_entry: 1 })
    })

    expect(actions.loadBudgetItems).toHaveBeenCalledWith(42)
  })

  it('FE-TP-HOOK-077: a new hotel refreshes the accommodation list', async () => {
    seedTrip()
    vi.mocked(accommodationsApi.list).mockResolvedValue({ accommodations: [{ id: 3 }] })

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({ title: 'Ryokan', type: 'hotel' })
    })

    await waitFor(() => expect(result.current.tripAccommodations).toHaveLength(1))
  })

  it('FE-TP-HOOK-078: editing a booking never forces a day_id onto the payload', async () => {
    const reservation = buildReservation({ id: 5, type: 'hotel' })
    seedTrip({ selectedDayId: 7, reservations: [reservation] })

    const { result } = await renderPlanner()
    act(() => { result.current.setEditingReservation(reservation) })

    await act(async () => {
      await result.current.handleSaveReservation({ title: 'Ryokan', type: 'hotel' })
    })

    expect(actions.updateReservation).toHaveBeenCalledWith(42, 5, { title: 'Ryokan', type: 'hotel' })
    expect(result.current.editingReservation).toBeNull()
  })

  it('FE-TP-HOOK-079: an edited hotel address is written through to the linked place', async () => {
    const place = buildPlace({ id: 1, lat: 1, lng: 2, address: 'Old street 1' })
    seedTrip({ places: [place] })

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Ryokan', type: 'hotel',
        create_accommodation: { place_id: 1, address: '  New street 2  ' },
      } as never)
    })

    expect(actions.updatePlace).toHaveBeenCalledWith(42, 1, { address: 'New street 2' })
    const payload = actions.addReservation.mock.calls[0][1] as { create_accommodation: Record<string, unknown> }
    expect(payload.create_accommodation).not.toHaveProperty('address')
  })

  it('FE-TP-HOOK-080: an imported hotel venue is matched against the existing places', async () => {
    seedTrip({ places: [buildPlace({ id: 4, name: 'Hotel Granvia', lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Stay', type: 'hotel',
        create_accommodation: { venue: { name: 'hotel granvia' } },
      } as never)
    })

    const payload = actions.addReservation.mock.calls[0][1] as { create_accommodation: { place_id?: number; venue?: unknown } }
    expect(payload.create_accommodation.place_id).toBe(4)
    expect(payload.create_accommodation.venue).toBeUndefined()
    expect(actions.addPlace).not.toHaveBeenCalled()
  })

  it('FE-TP-HOOK-080b: a venue name that only partially matches still links that place', async () => {
    seedTrip({ places: [buildPlace({ id: 6, name: 'Granvia', lat: 1, lng: 2 })] })

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Stay', type: 'hotel',
        create_accommodation: { venue: { name: 'Hotel Granvia Kyoto' } },
      } as never)
    })

    const payload = actions.addReservation.mock.calls[0][1] as { create_accommodation: { place_id?: number } }
    expect(payload.create_accommodation.place_id).toBe(6)
    expect(mapsApi.search).not.toHaveBeenCalled()
  })

  it('FE-TP-HOOK-081: an unknown venue is geocoded and created as a new place', async () => {
    vi.mocked(mapsApi.search).mockResolvedValue({
      places: [{ lat: 35.1, lng: 135.7, address: 'Kyoto, JP' }],
    } as never)
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Stay', type: 'hotel',
        create_accommodation: { venue: { name: 'Ryokan Sakura', address: 'Gion' } },
      } as never)
    })

    expect(mapsApi.search).toHaveBeenCalledWith('Ryokan Sakura Gion')
    // Created through the store (addPlace), which unwraps the API's { place }
    // envelope and pushes the place into `places` — not through placesApi
    // directly, whose envelope used to be read as the place itself (#2243).
    expect(actions.addPlace).toHaveBeenCalledWith(42, { name: 'Ryokan Sakura', lat: 35.1, lng: 135.7, address: 'Gion' })
    const payload = actions.addReservation.mock.calls[0][1] as { create_accommodation: { place_id?: number; venue?: unknown } }
    expect(payload.create_accommodation.place_id).toBe(900)
    expect(payload.create_accommodation.venue).toBeUndefined()
  })

  it('FE-TP-HOOK-081c: the place created for a new hotel is linked, so the next save of the same hotel reuses it (#2243)', async () => {
    vi.mocked(mapsApi.search).mockResolvedValue({
      places: [{ lat: 35.1, lng: 135.7, address: 'Kyoto, JP' }],
    } as never)
    // The real addPlace puts the created place into the store; mirror that so
    // the second save sees it the way the planner does after a create.
    actions.addPlace.mockImplementation(async (_tripId: unknown, data: { name: string }) => {
      const created = buildPlace({ id: 901, name: data.name, lat: 35.1, lng: 135.7 })
      useTripStore.setState(s => ({ places: [created, ...s.places] }))
      return created
    })
    seedTrip()

    const { result } = await renderPlanner()
    const save = () => result.current.handleSaveReservation({
      title: 'Ryokan Sakura', type: 'hotel',
      create_accommodation: { venue: { name: 'Ryokan Sakura' } },
    } as never)
    await act(async () => { await save() })
    await act(async () => { await save() })

    expect(actions.addPlace).toHaveBeenCalledTimes(1)
    const first = actions.addReservation.mock.calls[0][1] as { create_accommodation: { place_id?: number } }
    const second = actions.addReservation.mock.calls[1][1] as { create_accommodation: { place_id?: number } }
    expect(first.create_accommodation.place_id).toBe(901)
    expect(second.create_accommodation.place_id).toBe(901)
  })

  it('FE-TP-HOOK-081b: a geocoded venue without a reviewed address adopts the hit address', async () => {
    vi.mocked(mapsApi.search).mockResolvedValue({
      places: [{ lat: 35.1, lng: 135.7, address: 'Kyoto, JP' }],
    } as never)
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Stay', type: 'hotel',
        create_accommodation: { venue: { name: 'Ryokan Sakura' } },
      } as never)
    })

    expect(mapsApi.search).toHaveBeenCalledWith('Ryokan Sakura')
    expect(actions.addPlace).toHaveBeenCalledWith(42, { name: 'Ryokan Sakura', lat: 35.1, lng: 135.7, address: 'Kyoto, JP' })
  })

  it('FE-TP-HOOK-082: a failed geocode still creates the place, a failed create yields no link', async () => {
    vi.mocked(mapsApi.search).mockRejectedValue(new Error('overpass down'))
    actions.addPlace.mockRejectedValue(new Error('quota'))
    seedTrip()

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({
        title: 'Stay', type: 'hotel',
        create_accommodation: { venue: { name: 'Nowhere Inn' } },
      } as never)
    })

    expect(actions.addPlace).toHaveBeenCalled()
    const payload = actions.addReservation.mock.calls[0][1] as { create_accommodation: { place_id?: number } }
    expect(payload.create_accommodation.place_id).toBeUndefined()
  })

  it('FE-TP-HOOK-083: a failing booking save toasts the server message', async () => {
    seedTrip()
    actions.addReservation.mockRejectedValue(new Error('invalid date'))

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveReservation({ title: 'Dinner', type: 'restaurant' })
    })

    expect(toasts.some(t => t.message === 'invalid date')).toBe(true)
  })

  it('FE-TP-HOOK-084: a new transport closes the modal and reloads costs when one was linked', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    act(() => { result.current.setShowTransportModal(true); result.current.setTransportModalDayId(7) })

    await act(async () => {
      await result.current.handleSaveTransport({ title: 'Shinkansen', type: 'train', create_budget_entry: true })
    })

    expect(actions.addReservation).toHaveBeenCalledWith(42, { title: 'Shinkansen', type: 'train', create_budget_entry: true })
    expect(actions.loadBudgetItems).toHaveBeenCalledWith(42)
    expect(result.current.showTransportModal).toBe(false)
    expect(result.current.transportModalDayId).toBeNull()
  })

  it('FE-TP-HOOK-085: editing a transport updates it and clears the editor', async () => {
    const reservation = buildReservation({ id: 8, type: 'train' })
    seedTrip({ reservations: [reservation] })

    const { result } = await renderPlanner()
    act(() => { result.current.setEditingTransport(reservation) })

    await act(async () => {
      await result.current.handleSaveTransport({ title: 'Shinkansen', type: 'train' })
    })

    expect(actions.updateReservation).toHaveBeenCalledWith(42, 8, { title: 'Shinkansen', type: 'train' })
    expect(result.current.editingTransport).toBeNull()
  })

  it('FE-TP-HOOK-086: a failing transport save toasts', async () => {
    seedTrip()
    actions.addReservation.mockRejectedValue(new Error('bad leg'))

    const { result } = await renderPlanner()
    await act(async () => {
      await result.current.handleSaveTransport({ title: 'Bus', type: 'bus' })
    })

    expect(toasts.some(t => t.message === 'bad leg')).toBe(true)
  })

  it('FE-TP-HOOK-087: deleting a booking refreshes the accommodations', async () => {
    seedTrip()
    vi.mocked(accommodationsApi.list).mockResolvedValue({ accommodations: [{ id: 1 }] })

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleDeleteReservation(5) })

    expect(actions.deleteReservation).toHaveBeenCalledWith(42, 5)
    await waitFor(() => expect(result.current.tripAccommodations).toHaveLength(1))
  })

  it('FE-TP-HOOK-088: a failing booking delete toasts', async () => {
    seedTrip()
    actions.deleteReservation.mockRejectedValue(new Error('referenced'))

    const { result } = await renderPlanner()
    await act(async () => { await result.current.handleDeleteReservation(5) })

    expect(toasts.some(t => t.message === 'referenced')).toBe(true)
  })
})

describe('useTripPlanner — booking import review', () => {
  const hotelItem = { type: 'hotel', title: 'Ryokan', source: { fileName: 'mail.pdf' } }
  const flightItem = { type: 'flight', title: 'NRT → CDG' }

  it('FE-TP-HOOK-089: the review starts on the first item and routes hotels to the booking modal', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    const file = new File(['x'], 'mail.pdf')

    act(() => { result.current.startImportReview([hotelItem, flightItem] as never, [file]) })

    expect(result.current.importReviewActive).toBe(true)
    expect(result.current.showReservationModal).toBe(true)
    expect(result.current.reservationPrefill?.title).toBe('Ryokan')
    expect(result.current.reservationPrefill?._sourceFiles).toEqual([file])
  })

  // #2076 — an item whose type neither form can express used to land in the booking
  // form, which offers six chips and not one transport among them, so the only
  // honest pick left was 'other'. The tab the import started from breaks the tie.
  it('FE-TP-HOOK-112: an unreadable item opens the transport form when the import began there', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    const odd = { type: 'shuttle-voucher', title: 'Airport transfer' }

    // The tab now travels with the review rather than living in component state:
    // the parse outlives navigation and reload, and the review is triggered by the
    // global widget, so by then the state has remounted back to its default.
    act(() => { result.current.startImportReview([odd] as never, [], 'transports') })

    expect(result.current.showTransportModal).toBe(true)
    expect(result.current.showReservationModal).toBe(false)
  })

  it('FE-TP-HOOK-113: the same item opens the booking form when the import began there', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    const odd = { type: 'shuttle-voucher', title: 'Airport transfer' }

    act(() => { result.current.startImportReview([odd] as never, [], 'bookings') })

    expect(result.current.showReservationModal).toBe(true)
    expect(result.current.showTransportModal).toBe(false)
  })

  // The case that actually occurs. The server only ever emits its eight known
  // types, so 'shuttle-voucher' above never reaches a real import: a document the
  // model could not classify arrived as a placeholder 'hotel', which IS a booking
  // type, so the tie-breaker never ran and the tab lost every time (#2076).
  it('FE-TP-HOOK-112b: a guessed hotel opens the transport form when the import began there', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    const guessed = { type: 'hotel', title: 'Airport transfer', type_guessed: true }

    act(() => { result.current.startImportReview([guessed] as never, [], 'transports') })

    expect(result.current.showTransportModal).toBe(true)
    expect(result.current.showReservationModal).toBe(false)
  })

  it('FE-TP-HOOK-112c: a real hotel from the same tab still opens the booking form', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    const real = { type: 'hotel', title: 'Ryokan' }

    act(() => { result.current.startImportReview([real] as never, [], 'transports') })

    expect(result.current.showReservationModal).toBe(true)
    expect(result.current.showTransportModal).toBe(false)
  })

  // A recognised type always wins over the tab: one PDF routinely holds both.
  it('FE-TP-HOOK-114: a hotel imported from the transports tab still opens the booking form', async () => {
    seedTrip()
    const { result } = await renderPlanner()

    act(() => { result.current.setBookingImportKind('transports') })
    act(() => { result.current.startImportReview([hotelItem] as never) })

    expect(result.current.showReservationModal).toBe(true)
    expect(result.current.showTransportModal).toBe(false)
  })

  it('FE-TP-HOOK-090: advancing moves on to the transport item and then finishes the session', async () => {
    seedTrip()
    vi.mocked(accommodationsApi.list).mockResolvedValue({ accommodations: [{ id: 2 }] })

    const { result } = await renderPlanner()
    act(() => { result.current.startImportReview([hotelItem, flightItem] as never) })

    act(() => { result.current.advanceImportReview() })
    expect(result.current.showTransportModal).toBe(true)
    expect(result.current.transportPrefill?.title).toBe('NRT → CDG')
    expect(result.current.showReservationModal).toBe(false)

    act(() => { result.current.advanceImportReview() })
    expect(result.current.importReviewActive).toBe(false)
    expect(result.current.showTransportModal).toBe(false)
    expect(actions.loadBudgetItems).toHaveBeenCalledWith(42)
    await waitFor(() => expect(result.current.tripAccommodations).toHaveLength(1))
  })

  it('FE-TP-HOOK-091: an empty import list never opens the review', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    act(() => { result.current.startImportReview([]) })

    expect(result.current.importReviewActive).toBe(false)
    expect(result.current.showReservationModal).toBe(false)
  })

  it('FE-TP-HOOK-092: a finished background import hands its items to the review and clears the widget', async () => {
    seedTrip()
    useBackgroundTasksStore.setState({
      tasks: [{
        id: 'job-1', tripId: '42', label: 'mail.pdf', status: 'done', done: 1, total: 1,
        reviewRequested: true, items: [flightItem], sourceFiles: [new File(['x'], 'mail.pdf')],
      }] as never,
    })

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.showTransportModal).toBe(true))
    expect(result.current.transportPrefill?.title).toBe('NRT → CDG')
    expect(useBackgroundTasksStore.getState().tasks).toHaveLength(0)
  })

  it('FE-TP-HOOK-093: a background import without in-memory files falls back to the IndexedDB copy', async () => {
    seedTrip()
    useBackgroundTasksStore.setState({
      tasks: [{
        id: 'job-2', tripId: '42', label: 'mail.pdf', status: 'done', done: 1, total: 1,
        reviewRequested: true, items: [hotelItem],
      }] as never,
    })

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.showReservationModal).toBe(true))
    expect(result.current.reservationPrefill?._sourceFiles).toBeUndefined()
  })

  it('FE-TP-HOOK-094: a background task for another trip is left alone', async () => {
    seedTrip()
    useBackgroundTasksStore.setState({
      tasks: [{
        id: 'job-3', tripId: '99', label: 'mail.pdf', status: 'done', done: 1, total: 1,
        reviewRequested: true, items: [flightItem],
      }] as never,
    })

    const { result } = await renderPlanner()

    await waitFor(() => expect(result.current.tripId).toBe(42))
    expect(result.current.showTransportModal).toBe(false)
    expect(useBackgroundTasksStore.getState().tasks).toHaveLength(1)
  })
})

describe('useTripPlanner — misc state', () => {
  it('FE-TP-HOOK-095: the map tile url falls back to the default basemap', async () => {
    seedTrip()

    const { result } = await renderPlanner()
    expect(result.current.mapTileUrl).toContain('openfreemap.org')

    act(() => { setSettings({ map_tile_url: 'https://tiles/{z}/{x}/{y}.png' }) })
    expect(result.current.mapTileUrl).toBe('https://tiles/{z}/{x}/{y}.png')
  })

  it('FE-TP-HOOK-096: the transport type set matches the booking tab split', async () => {
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.TRANSPORT_TYPES.has('flight')).toBe(true)
    expect(result.current.TRANSPORT_TYPES.has('hotel')).toBe(false)
  })

  it('FE-TP-HOOK-097: the media query listener drives the mobile flag', async () => {
    const listeners: Record<string, Array<(e: MediaQueryListEvent) => void>> = {}
    const removeEventListener = vi.fn()
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_: string, handler: (e: MediaQueryListEvent) => void) => {
        ;(listeners[query] ??= []).push(handler)
      },
      removeEventListener,
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList)
    seedTrip()

    const { result, unmount } = await renderPlanner()
    expect(result.current.isMobile).toBe(false)

    act(() => { listeners['(max-width: 767px)'][0]({ matches: true } as MediaQueryListEvent) })
    expect(result.current.isMobile).toBe(true)

    unmount()
    expect(removeEventListener).toHaveBeenCalled()
  })

  it('FE-TP-HOOK-098: selectedPlace resolves the current selection out of the store', async () => {
    const place = buildPlace({ id: 1, name: 'Kiyomizu', lat: 1, lng: 2 })
    seedTrip({ places: [place] })

    const { result } = await renderPlanner()
    expect(result.current.selectedPlace).toBeNull()

    act(() => { result.current.handlePlaceClick(1) })
    expect(result.current.selectedPlace?.name).toBe('Kiyomizu')
  })

  it('FE-TP-HOOK-099: the map transport detail is a plain open/close slot', async () => {
    const reservation = buildReservation({ id: 3 }) as Reservation
    seedTrip()

    const { result } = await renderPlanner()
    act(() => { result.current.setMapTransportDetail(reservation) })
    expect(result.current.mapTransportDetail?.id).toBe(3)

    act(() => { result.current.setMapTransportDetail(null) })
    expect(result.current.mapTransportDetail).toBeNull()
  })

  it('FE-TP-HOOK-100: a member without upload rights gets no upload handler', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 2, role: 'user' }) })
    usePermissionsStore.setState({ permissions: { file_upload: 'trip_owner' } })
    seedTrip()

    const { result } = await renderPlanner()

    expect(result.current.canUploadFiles).toBe(false)
    expect(result.current.can('place_edit', result.current.trip)).toBe(true)
  })

  it('FE-TP-HOOK-101: without place_edit rights neither add-place entry point opens the form', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 2, role: 'user' }) })
    usePermissionsStore.setState({ permissions: { place_edit: 'admin' } })
    seedTrip()

    const { result } = await renderPlanner()

    await act(async () => {
      await result.current.handleMapContextMenu({ latlng: { lat: 1, lng: 2 } })
    })
    act(() => {
      result.current.openAddPlaceFromPoi({ lat: 1, lng: 2, name: 'x', address: null, website: null, phone: null, osm_id: 'n/1' })
    })

    expect(result.current.showPlaceForm).toBe(false)
    expect(result.current.prefillCoords).toBeNull()
  })

  it('FE-TP-HOOK-102: a member roster refresh replaces the cached list', async () => {
    seedTrip()
    const { result } = await renderPlanner()
    await waitFor(() => expect(tripsApi.getMembers).toHaveBeenCalled())

    vi.mocked(tripsApi.getMembers).mockResolvedValue({
      owner: { user_id: 1, username: 'owner' },
      members: [{ user_id: 2 }, { user_id: 3 }],
    })
    act(() => { result.current.refreshMembers() })

    await waitFor(() => expect(result.current.tripMembers).toHaveLength(3))
  })

  it('FE-TP-HOOK-103: a rejected roster fetch leaves the list untouched', async () => {
    vi.mocked(tripsApi.getMembers).mockRejectedValue(new Error('403'))
    seedTrip()

    const { result } = await renderPlanner()

    await waitFor(() => expect(tripsApi.getMembers).toHaveBeenCalled())
    expect(result.current.tripMembers).toEqual([])
  })
})
