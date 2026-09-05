// FE-PAGE-TPW-001 to FE-PAGE-TPW-061
//
// The planner page is a wiring container: everything stateful lives in
// useTripPlanner (covered in src/pages/tripPlanner/useTripPlanner.test.tsx).
// Here the hook is replaced by a controllable fixture so every branch of the
// layout — panels, portals, tabs, modals — and every inline callback the page
// hands its children can be driven directly.
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '../../tests/helpers/render'
import { resetAllStores, seedStore } from '../../tests/helpers/store'
import { buildUser, buildTrip, buildDay, buildPlace, buildAssignment, buildReservation, buildPackingItem, buildTodoItem } from '../../tests/helpers/factories'
import { useAuthStore } from '../store/authStore'
import { useTripStore } from '../store/tripStore'
import { useSettingsStore } from '../store/settingsStore'
import { assignmentsApi } from '../api/client'
import TripPlannerPage from './TripPlannerPage'
import type { Day, Place, Reservation, Settings } from '../types'

// ── Component stubs ───────────────────────────────────────────────────────────
// Each stub records the props it was rendered with so the page's inline
// callbacks can be invoked from the test.
type Props = Record<string, unknown>
const captured: Record<string, Props> = {}

function stub(name: string, testId?: string) {
  return (props: Props) => {
    captured[name] = props
    return testId ? React.createElement('div', { 'data-testid': testId }) : null
  }
}

/** The functional updater a setter spy was last called with. */
function updaterOf<T>(setter: unknown): (prev: T) => T {
  const calls = (setter as { mock: { calls: unknown[][] } }).mock.calls
  return calls[calls.length - 1][0] as (prev: T) => T
}

type AnyProp = ((...args: unknown[]) => unknown) & Record<string, unknown>

/** The last-rendered props of a stub, typed loosely so callbacks can be invoked. */
function props(name: string): Record<string, AnyProp> {
  return (captured[name] ?? {}) as Record<string, AnyProp>
}

vi.mock('../components/Map/MapViewAuto', () => ({ MapViewAuto: stub('map', 'map-view') }))
vi.mock('../components/Map/MapCompassPill', () => ({ MapCompassPill: stub('compass', 'compass-pill') }))
vi.mock('../components/Map/PoiCategoryPill', () => ({ default: stub('poiPill', 'poi-pill') }))
vi.mock('../components/Map/usePoiExplore', () => ({
  usePoiExplore: () => ({
    active: [], pois: [], loadingKeys: [], errorKeys: [], moved: false,
    toggle: vi.fn(), searchArea: vi.fn(), onViewportChange: vi.fn(),
  }),
}))

vi.mock('../components/Layout/Navbar', () => ({ default: stub('navbar', 'navbar') }))
vi.mock('../components/shared/SlidingTabs', () => ({ default: stub('tabs', 'sliding-tabs') }))
vi.mock('../components/shared/TripLoadingSplash', () => ({
  default: ({ title }: { title?: string }) =>
    React.createElement('div', { 'data-testid': 'splash', role: 'status' }, title ?? 'TREK'),
}))
const confirmDialogs: Props[] = []
vi.mock('../components/shared/ConfirmDialog', () => ({
  default: (p: Props) => { confirmDialogs.push(p); return null },
}))

vi.mock('../components/Planner/DayPlanSidebar', () => ({ default: stub('dayPlan', 'day-plan-sidebar') }))
vi.mock('../components/Planner/PlacesSidebar', () => ({ default: stub('places', 'places-sidebar') }))
vi.mock('../components/Planner/PlaceInspector', () => ({ default: stub('inspector', 'place-inspector') }))
vi.mock('../components/Planner/DayDetailPanel', () => ({ default: stub('dayDetail', 'day-detail-panel') }))
vi.mock('../components/Planner/PlaceFormModal', () => ({ default: stub('placeForm') }))
vi.mock('../components/Planner/ReservationModal', () => ({ ReservationModal: stub('reservationModal') }))
vi.mock('../components/Planner/TransportModal', () => ({ TransportModal: stub('transportModal', 'transport-modal') }))
vi.mock('../components/Planner/TransitJourneyModal', () => ({ default: stub('transitModal', 'transit-modal') }))
vi.mock('../components/Planner/BookingImportModal', () => ({ default: stub('bookingImport') }))
vi.mock('../components/Planner/AirTrailImportModal', () => ({ default: stub('airtrailImport') }))
vi.mock('../components/Planner/ReservationsPanel', () => ({ default: stub('reservationsPanel', 'reservations-panel') }))
vi.mock('../components/Planner/TripWarningsBanner', () => ({ default: stub('warnings', 'trip-warnings') }))

vi.mock('../components/Trips/TripFormModal', () => ({ default: stub('tripForm') }))
vi.mock('../components/Trips/TripMembersModal', () => ({ default: stub('membersModal') }))
vi.mock('../components/Packing/PackingListPanel', () => ({ default: stub('packingPanel', 'packing-list-panel') }))
vi.mock('../components/Packing/ApplyTemplateButton', () => ({ default: stub('applyTemplate', 'apply-template') }))
vi.mock('../components/Todo/TodoListPanel', () => ({ default: stub('todoPanel', 'todo-list-panel') }))
vi.mock('../components/Files/FileManager', () => ({ default: stub('fileManager', 'file-manager') }))
vi.mock('../components/Budget/CostsPanel', () => ({
  default: stub('costsPanel', 'costs-panel'),
  ExpenseModal: stub('expenseModal', 'expense-modal'),
}))
vi.mock('../components/Collab/CollabPanel', () => ({ default: stub('collabPanel', 'collab-panel') }))
vi.mock('../components/Plugins/PluginFrame', () => ({ default: stub('pluginFrame', 'plugin-frame') }))

// ── useTripPlanner fixture ────────────────────────────────────────────────────

const trip = buildTrip({ id: 42, title: 'Kyoto', currency: 'JPY' })
const day: Day = buildDay({ id: 7, trip_id: 42 })
const place: Place = buildPlace({ id: 1, name: 'Kiyomizu', lat: 34.9, lng: 135.7 })

type HookState = Record<string, unknown>
let hookState: HookState

