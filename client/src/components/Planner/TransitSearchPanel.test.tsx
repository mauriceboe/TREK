// FE-PLANNER-TRANSIT-001 to FE-PLANNER-TRANSIT-030 — the transit search panel
// (embedded as the TransportModal's Automated mode).
import { render, screen, fireEvent, waitFor } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { buildUser, buildDay, buildPlace } from '../../../tests/helpers/factories'
import type { Accommodation, Day } from '../../types'
import TransitSearchPanel from './TransitSearchPanel'

const { transitApiMock, toastErrors } = vi.hoisted(() => ({
  transitApiMock: { geocode: vi.fn(), plan: vi.fn() },
  toastErrors: [] as string[],
}))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal() as object
  return { ...actual, transitApi: transitApiMock }
})

vi.mock('../shared/Toast', () => ({
  useToast: () => ({ error: (m: string) => { toastErrors.push(m) }, success: vi.fn() }),
}))

// Berlin, summer time (UTC+2): 06:30Z departs 08:30 local, 07:00Z arrives 09:00.
const ITINERARY = {
  startTime: '2025-06-01T06:30:00Z',
  endTime: '2025-06-01T07:00:00Z',
  duration: 1800,
  transfers: 1,
  walkSeconds: 240,
  legs: [
    { mode: 'WALK', from: { name: 'Start', lat: 52.52, lng: 13.4, time: '2025-06-01T06:30:00Z', scheduledTime: null, track: null }, to: { name: 'Alexanderplatz', lat: 52.521, lng: 13.41, time: '2025-06-01T06:34:00Z', scheduledTime: null, track: null }, duration: 240, distance: 300, headsign: null, line: null, lineColor: null, lineTextColor: null, agency: null, intermediateStops: 0 },
    { mode: 'SUBWAY', from: { name: 'Alexanderplatz', lat: 52.521, lng: 13.41, time: '2025-06-01T06:36:00Z', scheduledTime: null, track: '2' }, to: { name: 'Zoologischer Garten', lat: 52.507, lng: 13.332, time: '2025-06-01T07:00:00Z', scheduledTime: null, track: null }, duration: 1440, distance: null, headsign: 'Ruhleben', line: 'U2', lineColor: '#FF3300', lineTextColor: '#FFFFFF', agency: 'BVG', intermediateStops: 6 },
  ],
}

const stop = (name: string, lat: number, lng: number, time: string, track: string | null = null) =>
  ({ name, lat, lng, time, scheduledTime: null, track })

// The shape MOTIS actually returns for the reported connection: every journey is
// bracketed in walking legs, and a change between two stations adds one in the
// middle (#2106).
const WALK_BRACKETED = {
  startTime: '2025-06-01T06:30:00Z',
  endTime: '2025-06-01T09:10:00Z',
  duration: 9600,
  transfers: 1,
  walkSeconds: 1080,
  legs: [
    { mode: 'WALK', from: stop('Aachen, Bushof', 50.777, 6.09, '2025-06-01T06:30:00Z'), to: stop('Aachen Hbf', 50.768, 6.091, '2025-06-01T06:34:00Z'), duration: 240, distance: 300, headsign: null, line: null, lineColor: null, lineTextColor: null, agency: null, intermediateStops: 0 },
    { mode: 'HIGHSPEED_RAIL', from: stop('Aachen Hbf', 50.768, 6.091, '2025-06-01T06:40:00Z', '2'), to: stop('Koeln Hbf', 50.943, 6.959, '2025-06-01T07:30:00Z'), duration: 3000, distance: null, headsign: 'Koeln', line: 'ICE 10', lineColor: null, lineTextColor: null, agency: 'DB', intermediateStops: 1 },
    { mode: 'WALK', from: stop('Koeln Hbf', 50.943, 6.959, '2025-06-01T07:32:00Z'), to: stop('Koeln Messe/Deutz', 50.941, 6.974, '2025-06-01T07:40:00Z'), duration: 480, distance: 600, headsign: null, line: null, lineColor: null, lineTextColor: null, agency: null, intermediateStops: 0 },
    { mode: 'HIGHSPEED_RAIL', from: stop('Koeln Messe/Deutz', 50.941, 6.974, '2025-06-01T07:50:00Z', '11'), to: stop('Frankfurt(Main)Hbf', 50.107, 8.663, '2025-06-01T08:57:00Z'), duration: 4020, distance: null, headsign: 'Frankfurt', line: 'ICE 610', lineColor: null, lineTextColor: null, agency: 'DB', intermediateStops: 2 },
    { mode: 'WALK', from: stop('Frankfurt(Main)Hbf', 50.107, 8.663, '2025-06-01T09:00:00Z'), to: stop('Frankfurt Flughafen Fernbf', 50.053, 8.57, '2025-06-01T09:10:00Z'), duration: 600, distance: 800, headsign: null, line: null, lineColor: null, lineTextColor: null, agency: null, intermediateStops: 0 },
  ],
}

