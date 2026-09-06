import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MReservationSheet from '../../../../src/mobile/screens/trip/sheets/MReservationSheet'
import { useAddonStore } from '../../../../src/store/addonStore'
import { useTripStore } from '../../../../src/store/tripStore'
import type { Accommodation, Assignment, Day, Place, Reservation, TripMember } from '../../../../src/types'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { resetAllStores } from '../../../helpers/store'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-RESSH-001 to FE-MOB-RESSH-051

// Date/time/select pickers have their own suites — here they only have to be
// addressable, so they render as plain controls.
vi.mock('../../../../src/components/shared/CustomSelect', () => ({
  default: ({ value, onChange, options = [], placeholder }: {
    value: string | number
    onChange: (v: string | number) => void
    options?: { value: string | number; label: string }[]
    placeholder?: string
  }) => (
    <select
      data-testid="cselect"
      data-value={String(value ?? '')}
      aria-label={placeholder}
      value={options.some(o => String(o.value) === String(value)) ? String(value) : ''}
      onChange={e => {
        const hit = options.find(o => String(o.value) === e.target.value)
        onChange(hit ? hit.value : e.target.value)
      }}
    >
      <option value="" />
      {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  ),
}))

vi.mock('../../../../src/components/shared/CustomTimePicker', () => ({
  default: ({ value, onChange, placeholder = '00:00' }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <input data-testid="ctime" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
  ),
}))

vi.mock('../../../../src/components/shared/CustomDateTimePicker', () => ({
  CustomDatePicker: ({ value, onChange, min, max }: {
    value: string
    onChange: (v: string) => void
    min?: string
    max?: string
  }) => (
    <input
      data-testid="cdate"
      data-min={min ?? ''}
      data-max={max ?? ''}
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  ),
}))

const DAYS = [
  { id: 11, trip_id: 5, day_number: 1, date: '2026-05-01', title: null },
  { id: 12, trip_id: 5, day_number: 2, date: '2026-05-02', title: null },
  { id: 13, trip_id: 5, day_number: 3, date: '2026-05-03', title: 'Fly home' },
] as unknown as Day[]

const PLACES = [
  { id: 101, name: 'Hotel Sacher', address: 'Philharmonikerstrasse 4' },
  { id: 102, name: 'Cafe Central', address: null },
] as unknown as Place[]

const ACCOMMODATIONS = [
  { id: 77, trip_id: 5, place_id: 101, start_day_id: 12, end_day_id: 13 },
] as unknown as Accommodation[]

const ASSIGNMENT = {
  id: 11, day_id: 12, order_index: 0, place_id: 102,
  place: { id: 102, name: 'Cafe Central', place_time: '19:30' },
} as unknown as Assignment

const MEMBERS = [
  { id: 7, username: 'Ana', avatar_url: '/uploads/ana.png' },
  { id: 8, username: 'bob', is_guest: true },
] as unknown as TripMember[]

const DINNER = {
  id: 55, trip_id: 5, title: 'Dinner', type: 'restaurant', status: 'confirmed',
  reservation_time: '2026-05-02T19:30:00', reservation_end_time: '2026-05-02T21:00',
  location: 'Old Town', confirmation_number: 'C1', notes: 'window seat', url: 'https://example.test',
  place_id: 102, metadata: '{"check_in_time":"15:00"}',
  travelers: [{ user_id: 7 }],
} as unknown as Reservation

const HOTEL = {
  id: 56, trip_id: 5, title: 'Hotel Sacher', type: 'hotel', status: 'pending',
  accommodation_id: 77, location: 'fallback address',
  metadata: { check_in_time: '15:00', check_out_time: '11:00' },
} as unknown as Reservation

let setTravelers: ReturnType<typeof vi.fn>

function makePlanner(overrides: Record<string, unknown> = {}) {
  return buildPlanner({
    tripId: 5,
    days: DAYS,
    places: PLACES,
    tripAccommodations: ACCOMMODATIONS,
    tripMembers: [],
    selectedDayId: 12,
    showReservationModal: true,
    canUploadFiles: true,
    handleSaveReservation: vi.fn(async () => ({ id: 99 })),
    ...overrides,
  } as never)
}

function setup(planner = makePlanner()) {
  const onOpenExpense = vi.fn()
  const view = render(<MReservationSheet planner={planner} onOpenExpense={onOpenExpense} />)
  return { ...view, planner, onOpenExpense }
}

const times = () => screen.getAllByTestId('ctime') as HTMLInputElement[]
const dates = () => screen.getAllByTestId('cdate') as HTMLInputElement[]
const selects = () => screen.getAllByTestId('cselect') as HTMLSelectElement[]

const titleField = () => screen.getByPlaceholderText('reservations.titlePlaceholder')
const submitBtn = () => screen.getByRole('button', { name: /^common\.(add|update|saving)$/ })

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

function pick(select: HTMLSelectElement, value: string | number) {
  fireEvent.change(select, { target: { value: String(value) } })
}

/** The payload the sheet handed to planner.handleSaveReservation. */
function savedPayload(planner: ReturnType<typeof makePlanner>) {
  const fn = planner.handleSaveReservation as unknown as ReturnType<typeof vi.fn>
  return fn.mock.calls[0][0] as Record<string, unknown>
}

describe('MReservationSheet', () => {
  beforeEach(() => {
    resetAllStores()
    setTravelers = vi.fn(async () => undefined)
    useTripStore.setState({ setReservationTravelers: setTravelers as never })
    useAddonStore.setState({
      addons: [{ id: 'budget', name: 'Budget', type: 'trip', icon: 'wallet', enabled: true }],
      loaded: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Open / close ───────────────────────────────────────────────────────────

  it('FE-MOB-RESSH-001: renders nothing while the planner has the editor closed', () => {
    setup(makePlanner({ showReservationModal: false }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('FE-MOB-RESSH-002: opens the empty create form with a disabled submit', () => {
    setup()
    expect(screen.getByRole('dialog', { name: 'reservations.newTitle' })).toBeInTheDocument()
    expect(titleField()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'reservations.type.other' })).toHaveAttribute('aria-pressed', 'true')
    expect(submitBtn()).toHaveTextContent('common.add')
    expect(submitBtn()).toBeDisabled()
  })

  it('FE-MOB-RESSH-003: cancel clears every editor flag of the planner', () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(planner.setShowReservationModal).toHaveBeenCalledWith(false)
    expect(planner.setEditingReservation).toHaveBeenCalledWith(null)
    expect(planner.setBookingForAssignmentId).toHaveBeenCalledWith(null)
  })

  it('FE-MOB-RESSH-004: the header X closes the same way', () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(planner.setShowReservationModal).toHaveBeenCalledWith(false)
  })

  it('FE-MOB-RESSH-005: during an import review closing advances the queue instead', () => {
    const { planner } = setup(makePlanner({ importReviewActive: true }))
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(planner.advanceImportReview).toHaveBeenCalledTimes(1)
    expect(planner.setShowReservationModal).not.toHaveBeenCalled()
  })

  // ── Form basics ────────────────────────────────────────────────────────────

  it('FE-MOB-RESSH-006: a title unlocks the submit and the default booking is saved as-is', async () => {
    const { planner } = setup()
    type(titleField(), 'Museum ticket')
    expect(submitBtn()).toBeEnabled()
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toEqual({
      title: 'Museum ticket', type: 'other', status: 'pending',
      reservation_time: null, reservation_end_time: null,
      location: '', confirmation_number: '', notes: '', url: '',
      assignment_id: null, accommodation_id: null, place_id: null,
      metadata: {}, endpoints: [], needs_review: false,
    })
  })

  it('FE-MOB-RESSH-054: editing a booking keeps the stop it was linked to (#2216)', async () => {
    const linked = { ...DINNER, id: 71, assignment_id: 11, title: 'Zoo tickets' } as unknown as Reservation
    const planner = makePlanner({ editingReservation: linked, assignments: { 12: [ASSIGNMENT] } })
    setup(planner)

    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    // Saving without touching the picker used to send null and erase the link.
    expect(savedPayload(planner).assignment_id).toBe(11)
    // And the endpoint set is left alone rather than replaced by an empty one.
    expect(savedPayload(planner)).not.toHaveProperty('endpoints')
  })

  it('FE-MOB-RESSH-055: the picker shows the plan and can unlink the booking (#2216)', async () => {
    const linked = { ...DINNER, id: 71, assignment_id: 11 } as unknown as Reservation
    const planner = makePlanner({ editingReservation: linked, assignments: { 12: [ASSIGNMENT] } })
    setup(planner)

    expect(screen.getByText('reservations.linkAssignment')).toBeInTheDocument()
    const picker = selects().find(s => s.getAttribute('data-value') === '11')
    expect(picker).toBeTruthy()

    pick(picker!, '')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner).assignment_id).toBeNull()
  })

  it('FE-MOB-RESSH-056: a booking created for a stop still saves that stop', async () => {
    const planner = makePlanner({ bookingForAssignmentId: 11, assignments: { 12: [ASSIGNMENT] } })
    setup(planner)
    type(titleField(), 'Zoo tickets')
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner).assignment_id).toBe(11)
    // A create still declares the endpoint set, which is what the server expects.
    expect(savedPayload(planner).endpoints).toEqual([])
  })

  it('FE-MOB-RESSH-057: the files already on the booking are listed, not just this session\'s picks (#2217)', () => {
    const linked = { ...DINNER, id: 71 } as unknown as Reservation
    const files = [
      { id: 4, trip_id: 5, reservation_id: 71, original_name: 'voucher.pdf', url: '/uploads/voucher.pdf', deleted_at: null },
      { id: 5, trip_id: 5, reservation_id: 99, original_name: 'other.pdf', url: '/uploads/other.pdf', deleted_at: null },
      { id: 6, trip_id: 5, linked_reservation_ids: [71], original_name: 'linked.pdf', url: '/uploads/linked.pdf', deleted_at: null },
    ]
    setup(makePlanner({ editingReservation: linked, files }))

    expect(screen.getByText('voucher.pdf')).toBeInTheDocument()
    expect(screen.getByText('linked.pdf')).toBeInTheDocument()
    expect(screen.queryByText('other.pdf')).not.toBeInTheDocument()
  })

  it('FE-MOB-RESSH-007: the type chips switch the form between event and hotel layout', () => {
    setup()
    expect(screen.getByLabelText('reservations.meta.pickPlace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    expect(screen.getByRole('button', { name: 'reservations.type.hotel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('reservations.meta.pickHotel')).toBeInTheDocument()
    expect(screen.queryByLabelText('reservations.meta.pickPlace')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('cdate')).toHaveLength(0)
  })

  it('FE-MOB-RESSH-008: status, code, link and notes all reach the payload', async () => {
    const { planner } = setup()
    type(titleField(), 'Opera')
    fireEvent.click(screen.getByRole('button', { name: 'reservations.confirmed' }))
    type(screen.getByPlaceholderText('reservations.confirmationPlaceholder'), 'OP-7')
    type(screen.getByPlaceholderText('reservations.urlPlaceholder'), 'https://opera.test')
    type(screen.getByPlaceholderText('reservations.notesPlaceholder'), 'balcony')
    type(screen.getByPlaceholderText('reservations.locationPlaceholder'), 'Ringstrasse 2')
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      status: 'confirmed', confirmation_number: 'OP-7',
      url: 'https://opera.test', notes: 'balcony', location: 'Ringstrasse 2',
    })
  })

  it('FE-MOB-RESSH-009: the date pickers are pinned to the trip span', () => {
    setup()
    for (const el of dates()) {
      expect(el).toHaveAttribute('data-min', '2026-05-01')
      expect(el).toHaveAttribute('data-max', '2026-05-03')
    }
  })

  it('FE-MOB-RESSH-010: linking a place fills the still-empty title and address', () => {
    setup()
    pick(screen.getByLabelText('reservations.meta.pickPlace') as HTMLSelectElement, 101)
    expect(titleField()).toHaveValue('Hotel Sacher')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Philharmonikerstrasse 4')
  })

  it('FE-MOB-RESSH-011: linking a place never overwrites what the user already typed', () => {
    setup()
    type(titleField(), 'My dinner')
    type(screen.getByPlaceholderText('reservations.locationPlaceholder'), 'My address')
    pick(screen.getByLabelText('reservations.meta.pickPlace') as HTMLSelectElement, 101)
    expect(titleField()).toHaveValue('My dinner')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('My address')
  })

  it('FE-MOB-RESSH-012: unlinking the place leaves the typed fields alone', async () => {
    const { planner } = setup()
    type(titleField(), 'Walk')
    const placeSelect = screen.getByLabelText('reservations.meta.pickPlace') as HTMLSelectElement
    pick(placeSelect, 102)
    pick(placeSelect, '')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ place_id: null, title: 'Walk' })
  })

  // ── Times ──────────────────────────────────────────────────────────────────

  it('FE-MOB-RESSH-013: date plus start and end time are combined into one timestamp pair', async () => {
    const { planner } = setup()
    type(titleField(), 'Dinner')
    type(dates()[0], '2026-05-02')
    type(times()[0], '19:30')
    type(times()[1], '21:00')
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      reservation_time: '2026-05-02T19:30',
      reservation_end_time: '2026-05-02T21:00',
    })
  })

  it('FE-MOB-RESSH-014: a start time without a date falls back to the selected day', async () => {
    const { planner } = setup()
    type(titleField(), 'Dinner')
    type(times()[0], '09:00')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ reservation_time: '2026-05-02T09:00' })
  })

  it('FE-MOB-RESSH-015: an end date without an end time stays a plain date', async () => {
    const { planner } = setup()
    type(titleField(), 'Festival')
    type(dates()[0], '2026-05-01')
    type(dates()[1], '2026-05-03')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      reservation_time: '2026-05-01',
      reservation_end_time: '2026-05-03',
    })
  })

  it('FE-MOB-RESSH-016: clearing the start date drops the timestamp again', async () => {
    const { planner } = setup()
    type(titleField(), 'Festival')
    type(dates()[0], '2026-05-01')
    type(dates()[0], '')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ reservation_time: null })
  })

  it('FE-MOB-RESSH-017: an end before the start blocks the submit and warns inline', () => {
    setup()
    type(titleField(), 'Dinner')
    type(dates()[0], '2026-05-02')
    type(times()[0], '19:30')
    type(dates()[1], '2026-05-01')
    expect(screen.getByText('reservations.validation.endBeforeStart')).toBeInTheDocument()
    expect(submitBtn()).toBeDisabled()
  })

  it('FE-MOB-RESSH-018: submitting an inverted range through the costs shortcut only toasts', async () => {
    const { planner, onOpenExpense } = setup()
    type(titleField(), 'Dinner')
    type(dates()[0], '2026-05-02')
    type(times()[0], '19:30')
    type(dates()[1], '2026-05-01')
    fireEvent.click(screen.getByRole('button', { name: 'reservations.createExpense' }))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('reservations.validation.endBeforeStart'))
    expect(planner.handleSaveReservation).not.toHaveBeenCalled()
    expect(onOpenExpense).not.toHaveBeenCalled()
  })

  it('FE-MOB-RESSH-018b: an all-day booking that ends on its start day is savable', async () => {
    const { planner } = setup()
    type(titleField(), 'Museum pass')
    type(dates()[0], '2026-05-02')
    type(dates()[1], '2026-05-02')

    expect(screen.queryByText('reservations.validation.endBeforeStart')).toBeNull()
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      reservation_time: '2026-05-02',
      reservation_end_time: '2026-05-02',
    })
  })

  // ── Editing an existing booking ────────────────────────────────────────────

  it('FE-MOB-RESSH-019: editing seeds every field and splits the end timestamp', () => {
    setup(makePlanner({ editingReservation: DINNER }))
    expect(screen.getByRole('dialog', { name: 'reservations.editTitle' })).toBeInTheDocument()
    expect(submitBtn()).toHaveTextContent('common.update')
    expect(titleField()).toHaveValue('Dinner')
    expect(screen.getByRole('button', { name: 'reservations.type.restaurant' })).toHaveAttribute('aria-pressed', 'true')
    expect(dates()[0]).toHaveValue('2026-05-02')
    expect(times()[0]).toHaveValue('19:30')
    expect(dates()[1]).toHaveValue('2026-05-02')
    expect(times()[1]).toHaveValue('21:00')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Old Town')
    expect(screen.getByPlaceholderText('reservations.confirmationPlaceholder')).toHaveValue('C1')
    expect(screen.getByPlaceholderText('reservations.notesPlaceholder')).toHaveValue('window seat')
    expect(screen.getByPlaceholderText('reservations.urlPlaceholder')).toHaveValue('https://example.test')
    expect(screen.getByLabelText('reservations.meta.pickPlace')).toHaveAttribute('data-value', '102')
  })

  it('FE-MOB-RESSH-020: a date-only end is read back into the end-date field', () => {
    setup(makePlanner({ editingReservation: { ...DINNER, reservation_end_time: '2026-05-03' } }))
    expect(dates()[1]).toHaveValue('2026-05-03')
    expect(times()[1]).toHaveValue('')
  })

  it('FE-MOB-RESSH-021: a booking with no times at all seeds empty fields', () => {
    setup(makePlanner({
      editingReservation: {
        id: 57, title: 'Museum', type: undefined, status: undefined,
        reservation_time: null, reservation_end_time: null, metadata: {},
      } as unknown as Reservation,
    }))
    expect(titleField()).toHaveValue('Museum')
    expect(screen.getByRole('button', { name: 'reservations.type.other' })).toHaveAttribute('aria-pressed', 'true')
    expect(dates()[0]).toHaveValue('')
    expect(times()[1]).toHaveValue('')
  })

  it('FE-MOB-RESSH-022: a hotel booking seeds its stay from the linked accommodation', () => {
    setup(makePlanner({ editingReservation: HOTEL }))
    expect(screen.getByLabelText('reservations.meta.pickHotel')).toHaveAttribute('data-value', '101')
    const [from, to] = selects().slice(1)
    expect(from).toHaveAttribute('data-value', '12')
    expect(to).toHaveAttribute('data-value', '13')
    expect(screen.getByPlaceholderText('15:00')).toHaveValue('15:00')
    expect(screen.getByPlaceholderText('11:00')).toHaveValue('11:00')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Philharmonikerstrasse 4')
  })

  it('FE-MOB-RESSH-023: a hotel without an accommodation falls back to the booking location', () => {
    setup(makePlanner({ editingReservation: { ...HOTEL, accommodation_id: null } }))
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('fallback address')
    expect(screen.getByLabelText('reservations.meta.pickHotel')).toHaveAttribute('data-value', '')
  })

  // ── Hotels ─────────────────────────────────────────────────────────────────

  it('FE-MOB-RESSH-024: a hotel with a linked place and a day range creates the accommodation', async () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    type(titleField(), 'Sacher')
    pick(screen.getByLabelText('reservations.meta.pickHotel') as HTMLSelectElement, 101)
    pick(selects()[1], 12)
    pick(selects()[2], 13)
    type(screen.getByPlaceholderText('15:00'), '15:00')
    type(screen.getByPlaceholderText('11:00'), '11:00')
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      type: 'hotel',
      reservation_time: null,
      reservation_end_time: null,
      location: 'Philharmonikerstrasse 4',
      accommodation_id: null,
      place_id: null,
      metadata: { check_in_time: '15:00', check_out_time: '11:00' },
      create_accommodation: {
        place_id: 101, venue: null, address: 'Philharmonikerstrasse 4',
        start_day_id: 12, end_day_id: 13, check_in: '15:00', check_out: '11:00', confirmation: null,
      },
    })
  })

  it('FE-MOB-RESSH-025: a hotel without a linked place proposes a venue from title and address', async () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    type(titleField(), 'Ibis')
    type(screen.getByPlaceholderText('reservations.locationPlaceholder'), 'Somewhere 5')
    pick(selects()[1], 12)
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      create_accommodation: {
        place_id: null,
        venue: { name: 'Ibis', address: 'Somewhere 5' },
        start_day_id: 12, end_day_id: 12,
      },
    })
  })

  it('FE-MOB-RESSH-026: a hotel without any day range creates no accommodation', async () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    type(titleField(), 'Ibis')
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).not.toHaveProperty('create_accommodation')
  })

  it('FE-MOB-RESSH-027: picking a hotel place adopts its name and address', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    pick(screen.getByLabelText('reservations.meta.pickHotel') as HTMLSelectElement, 101)
    expect(titleField()).toHaveValue('Hotel Sacher')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Philharmonikerstrasse 4')
  })

  it('FE-MOB-RESSH-028: an earlier end day pulls the start day back with it', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    pick(selects()[1], 13)
    expect(selects()[2]).toHaveAttribute('data-value', '13')
    pick(selects()[2], 11)
    expect(selects()[1]).toHaveAttribute('data-value', '11')
  })

  // ── Prefill from the booking import ────────────────────────────────────────

  it('FE-MOB-RESSH-029: an import prefill seeds the hotel form, its day range and the source file', () => {
    setup(makePlanner({
      reservationPrefill: {
        title: 'Hotel Ibis', type: 'hotel', status: 'confirmed',
        reservation_time: '2026-05-02T14:00:00', reservation_end_time: '2026-05-03T10:00',
        location: 'Vienna', confirmation_number: 'PF1', notes: 'late arrival', url: 'https://ibis.test',
        metadata: { check_in_time: '14:00', check_out_time: '10:00' },
        _accommodation: { check_in: '2026-05-02', check_out: '2026-05-03' },
        _venue: { address: 'Mariahilfer 1' },
        _sourceFiles: [new File(['x'], 'voucher.pdf', { type: 'application/pdf' })],
      },
    }))
    expect(titleField()).toHaveValue('Hotel Ibis')
    expect(screen.getByPlaceholderText('reservations.confirmationPlaceholder')).toHaveValue('PF1')
    expect(screen.getByPlaceholderText('reservations.urlPlaceholder')).toHaveValue('https://ibis.test')
    expect(screen.getByPlaceholderText('15:00')).toHaveValue('14:00')
    expect(selects()[1]).toHaveAttribute('data-value', '12')
    expect(selects()[2]).toHaveAttribute('data-value', '13')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Mariahilfer 1')
    expect(screen.getByText('voucher.pdf')).toBeInTheDocument()
  })

  it('FE-MOB-RESSH-030: a prefill with a date-only end fills the end-date field', () => {
    setup(makePlanner({
      reservationPrefill: { title: 'Tour', type: 'tour', reservation_end_time: '2026-05-03', metadata: null },
    }))
    expect(dates()[1]).toHaveValue('2026-05-03')
    expect(times()[1]).toHaveValue('')
  })

  // ── Travelers ──────────────────────────────────────────────────────────────

  it('FE-MOB-RESSH-031: without trip members the traveler list shows its empty note', () => {
    setup()
    expect(screen.getByText('reservations.travelers.none')).toBeInTheDocument()
  })

  it('FE-MOB-RESSH-032: members render with avatar, initial and the guest badge', () => {
    setup(makePlanner({ tripMembers: MEMBERS }))
    const ana = screen.getByText('Ana').closest('button') as HTMLButtonElement
    expect(ana.querySelector('img')).toHaveAttribute('src', '/uploads/ana.png')
    const bob = screen.getByText('bob').closest('button') as HTMLButtonElement
    expect(bob.querySelector('img')).toBeNull()
    expect(bob).toHaveTextContent('B')
    expect(bob).toHaveTextContent('Guest')
  })

  it('FE-MOB-RESSH-033: assigning travelers persists after the booking was created', async () => {
    setup(makePlanner({ tripMembers: MEMBERS }))
    type(titleField(), 'Dinner')
    fireEvent.click(screen.getByText('Ana'))
    fireEvent.click(screen.getByText('bob'))
    fireEvent.click(screen.getByText('Ana'))
    fireEvent.click(submitBtn())
    await waitFor(() => expect(setTravelers).toHaveBeenCalledWith(5, 99, [8]))
  })

  it('FE-MOB-RESSH-034: an unchanged traveler set is not written again', async () => {
    const { planner } = setup(makePlanner({ tripMembers: MEMBERS, editingReservation: DINNER }))
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(setTravelers).not.toHaveBeenCalled()
  })

  it('FE-MOB-RESSH-035: removing a traveler falls back to the edited booking id', async () => {
    const planner = makePlanner({
      tripMembers: MEMBERS,
      editingReservation: DINNER,
      handleSaveReservation: vi.fn(async () => undefined),
    })
    setup(planner)
    fireEvent.click(screen.getByText('Ana'))
    fireEvent.click(submitBtn())
    await waitFor(() => expect(setTravelers).toHaveBeenCalledWith(5, 55, []))
  })

  // ── Files, costs, errors ───────────────────────────────────────────────────

  it('FE-MOB-RESSH-036: attached files are uploaded against the new booking', async () => {
    const { planner } = setup()
    type(titleField(), 'Flight docs')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')] } })
    expect(screen.getByText('a.pdf')).toBeInTheDocument()
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.tripActions.addFile).toHaveBeenCalledTimes(2))
    const [tripId, fd] = vi.mocked(planner.tripActions.addFile).mock.calls[0] as [number, FormData]
    expect(tripId).toBe(5)
    expect(fd.get('reservation_id')).toBe('99')
    expect(fd.get('description')).toBe('Flight docs')
    expect((fd.get('file') as File).name).toBe('a.pdf')
  })

  it('FE-MOB-RESSH-037: files are not re-uploaded when an existing booking is edited', async () => {
    const { planner } = setup(makePlanner({ editingReservation: DINNER }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.pdf')] } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(planner.tripActions.addFile).not.toHaveBeenCalled()
  })

  it('FE-MOB-RESSH-038: without upload permission the attachment block is gone', () => {
    setup(makePlanner({ canUploadFiles: false }))
    expect(screen.queryByRole('button', { name: 'files.attach' })).not.toBeInTheDocument()
  })

  it('FE-MOB-RESSH-039: the costs shortcut saves first and then opens the expense form', async () => {
    const { planner, onOpenExpense } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.restaurant' }))
    type(titleField(), 'Dinner')
    fireEvent.click(screen.getByRole('button', { name: 'reservations.createExpense' }))

    await waitFor(() => expect(onOpenExpense).toHaveBeenCalled())
    expect(planner.handleSaveReservation).toHaveBeenCalledTimes(1)
    expect(onOpenExpense).toHaveBeenCalledWith({
      prefill: { reservationId: 99, name: 'Dinner', category: 'food' },
    })
  })

  it('FE-MOB-RESSH-040: a plain submit never opens the expense form', async () => {
    const { planner, onOpenExpense } = setup()
    type(titleField(), 'Dinner')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(onOpenExpense).not.toHaveBeenCalled()
  })

  it('FE-MOB-RESSH-041: without the budget addon there is no costs section', () => {
    useAddonStore.setState({ addons: [], loaded: true })
    setup()
    expect(screen.queryByRole('button', { name: 'reservations.createExpense' })).not.toBeInTheDocument()
  })

  it('FE-MOB-RESSH-042: a failing save surfaces the error message and unlocks the form', async () => {
    const planner = makePlanner({ handleSaveReservation: vi.fn(async () => { throw new Error('server said no') }) })
    setup(planner)
    type(titleField(), 'Dinner')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('server said no'))
    expect(submitBtn()).toBeEnabled()
  })

  it('FE-MOB-RESSH-043: a non-Error rejection falls back to the generic message', async () => {
    const planner = makePlanner({ handleSaveReservation: vi.fn(async () => { throw 'nope' }) })
    setup(planner)
    type(titleField(), 'Dinner')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('common.unknownError'))
  })

  it('FE-MOB-RESSH-044: a booking opened for a transport segment keeps that assignment', async () => {
    const { planner } = setup(makePlanner({ bookingForAssignmentId: 42 }))
    type(titleField(), 'Seat reservation')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ assignment_id: 42 })
  })

  it('FE-MOB-RESSH-045: a saved import review advances to the next parsed booking', async () => {
    const { planner } = setup(makePlanner({ importReviewActive: true }))
    type(titleField(), 'Imported hotel')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.advanceImportReview).toHaveBeenCalledTimes(1))
  })

  it('FE-MOB-RESSH-046: a pending attachment can be dropped again before saving', async () => {
    const { planner } = setup()
    type(titleField(), 'Flight docs')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')] } })
    fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' })[0])
    expect(screen.queryByText('a.pdf')).not.toBeInTheDocument()
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.tripActions.addFile).toHaveBeenCalledTimes(1))
    const [, fd] = vi.mocked(planner.tripActions.addFile).mock.calls[0] as [number, FormData]
    expect((fd.get('file') as File).name).toBe('b.pdf')
  })

  it('FE-MOB-RESSH-047: picking the date after the time keeps the time', async () => {
    const { planner } = setup()
    type(titleField(), 'Dinner')
    type(times()[0], '19:30')
    type(dates()[0], '2026-05-01')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ reservation_time: '2026-05-01T19:30' })
  })

  it('FE-MOB-RESSH-048: clearing the end date drops the end timestamp', async () => {
    const { planner } = setup()
    type(titleField(), 'Festival')
    type(dates()[1], '2026-05-03')
    type(dates()[1], '')
    fireEvent.click(submitBtn())
    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({ reservation_end_time: null })
  })

  it('FE-MOB-RESSH-049: a hotel with only an end day and no address stays a name-only venue', async () => {
    const { planner } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    type(titleField(), 'Ibis')
    pick(selects()[2], 13)
    fireEvent.click(submitBtn())

    await waitFor(() => expect(planner.handleSaveReservation).toHaveBeenCalled())
    expect(savedPayload(planner)).toMatchObject({
      location: '',
      create_accommodation: {
        place_id: null,
        venue: { name: 'Ibis', address: null },
        address: null,
        start_day_id: 13, end_day_id: 13,
      },
    })
  })

  it('FE-MOB-RESSH-050: a later start day inside the range leaves the end day alone', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    pick(selects()[2], 13)
    pick(selects()[1], 12)
    expect(selects()[1]).toHaveAttribute('data-value', '12')
    expect(selects()[2]).toHaveAttribute('data-value', '13')
  })

  // A legacy or corrupted metadata column used to throw straight out of the open
  // effect and leave the sheet blank.
  it('FE-MOB-RESSH-052: unparseable metadata opens the sheet with empty check-in times', () => {
    setup(makePlanner({
      editingReservation: { ...DINNER, type: 'hotel', metadata: '{not json' },
    }))
    expect(titleField()).toHaveValue('Dinner')
    expect(screen.getByPlaceholderText('15:00')).toHaveValue('')
  })

  it('FE-MOB-RESSH-053: double-encoded metadata still fills the check-in times', () => {
    setup(makePlanner({
      editingReservation: {
        ...DINNER, type: 'hotel',
        metadata: JSON.stringify(JSON.stringify({ check_in_time: '16:00', check_out_time: '10:30' })),
      },
    }))
    expect(screen.getByPlaceholderText('15:00')).toHaveValue('16:00')
    expect(screen.getByPlaceholderText('11:00')).toHaveValue('10:30')
  })

  it('FE-MOB-RESSH-051: a hotel place without an address keeps the typed one', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'reservations.type.hotel' }))
    type(screen.getByPlaceholderText('reservations.locationPlaceholder'), 'Manual 3')
    pick(screen.getByLabelText('reservations.meta.pickHotel') as HTMLSelectElement, 102)
    expect(titleField()).toHaveValue('Cafe Central')
    expect(screen.getByPlaceholderText('reservations.locationPlaceholder')).toHaveValue('Manual 3')
  })
})
