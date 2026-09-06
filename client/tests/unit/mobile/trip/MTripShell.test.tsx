import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '../../../helpers/render'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import type { MTripShellApi, TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import type { Day, PackingItem, TodoItem } from '../../../../src/types'

// FE-MOB-SHELL-001 to FE-MOB-SHELL-051

const mocks = vi.hoisted(() => ({ planner: {} as TripPlanner }))

vi.mock('../../../../src/pages/tripPlanner/useTripPlanner', () => ({
  useTripPlanner: () => mocks.planner,
}))

// The real slots pull in the map engine and every tab panel; the shell only
// ever hands them props, so they are replaced by the probes below.
vi.mock('../../../../src/mobile/screens/trip/plan/MPlanTimeline', () => ({ default: () => null }))
vi.mock('../../../../src/mobile/screens/trip/map/MMapArea', () => ({ default: () => null }))
vi.mock('../../../../src/mobile/screens/trip/places/MPlacesBrowser', () => ({ default: () => null }))
vi.mock('../../../../src/mobile/screens/trip/tabs/MTripTabPanel', () => ({ default: () => null }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MTripSheets', () => ({ default: () => null }))

import MTripShell from '../../../../src/mobile/screens/trip/MTripShell'

/** Last shell api handed to a slot — the object every slot shares. */
let shellApi!: MTripShellApi

function slot(testId: string) {
  return function Slot({ shell }: { planner: TripPlanner; shell: MTripShellApi }) {
    shellApi = shell
    return <div data-testid={testId} />
  }
}

function TabSlot({ shell, tab }: { planner: TripPlanner; shell: MTripShellApi; tab: string }) {
  shellApi = shell
  return <div data-testid="tab-panel">{tab}</div>
}

const TRIP_TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'transports', label: 'Transport' },
  { id: 'buchungen', label: 'Bookings' },
  { id: 'finanzplan', label: 'Budget' },
  { id: 'listen', label: 'Lists' },
  { id: 'dateien', label: 'Files' },
  { id: 'collab', label: 'Collaboration' },
]

const DAYS = [
  { id: 11, trip_id: 1, day_number: 1, date: '2026-05-02', title: null },
  { id: 12, trip_id: 1, day_number: 2, date: '2026-05-03', title: null },
] as unknown as Day[]

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function renderShell(overrides: Partial<TripPlanner> = {}) {
  mocks.planner = buildPlanner({
    days: DAYS,
    selectedDayId: 11,
    TRIP_TABS,
    ...overrides,
  } as Partial<TripPlanner>)
  const Shell = () => (
    <MTripShell
      PlanTimeline={slot('plan-timeline')}
      MapArea={slot('map-area')}
      PlacesBrowser={slot('places-browser')}
      TabPanel={TabSlot}
      Sheets={slot('sheets')}
    />
  )
  const view = render(<Shell />)
  return { ...view, planner: mocks.planner, rerenderShell: () => view.rerender(<Shell />) }
}

const spy = (planner: TripPlanner, name: keyof TripPlanner) =>
  vi.mocked(planner[name] as unknown as ReturnType<typeof vi.fn>)

describe('MTripShell', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('FE-MOB-SHELL-001: shows the loading splash with the trip title while the planner loads', () => {
    renderShell({ isLoading: true } as Partial<TripPlanner>)
    expect(screen.getByText('Japan 2026')).toBeInTheDocument()
    expect(screen.queryByTestId('sheets')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-002: keeps the splash up until the photo warm-up finished', () => {
    renderShell({ splashDone: false } as Partial<TripPlanner>)
    expect(screen.getByText('Japan 2026')).toBeInTheDocument()
    expect(screen.queryByTestId('map-area')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-003: renders nothing once loading finished without a trip', () => {
    const { container } = renderShell({ trip: null } as Partial<TripPlanner>)
    expect(container).toBeEmptyDOMElement()
  })

  it('FE-MOB-SHELL-003b: the splash falls back to the brand name before the trip arrives', () => {
    renderShell({ isLoading: true, trip: null } as Partial<TripPlanner>)
    expect(screen.getByText('TREK')).toBeInTheDocument()
  })

  it('FE-MOB-SHELL-004: seeds the running trip on today rather than on day one', () => {
    const days = [
      { id: 11, day_number: 1, date: '2026-05-02' },
      { id: 12, day_number: 2, date: todayIso() },
    ] as unknown as Day[]
    const { planner } = renderShell({ days, selectedDayId: null } as Partial<TripPlanner>)
    expect(planner.tripActions.setSelectedDay).toHaveBeenCalledWith(12)
  })

  it('FE-MOB-SHELL-005: falls back to the first day when the trip is not running', () => {
    const { planner } = renderShell({ selectedDayId: null } as Partial<TripPlanner>)
    expect(planner.tripActions.setSelectedDay).toHaveBeenCalledWith(11)
  })

  it('FE-MOB-SHELL-006: leaves an existing day selection alone, and a later deselect too', () => {
    const { planner, rerenderShell } = renderShell()
    expect(planner.tripActions.setSelectedDay).not.toHaveBeenCalled()

    // Clearing the day is the user's doing; seeding it again here would be the
    // shell fighting them for it.
    planner.selectedDayId = null
    rerenderShell()
    expect(planner.tripActions.setSelectedDay).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-006b: seeds the next dated day when today falls in a gap', () => {
    const now = new Date()
    const iso = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const days = [
      { id: 11, day_number: 1, date: iso(-2) },
      { id: 12, day_number: 2, date: iso(2) },
    ] as unknown as Day[]
    const { planner } = renderShell({ days, selectedDayId: null } as Partial<TripPlanner>)
    expect(planner.tripActions.setSelectedDay).toHaveBeenCalledWith(12)
  })

  it('FE-MOB-SHELL-007: does not seed a day before the days arrive', () => {
    const { planner } = renderShell({ days: [], selectedDayId: null } as Partial<TripPlanner>)
    expect(planner.tripActions.setSelectedDay).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Sat 2' })).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-008: the back button leaves for the dashboard', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'common.back' }))
    expect(planner.navigate).toHaveBeenCalledWith('/dashboard')
  })

  it('FE-MOB-SHELL-009: the plan tab mounts the map under the timeline and no browser', () => {
    renderShell()
    expect(screen.getByTestId('map-area')).toBeInTheDocument()
    expect(screen.getByTestId('plan-timeline')).toBeInTheDocument()
    expect(screen.getByTestId('sheets')).toBeInTheDocument()
    expect(screen.queryByTestId('places-browser')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-panel')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-010: the browse segment swaps the timeline for the places browser', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    expect(screen.getByTestId('places-browser')).toBeInTheDocument()
    expect(screen.queryByTestId('plan-timeline')).not.toBeInTheDocument()
    expect(shellApi.mode).toBe('browse')
    expect(shellApi.view).toBe('plan')
  })

  it('FE-MOB-SHELL-011: browse entered from edit flags browseFromEdit for the pool filter', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlan' }))
    expect(shellApi.mode).toBe('edit')
    expect(shellApi.browseFromEdit).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    expect(shellApi.browseFromEdit).toBe(true)
  })

  it('FE-MOB-SHELL-012: browse entered from travel leaves browseFromEdit off', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    expect(shellApi.browseFromEdit).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.travel' }))
    expect(shellApi.mode).toBe('go')
  })

  it('FE-MOB-SHELL-013: switching the travel mode from another tab forces the plan tab', () => {
    const { planner } = renderShell({ activeTab: 'listen' } as Partial<TripPlanner>)
    act(() => { shellApi.setTravelMode('edit') })
    expect(planner.handleTabChange).toHaveBeenCalledWith('plan')
    expect(shellApi.mode).toBe('edit')
  })

  it('FE-MOB-SHELL-014: the map toggle draws the route and refits the selected day', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    expect(planner.autoShowRoute).toHaveBeenCalled()
    expect(planner.handleSelectDay).toHaveBeenCalledWith(11, false)
    expect(shellApi.view).toBe('map')
    // The timeline unmounts, the map layer stays warm underneath.
    expect(screen.queryByTestId('plan-timeline')).not.toBeInTheDocument()
    expect(screen.getByTestId('map-area')).toBeInTheDocument()
  })

  it('FE-MOB-SHELL-015: leaving the map restores the timeline without touching the route', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.listView' }))
    expect(shellApi.view).toBe('plan')
    expect(screen.getByTestId('plan-timeline')).toBeInTheDocument()
    // Entering the map defaults the route on once; leaving it leaves the choice alone.
    expect(spy(planner, 'autoShowRoute')).toHaveBeenCalledTimes(1)
    expect(spy(planner, 'setRouteShown')).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-016: the map toggle skips the refit while no day is selected', () => {
    const { planner } = renderShell({ selectedDayId: null } as Partial<TripPlanner>)
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    expect(planner.autoShowRoute).toHaveBeenCalled()
    expect(planner.handleSelectDay).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-017: the map toggle drops out of browse mode', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    expect(shellApi.mode).toBe('go')
    expect(screen.queryByTestId('places-browser')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-018: day chips render weekday + date and mark the active one', () => {
    renderShell()
    const chip = screen.getByRole('button', { name: 'Sat 2' })
    expect(chip).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Sun 3' })).not.toHaveAttribute('aria-current')
  })

  it('FE-MOB-SHELL-019: a chip without a usable date falls back to the day number', () => {
    const days = [
      { id: 11, day_number: 1, date: null },
      { id: 12, day_number: 2, date: 'nodatehere' },
      { id: 13, date: null },
    ] as unknown as Day[]
    renderShell({ days } as Partial<TripPlanner>)
    expect(screen.getByRole('button', { name: 'planner.dayN:1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'planner.dayN:2' })).toBeInTheDocument()
    // A day the server sent without a number falls back to its position.
    expect(screen.getByRole('button', { name: 'planner.dayN:3' })).toBeInTheDocument()
  })

  it('FE-MOB-SHELL-020: tapping another day selects it and fits the list view', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Sun 3' }))
    expect(planner.handleSelectDay).toHaveBeenCalledWith(12, true)
    expect(planner.autoShowRoute).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-021: tapping the active day opens the day sheet', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Sat 2' }))
    expect(shellApi.sheet).toEqual({ id: 'day', payload: { dayId: 11 } })
    expect(planner.handleSelectDay).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-022: a day tap in map mode fits without the list flag and draws the route', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    vi.mocked(planner.setRouteShown).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Sun 3' }))
    expect(planner.handleSelectDay).toHaveBeenLastCalledWith(12, false)
    expect(planner.autoShowRoute).toHaveBeenCalled()
  })

  // #1962 — the phone lost the desktop sidebar's collapse chevron, so the map showed
  // every day's pins at once with no way to narrow it down.
  it('FE-MOB-SHELL-040: entering the map focuses it on the selected day', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    expect(planner.setExpandedDayIds).toHaveBeenCalledWith(new Set([11]))
  })

  it('FE-MOB-SHELL-041: a day tap in map mode moves the focus with it', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    vi.mocked(planner.setExpandedDayIds).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Sun 3' }))
    expect(planner.setExpandedDayIds).toHaveBeenCalledWith(new Set([12]))
  })

  it('FE-MOB-SHELL-042: a day tap in list mode leaves the map unfiltered', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Sun 3' }))
    expect(planner.setExpandedDayIds).not.toHaveBeenCalled()
  })

  it('FE-MOB-SHELL-043: leaving the map clears the focus again', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))
    vi.mocked(planner.setExpandedDayIds).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.listView' }))
    expect(planner.setExpandedDayIds).toHaveBeenCalledWith(null)
  })

  it('FE-MOB-SHELL-023: the dock only shows enabled tabs and marks the active one', () => {
    const { planner } = renderShell({
      TRIP_TABS: [
        { id: 'plan', label: 'Plan' },
        { id: 'transports', label: 'Transport' },
        // A plugin tab that arrived without a name still needs a label.
        { id: 'buchungen' },
      ],
    } as Partial<TripPlanner>)
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'buchungen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lists' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Transport' }))
    expect(planner.handleTabChange).toHaveBeenCalledWith('transports')
    expect(shellApi.mode).toBe('go')
  })

  it('FE-MOB-SHELL-024: a dock tap changes the tab and drops out of browse mode', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    expect(shellApi.mode).toBe('browse')
    fireEvent.click(screen.getByRole('button', { name: 'Lists' }))
    expect(planner.handleTabChange).toHaveBeenCalledWith('listen')
    expect(shellApi.mode).toBe('go')
  })

  it('FE-MOB-SHELL-025: the Mehr button opens the sheet and closeSheet clears it', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.more' }))
    expect(shellApi.sheet).toEqual({ id: 'mehr', payload: undefined })
    act(() => { shellApi.closeSheet() })
    expect(shellApi.sheet).toBeNull()
  })

  it('FE-MOB-SHELL-026: a non-plan tab replaces the plan chrome with its panel', () => {
    renderShell({ activeTab: 'dateien' } as Partial<TripPlanner>)
    expect(screen.getByTestId('tab-panel')).toHaveTextContent('dateien')
    expect(screen.queryByTestId('map-area')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'mobileTrip.travel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'mobileTrip.mapView' })).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-027: the transports header opens a blank transport modal', () => {
    const { planner } = renderShell({ activeTab: 'transports' } as Partial<TripPlanner>)
    fireEvent.click(screen.getByRole('button', { name: 'transport.addTransport' }))
    expect(planner.setEditingTransport).toHaveBeenCalledWith(null)
    expect(planner.setTransitPrefill).toHaveBeenCalledWith(null)
    expect(planner.setTransportModalAutomated).toHaveBeenCalledWith(false)
    expect(planner.setShowTransportModal).toHaveBeenCalledWith(true)
  })

  it('FE-MOB-SHELL-028: the transports header offers both importers when they are available', () => {
    const { planner } = renderShell({ activeTab: 'transports', airTrailAvailable: true } as Partial<TripPlanner>)
    fireEvent.click(screen.getByRole('button', { name: 'reservations.import.title' }))
    fireEvent.click(screen.getByRole('button', { name: 'reservations.airtrail.title' }))
    expect(planner.setShowBookingImport).toHaveBeenCalledWith(true)
    expect(planner.setShowAirTrailImport).toHaveBeenCalledWith(true)
  })

  it('FE-MOB-SHELL-029: the transports header hides the importers that are switched off', () => {
    renderShell({
      activeTab: 'transports', bookingImportAvailable: false, airTrailAvailable: false,
    } as Partial<TripPlanner>)
    expect(screen.queryByRole('button', { name: 'reservations.import.title' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'reservations.airtrail.title' })).not.toBeInTheDocument()
  })

  it('FE-MOB-SHELL-030: the transports compact toggle flips the shell flag', () => {
    renderShell({ activeTab: 'transports' } as Partial<TripPlanner>)
    const toggle = screen.getByRole('button', { name: 'mobileTrip.compactView' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(shellApi.transportsCompact).toBe(true)
    expect(shellApi.bookingsCompact).toBe(false)
  })

  it('FE-MOB-SHELL-031: the bookings header opens a blank reservation and toggles its own density', () => {
    const { planner } = renderShell({ activeTab: 'buchungen' } as Partial<TripPlanner>)
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.newReservation' }))
    expect(planner.setEditingReservation).toHaveBeenCalledWith(null)
    expect(planner.setShowReservationModal).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'reservations.import.title' }))
    expect(planner.setShowBookingImport).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.compactView' }))
    expect(shellApi.bookingsCompact).toBe(true)
    expect(shellApi.transportsCompact).toBe(false)
  })

  it('FE-MOB-SHELL-032: the costs header raises the add-expense and CSV signals', () => {
    renderShell({ activeTab: 'finanzplan' } as Partial<TripPlanner>)
    expect(shellApi.addExpenseSignal).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'costs.addExpense' }))
    fireEvent.click(screen.getByRole('button', { name: 'budget.exportCsv' }))
    expect(shellApi.addExpenseSignal).toBe(1)
    expect(shellApi.exportCostsCsvSignal).toBe(1)
  })

  it('FE-MOB-SHELL-033: the files header raises the upload and trash signals', () => {
    renderShell({ activeTab: 'dateien' } as Partial<TripPlanner>)
    fireEvent.click(screen.getByRole('button', { name: 'common.upload' }))
    fireEvent.click(screen.getByRole('button', { name: 'files.trash' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.upload' }))
    expect(shellApi.uploadFilesSignal).toBe(2)
    expect(shellApi.openFilesTrashSignal).toBe(1)
  })

  it('FE-MOB-SHELL-034: the lists header shows packed/open counts and persists the sub-tab', () => {
    const packingItems = [
      { id: 1, checked: true }, { id: 2, checked: false }, { id: 3, checked: true },
    ] as unknown as PackingItem[]
    const todoItems = [{ id: 1, checked: false }, { id: 2, checked: false }] as unknown as TodoItem[]
    renderShell({ activeTab: 'listen', packingItems, todoItems } as Partial<TripPlanner>)
    expect(screen.getByRole('button', { name: /todo\.subtab\.packing/ })).toHaveTextContent('2/3')
    const todoTab = screen.getByRole('button', { name: /todo\.subtab\.todo/ })
    expect(todoTab).toHaveTextContent('mobileTrip.todoOpenCount:2')

    fireEvent.click(todoTab)
    expect(shellApi.listsTab).toBe('todo')
    expect(sessionStorage.getItem('trip-lists-subtab-1')).toBe('todo')
  })

  it('FE-MOB-SHELL-035: the lists sub-tab is restored from the session', () => {
    sessionStorage.setItem('trip-lists-subtab-1', 'todo')
    renderShell({ activeTab: 'listen' } as Partial<TripPlanner>)
    expect(shellApi.listsTab).toBe('todo')
  })

  it('FE-MOB-SHELL-036: the collab header switches the sub-tab', () => {
    renderShell({ activeTab: 'collab' } as Partial<TripPlanner>)
    expect(shellApi.collabTab).toBe('chat')
    fireEvent.click(screen.getByRole('button', { name: 'collab.tabs.polls' }))
    expect(shellApi.collabTab).toBe('polls')
    fireEvent.click(screen.getByRole('button', { name: 'collab.tabs.notes' }))
    expect(shellApi.collabTab).toBe('notes')
  })

  it('FE-MOB-SHELL-037: setTrTab from a slot routes through the planner and resets browse', () => {
    const { planner } = renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'trip.mobilePlaces' }))
    act(() => { shellApi.setTrTab('collab') })
    expect(planner.handleTabChange).toHaveBeenCalledWith('collab')
    expect(shellApi.mode).toBe('go')
  })

  it('FE-MOB-SHELL-038: openSheet carries the payload through to the slots', () => {
    renderShell()
    act(() => { shellApi.openSheet('note', { dayId: 12 }) })
    expect(shellApi.sheet).toEqual({ id: 'note', payload: { dayId: 12 } })
  })

  // The chip rail overflows from roughly six days on, and swiping the day panel
  // (#2051) can move the day well past what is on screen.
  describe('chip rail auto-scroll', () => {
    const RAIL = { left: 0, right: 300 } as DOMRect
    /** Rects are all zero without layout, so the two boxes are stubbed by role. */
    function stubRects(chip: Partial<DOMRect>) {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return (this.tagName === 'BUTTON' ? { ...RAIL, ...chip } : RAIL) as DOMRect
      })
    }

    afterEach(() => { vi.restoreAllMocks() })

    it('FE-MOB-SHELL-044: a clipped active chip pulls itself into the middle of the rail', () => {
      const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
      scrollIntoView.mockClear()
      stubRects({ left: 480, right: 540 })
      renderShell({ selectedDayId: 12 } as Partial<TripPlanner>)
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    })

    it('FE-MOB-SHELL-045: a chip already in view never shifts the rail under the thumb', () => {
      const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
      scrollIntoView.mockClear()
      stubRects({ left: 40, right: 100 })
      renderShell({ selectedDayId: 12 } as Partial<TripPlanner>)
      expect(scrollIntoView).not.toHaveBeenCalled()
    })

    it('FE-MOB-SHELL-046: reduced motion jumps instead of gliding', () => {
      const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
      scrollIntoView.mockClear()
      stubRects({ left: 480, right: 540 })
      vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
        matches: query.includes('reduced-motion'), media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList)
      renderShell({ selectedDayId: 12 } as Partial<TripPlanner>)
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', inline: 'center', block: 'nearest' })
    })
  })

  // #2257 — the map filters down to one day, and until now nothing took that
  // filter back off: the chip rail can only swap one day for another, and the
  // second tap on the active chip is the day sheet. Its own control, map only.
  describe('the all-days toggle (#2257)', () => {
    const allDays = () => screen.getByRole('button', { name: 'mobileTrip.allDays' })
    const enterMap = () => fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.mapView' }))

    it('FE-MOB-SHELL-047: stays off the plan view, where nothing is filtered anyway', () => {
      renderShell()
      expect(screen.queryByRole('button', { name: 'mobileTrip.allDays' })).not.toBeInTheDocument()
      enterMap()
      expect(allDays()).toBeInTheDocument()
    })

    it('FE-MOB-SHELL-048: drops the day and its pin filter so the whole trip comes back', () => {
      const { planner } = renderShell()
      enterMap()
      vi.mocked(planner.setExpandedDayIds).mockClear()

      fireEvent.click(allDays())

      expect(planner.handleSelectDay).toHaveBeenLastCalledWith(null, false)
      expect(planner.setExpandedDayIds).toHaveBeenCalledWith(null)
      // The day sheet belongs to the chip, not to this button.
      expect(shellApi.sheet).toBeNull()
    })

    it('FE-MOB-SHELL-049: a second press goes back to the day it came from', () => {
      const { planner, rerenderShell } = renderShell()
      enterMap()
      fireEvent.click(allDays())

      // The planner is a fixture, so the commit is replayed by hand.
      ;(planner as { selectedDayId: number | null }).selectedDayId = null
      rerenderShell()
      vi.mocked(planner.setExpandedDayIds).mockClear()
      vi.mocked(planner.autoShowRoute).mockClear()

      fireEvent.click(allDays())

      expect(planner.handleSelectDay).toHaveBeenLastCalledWith(11, false)
      expect(planner.setExpandedDayIds).toHaveBeenCalledWith(new Set([11]))
      expect(planner.autoShowRoute).toHaveBeenCalled()
    })

    it('FE-MOB-SHELL-050: leaving the map puts a day back, the timeline has no all-days state', () => {
      const { planner, rerenderShell } = renderShell()
      enterMap()
      fireEvent.click(allDays())
      ;(planner as { selectedDayId: number | null }).selectedDayId = null
      rerenderShell()

      fireEvent.click(screen.getByRole('button', { name: 'mobileTrip.listView' }))

      expect(planner.handleSelectDay).toHaveBeenLastCalledWith(11, true)
    })

    it('FE-MOB-SHELL-051: the active chip still opens the day sheet on the map', () => {
      const { planner } = renderShell()
      enterMap()
      vi.mocked(planner.handleSelectDay).mockClear()

      fireEvent.click(screen.getByRole('button', { name: 'Sat 2' }))

      expect(shellApi.sheet).toEqual({ id: 'day', payload: { dayId: 11 } })
      expect(planner.handleSelectDay).not.toHaveBeenCalled()
    })
  })
})

describe('buildShell fixture', () => {
  it('FE-MOB-SHELL-039: defaults to the plan/go state and takes overrides', () => {
    const shell = buildShell({ mode: 'browse', browseFromEdit: true })
    expect(shell.view).toBe('plan')
    expect(shell.trTab).toBe('plan')
    expect(shell.mode).toBe('browse')
    expect(shell.browseFromEdit).toBe(true)
  })
})
