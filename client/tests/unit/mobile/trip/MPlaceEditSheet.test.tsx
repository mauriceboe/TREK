import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpResponse, http } from 'msw'
import MPlaceEditSheet from '../../../../src/mobile/screens/trip/sheets/MPlaceEditSheet'
import type { TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import type { Assignment, Category, Place } from '../../../../src/types'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { useAddonStore } from '../../../../src/store/addonStore'
import { useTripStore } from '../../../../src/store/tripStore'
import { server } from '../../../helpers/msw/server'
import { resetAllStores, seedStore } from '../../../helpers/store'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-PLEDIT-001 to FE-MOB-PLEDIT-024, plus FE-MOB-PLEDIT-033 to -035
// planner.t echoes the key, so every label/placeholder is asserted as its key.

const CATEGORIES = [
  { id: 3, name: 'Food', color: '#ef4444', icon: 'Coffee', user_id: 1 },
] as unknown as Category[]

const EXISTING = {
  id: 41, trip_id: 1, name: 'Ueno Park', address: 'Taito City', lat: 35.715, lng: 139.773,
  google_place_id: 'ChIJ_ueno',
} as unknown as Place

const EDITED = {
  id: 42, trip_id: 1, name: 'Senso-ji', description: 'Oldest temple', address: '2-3-1 Asakusa',
  lat: 35.7148, lng: 139.7967, category_id: 3, notes: 'Go early', website: 'https://senso-ji.jp',
  place_time: '08:00', end_time: '09:30', transport_mode: 'transit',
} as unknown as Place

function setup(overrides: Partial<TripPlanner> = {}) {
  const planner = buildPlanner({ showPlaceForm: true, categories: CATEGORIES, ...overrides })
  const onOpenExpense = vi.fn()
  const view = render(<MPlaceEditSheet planner={planner} onOpenExpense={onOpenExpense} />)
  return { ...view, planner, onOpenExpense }
}

const nameField = () => screen.getByPlaceholderText('places.formNamePlaceholder')
const submit = () => screen.getByRole('button', { name: /^(common\.add|common\.save|common\.saving|places\.addAnyway)$/ })

describe('MPlaceEditSheet', () => {
  beforeEach(() => {
    resetAllStores()
    server.use(
      http.post('/api/maps/search', () => HttpResponse.json({
        source: 'osm',
        places: [{ name: 'Ueno Koen', address: 'Taito', lat: 35.7, lng: 139.7, google_place_id: 'ChIJ_ueno' }],
      })),
      http.post('/api/maps/autocomplete', () => HttpResponse.json({ source: 'osm', suggestions: [] })),
    )
  })

  it('FE-MOB-PLEDIT-001: stays unmounted while the planner has no editor open', () => {
    setup({ showPlaceForm: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLEDIT-002: opens blank in add mode', () => {
    setup()
    expect(screen.getByRole('dialog', { name: 'places.addPlace' })).toBeInTheDocument()
    expect(screen.getAllByText('places.addPlace').length).toBeGreaterThan(0)
    expect(nameField()).toHaveValue('')
    expect(submit()).toHaveTextContent('common.add')
    // No place in context — no delete affordance and no time fields.
    expect(screen.queryByRole('button', { name: 'common.delete' })).not.toBeInTheDocument()
    expect(screen.queryByText('places.startTime')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLEDIT-003: prefills every field from the place under edit', () => {
    setup({ editingPlace: EDITED })
    expect(screen.getByRole('dialog', { name: 'places.editPlace' })).toBeInTheDocument()
    expect(nameField()).toHaveValue('Senso-ji')
    expect(screen.getByPlaceholderText('places.formDescriptionPlaceholder')).toHaveValue('Oldest temple')
    expect(screen.getByPlaceholderText('places.formNotesPlaceholder')).toHaveValue('Go early')
    expect(screen.getByPlaceholderText('places.formAddressPlaceholder')).toHaveValue('2-3-1 Asakusa')
    expect(screen.getByPlaceholderText('places.formLat')).toHaveValue('35.7148')
    expect(screen.getByPlaceholderText('places.formLng')).toHaveValue('139.7967')
    expect(screen.getByPlaceholderText('https://')).toHaveValue('https://senso-ji.jp')
    expect(screen.getByRole('button', { name: /Food/ }).className).toContain('bg-m-act')
    expect(submit()).toHaveTextContent('common.save')
  })

  it('FE-MOB-PLEDIT-004: leaves optional fields blank when the place has none', () => {
    const bare = { id: 43, trip_id: 1, name: 'Nameless' } as unknown as Place
    setup({ editingPlace: bare })
    expect(nameField()).toHaveValue('Nameless')
    expect(screen.getByPlaceholderText('places.formLat')).toHaveValue('')
    expect(screen.getByPlaceholderText('places.formNotesPlaceholder')).toHaveValue('')
  })

  it('FE-MOB-PLEDIT-005: reads the times off the in-context assignment, not off the place', () => {
    const assignment = {
      id: 7, day_id: 2, place_id: 42, order_index: 0,
      place: { ...EDITED, place_time: '14:00', end_time: '15:00' },
    } as unknown as Assignment
    setup({ editingPlace: EDITED, editingAssignmentId: 7, assignments: { '2': [assignment] } })
    expect(screen.getByText('places.startTime')).toBeInTheDocument()
    const times = screen.getAllByDisplayValue(/^1[45]:00$/)
    expect(times.map(el => (el as HTMLInputElement).value)).toEqual(['14:00', '15:00'])
  })

  it('FE-MOB-PLEDIT-006: prefills from a map long-press / POI pick', () => {
    setup({
      prefillCoords: {
        lat: 35.6586, lng: 139.7454, name: 'Tokyo Tower', address: '4-2-8 Shibakoen',
        website: 'https://tokyotower.co.jp', phone: '+81 3', osm_id: 'W123',
      },
    })
    expect(nameField()).toHaveValue('Tokyo Tower')
    expect(screen.getByPlaceholderText('places.formLat')).toHaveValue('35.6586')
    expect(screen.getByPlaceholderText('places.formLng')).toHaveValue('139.7454')
    expect(screen.getByPlaceholderText('places.formAddressPlaceholder')).toHaveValue('4-2-8 Shibakoen')
    expect(screen.getByPlaceholderText('https://')).toHaveValue('https://tokyotower.co.jp')
  })

  it('FE-MOB-PLEDIT-007: falls back to bare coordinates when the pick carries no metadata', () => {
    setup({ prefillCoords: { lat: 1.5, lng: 2.5 } })
    expect(nameField()).toHaveValue('')
    expect(screen.getByPlaceholderText('places.formLat')).toHaveValue('1.5')
  })

  it('FE-MOB-PLEDIT-008: refuses to save without a name', () => {
    const { planner } = setup()
    fireEvent.change(nameField(), { target: { value: '   ' } })
    fireEvent.click(submit())
    expect(planner.toast.error).toHaveBeenCalledWith('places.nameRequired')
    expect(planner.handleSavePlace).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLEDIT-009: saves the parsed form and clears every editor flag', async () => {
    const { planner } = setup()
    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.change(screen.getByPlaceholderText('places.formLat'), { target: { value: '35.71' } })
    fireEvent.change(screen.getByPlaceholderText('places.formLng'), { target: { value: '139.79' } })
    fireEvent.click(screen.getByRole('button', { name: /Food/ }))
    fireEvent.click(submit())

    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
    expect(planner.handleSavePlace).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nakamise', lat: 35.71, lng: 139.79, category_id: '3', _pendingFiles: undefined,
    }))
    expect(planner.setShowPlaceForm).toHaveBeenCalledWith(false)
    expect(planner.setEditingPlace).toHaveBeenCalledWith(null)
    expect(planner.setEditingAssignmentId).toHaveBeenCalledWith(null)
    expect(planner.setPrefillCoords).toHaveBeenCalledWith(null)
  })

  it('FE-MOB-PLEDIT-009b: carries the free-text fields into the save payload', async () => {
    const { planner } = setup()
    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.change(screen.getByPlaceholderText('places.formDescriptionPlaceholder'), { target: { value: 'Shopping street' } })
    fireEvent.change(screen.getByPlaceholderText('places.formNotesPlaceholder'), { target: { value: 'Cash only' } })
    fireEvent.change(screen.getByPlaceholderText('places.formAddressPlaceholder'), { target: { value: '1-36-3 Asakusa' } })
    fireEvent.change(screen.getByPlaceholderText('https://'), { target: { value: 'https://asakusa.example' } })
    fireEvent.click(submit())

    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
    expect(planner.handleSavePlace).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Shopping street',
      notes: 'Cash only',
      address: '1-36-3 Asakusa',
      website: 'https://asakusa.example',
    }))
  })

  it('FE-MOB-PLEDIT-010: sends null coordinates and no category when the fields stay empty', async () => {
    const { planner } = setup()
    fireEvent.change(nameField(), { target: { value: 'Somewhere' } })
    fireEvent.click(submit())
    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
    expect(planner.handleSavePlace).toHaveBeenCalledWith(expect.objectContaining({ lat: null, lng: null, category_id: null }))
  })

  it('FE-MOB-PLEDIT-011: strips non-numeric characters from the coordinate fields', () => {
    setup()
    const lat = screen.getByPlaceholderText('places.formLat')
    fireEvent.change(lat, { target: { value: '3a5.7N' } })
    expect(lat).toHaveValue('35.7')
  })

  it('FE-MOB-PLEDIT-012: a pasted "lat, lng" pair fills both coordinate fields', () => {
    setup()
    const lat = screen.getByPlaceholderText('places.formLat')
    fireEvent.paste(lat, { clipboardData: { getData: () => ' 35.6895, 139.6917 ' } })
    expect(lat).toHaveValue('35.6895')
    expect(screen.getByPlaceholderText('places.formLng')).toHaveValue('139.6917')
  })

  it('FE-MOB-PLEDIT-013: an unparseable paste is left to the browser', () => {
    setup()
    const lat = screen.getByPlaceholderText('places.formLat')
    fireEvent.paste(lat, { clipboardData: { getData: () => 'Tokyo Tower' } })
    expect(lat).toHaveValue('')
  })

  it('FE-MOB-PLEDIT-014: warns once about a duplicate name and saves on the second tap', async () => {
    const { planner } = setup({ places: [EXISTING] })
    fireEvent.change(nameField(), { target: { value: '  ueno park ' } })
    fireEvent.click(submit())

    expect(planner.toast.warning).toHaveBeenCalledWith('places.duplicateExists:Ueno Park')
    expect(planner.handleSavePlace).not.toHaveBeenCalled()
    expect(submit()).toHaveTextContent('places.addAnyway')

    fireEvent.click(submit())
    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
  })

  it('FE-MOB-PLEDIT-015: treats near-identical coordinates as a duplicate', () => {
    const { planner } = setup({ places: [EXISTING], prefillCoords: { lat: 35.71505, lng: 139.77305 } })
    fireEvent.change(nameField(), { target: { value: 'Park entrance' } })
    fireEvent.click(submit())
    expect(planner.toast.warning).toHaveBeenCalledWith('places.duplicateExists:Ueno Park')
  })

  it('FE-MOB-PLEDIT-016: a maps pick that shares the Google Place ID counts as a duplicate', async () => {
    const { planner } = setup({ places: [EXISTING] })
    fireEvent.change(screen.getByPlaceholderText('places.mapsSearchPlaceholder'), { target: { value: 'ueno koen' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))
    fireEvent.click(await screen.findByText('Ueno Koen'))

    expect(nameField()).toHaveValue('Ueno Koen')
    fireEvent.click(submit())
    expect(planner.toast.warning).toHaveBeenCalledWith('places.duplicateExists:Ueno Park')
  })

  it('FE-MOB-PLEDIT-017: an existing place never triggers the duplicate guard', async () => {
    const { planner } = setup({ places: [EXISTING], editingPlace: { ...EXISTING, id: 99 } as unknown as Place })
    fireEvent.click(submit())
    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
    expect(planner.toast.warning).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLEDIT-018: surfaces the server message and keeps the sheet open when the save fails', async () => {
    const handleSavePlace = vi.fn().mockRejectedValue(new Error('Trip is locked'))
    const { planner } = setup({ handleSavePlace })
    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.click(submit())

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('Trip is locked'))
    expect(planner.setShowPlaceForm).not.toHaveBeenCalled()
    expect(submit()).not.toBeDisabled()
  })

  it('FE-MOB-PLEDIT-019: falls back to the generic message for a non-Error rejection', async () => {
    const handleSavePlace = vi.fn().mockRejectedValue('nope')
    const { planner } = setup({ handleSavePlace })
    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.click(submit())
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('places.saveError'))
  })

  it('FE-MOB-PLEDIT-020: shows the saving label and blocks the button while the save runs', async () => {
    let release: () => void = () => {}
    const handleSavePlace = vi.fn(() => new Promise<{ id: number }>(resolve => { release = () => resolve({ id: 1 }) }))
    setup({ handleSavePlace })
    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.click(submit())

    await waitFor(() => expect(submit()).toHaveTextContent('common.saving'))
    expect(submit()).toBeDisabled()
    release()
    await waitFor(() => expect(handleSavePlace).toHaveBeenCalledTimes(1))
  })

  it('FE-MOB-PLEDIT-021: deletes on the second tap and stages the id on the first', async () => {
    const { planner } = setup({ editingPlace: EDITED })
    const del = screen.getByRole('button', { name: 'common.delete' })
    fireEvent.click(del)
    expect(planner.setDeletePlaceId).toHaveBeenCalledWith(42)
    expect(planner.toast.warning).toHaveBeenCalledWith('mobileTrip.tapAgainToDelete')
    expect(planner.confirmDeletePlace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    await waitFor(() => expect(planner.confirmDeletePlace).toHaveBeenCalledTimes(1))
    expect(planner.setShowPlaceForm).toHaveBeenCalledWith(false)
  })

  it('FE-MOB-PLEDIT-022: cancelling an armed delete un-stages the id', () => {
    const { planner } = setup({ editingPlace: EDITED })
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(planner.setDeletePlaceId).toHaveBeenLastCalledWith(null)
    expect(planner.setShowPlaceForm).toHaveBeenCalledWith(false)
  })

  it('FE-MOB-PLEDIT-023: the header close leaves the staged id alone when nothing was armed', () => {
    const { planner } = setup({ editingPlace: EDITED })
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(planner.setShowPlaceForm).toHaveBeenCalledWith(false)
    expect(planner.setDeletePlaceId).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLEDIT-024: blocks the save while the end time is not after the start', () => {
    const assignment = { id: 7, day_id: 2, place_id: 42, order_index: 0, place: EDITED } as unknown as Assignment
    setup({ editingPlace: EDITED, editingAssignmentId: 7, assignments: { '2': [assignment] } })
    const [start, end] = screen.getAllByDisplayValue(/^0[89]:[0-3]0$/) as HTMLInputElement[]
    expect(submit()).not.toBeDisabled()
    fireEvent.change(end, { target: { value: '07:00' } })
    expect(start).toHaveValue('08:00')
    expect(screen.getByText('places.endTimeBeforeStart')).toBeInTheDocument()
    expect(submit()).toBeDisabled()
  })

  it('FE-MOB-PLEDIT-025: attaches pasted images and sends them with the save', async () => {
    const { planner } = setup()
    const file = new File(['x'], 'ticket.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText('places.formAddressPlaceholder'), {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }, { type: 'image/png', getAsFile: () => file }] },
    })
    expect(await screen.findByText('ticket.png')).toBeInTheDocument()

    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.click(submit())
    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledTimes(1))
    expect(planner.handleSavePlace).toHaveBeenCalledWith(expect.objectContaining({ _pendingFiles: [file] }))
  })

  it('FE-MOB-PLEDIT-025b: attaches files chosen through the picker', async () => {
    const { planner } = setup()
    const file = new File(['x'], 'map.pdf', { type: 'application/pdf' })
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(picker, { target: { files: [file] } })
    expect(await screen.findByText('map.pdf')).toBeInTheDocument()

    fireEvent.change(nameField(), { target: { value: 'Nakamise' } })
    fireEvent.click(submit())
    await waitFor(() => expect(planner.handleSavePlace).toHaveBeenCalledWith(expect.objectContaining({ _pendingFiles: [file] })))
  })

  it('FE-MOB-PLEDIT-026: a clipboard item without a file is ignored', () => {
    setup()
    fireEvent.paste(screen.getByPlaceholderText('places.formAddressPlaceholder'), {
      clipboardData: { items: [{ type: 'application/pdf', getAsFile: () => null }] },
    })
    expect(screen.queryByRole('button', { name: 'common.delete' })).not.toBeInTheDocument()
  })

  it('FE-MOB-PLEDIT-027: drops a pending attachment again', async () => {
    setup()
    const file = new File(['x'], 'voucher.pdf', { type: 'application/pdf' })
    fireEvent.paste(screen.getByPlaceholderText('places.formAddressPlaceholder'), {
      clipboardData: { items: [{ type: 'application/pdf', getAsFile: () => file }] },
    })
    expect(await screen.findByText('voucher.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }))
    expect(screen.queryByText('voucher.pdf')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLEDIT-028: hides the file row and ignores pastes without the upload permission', () => {
    setup({ canUploadFiles: false })
    expect(screen.queryByText('files.title')).not.toBeInTheDocument()
    const file = new File(['x'], 'ticket.png', { type: 'image/png' })
    fireEvent.paste(screen.getByPlaceholderText('places.formAddressPlaceholder'), {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
    })
    expect(screen.queryByText('ticket.png')).not.toBeInTheDocument()
  })

  /**
   * Types into the search row and returns the bias the autocomplete request
   * carried. The hint comes from useLocationBias, which reads the trip store,
   * not the planner prop, so both are seeded the way the running app has them.
   */
  async function capturedBias(places: Place[], day?: { id: number; placeIds: number[] }) {
    const bodies: Record<string, unknown>[] = []
    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      bodies.push(await request.json() as Record<string, unknown>)
      return HttpResponse.json({ source: 'osm', suggestions: [] })
    }))
    seedStore(useTripStore, {
      places,
      assignments: day ? { [String(day.id)]: day.placeIds.map(id => ({ place_id: id })) } : {},
      selectedDayId: day?.id ?? null,
    })
    setup({ places })
    fireEvent.change(screen.getByPlaceholderText('places.mapsSearchPlaceholder'), { target: { value: 'ueno' } })
    await waitFor(() => expect(bodies).toHaveLength(1))
    return bodies[0].locationBias
  }

  it('FE-MOB-PLEDIT-029: biases the maps search on the trip box while the trip fits one region', async () => {
    const places = [
      { id: 1, name: 'A', lat: 35.6, lng: 139.7 },
      { id: 2, name: 'B', lat: 35.8, lng: 139.9 },
      { id: 3, name: 'C', lat: null, lng: null },
    ] as unknown as Place[]
    // 25km across and no day open, so the trip is the best hint there is.
    expect(await capturedBias(places)).toEqual({ low: { lat: 35.6, lng: 139.7 }, high: { lat: 35.8, lng: 139.9 } })
  })

  it('FE-MOB-PLEDIT-029b: narrows the bias to the open day when the trip is too wide for one', async () => {
    const places = [
      { id: 1, name: 'Ueno', lat: 35.71, lng: 139.77 },
      { id: 2, name: 'Asakusa', lat: 35.71, lng: 139.8 },
      { id: 3, name: 'Nagoya', lat: 35.18, lng: 136.91 },
    ] as unknown as Place[]
    // The trip reaches Nagoya and is dropped, but the day being planned still
    // gets a hint. That is what preferring the day buys.
    expect(await capturedBias(places, { id: 7, placeIds: [1, 2] })).toEqual({
      low: { lat: 35.71, lng: 139.77 }, high: { lat: 35.71, lng: 139.8 },
    })
  })

  it('FE-MOB-PLEDIT-030: drops the bias for a trip that outgrows one region', async () => {
    // Tokyo to Nagoya, 264km across: inside the old 500km diagonal rule, outside
    // the 60km radius one. A box that wide has its centre in open country.
    const places = [
      { id: 1, name: 'Tokyo', lat: 35.68, lng: 139.76 },
      { id: 2, name: 'Nagoya', lat: 35.18, lng: 136.91 },
    ] as unknown as Place[]
    expect(await capturedBias(places)).toBeUndefined()
  })

  it('FE-MOB-PLEDIT-031: sends no bias when no place has usable coordinates', async () => {
    const places = [{ id: 1, name: 'Broken', lat: 'north', lng: 'east' }] as unknown as Place[]
    expect(await capturedBias(places)).toBeUndefined()
  })

  it('FE-MOB-PLEDIT-032: sends no bias for a trip without any located place', async () => {
    expect(await capturedBias([])).toBeUndefined()
  })

  // ── Linked expense (#1298) — the same block the booking sheet has ──────────

  describe('Costs', () => {
    const withBudget = () => useAddonStore.setState({
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }] as never,
      loaded: true,
    })

    it('FE-MOB-PLEDIT-033: the button only appears while the Budget addon is on', () => {
      const { unmount } = setup()
      expect(screen.queryByRole('button', { name: 'reservations.createExpense' })).not.toBeInTheDocument()
      unmount()

      withBudget()
      setup()
      expect(screen.getByRole('button', { name: 'reservations.createExpense' })).toBeInTheDocument()
    })

    it('FE-MOB-PLEDIT-034: creating an expense saves the place first, then opens the editor', async () => {
      withBudget()
      const handleSavePlace = vi.fn(async () => ({ id: 42 }))
      const { onOpenExpense } = setup({ handleSavePlace })

      fireEvent.change(nameField(), { target: { value: 'Louvre' } })
      fireEvent.click(screen.getByRole('button', { name: 'reservations.createExpense' }))

      await waitFor(() => expect(onOpenExpense).toHaveBeenCalled())
      expect(handleSavePlace.mock.invocationCallOrder[0]).toBeLessThan(onOpenExpense.mock.invocationCallOrder[0])
      expect(onOpenExpense).toHaveBeenCalledWith({
        prefill: { placeId: 42, name: 'Louvre', category: 'activities' },
      })
    })

    it('FE-MOB-PLEDIT-035: a save that yields no id opens no editor', async () => {
      withBudget()
      const handleSavePlace = vi.fn(async () => undefined)
      const { onOpenExpense } = setup({ handleSavePlace })

      fireEvent.change(nameField(), { target: { value: 'Louvre' } })
      fireEvent.click(screen.getByRole('button', { name: 'reservations.createExpense' }))

      await waitFor(() => expect(handleSavePlace).toHaveBeenCalled())
      expect(onOpenExpense).not.toHaveBeenCalled()
    })
  })
})