function baseState(): HookState {
  return {
    tripId: 42,
    navigate: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    t: (key: string) => key,
    language: 'en',
    placesPhotosEnabled: true,
    trip,
    days: [day],
    places: [place],
    assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place, order_index: 0 })] },
    packingItems: [],
    todoItems: [],
    categories: [],
    reservations: [],
    budgetItems: [],
    files: [],
    selectedDayId: 7,
    isLoading: false,
    tripActions: {
      addFile: vi.fn(async () => undefined),
      deleteFile: vi.fn(async () => undefined),
      loadFiles: vi.fn(async () => undefined),
      updatePlace: vi.fn(async () => undefined),
      uploadPlaceImage: vi.fn(async () => undefined),
      ratePlace: vi.fn(async () => undefined),
      updateReservation: vi.fn(async () => undefined),
      updateTrip: vi.fn(async () => undefined),
      setSelectedDay: vi.fn(() => undefined),
      addCategory: vi.fn(async () => undefined),
    },
    can: vi.fn(() => true),
    canUploadFiles: true,
    pushUndo: vi.fn(() => undefined),
    undo: vi.fn(async () => undefined),
    canUndo: false,
    lastActionLabel: null,
    handleUndo: vi.fn(async () => undefined),
    enabledAddons: { packing: true, budget: true, documents: true, collab: true },
    collabFeatures: { chat: true, notes: true, polls: true, whatsnext: true },
    tripAccommodations: [],
    setTripAccommodations: vi.fn(),
    allowedFileTypes: 'pdf',
    tripMembers: [],
    setTripMembers: vi.fn(),
    refreshMembers: vi.fn(),
    loadAccommodations: vi.fn(),
    TRANSPORT_TYPES: new Set(['flight', 'train']),
    TRIP_TABS: [
      { id: 'plan', label: 'Plan' },
      { id: 'transports', label: 'Transports' },
      { id: 'buchungen', label: 'Bookings', shortLabel: 'Book' },
      { id: 'listen', label: 'Lists' },
      { id: 'finanzplan', label: 'Costs' },
      { id: 'dateien', label: 'Files' },
      { id: 'collab', label: 'Collab' },
    ],
    activeTab: 'plan',
    setActiveTab: vi.fn(),
    handleTabChange: vi.fn(),
    leftWidth: 320,
    rightWidth: 320,
    leftCollapsed: false,
    rightCollapsed: false,
    setLeftCollapsed: vi.fn(),
    setRightCollapsed: vi.fn(),
    leftHidden: false,
    rightHidden: false,
    toggleLeft: vi.fn(),
    toggleRight: vi.fn(),
    narrowPanels: false,
    startResizeLeft: vi.fn(),
    startResizeRight: vi.fn(),
    selectedPlaceId: null,
    selectedAssignmentId: null,
    setSelectedPlaceId: vi.fn(),
    selectAssignment: vi.fn(),
    showDayDetail: null,
    setShowDayDetail: vi.fn(),
    dayDetailCollapsed: false,
    setDayDetailCollapsed: vi.fn(),
    showPlaceForm: false,
    setShowPlaceForm: vi.fn(),
    editingPlace: null,
    setEditingPlace: vi.fn(),
    prefillCoords: null,
    setPrefillCoords: vi.fn(),
    editingAssignmentId: null,
    setEditingAssignmentId: vi.fn(),
    showTripForm: false,
    setShowTripForm: vi.fn(),
    showMembersModal: false,
    setShowMembersModal: vi.fn(),
    showReservationModal: false,
    setShowReservationModal: vi.fn(),
    editingReservation: null,
    setEditingReservation: vi.fn(),
    showBookingImport: false,
    setShowBookingImport: vi.fn(),
    bookingImportKind: 'bookings' as const,
    setBookingImportKind: vi.fn(),
    bookingImportAvailable: true,
    airTrailAvailable: true,
    showAirTrailImport: false,
    setShowAirTrailImport: vi.fn(),
    bookingForAssignmentId: null,
    setBookingForAssignmentId: vi.fn(),
    showTransportModal: false,
    setShowTransportModal: vi.fn(),
    editingTransport: null,
    setEditingTransport: vi.fn(),
    transportModalDayId: null,
    setTransportModalDayId: vi.fn(),
    transportModalAutomated: false,
    setTransportModalAutomated: vi.fn(),
    transitPrefill: null,
    setTransitPrefill: vi.fn(),
    transitJourney: null,
    setTransitJourney: vi.fn(),
    reservationPrefill: null,
    transportPrefill: null,
    importReviewActive: false,
    advanceImportReview: vi.fn(),
    routeShown: false,
    setRouteShown: vi.fn(),
    transitRoutesShown: false,
    routeProfile: 'driving',
    setRouteProfile: vi.fn(),
    routeVias: [],
    fitKey: 0,
    setFitKey: vi.fn(),
    mobileSidebarOpen: null,
    setMobileSidebarOpen: vi.fn(),
    mobilePlanScrollTopRef: { current: 0 },
    mobilePlacesScrollTopRef: { current: 0 },
    deletePlaceId: null,
    setDeletePlaceId: vi.fn(),
    deletePlaceIds: null,
    setDeletePlaceIds: vi.fn(),
    visibleConnections: [],
    toggleConnection: vi.fn(),
    allConnectionsShown: false,
    toggleAllConnections: vi.fn(),
    mapTransportDetail: null,
    setMapTransportDetail: vi.fn(),
    isMobile: false,
    isTouch: false,
    expandedDayIds: null,
    setExpandedDayIds: vi.fn(),
    mapPlaces: [place],
    route: null,
    routeSegments: [],
    routeInfo: null,
    setRoute: vi.fn(),
    setRouteInfo: vi.fn(),
    updateRouteForDay: vi.fn(),
    handleSelectDay: vi.fn(),
    handlePlaceClick: vi.fn(),
    handleMarkerClick: vi.fn(),
    handleMapClick: vi.fn(),
    handleMapContextMenu: vi.fn(),
    openAddPlaceFromPoi: vi.fn(),
    handleSavePlace: vi.fn(async () => undefined),
    openPlaceEditor: vi.fn(),
    handleDeletePlace: vi.fn(),
    confirmDeletePlace: vi.fn(async () => undefined),
    confirmDeletePlaces: vi.fn(async () => undefined),
    confirmChangeCategory: vi.fn(async () => undefined),
    handleAssignToDay: vi.fn(async () => undefined),
    handleRemoveAssignment: vi.fn(async () => undefined),
    handleReorder: vi.fn(),
    handleReorderDays: vi.fn(),
    handleAddDay: vi.fn(),
    handleUpdateDayTitle: vi.fn(async () => undefined),
    handleSaveReservation: vi.fn(async () => ({ id: 1 })),
    handleSaveTransport: vi.fn(async () => ({ id: 2 })),
    handleDeleteReservation: vi.fn(async () => undefined),
    selectedPlace: null,
    dayOrderMap: {},
    dayPlaces: [],
    mapTileUrl: 'https://tiles/{z}/{x}/{y}.png',
    fontStyle: { fontFamily: 'var(--font-system)' },
    splashDone: true,
  }
}

vi.mock('./tripPlanner/useTripPlanner', () => ({
  useTripPlanner: () => hookState,
}))

function setSettings(patch: Partial<Settings>) {
  useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ...patch } })
}

function renderPage(overrides: HookState = {}) {
  hookState = { ...hookState, ...overrides }
  return render(<TripPlannerPage />)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAllStores()
  for (const key of Object.keys(captured)) delete captured[key]
  confirmDialogs.length = 0
  hookState = baseState()
  seedStore(useAuthStore, { isAuthenticated: true, user: buildUser({ id: 5 }) })
  useTripStore.setState({ loadBudgetItems: vi.fn(async () => undefined) } as never)
})