const day = buildDay({ id: 10, trip_id: 1, date: '2025-06-01', title: 'Berlin Day' })

function makeProps(overrides = {}) {
  return {
    day,
    days: [day],
    places: [buildPlace({ id: 1, name: 'Fernsehturm', lat: 52.5208, lng: 13.4094 })],
    accommodations: [],
    onAdd: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

async function pickFromAndTo(user: ReturnType<typeof userEvent.setup>) {
  // Quick picks (the day's places) appear on focus with an empty query.
  const [fromInput, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
  await user.click(fromInput)
  await user.click(await screen.findByText('Fernsehturm'))

  transitApiMock.geocode.mockResolvedValueOnce({ results: [{ name: 'Zoologischer Garten', lat: 52.507, lng: 13.332, type: 'STOP', area: 'Berlin' }] })
  await user.click(toInput)
  await user.type(toInput, 'Zoo')
  await user.click(await screen.findByText(/Zoologischer Garten/))
}

beforeEach(() => {
  resetAllStores()
  vi.clearAllMocks()
  toastErrors.length = 0
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true })
  seedStore(useSettingsStore, { settings: { time_format: '24h' } } as any)
})

describe('TransitSearchPanel', () => {
  it('FE-PLANNER-TRANSIT-001: renders from/to pickers, modes and preferences', () => {
    render(<TransitSearchPanel {...makeProps()} />)
    expect(screen.getAllByPlaceholderText('Search stop or station…')).toHaveLength(2)
    expect(screen.getByText('Subway')).toBeInTheDocument()
    expect(screen.getByText('Fewer transfers')).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-002: searching lists itineraries with times, transfers and line badges', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    // Local Berlin times, U2 badge, 1 transfer.
    expect(await screen.findByText(/08:30 – 09:00/)).toBeInTheDocument()
    expect(screen.getByText('U2')).toBeInTheDocument()
    expect(screen.getByText('1 transfers')).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-003: adding a route builds a transport payload with local times + endpoints', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn().mockResolvedValue({})
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    render(<TransitSearchPanel {...makeProps({ onAdd })} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))
    await user.click(await screen.findByRole('button', { name: 'Add to day' }))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    const payload = onAdd.mock.calls[0][0]
    expect(payload.type).toBe('transit') // first-class transit type (#1065)
    expect(payload.title).toBe('Fernsehturm → Zoologischer Garten')
    expect(payload.day_id).toBe(10)
    expect(payload.reservation_time).toBe('2025-06-01T08:30')
    expect(payload.reservation_end_time).toBe('2025-06-01T09:00')
    expect(payload.status).toBe('confirmed')
    // from + to endpoints (single transit leg → no transfer stops)
    expect(payload.endpoints).toHaveLength(2)
    expect(payload.endpoints[0]).toMatchObject({ role: 'from', name: 'Fernsehturm', timezone: 'Europe/Berlin' })
    expect(payload.endpoints[1]).toMatchObject({ role: 'to', name: 'Zoologischer Garten' })
    // compact itinerary stored for the detail modal
    expect(payload.metadata.transit.provider).toBe('transitous')
    expect(payload.metadata.transit.legs).toHaveLength(2)
    expect(payload.metadata.transit.legs[1]).toMatchObject({ mode: 'SUBWAY', line: 'U2', line_color: '#FF3300', headsign: 'Ruhleben' })
  })

  it('FE-PLANNER-TRANSIT-004: search failure shows the empty state, not a crash', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockRejectedValueOnce(new Error('boom'))
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    expect(await screen.findByText(/No connections found/)).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-005: preference "fewer transfers" re-ranks the list', async () => {
    const user = userEvent.setup()
    const direct = { ...ITINERARY, startTime: '2025-06-01T06:40:00Z', endTime: '2025-06-01T07:20:00Z', duration: 2400, transfers: 0 }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY, direct] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await screen.findByText(/08:30 – 09:00/)
    await user.click(screen.getByText('Fewer transfers'))
    const cards = screen.getAllByText(/–/).filter(el => el.textContent?.match(/\d{2}:\d{2} – \d{2}:\d{2}/))
    // The direct (0-transfer) itinerary now ranks first.
    expect(cards[0].textContent).toContain('08:40')
  })

  // Cross-timezone route (#1479): origin Europe/Berlin (UTC+2 in June),
  // destination Europe/London (UTC+1). Same wall-clock 09:00 resolves to a
  // different UTC instant depending on which end the user anchors to.
  async function pickFromAndLondon(user: ReturnType<typeof userEvent.setup>) {
    const [fromInput, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(fromInput)
    await user.click(await screen.findByText('Fernsehturm'))

    transitApiMock.geocode.mockResolvedValueOnce({ results: [{ name: 'London Victoria', lat: 51.5074, lng: -0.1278, type: 'STOP', area: 'England' }] })
    await user.click(toInput)
    await user.type(toInput, 'Lon')
    await user.click(await screen.findByText(/London Victoria/))
  }

  /**
   * An empty result is ambiguous without the backend's name: the fallback to
   * Transitous is silent, so "no connections" could mean the provider has no
   * data here or that the provider you picked never ran (#1699).
   */
  it('FE-PLANNER-TRANSIT-006b: the empty state names the backend that answered', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [], provider: 'transitous' })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndLondon(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    expect(await screen.findByText(/No connections found via Transitous/)).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-006c: falls back to the unnamed message when the server sends no provider', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndLondon(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    expect(await screen.findByText(/^No connections found\./)).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-007: depart-by anchors the entered time to the origin timezone', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndLondon(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    // Default 09:00 in Berlin (UTC+2) → 07:00Z.
    expect(transitApiMock.plan.mock.calls[0][0]).toMatchObject({ arriveBy: false, time: '2025-06-01T07:00:00.000Z' })
  })

  it('FE-PLANNER-TRANSIT-008: arrive-by anchors the entered time to the destination timezone', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndLondon(user)
    await user.click(screen.getByRole('button', { name: 'Arrive' }))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    // 09:00 arrival in London (UTC+1) → 08:00Z, not 07:00Z.
    expect(transitApiMock.plan.mock.calls[0][0]).toMatchObject({ arriveBy: true, time: '2025-06-01T08:00:00.000Z' })
  })

  it('FE-PLANNER-TRANSIT-008b: initialTime seeds the departure time', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps({
      initialFrom: { name: 'Fernsehturm', lat: 52.5208, lng: 13.4094 },
      initialTo: { name: 'London Victoria', lat: 51.5074, lng: -0.1278 },
      initialTime: '11:00',
    })} />)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    // 11:00 in Berlin (UTC+2) anchors depart-by to the origin zone → 09:00Z.
    expect(transitApiMock.plan.mock.calls[0][0]).toMatchObject({ time: '2025-06-01T09:00:00.000Z' })
  })

  it('FE-PLANNER-TRANSIT-009: arrive-by lists the latest-arriving itinerary first', async () => {
    const user = userEvent.setup()
    // MOTIS returns arrive-by results ascending, deadline-adjacent last (#1479).
    const later = { ...ITINERARY, startTime: '2025-06-01T07:10:00Z', endTime: '2025-06-01T07:40:00Z' }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY, later] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: 'Arrive' }))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await screen.findByText(/09:10 – 09:40/)
    const cards = screen.getAllByText(/–/).filter(el => el.textContent?.match(/\d{2}:\d{2} – \d{2}:\d{2}/))
    // The itinerary arriving closest to the requested arrival time leads.
    expect(cards[0].textContent).toContain('09:40')
    expect(cards[1].textContent).toContain('09:00')
  })

  it('FE-PLANNER-TRANSIT-006: swap exchanges from and to', async () => {
    const user = userEvent.setup()
    render(<TransitSearchPanel {...makeProps()} />)
    const [fromInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(fromInput)
    await user.click(await screen.findByText('Fernsehturm'))
    await user.click(screen.getByLabelText('Swap'))
    const inputs = screen.getAllByPlaceholderText('Search stop or station…')
    expect((inputs[0] as HTMLInputElement).value).toBe('')
    expect((inputs[1] as HTMLInputElement).value).toBe('Fernsehturm')
  })

  // ── quick picks ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSIT-010: quick picks add located accommodations and drop duplicates', async () => {
    const user = userEvent.setup()
    const accommodations = [
      { place_lat: 52.5, place_lng: 13.3, place_name: 'Hotel Berlin' },
      // No coordinates / no name — neither may become a quick pick.
      { place_lat: null, place_lng: null, place_name: 'Unlocated Inn' },
      { place_lat: 52.4, place_lng: 13.2, place_name: null },
    ] as unknown as Accommodation[]
    render(<TransitSearchPanel {...makeProps({
      places: [
        buildPlace({ id: 1, name: 'Fernsehturm', lat: 52.5208, lng: 13.4094 }),
        buildPlace({ id: 2, name: 'Fernsehturm', lat: 52.5208, lng: 13.4094 }),
        buildPlace({ id: 3, name: 'No coords', lat: null, lng: null }),
      ],
      accommodations,
    })} />)
    const [fromInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(fromInput)
    expect(await screen.findByText('Hotel Berlin')).toBeInTheDocument()
    expect(screen.getAllByText('Fernsehturm')).toHaveLength(1)
    expect(screen.queryByText('Unlocated Inn')).not.toBeInTheDocument()
    expect(screen.queryByText('No coords')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-011: hovering a quick pick and a geocode result toggles the row background', async () => {
    const user = userEvent.setup()
    render(<TransitSearchPanel {...makeProps()} />)
    const [fromInput, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(fromInput)
    const quick = (await screen.findByText('Fernsehturm')).closest('button') as HTMLButtonElement
    fireEvent.mouseEnter(quick)
    expect(quick.style.background).toBe('var(--bg-hover)')
    fireEvent.mouseLeave(quick)
    expect(quick.style.background).toBe('none')

    transitApiMock.geocode.mockResolvedValueOnce({ results: [{ name: 'Ostbahnhof', lat: 52.51, lng: 13.43, type: 'STOP', area: 'Berlin' }] })
    await user.click(toInput)
    await user.type(toInput, 'Ost')
    const hit = (await screen.findByText('Ostbahnhof')).closest('button') as HTMLButtonElement
    fireEvent.mouseEnter(hit)
    expect(hit.style.background).toBe('var(--bg-hover)')
    fireEvent.mouseLeave(hit)
    expect(hit.style.background).toBe('none')
  })

  it('FE-PLANNER-TRANSIT-012: a failing stop lookup clears the result list instead of throwing', async () => {
    const user = userEvent.setup()
    transitApiMock.geocode.mockRejectedValueOnce(new Error('offline'))
    render(<TransitSearchPanel {...makeProps()} />)
    const [, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(toInput)
    await user.type(toInput, 'Zoo')
    await waitFor(() => expect(transitApiMock.geocode).toHaveBeenCalled())
    // No dropdown rows, and the panel still works.
    await waitFor(() => expect(screen.queryByText('Fernsehturm')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Search$/ })).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-013: a query shorter than two characters never reaches the API', async () => {
    const user = userEvent.setup()
    render(<TransitSearchPanel {...makeProps()} />)
    const [, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.type(toInput, 'Z')
    await new Promise(r => setTimeout(r, 350))
    expect(transitApiMock.geocode).not.toHaveBeenCalled()
  })

  // ── filters ─────────────────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSIT-014: deselecting a mode narrows the requested modes, the last one cannot be dropped', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    for (const label of ['Train', 'Subway', 'Tram', 'Ferry', 'Cable car']) {
      await user.click(screen.getByText(label))
    }
    // Only "Bus" is left — clicking it must not empty the selection.
    await user.click(screen.getByText('Bus'))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    expect(transitApiMock.plan.mock.calls[0][0].modes).toBe('BUS,COACH')
  })

  it('FE-PLANNER-TRANSIT-015: re-enabling every mode sends no mode filter at all', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByText('Ferry'))
    await user.click(screen.getByText('Ferry'))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    expect(transitApiMock.plan.mock.calls[0][0].modes).toBeUndefined()
  })

  it('FE-PLANNER-TRANSIT-016: switching back to Depart resets arriveBy', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: 'Arrive' }))
    await user.click(screen.getByRole('button', { name: 'Depart' }))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    expect(transitApiMock.plan.mock.calls[0][0].arriveBy).toBe(false)
  })

  it('FE-PLANNER-TRANSIT-017: "Less walking" ranks the least-walking itinerary first, "Best route" restores the original order', async () => {
    const user = userEvent.setup()
    const lessWalking = { ...ITINERARY, startTime: '2025-06-01T06:45:00Z', endTime: '2025-06-01T07:25:00Z', walkSeconds: 60 }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY, lessWalking] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await screen.findByText(/08:30 – 09:00/)

    await user.click(screen.getByText('Less walking'))
    const headings = () => screen.getAllByText(/\d{2}:\d{2} – \d{2}:\d{2}/)
    expect(headings()[0].textContent).toContain('08:45')

    await user.click(screen.getByText('Best route'))
    expect(headings()[0].textContent).toContain('08:30')
  })

  // ── search + add edge cases ─────────────────────────────────────────────────

  it('FE-PLANNER-TRANSIT-018: a day without a date never triggers a search', async () => {
    const user = userEvent.setup()
    const dateless = buildDay({ id: 11, trip_id: 1, date: null, title: 'Unscheduled' } as unknown as Partial<Day>)
    render(<TransitSearchPanel {...makeProps({ day: dateless, days: [dateless] })} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    expect(transitApiMock.plan).not.toHaveBeenCalled()
  })

  it('FE-PLANNER-TRANSIT-019: an unresolvable coordinate falls back to UTC instead of throwing', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    render(<TransitSearchPanel {...makeProps({
      places: [buildPlace({ id: 9, name: 'Nowhere', lat: 999, lng: 999 })],
    })} />)
    const [fromInput, toInput] = screen.getAllByPlaceholderText('Search stop or station…')
    await user.click(fromInput)
    await user.click(await screen.findByText('Nowhere'))
    transitApiMock.geocode.mockResolvedValueOnce({ results: [{ name: 'Zoologischer Garten', lat: 52.507, lng: 13.332, type: 'STOP', area: 'Berlin' }] })
    await user.click(toInput)
    await user.type(toInput, 'Zoo')
    await user.click(await screen.findByText(/Zoologischer Garten/))
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await waitFor(() => expect(transitApiMock.plan).toHaveBeenCalled())
    // 09:00 read as UTC because tz-lookup rejected the coordinate.
    expect(transitApiMock.plan.mock.calls[0][0].time).toBe('2025-06-01T09:00:00.000Z')
  })

  it('FE-PLANNER-TRANSIT-020: a multi-transfer itinerary persists an endpoint per transfer stop', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn().mockResolvedValue({})
    const twoLegs = {
      ...ITINERARY,
      transfers: 2,
      legs: [
        ITINERARY.legs[1],
        { ...ITINERARY.legs[1], mode: 'BUS', line: '100', from: { name: 'Zoologischer Garten', lat: 52.507, lng: 13.332, time: '2025-06-01T06:50:00Z', scheduledTime: null, track: null }, to: { name: 'Hauptbahnhof', lat: 52.525, lng: 13.369, time: '2025-06-01T07:00:00Z', scheduledTime: null, track: null } },
      ],
    }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [twoLegs] })
    render(<TransitSearchPanel {...makeProps({ onAdd })} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))
    await user.click(await screen.findByRole('button', { name: 'Add to day' }))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    const endpoints = onAdd.mock.calls[0][0].endpoints
    expect(endpoints).toHaveLength(3)
    expect(endpoints[1]).toMatchObject({ role: 'stop', sequence: 1, name: 'Zoologischer Garten', local_time: '09:00' })
    expect(endpoints[2]).toMatchObject({ role: 'to', sequence: 2 })
  })

  it('FE-PLANNER-TRANSIT-021: an after-midnight arrival is attached to the following trip day', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn().mockResolvedValue({})
    const nextDay = buildDay({ id: 11, trip_id: 1, date: '2025-06-02', title: 'Day 2' })
    const overnight = { ...ITINERARY, startTime: '2025-06-01T21:00:00Z', endTime: '2025-06-01T23:30:00Z' }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [overnight] })
    render(<TransitSearchPanel {...makeProps({ onAdd, days: [day, nextDay] })} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/23:00 – 01:30/))
    await user.click(await screen.findByRole('button', { name: 'Add to day' }))

    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    const payload = onAdd.mock.calls[0][0]
    expect(payload.day_id).toBe(10)
    expect(payload.end_day_id).toBe(11)
    expect(payload.reservation_end_time).toBe('2025-06-02T01:30')
  })

  it('FE-PLANNER-TRANSIT-022: a failing save toasts instead of leaving the button stuck', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn().mockRejectedValue(new Error('save failed'))
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    render(<TransitSearchPanel {...makeProps({ onAdd })} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))
    await user.click(await screen.findByRole('button', { name: 'Add to day' }))
    await waitFor(() => expect(toastErrors).toContain('Unknown error'))
    expect(await screen.findByRole('button', { name: 'Add to day' })).toBeEnabled()
  })

  it('FE-PLANNER-TRANSIT-023: losing the day date between search and add blocks the save', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn().mockResolvedValue({})
    const dateless = buildDay({ id: 10, trip_id: 1, date: null, title: 'Unscheduled' } as unknown as Partial<Day>)
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    const props = makeProps({ onAdd })
    const { rerender } = render(<TransitSearchPanel {...props} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))

    rerender(<TransitSearchPanel {...props} day={dateless} days={[dateless]} />)
    await user.click(await screen.findByRole('button', { name: 'Add to day' }))
    expect(onAdd).not.toHaveBeenCalled()
  })

  // ── itinerary rendering ─────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSIT-024: durations of an hour or more render as hours and minutes', async () => {
    const user = userEvent.setup()
    const long = { ...ITINERARY, duration: 5400, endTime: '2025-06-01T08:00:00Z' }
    const exact = { ...ITINERARY, startTime: '2025-06-01T10:00:00Z', endTime: '2025-06-01T11:00:00Z', duration: 3600 }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [long, exact] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    expect(await screen.findByText('1 h 30 min')).toBeInTheDocument()
    expect(screen.getByText('1 h')).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-025: every transit mode gets its own line badge icon', async () => {
    const user = userEvent.setup()
    const leg = (mode: string, line: string) => ({
      ...ITINERARY.legs[1], mode, line, lineColor: null, lineTextColor: null,
    })
    const mixed = {
      ...ITINERARY,
      legs: [leg('BUS', 'B1'), leg('TRAM', 'M4'), leg('FERRY', 'F10'), leg('FUNICULAR', 'FU'), leg('AERIAL_LIFT', 'AL'), leg('SUBWAY', 'U2'), leg('HIGHSPEED_RAIL', 'ICE 599')],
    }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [mixed] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await screen.findByText('B1')
    const icon = (text: string) => screen.getAllByText(text)[0].closest('span')?.querySelector('svg')?.getAttribute('class')
    expect(icon('B1')).toContain('lucide-bus')
    expect(icon('M4')).toContain('lucide-tram-front')
    expect(icon('F10')).toContain('lucide-sailboat')
    expect(icon('FU')).toContain('lucide-cable-car')
    expect(icon('AL')).toContain('lucide-cable-car')
    expect(icon('U2')).toContain('lucide-train-front-tunnel')
    // Anything else (rail and friends) falls through to TrainFront, which stays
    // distinct from the tram glyph.
    expect(icon('ICE 599')).toContain('lucide-train-front')
    expect(icon('ICE 599')).not.toContain('tunnel')
  })

  it('FE-PLANNER-TRANSIT-026: a leg without a usable timestamp renders an empty time cell, not "Invalid Date"', async () => {
    const user = userEvent.setup()
    const broken = {
      ...ITINERARY,
      legs: [
        { ...ITINERARY.legs[1], from: { ...ITINERARY.legs[1].from, time: null } },
        { ...ITINERARY.legs[1], line: 'U5', from: { ...ITINERARY.legs[1].from, name: 'Frankfurter Tor', time: 'not-a-time' } },
      ],
    }
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [broken] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))
    expect(await screen.findByText('Frankfurter Tor')).toBeInTheDocument()
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-027: an expanded itinerary lists agencies, platform and walking distance', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [ITINERARY] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 09:00/))
    expect(await screen.findByText('BVG')).toBeInTheDocument()
    expect(screen.getByText(/Platform 2/)).toBeInTheDocument()
    // Rows are anchored at the leg's start, so the access walk carries the picked
    // origin and not the station the next row already names (#2106).
    expect(screen.getByText('Start')).toBeInTheDocument()
    expect(screen.queryByText('Walk to Alexanderplatz')).not.toBeInTheDocument()
    expect(screen.getByText('300 m')).toBeInTheDocument()
    expect(screen.getByText('6 stops')).toBeInTheDocument()
  })

  // #2106 — the walking legs printed their DESTINATION as the row heading, which is
  // the stop the next row already names. The stop you actually get off at is a
  // walking leg's origin, so it had no row at all and disappeared from the card.
  it('FE-PLANNER-TRANSIT-028: the stop you get off at is listed, with the arrival time', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [WALK_BRACKETED] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 11:10/))

    // The final train's arrival station, which is where the closing walk begins.
    expect(await screen.findByText(/Frankfurt\(Main\)Hbf/)).toBeInTheDocument()
    // Its arrival time, which the old WALK branch blanked. Not a time the card
    // header already prints, or this would pass without the fix.
    expect(screen.getByText('11:00')).toBeInTheDocument()
  })

  it('FE-PLANNER-TRANSIT-029: a walk between two stations names the station it starts from', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [WALK_BRACKETED] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 11:10/))

    // The change happens on foot between two different stations: the one you leave
    // is its own row now, at the time the first train gets in.
    expect(await screen.findByText('Koeln Hbf')).toBeInTheDocument()
    expect(screen.getByText('09:32')).toBeInTheDocument()
    // And the walk is still marked as one, in the badge row rather than the heading.
    expect(screen.getAllByText('Walking').length).toBe(3)
  })

  it('FE-PLANNER-TRANSIT-030: no row is headed with the destination of its own walk', async () => {
    const user = userEvent.setup()
    transitApiMock.plan.mockResolvedValueOnce({ itineraries: [WALK_BRACKETED] })
    render(<TransitSearchPanel {...makeProps()} />)
    await pickFromAndTo(user)
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await user.click(await screen.findByText(/08:30 – 11:10/))

    await screen.findByText(/Frankfurt\(Main\)Hbf/)
    expect(screen.queryByText(/^Walk to /)).not.toBeInTheDocument()
    // The picked origin survives instead of being replaced by the first station.
    expect(screen.getByText('Aachen, Bushof')).toBeInTheDocument()
  })
})