describe('TripPlannerPage — shell', () => {
  it('FE-PAGE-TPW-002: the splash holds the page until the trip finished loading', () => {
    renderPage({ isLoading: true, splashDone: false })

    expect(screen.getByRole('status')).toHaveTextContent('Kyoto')
    expect(screen.queryByTestId('map-view')).not.toBeInTheDocument()
  })

  it('FE-PAGE-TPW-003: the splash also covers the gap between load and splashDone', () => {
    renderPage({ isLoading: false, splashDone: false })

    expect(screen.getByTestId('splash')).toBeInTheDocument()
  })

  it('FE-PAGE-TPW-004: a trip that never arrived renders nothing at all', () => {
    const { container } = renderPage({ trip: null, isLoading: false, splashDone: true })

    expect(container).toBeEmptyDOMElement()
  })

  it('FE-PAGE-TPW-005: the navbar gets the trip title and drives back / share', () => {
    renderPage()

    expect(props('navbar').tripTitle).toBe('Kyoto')
    act(() => { props('navbar').onBack() })
    expect(hookState.navigate).toHaveBeenCalledWith('/dashboard')

    act(() => { props('navbar').onShare() })
    expect(hookState.setShowMembersModal).toHaveBeenCalledWith(true)
  })

  it('FE-PAGE-TPW-006: the tab bar renders every tab and forwards a switch to the hook', () => {
    renderPage()

    const tabs = props('tabs').tabs as unknown as Array<{ id: string; title: string }>
    expect(tabs.map(t => t.id)).toContain('collab')
    expect(tabs.find(t => t.id === 'buchungen')?.title).toBe('Bookings')

    act(() => { props('tabs').onChange('dateien') })
    expect(hookState.handleTabChange).toHaveBeenCalledWith('dateien')
  })

  it('FE-PAGE-TPW-007: a plugin warning chip jumps to that plugin tab', () => {
    renderPage()

    act(() => { props('warnings').onOpenPluginTab('routes') })
    expect(hookState.handleTabChange).toHaveBeenCalledWith('plugin:routes')
  })
})

describe('TripPlannerPage — plan tab', () => {
  it('FE-PAGE-TPW-008: the map receives the filtered markers, the tile url, the panel widths and the selected day', () => {
    renderPage({ transitRoutesShown: true })

    expect(props('map').places).toEqual([place])
    expect(props('map').tileUrl).toBe('https://tiles/{z}/{x}/{y}.png')
    expect(props('map').leftWidth).toBe(320)
    expect(props('map').center).toBeUndefined()
    // Without the day the route toggle belongs to, the map draws every automated
    // transport in the trip as soon as any day's route is on (#2019).
    expect(props('map').days).toEqual([day])
    expect(props('map').selectedDayId).toBe(7)
    // Transit visibility rides the hook's day-aware derivation, not the raw
    // toggle — routeShown is still false in this fixture (#2019).
    expect(props('map').showTransitRoutes).toBe(true)
  })

  it('FE-PAGE-TPW-009: collapsed panels report a zero width to the map', () => {
    renderPage({ leftHidden: true, rightHidden: true })

    expect(props('map').leftWidth).toBe(0)
    expect(props('map').rightWidth).toBe(0)
  })

  it('FE-PAGE-TPW-010: clicking a booking route on the map opens its transport detail', () => {
    const reservation = buildReservation({ id: 3, type: 'train' })
    renderPage({ reservations: [reservation] })

    act(() => { props('map').onReservationClick(3) })
    expect(hookState.setMapTransportDetail).toHaveBeenCalledWith(reservation)

    act(() => { props('map').onReservationClick(999) })
    expect(hookState.setMapTransportDetail).toHaveBeenCalledTimes(1)
  })

  it('FE-PAGE-TPW-011: the compass pill appears once the GL map reports itself ready', async () => {
    renderPage()
    expect(screen.queryByTestId('compass-pill')).not.toBeInTheDocument()

    await act(async () => { props('map').onMapReady({ getBearing: () => 0 }) })

    await waitFor(() => expect(screen.getAllByTestId('compass-pill').length).toBeGreaterThan(0))
  })

  it('FE-PAGE-TPW-012: turning the POI pill off in settings removes both POI controls', () => {
    setSettings({ map_poi_pill_enabled: false })
    renderPage()

    expect(screen.queryByTestId('poi-pill')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-poi-category-pill')).not.toBeInTheDocument()
  })

  it('FE-PAGE-TPW-013: the collapse buttons toggle each side panel', () => {
    renderPage()

    const [leftBtn, rightBtn] = screen.getAllByRole('button')
    fireEvent.click(leftBtn)
    expect(hookState.toggleLeft).toHaveBeenCalled()

    fireEvent.mouseEnter(leftBtn)
    fireEvent.mouseLeave(leftBtn)

    fireEvent.click(rightBtn)
    expect(hookState.toggleRight).toHaveBeenCalled()
    fireEvent.mouseEnter(rightBtn)
    fireEvent.mouseLeave(rightBtn)
  })

  // The tabs are the only way back to a panel on a touch device, and they used to
  // announce themselves with nothing but a hover colour (#2247).
  it('FE-PAGE-TPW-013b: each collapse tab is named for what it does', () => {
    renderPage({ leftHidden: true, rightHidden: false })
    const [leftBtn, rightBtn] = screen.getAllByRole('button')
    expect(leftBtn).toHaveAttribute('aria-label', 'trip.mobilePlan')
    expect(rightBtn).toHaveAttribute('aria-label', 'common.collapse')
  })

  // At a foldable's ~860px the viewport centre sits under the Places panel, so the
  // floating POI/compass cluster covered both tabs and the Add Place button (#2247).
  it('FE-PAGE-TPW-013c: the floating map controls centre on the map corridor, not the viewport', () => {
    const { container } = renderPage({ leftWidth: 340, rightWidth: 300 })
    const cluster = container.querySelector('div[style*="translateX(-50%)"][style*="z-index: 25"]') as HTMLElement
    expect(cluster.style.left).toBe('calc(350px + 0.5 * (100% - 350px - 310px))')
  })

  it('FE-PAGE-TPW-013d: a hidden panel takes no corridor away from the map controls', () => {
    const { container } = renderPage({ leftWidth: 340, rightWidth: 300, rightHidden: true })
    const cluster = container.querySelector('div[style*="translateX(-50%)"][style*="z-index: 25"]') as HTMLElement
    expect(cluster.style.left).toBe('calc(350px + 0.5 * (100% - 350px - 0px))')
  })

  it('FE-PAGE-TPW-014: a collapsed panel keeps its toggle but drops the hover highlight', () => {
    renderPage({ leftHidden: true, rightHidden: true })

    const [leftBtn, rightBtn] = screen.getAllByRole('button')
    fireEvent.mouseEnter(leftBtn)
    fireEvent.mouseLeave(leftBtn)
    fireEvent.mouseEnter(rightBtn)
    fireEvent.mouseLeave(rightBtn)

    expect(screen.getByTestId('day-plan-sidebar')).toBeInTheDocument()
  })

  // Mouse-only handles (mousedown + document mousemove) are inert on a tablet, and
  // a 4px invisible strip on the panel edge is a trap for a fat finger (#2247).
  it('FE-PAGE-TPW-015b: the narrow layout drops the mouse-only resize handles', () => {
    const { container } = renderPage({ narrowPanels: true })
    expect(container.querySelectorAll('div[style*="col-resize"]')).toHaveLength(0)
  })

  it('FE-PAGE-TPW-015: the resize handles start a drag on mouse-down and highlight on hover', () => {
    const { container } = renderPage()
    const handles = container.querySelectorAll('div[style*="col-resize"]')
    expect(handles).toHaveLength(2)

    fireEvent.mouseDown(handles[0])
    expect(hookState.startResizeLeft).toHaveBeenCalled()
    fireEvent.mouseEnter(handles[0])
    fireEvent.mouseLeave(handles[0])

    fireEvent.mouseDown(handles[1])
    expect(hookState.startResizeRight).toHaveBeenCalled()
    fireEvent.mouseEnter(handles[1])
    fireEvent.mouseLeave(handles[1])
  })
})

describe('TripPlannerPage — day plan sidebar wiring', () => {
  it('FE-PAGE-TPW-016: a calculated route is pushed into the map, clearing it resets both slots', () => {
    renderPage()

    act(() => { props('dayPlan').onRouteCalculated({ coordinates: [[1, 2]], distanceText: '1 km' }) })
    expect(hookState.setRoute).toHaveBeenCalledWith([[[1, 2]]])
    expect(hookState.setRouteInfo).toHaveBeenCalled()

    act(() => { props('dayPlan').onRouteCalculated(null) })
    expect(hookState.setRoute).toHaveBeenLastCalledWith(null)
    expect(hookState.setRouteInfo).toHaveBeenLastCalledWith(null)
  })

  it('FE-PAGE-TPW-017: adding a booking from a day selects that day and opens the modal', () => {
    renderPage()

    act(() => { props('dayPlan').onAddReservation(7) })

    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(hookState.setEditingReservation).toHaveBeenCalledWith(null)
    expect(tripActions.setSelectedDay).toHaveBeenCalledWith(7)
    expect(hookState.setShowReservationModal).toHaveBeenCalledWith(true)
  })

  it('FE-PAGE-TPW-018: the manual and automated transport entry points differ only in the mode', () => {
    renderPage({ trip: { ...trip, start_date: '2025-06-01', end_date: '2025-06-05' } })

    act(() => { props('dayPlan').onAddTransport(7) })
    expect(hookState.setTransportModalAutomated).toHaveBeenLastCalledWith(false)

    act(() => { props('dayPlan').onPlanTransit(7) })
    expect(hookState.setTransportModalAutomated).toHaveBeenLastCalledWith(true)
    expect(hookState.setTransportModalDayId).toHaveBeenLastCalledWith(7)
  })

  it('FE-PAGE-TPW-019: a trip without dates hides the transit planner, no rights hides the rest', () => {
    renderPage({
      trip: { ...trip, start_date: null, end_date: null },
      can: vi.fn(() => false),
    })

    expect(props('dayPlan').onPlanTransit).toBeUndefined()
    expect(props('dayPlan').onAddTransport).toBeUndefined()
    expect(props('dayPlan').onEditTransport).toBeUndefined()
    expect(props('dayPlan').onEditReservation).toBeUndefined()
    expect(props('dayPlan').onAddBookingToAssignment).toBeUndefined()
  })

  it('FE-PAGE-TPW-020: editing a transport or a booking from a day opens the matching modal', () => {
    const transport = buildReservation({ id: 4, type: 'train', day_id: 7 })
    const booking = buildReservation({ id: 5, type: 'hotel' })
    renderPage()

    act(() => { props('dayPlan').onEditTransport(transport) })
    expect(hookState.setEditingTransport).toHaveBeenCalledWith(transport)
    expect(hookState.setTransportModalDayId).toHaveBeenCalledWith(7)

    act(() => { props('dayPlan').onEditReservation(booking) })
    expect(hookState.setEditingReservation).toHaveBeenCalledWith(booking)
    expect(hookState.setShowReservationModal).toHaveBeenCalledWith(true)
  })

  it('FE-PAGE-TPW-021: the remaining day-plan callbacks reach their hook handlers', () => {
    renderPage()

    act(() => { props('dayPlan').onOpenTransit(buildReservation({ id: 6, type: 'transit' })) })
    expect(hookState.setTransitJourney).toHaveBeenCalled()

    act(() => { props('dayPlan').onDayDetail(day) })
    expect(hookState.setShowDayDetail).toHaveBeenCalledWith(day)
    expect(hookState.selectAssignment).toHaveBeenCalledWith(null)

    act(() => { props('dayPlan').onEditPlace(place, 10) })
    expect(hookState.setEditingAssignmentId).toHaveBeenCalledWith(10)

    act(() => { props('dayPlan').onEditPlace(place, undefined) })
    expect(hookState.setEditingAssignmentId).toHaveBeenLastCalledWith(null)

    act(() => { props('dayPlan').onDeletePlace(1) })
    expect(hookState.handleDeletePlace).toHaveBeenCalledWith(1)

    act(() => { props('dayPlan').onToggleRoute() })
    expect(updaterOf<boolean>(hookState.setRouteShown)(false)).toBe(true)

    act(() => { props('dayPlan').onNavigateToFiles() })
    expect(hookState.handleTabChange).toHaveBeenCalledWith('dateien')

    act(() => { props('dayPlan').onRouteRefresh() })
    expect(hookState.updateRouteForDay).toHaveBeenCalledWith(7)

    act(() => { props('dayPlan').onAddBookingToAssignment(7, 10) })
    expect(hookState.setBookingForAssignmentId).toHaveBeenCalledWith(10)

    act(() => { props('dayPlan').onExternalTransportDetailHandled() })
    expect(hookState.setMapTransportDetail).toHaveBeenCalledWith(null)
  })

  it('FE-PAGE-TPW-022: a route refresh without a selected day is skipped', () => {
    renderPage({ selectedDayId: null })

    act(() => { props('dayPlan').onRouteRefresh() })
    expect(hookState.updateRouteForDay).not.toHaveBeenCalled()
  })

  it('FE-PAGE-TPW-023: the places sidebar add/edit/bulk callbacks reach the hook', () => {
    renderPage()

    act(() => { props('places').onAddPlace() })
    expect(hookState.setShowPlaceForm).toHaveBeenCalledWith(true)

    act(() => { props('places').onEditPlace(place) })
    expect(hookState.openPlaceEditor).toHaveBeenCalledWith(place)

    act(() => { props('places').onDeletePlace(1) })
    expect(hookState.handleDeletePlace).toHaveBeenCalledWith(1)

    act(() => { props('places').onBulkDeletePlaces([1, 2]) })
    expect(hookState.setDeletePlaceIds).toHaveBeenCalledWith([1, 2])

    act(() => { props('places').onBulkChangeCategory([1], 4) })
    expect(hookState.confirmChangeCategory).toHaveBeenCalledWith([1], 4)
  })
})

describe('TripPlannerPage — day detail and inspector', () => {
  it('FE-PAGE-TPW-024: the day detail panel picks its coordinates from the day\'s first geo stop', () => {
    renderPage({ showDayDetail: day })

    expect(props('dayDetail').lat).toBe(34.9)
    expect(props('dayDetail').day).toEqual(day)

    act(() => { props('dayDetail').onClose() })
    expect(hookState.setShowDayDetail).toHaveBeenCalledWith(null)
    expect(hookState.handleSelectDay).toHaveBeenCalledWith(null)

    act(() => { props('dayDetail').onToggleCollapse() })
    expect(updaterOf<boolean>(hookState.setDayDetailCollapsed)(false)).toBe(true)

    act(() => { props('dayDetail').onAccommodationChange() })
    expect(hookState.loadAccommodations).toHaveBeenCalled()
  })

  it('FE-PAGE-TPW-025: a day without geo stops gets no weather anchor from other days (#2167)', () => {
    renderPage({ showDayDetail: { ...day, id: 99 }, assignments: {} })

    expect(props('dayDetail').lat).toBeNull()
    expect(props('dayDetail').lng).toBeNull()
  })

  it('FE-PAGE-TPW-026: the desktop inspector edits, deletes and rates through the hook', async () => {
    vi.spyOn(assignmentsApi, 'setParticipants').mockResolvedValue({ participants: [{ user_id: 5 }] })
    useTripStore.setState({ assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] } } as never)
    renderPage({ selectedPlace: place, selectedAssignmentId: 10 })

    // jsdom reports a 1024px viewport, so the inspector still gets the real panel widths.
    expect(props('inspector').leftWidth).toBe(320)
    act(() => { props('inspector').onEdit() })
    expect(hookState.openPlaceEditor).toHaveBeenCalledWith(place, 10)

    act(() => { props('inspector').onDelete() })
    expect(hookState.handleDeletePlace).toHaveBeenCalledWith(1)

    act(() => { props('inspector').onClose() })
    expect(hookState.setSelectedPlaceId).toHaveBeenCalledWith(null)

    await act(async () => { await props('inspector').onSetParticipants(10, 7, [5]) })
    expect(assignmentsApi.setParticipants).toHaveBeenCalledWith(42, 10, [5])
    expect(useTripStore.getState().assignments['7'][0].participants).toEqual([{ user_id: 5 }])

    await act(async () => { await props('inspector').onUpdatePlace(1, { name: 'X' }) })
    await act(async () => { await props('inspector').onUploadImage(1, new File(['x'], 'a.png')) })
    await act(async () => { await props('inspector').onRate(1, 4) })
    await act(async () => { await props('inspector').onFileUpload(new FormData()) })

    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(tripActions.addFile).toHaveBeenCalled()
    expect(tripActions.updatePlace).toHaveBeenCalledWith(42, 1, { name: 'X' })
    expect(tripActions.uploadPlaceImage).toHaveBeenCalled()
    expect(tripActions.ratePlace).toHaveBeenCalledWith(42, 1, 4)
  })

  it('FE-PAGE-TPW-027: inspector write failures are surfaced as toasts', async () => {
    vi.spyOn(assignmentsApi, 'setParticipants').mockRejectedValue(new Error('no rights'))
    const tripActions = {
      ...(baseState().tripActions as Record<string, ReturnType<typeof vi.fn>>),
      updatePlace: vi.fn(async () => { throw new Error('bad name') }),
      ratePlace: vi.fn(async () => { throw new Error('rate limit') }),
    }
    renderPage({ selectedPlace: place, tripActions })

    await act(async () => { await props('inspector').onSetParticipants(10, 7, [5]) })
    await act(async () => { await props('inspector').onUpdatePlace(1, {}) })
    await act(async () => { await props('inspector').onRate(1, 4) })

    const toast = hookState.toast as { error: ReturnType<typeof vi.fn> }
    expect(toast.error).toHaveBeenCalledTimes(3)
    expect(toast.error).toHaveBeenCalledWith('no rights')
  })

  it('FE-PAGE-TPW-028: without upload rights the inspector gets no upload handler', () => {
    renderPage({ selectedPlace: place, canUploadFiles: false })

    expect(props('inspector').onFileUpload).toBeUndefined()
  })

  it('FE-PAGE-TPW-029: on mobile the inspector moves into a dismissible bottom sheet', async () => {
    renderPage({ selectedPlace: place, isMobile: true, selectedAssignmentId: 10 })

    expect(screen.getByTestId('place-inspector')).toBeInTheDocument()
    expect(props('inspector').leftWidth).toBe(0)

    act(() => { props('inspector').onEdit() })
    expect(hookState.openPlaceEditor).toHaveBeenCalledWith(place, 10)
    expect(hookState.setSelectedPlaceId).toHaveBeenCalledWith(null)

    act(() => { props('inspector').onDelete() })
    expect(hookState.handleDeletePlace).toHaveBeenCalledWith(1)

    await act(async () => { await props('inspector').onUpdatePlace(1, { name: 'Y' }) })
    await act(async () => { await props('inspector').onUploadImage(1, new File(['x'], 'a.png')) })
    await act(async () => { await props('inspector').onRate(1, 3) })
    await act(async () => { await props('inspector').onFileUpload(new FormData()) })

    // Tapping the backdrop closes the sheet, tapping the sheet itself does not.
    const backdrop = document.body.querySelector('div[style*="z-index: 9999"]') as HTMLElement
    fireEvent.click(backdrop.firstElementChild as HTMLElement)
    const before = (hookState.setSelectedPlaceId as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(backdrop)
    expect((hookState.setSelectedPlaceId as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
  })

  it('FE-PAGE-TPW-029b: the mobile sheet writes participants and toasts its own failures', async () => {
    vi.spyOn(assignmentsApi, 'setParticipants').mockResolvedValue({ participants: [{ user_id: 5 }] })
    useTripStore.setState({ assignments: { '7': [buildAssignment({ id: 10, day_id: 7, place })] } } as never)
    renderPage({ selectedPlace: place, isMobile: true })

    await act(async () => { await props('inspector').onSetParticipants(10, 7, [5]) })
    expect(useTripStore.getState().assignments['7'][0].participants).toEqual([{ user_id: 5 }])

    vi.mocked(assignmentsApi.setParticipants).mockRejectedValue(new Error('no rights'))
    const tripActions = {
      ...(baseState().tripActions as Record<string, ReturnType<typeof vi.fn>>),
      updatePlace: vi.fn(async () => { throw new Error('bad name') }),
      ratePlace: vi.fn(async () => { throw new Error('rate limit') }),
    }
    cleanup()
    renderPage({ selectedPlace: place, isMobile: true, tripActions })

    await act(async () => { await props('inspector').onSetParticipants(10, 7, [5]) })
    await act(async () => { await props('inspector').onUpdatePlace(1, {}) })
    await act(async () => { await props('inspector').onRate(1, 2) })

    const toast = hookState.toast as { error: ReturnType<typeof vi.fn> }
    expect(toast.error.mock.calls.map(c => c[0])).toEqual(['no rights', 'bad name', 'rate limit'])
  })
})

describe('TripPlannerPage — mobile drawers', () => {
  it('FE-PAGE-TPW-030: the mobile Plan/Places buttons open their drawer', () => {
    renderPage()

    const planBtn = Array.from(document.body.querySelectorAll('button'))
      .find(b => b.textContent === 'trip.mobilePlan')!
    const placesBtn = Array.from(document.body.querySelectorAll('button'))
      .find(b => b.textContent === 'trip.mobilePlaces')!

    fireEvent.click(planBtn)
    expect(hookState.setMobileSidebarOpen).toHaveBeenCalledWith('left')
    fireEvent.click(placesBtn)
    expect(hookState.setMobileSidebarOpen).toHaveBeenCalledWith('right')
  })

  it('FE-PAGE-TPW-031: the left drawer renders the day plan and its mobile-only callbacks', () => {
    renderPage({ mobileSidebarOpen: 'left' })

    expect(screen.getAllByTestId('day-plan-sidebar')).toHaveLength(2)

    act(() => { props('dayPlan').onSelectDay(7) })
    expect(hookState.handleSelectDay).toHaveBeenCalledWith(7)
    expect(hookState.setMobileSidebarOpen).toHaveBeenCalledWith(null)

    act(() => { props('dayPlan').onPlaceClick(1, 10) })
    expect(hookState.handlePlaceClick).toHaveBeenCalledWith(1, 10)

    act(() => { props('dayPlan').onRouteCalculated({ coordinates: [[1, 2]] }) })
    expect(hookState.setRoute).toHaveBeenCalled()

    // clearing from the drawer resets both slots, same as the desktop sidebar
    act(() => { props('dayPlan').onRouteCalculated(null) })
    expect(hookState.setRoute).toHaveBeenLastCalledWith(null)
    expect(hookState.setRouteInfo).toHaveBeenLastCalledWith(null)

    act(() => { props('dayPlan').onAddReservation(7) })
    act(() => { props('dayPlan').onAddTransport(7) })
    act(() => { props('dayPlan').onPlanTransit(7) })
    act(() => { props('dayPlan').onOpenTransit(buildReservation({ id: 8, type: 'transit' })) })
    act(() => { props('dayPlan').onAddPlace() })
    act(() => { props('dayPlan').onEditPlace(place, 10) })
    act(() => { props('dayPlan').onNavigateToFiles() })
    act(() => { props('dayPlan').onEditTransport(buildReservation({ id: 9, type: 'train', day_id: null })) })
    act(() => { props('dayPlan').onEditReservation(buildReservation({ id: 11, type: 'hotel' })) })
    act(() => { props('dayPlan').onScrollTopChange(120) })
    act(() => { props('dayPlan').onDayDetail(day) })
    act(() => { props('dayPlan').onDeletePlace(1) })
    act(() => { props('dayPlan').onToggleRoute() })

    expect((hookState.mobilePlanScrollTopRef as { current: number }).current).toBe(120)
    expect(hookState.setTransportModalDayId).toHaveBeenLastCalledWith(null)
    expect(hookState.handleTabChange).toHaveBeenCalledWith('dateien')

    // The drawer header closes the sheet, and so does its backdrop.
    const header = screen.getByText('trip.mobilePlan')
    expect(header).toBeInTheDocument()
    const closeBtn = header.parentElement!.querySelector('button')!
    fireEvent.click(closeBtn)
    expect(hookState.setMobileSidebarOpen).toHaveBeenCalledWith(null)

    const backdrop = header.closest('div[style*="z-index: 9999"]') as HTMLElement
    const closes = (hookState.setMobileSidebarOpen as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(backdrop)
    expect((hookState.setMobileSidebarOpen as ReturnType<typeof vi.fn>).mock.calls.length).toBe(closes + 1)
  })

  it('FE-PAGE-TPW-032: the right drawer renders the places list and its mobile-only callbacks', () => {
    renderPage({ mobileSidebarOpen: 'right' })

    expect(screen.getAllByTestId('places-sidebar')).toHaveLength(2)
    expect(screen.getByText('trip.mobilePlaces')).toBeInTheDocument()

    act(() => { props('places').onPlaceClick(1) })
    expect(hookState.handlePlaceClick).toHaveBeenCalledWith(1)

    act(() => { props('places').onAddPlace() })
    act(() => { props('places').onEditPlace(place) })
    act(() => { props('places').onDeletePlace(1) })
    act(() => { props('places').onBulkDeletePlaces([1]) })
    act(() => { props('places').onBulkDeleteConfirm([1]) })
    act(() => { props('places').onBulkChangeCategory([1], null) })
    act(() => { props('places').onScrollTopChange(40) })

    expect(hookState.confirmDeletePlaces).toHaveBeenCalledWith([1])
    expect((hookState.mobilePlacesScrollTopRef as { current: number }).current).toBe(40)
  })

  it('FE-PAGE-TPW-033: an open drawer hides the floating map buttons', () => {
    renderPage({ mobileSidebarOpen: 'left' })

    expect(screen.queryByTestId('mobile-poi-category-pill')).not.toBeInTheDocument()
    expect(Array.from(document.body.querySelectorAll('button'))
      .some(b => b.textContent === 'trip.mobilePlaces')).toBe(false)
  })
})

describe('TripPlannerPage — other tabs', () => {
  const flight = buildReservation({ id: 1, type: 'flight' })
  const hotel = buildReservation({ id: 2, type: 'hotel' })
  const transit = buildReservation({ id: 3, type: 'train' })

  it('FE-PAGE-TPW-034: the transports tab lists only transport bookings and wires its actions', async () => {
    renderPage({ activeTab: 'transports', reservations: [flight, hotel, transit] })
    // The panel loads on demand now; its props only exist once the chunk is in.
    await screen.findByTestId('reservations-panel')

    const listed = props('reservationsPanel').reservations as unknown as Reservation[]
    expect(listed.map(r => r.id)).toEqual([1, 3])

    act(() => { props('reservationsPanel').onAdd() })
    expect(hookState.setTransportModalAutomated).toHaveBeenCalledWith(false)

    act(() => { props('reservationsPanel').onImport() })
    expect(hookState.setShowBookingImport).toHaveBeenCalledWith(true)

    act(() => { props('reservationsPanel').onAirTrailImport() })
    expect(hookState.setShowAirTrailImport).toHaveBeenCalledWith(true)

    act(() => { props('reservationsPanel').onEdit(transit) })
    expect(hookState.setEditingTransport).toHaveBeenCalledWith(transit)

    act(() => { props('reservationsPanel').onDelete(1) })
    expect(hookState.handleDeleteReservation).toHaveBeenCalledWith(1)

    act(() => { props('reservationsPanel').onNavigateToFiles() })
    expect(hookState.handleTabChange).toHaveBeenCalledWith('dateien')
  })

  it('FE-PAGE-TPW-035: a saved transit journey opens the journey view instead of the editor', async () => {
    const journey = buildReservation({ id: 9, type: 'transit' })
    renderPage({ activeTab: 'transports', reservations: [journey] })
    await screen.findByTestId('reservations-panel')

    act(() => { props('reservationsPanel').onEdit(journey) })
    expect(hookState.setTransitJourney).toHaveBeenCalledWith(journey)
    expect(hookState.setShowTransportModal).not.toHaveBeenCalled()
  })

  it('FE-PAGE-TPW-036: the bookings tab lists everything that is not transport', async () => {
    renderPage({ activeTab: 'buchungen', reservations: [flight, hotel] })
    await screen.findByTestId('reservations-panel')

    const listed = props('reservationsPanel').reservations as unknown as Reservation[]
    expect(listed.map(r => r.id)).toEqual([2])

    act(() => { props('reservationsPanel').onAdd() })
    expect(hookState.setShowReservationModal).toHaveBeenCalledWith(true)

    act(() => { props('reservationsPanel').onImport() })
    expect(hookState.setShowBookingImport).toHaveBeenCalledWith(true)

    act(() => { props('reservationsPanel').onEdit(hotel) })
    expect(hookState.setEditingReservation).toHaveBeenCalledWith(hotel)

    act(() => { props('reservationsPanel').onNavigateToFiles() })
    expect(hookState.handleTabChange).toHaveBeenCalledWith('dateien')
  })

  it('FE-PAGE-TPW-037: the costs, collab and plugin tabs mount their panel', async () => {
    renderPage({ activeTab: 'finanzplan' })
    expect(await screen.findByTestId('costs-panel')).toBeInTheDocument()

    cleanup()
    renderPage({ activeTab: 'collab' })
    expect(await screen.findByTestId('collab-panel')).toBeInTheDocument()

    cleanup()
    // PluginFrame is deliberately not lazy — DayDetailPanel and PlaceInspector
    // pull it in from the plan tab anyway — so this stays synchronous.
    renderPage({ activeTab: 'plugin:routes' })
    expect(props('pluginFrame').pluginId).toBe('routes')
    expect(props('pluginFrame').tripId).toBe('42')
  })

  it('FE-PAGE-TPW-038: the files tab hands the manager the trip files and the write callbacks', async () => {
    renderPage({ activeTab: 'dateien', files: [] })
    await screen.findByTestId('file-manager')

    expect(props('fileManager').allowedFileTypes).toBe('pdf')

    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    await act(async () => { await props('fileManager').onUpload(new FormData()) })
    await act(async () => { await props('fileManager').onDelete(3) })
    act(() => { props('fileManager').onUpdate(3, {}) })

    expect(tripActions.addFile).toHaveBeenCalled()
    expect(tripActions.deleteFile).toHaveBeenCalledWith(42, 3)
    expect(tripActions.loadFiles).toHaveBeenCalledWith(42)
  })
})

describe('TripPlannerPage — lists tab', () => {
  it('FE-PAGE-TPW-039: the lists tab starts on packing and remembers the chosen subtab', async () => {
    renderPage({ activeTab: 'listen', packingItems: [buildPackingItem({ checked: 0 })], todoItems: [buildTodoItem()] })

    expect(await screen.findByTestId('packing-list-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByText('To-Do'))

    expect(await screen.findByTestId('todo-list-panel')).toBeInTheDocument()
    expect(sessionStorage.getItem('trip-lists-subtab-42')).toBe('todo')
  })

  it('FE-PAGE-TPW-040: a persisted subtab wins over the packing default', async () => {
    sessionStorage.setItem('trip-lists-subtab-42', 'todo')
    renderPage({ activeTab: 'listen' })

    expect(await screen.findByTestId('todo-list-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add new task/i }))
    expect(props('todoPanel').addItemSignal).toBe(1)
  })

  it('FE-PAGE-TPW-041: the clear-checked action only appears once something is checked', async () => {
    renderPage({ activeTab: 'listen', packingItems: [buildPackingItem({ checked: 1 })] })
    await screen.findByTestId('packing-list-panel')

    const clear = screen.getByRole('button', { name: /Remove 1 checked/i })
    fireEvent.click(clear)
    expect(props('packingPanel').clearCheckedSignal).toBe(1)
  })

  it('FE-PAGE-TPW-042: an admin can save the current list as a template', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 5, role: 'admin' }) })
    renderPage({ activeTab: 'listen', packingItems: [buildPackingItem({ checked: 0 })] })
    await screen.findByTestId('packing-list-panel')

    fireEvent.click(screen.getByRole('button', { name: /Save as template/i }))
    expect(props('packingPanel').saveTemplateSignal).toBe(1)
  })

  it('FE-PAGE-TPW-043: a non-admin sees import but no save-as-template', async () => {
    renderPage({ activeTab: 'listen', packingItems: [buildPackingItem({ checked: 0 })] })
    await screen.findByTestId('packing-list-panel')

    expect(screen.queryByRole('button', { name: /Save as template/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Import/i }))
    expect(props('packingPanel').openImportSignal).toBe(1)
  })

  it('FE-PAGE-TPW-044: switching the packing visibility is forwarded to the template button', async () => {
    renderPage({ activeTab: 'listen', packingItems: [] })
    await screen.findByTestId('packing-list-panel')

    expect(props('applyTemplate').visibility).toBe('common')
    act(() => { props('packingPanel').onViewChange('personal') })
    expect(props('applyTemplate').visibility).toBe('personal')
  })
})

describe('TripPlannerPage — modals', () => {
  it('FE-PAGE-TPW-045: closing the place form clears every editing slot', () => {
    renderPage()

    act(() => { props('placeForm').onClose() })
    expect(hookState.setShowPlaceForm).toHaveBeenCalledWith(false)
    expect(hookState.setEditingPlace).toHaveBeenCalledWith(null)
    expect(hookState.setPrefillCoords).toHaveBeenCalledWith(null)

    act(() => { props('placeForm').onCategoryCreated({ id: 3, name: 'Food' }) })
    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(tripActions.addCategory).toHaveBeenCalledWith({ id: 3, name: 'Food' })
  })

  it('FE-PAGE-TPW-046: the place form only offers day assignments while editing', () => {
    renderPage()
    expect(props('placeForm').dayAssignments).toEqual([])

    cleanup()
    renderPage({ editingPlace: place })
    expect((props('placeForm').dayAssignments as unknown as unknown[]).length).toBe(1)
  })

  it('FE-PAGE-TPW-047: saving the trip form reloads the accommodations and confirms', async () => {
    renderPage()

    await act(async () => { await props('tripForm').onSave({ title: 'Kyoto 2' }) })
    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(tripActions.updateTrip).toHaveBeenCalledWith(42, { title: 'Kyoto 2' })
    expect(hookState.loadAccommodations).toHaveBeenCalled()

    act(() => { props('tripForm').onClose() })
    expect(hookState.setShowTripForm).toHaveBeenCalledWith(false)
  })

  it('FE-PAGE-TPW-048: a new cover image is written straight into the trip store', () => {
    useTripStore.setState({ trip: buildTrip({ id: 42 }) } as never)
    renderPage()

    act(() => { props('tripForm').onCoverUpdate(42, '/uploads/covers/new.jpg') })
    expect(useTripStore.getState().trip?.cover_image).toBe('/uploads/covers/new.jpg')

    useTripStore.setState({ trip: null } as never)
    act(() => { props('tripForm').onCoverUpdate(42, '/uploads/covers/other.jpg') })
    expect(useTripStore.getState().trip).toBeNull()
  })

  it('FE-PAGE-TPW-049: the members modal refreshes the roster when it changes', () => {
    renderPage()

    act(() => { props('membersModal').onMembersChanged() })
    expect(hookState.refreshMembers).toHaveBeenCalled()

    act(() => { props('membersModal').onClose() })
    expect(hookState.setShowMembersModal).toHaveBeenCalledWith(false)
  })

  it('FE-PAGE-TPW-050: closing the booking modal outside a review resets the editor', async () => {
    renderPage()

    act(() => { props('reservationModal').onClose() })
    expect(hookState.setShowReservationModal).toHaveBeenCalledWith(false)
    expect(hookState.setBookingForAssignmentId).toHaveBeenCalledWith(null)
    expect(hookState.advanceImportReview).not.toHaveBeenCalled()

    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    await act(async () => { await props('reservationModal').onFileUpload(new FormData()) })
    act(() => { props('reservationModal').onFileDelete(8) })
    expect(tripActions.addFile).toHaveBeenCalled()
    expect(tripActions.deleteFile).toHaveBeenCalledWith(42, 8)
  })

  it('FE-PAGE-TPW-051: during an import review both booking modal exits advance the queue', async () => {
    renderPage({ importReviewActive: true })

    act(() => { props('reservationModal').onClose() })
    expect(hookState.advanceImportReview).toHaveBeenCalledTimes(1)

    await act(async () => { await props('reservationModal').onSave({ title: 'Ryokan' }) })
    expect(hookState.handleSaveReservation).toHaveBeenCalledWith({ title: 'Ryokan' })
    expect(hookState.advanceImportReview).toHaveBeenCalledTimes(2)
  })

  it('FE-PAGE-TPW-052: a booking save that returned nothing does not advance the review', async () => {
    renderPage({ importReviewActive: true, handleSaveReservation: vi.fn(async () => undefined) })

    await act(async () => { await props('reservationModal').onSave({ title: 'x' }) })
    expect(hookState.advanceImportReview).not.toHaveBeenCalled()
  })

  it('FE-PAGE-TPW-053: the transport modal only mounts while it is open', async () => {
    renderPage()
    expect(screen.queryByTestId('transport-modal')).not.toBeInTheDocument()

    cleanup()
    renderPage({ showTransportModal: true })
    // Loads on demand now — it is the only path to TransitSearchPanel, which
    // carries tz-lookup.
    expect(await screen.findByTestId('transport-modal')).toBeInTheDocument()

    await act(async () => { await props('transportModal').onSave({ title: 'ICE' }) })
    expect(hookState.handleSaveTransport).toHaveBeenCalledWith({ title: 'ICE' })

    act(() => { props('transportModal').onClose() })
    expect(hookState.setShowTransportModal).toHaveBeenCalledWith(false)
    expect(hookState.setTransitPrefill).toHaveBeenCalledWith(null)

    await act(async () => { await props('transportModal').onFileUpload(new FormData()) })
    act(() => { props('transportModal').onFileDelete(2) })
    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(tripActions.deleteFile).toHaveBeenCalledWith(42, 2)
  })

  it('FE-PAGE-TPW-054: during a review the transport modal exits advance the queue too', async () => {
    renderPage({ showTransportModal: true, importReviewActive: true })

    act(() => { props('transportModal').onClose() })
    await act(async () => { await props('transportModal').onSave({ title: 'ICE' }) })
    expect(hookState.advanceImportReview).toHaveBeenCalledTimes(2)
  })

  it('FE-PAGE-TPW-055: the transit journey view saves, deletes and re-enters the search', async () => {
    const journey = buildReservation({
      id: 9, type: 'transit', day_id: 7,
      endpoints: [
        { role: 'from', name: 'Kyoto', lat: 34.9, lng: 135.7 },
        { role: 'to', name: 'Osaka', lat: 34.7, lng: 135.5 },
      ] as never,
    })
    renderPage({ transitJourney: journey, reservations: [journey] })

    expect(props('transitModal').canEdit).toBe(true)

    await act(async () => { await props('transitModal').onSave({ title: 'Updated' }) })
    const tripActions = hookState.tripActions as Record<string, ReturnType<typeof vi.fn>>
    expect(tripActions.updateReservation).toHaveBeenCalledWith(42, 9, { title: 'Updated' })
    expect(hookState.setTransitJourney).toHaveBeenCalledWith(null)

    await act(async () => { await props('transitModal').onDelete() })
    expect(hookState.handleDeleteReservation).toHaveBeenCalledWith(9)

    act(() => { props('transitModal').onChangeRoute() })
    expect(hookState.setTransitPrefill).toHaveBeenCalledWith({
      from: { name: 'Kyoto', lat: 34.9, lng: 135.7 },
      to: { name: 'Osaka', lat: 34.7, lng: 135.5 },
    })
    expect(hookState.setEditingTransport).toHaveBeenCalledWith(journey)
    expect(hookState.setTransportModalAutomated).toHaveBeenCalledWith(true)

    act(() => { props('transitModal').onClose() })
    expect(hookState.setTransitJourney).toHaveBeenLastCalledWith(null)
  })

  it('FE-PAGE-TPW-056: a journey without endpoints seeds an empty search', () => {
    const journey = buildReservation({ id: 9, type: 'transit', day_id: null })
    renderPage({ transitJourney: journey, reservations: [] })

    act(() => { props('transitModal').onChangeRoute() })
    expect(hookState.setTransitPrefill).toHaveBeenCalledWith({ from: null, to: null })
    expect(hookState.setTransportModalDayId).toHaveBeenCalledWith(null)
  })

  it('FE-PAGE-TPW-061: edit details hands the fresh reservation to the full transport editor', () => {
    const stale = buildReservation({ id: 9, type: 'transit', day_id: 7 })
    // The store copy may be newer than the journey held in state — the fresh
    // one must win.
    const fresh = { ...stale, title: 'Kyoto → Osaka' }
    renderPage({ transitJourney: stale, reservations: [fresh] })

    act(() => { props('transitModal').onEditDetails() })
    expect(hookState.setEditingTransport).toHaveBeenCalledWith(fresh)
    expect(hookState.setTransportModalDayId).toHaveBeenCalledWith(7)
    expect(hookState.setTransportModalAutomated).toHaveBeenCalledWith(false)
    expect(hookState.setTransitPrefill).toHaveBeenCalledWith(null)
    expect(hookState.setTransitJourney).toHaveBeenCalledWith(null)
    expect(hookState.setShowTransportModal).toHaveBeenCalledWith(true)
  })

  it('FE-PAGE-TPW-057: a booking opens the expense editor, prefilled or on an existing item', async () => {
    setSettings({ default_currency: 'eur' })
    renderPage()

    act(() => { props('reservationModal').onOpenExpense({ prefill: { amount: 20 } }) })
    await waitFor(() => expect(screen.getByTestId('expense-modal')).toBeInTheDocument())
    expect(props('expenseModal').base).toBe('EUR')
    expect(props('expenseModal').me).toBe(5)
    expect(props('expenseModal').prefill).toEqual({ amount: 20 })

    act(() => { props('expenseModal').onSaved() })
    await waitFor(() => expect(screen.queryByTestId('expense-modal')).not.toBeInTheDocument())
    expect(useTripStore.getState().loadBudgetItems).toHaveBeenCalledWith(42)

    act(() => { props('reservationModal').onOpenExpense({ editItem: { id: 4 } }) })
    await waitFor(() => expect(props('expenseModal').editing).toEqual({ id: 4 }))

    act(() => { props('expenseModal').onClose() })
    await waitFor(() => expect(screen.queryByTestId('expense-modal')).not.toBeInTheDocument())
  })

  it('FE-PAGE-TPW-058: an expense request with neither item nor prefill opens nothing', () => {
    renderPage()

    act(() => { props('reservationModal').onOpenExpense({}) })
    expect(screen.queryByTestId('expense-modal')).not.toBeInTheDocument()
  })

  it('FE-PAGE-TPW-059: the costs base currency falls back from the account to the trip', async () => {
    setSettings({ default_currency: '' })
    renderPage()

    act(() => { props('reservationModal').onOpenExpense({ prefill: { amount: 1 } }) })
    await waitFor(() => expect(props('expenseModal').base).toBe('JPY'))
  })

  it('FE-PAGE-TPW-060: both import modals and both delete dialogs close through the hook', () => {
    renderPage({ deletePlaceId: 1, deletePlaceIds: [1, 2] })

    act(() => { props('bookingImport').onClose() })
    expect(hookState.setShowBookingImport).toHaveBeenCalledWith(false)

    act(() => { props('airtrailImport').onClose() })
    expect(hookState.setShowAirTrailImport).toHaveBeenCalledWith(false)

    const [single, bulk] = confirmDialogs as unknown as Array<Record<string, () => unknown> & { isOpen: boolean }>
    expect(single.isOpen).toBe(true)
    expect(bulk.isOpen).toBe(true)

    act(() => { single.onClose() })
    act(() => { single.onConfirm() })
    expect(hookState.setDeletePlaceId).toHaveBeenCalledWith(null)
    expect(hookState.confirmDeletePlace).toHaveBeenCalled()

    act(() => { bulk.onClose() })
    act(() => { bulk.onConfirm() })
    expect(hookState.setDeletePlaceIds).toHaveBeenCalledWith(null)
    expect(hookState.confirmDeletePlaces).toHaveBeenCalled()
  })
})
