import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../helpers/render'
import {
  ConnRow, HotelConnRow, NoteRow, PlaceRow, PlanScheduleRow, ReorderStack, TransitRow, TransportRow,
} from '../../../../src/mobile/screens/trip/plan/MPlanTimelineRows'
import type { TransitMeta, TransportEntry } from '../../../../src/mobile/screens/trip/plan/planTimelineModel'
import type { PluginDayScheduleItem } from '../../../../src/api/client'
import type { Assignment, DayNote, Place, Reservation, RouteSegment, TranslationFn } from '../../../../src/types'

// FE-MOB-PLROW-001 to FE-MOB-PLROW-041

// Same echo strategy as tests/helpers/mobileTrip: assertions stay on keys, not copy.
const t: TranslationFn = (key, params) =>
  params ? `${key}:${Object.values(params).join(',')}` : key

const chrome = (editing = false) => ({ editing, t, language: 'en', timeFormat: '24h' })

const REORDER = <span data-testid="reorder">reorder</span>

function assignment(over: Record<string, unknown> = {}): Assignment {
  return {
    id: 11,
    day_id: 2,
    place_id: 101,
    order_index: 0,
    place: {
      id: 101,
      name: 'Museum',
      place_time: '09:30',
      address: 'Museum Rd 1',
      lat: 35.71,
      lng: 139.79,
      category: { icon: 'Landmark', color: '#a855f7' },
    },
    ...over,
  } as unknown as Assignment
}

const SEG: RouteSegment = {
  mid: [35.7, 139.7], from: [35.71, 139.79], to: [35.65, 139.7],
  distance: 5400, duration: 900,
  walkingText: '1 h 5 min', drivingText: '14 min', distanceText: '5.4 km',
}

describe('ReorderStack', () => {
  it('FE-MOB-PLROW-001: renders both arrows with their labels and fires them', () => {
    const onUp = vi.fn()
    const onDown = vi.fn()
    render(<ReorderStack onUp={onUp} onDown={onDown} canUp canDown t={t} />)

    fireEvent.click(screen.getByLabelText('dayplan.moveUp'))
    fireEvent.click(screen.getByLabelText('dayplan.moveDown'))

    expect(onUp).toHaveBeenCalledTimes(1)
    expect(onDown).toHaveBeenCalledTimes(1)
  })

  it('FE-MOB-PLROW-002: disables the arrow that would fall off the list', () => {
    render(<ReorderStack onUp={vi.fn()} onDown={vi.fn()} canUp={false} canDown={false} t={t} />)

    expect(screen.getByLabelText('dayplan.moveUp')).toBeDisabled()
    expect(screen.getByLabelText('dayplan.moveDown')).toBeDisabled()
  })

  it('FE-MOB-PLROW-003: stops the click from opening the row it sits in', () => {
    const rowClick = vi.fn()
    const onUp = vi.fn()
    render(
      <div onClick={rowClick}>
        <ReorderStack onUp={onUp} onDown={vi.fn()} canUp canDown t={t} />
      </div>,
    )

    fireEvent.click(screen.getByLabelText('dayplan.moveUp'))

    expect(onUp).toHaveBeenCalled()
    expect(rowClick).not.toHaveBeenCalled()
  })
})

describe('PlaceRow', () => {
  const props = {
    assignment: assignment(),
    fullPlace: undefined,
    linkedReservations: [],
    chrome: chrome(),
    reorder: REORDER,
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
  }

  it('FE-MOB-PLROW-004: shows name, formatted time and the address subtitle', () => {
    render(<PlaceRow {...props} onOpen={vi.fn()} />)

    expect(screen.getByText('Museum')).toBeInTheDocument()
    expect(screen.getByText('09:30')).toBeInTheDocument()
    expect(screen.getByText('Museum Rd 1')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-005: falls back to the description when there is no address', () => {
    const a = assignment({
      place: { id: 101, name: 'Museum', address: null, description: 'Ukiyo-e wing' },
    })
    render(<PlaceRow {...props} assignment={a} />)

    expect(screen.getByText('Ukiyo-e wing')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-006: drops the meta line entirely when there is neither time nor subtitle', () => {
    const a = assignment({ place: { id: 101, name: 'Museum' } })
    const { container } = render(<PlaceRow {...props} assignment={a} />)

    expect(container.textContent).toBe('Museum')
  })

  it('FE-MOB-PLROW-007: a linked booking replaces the subtitle and adds the booking badge', () => {
    const linkedRes = { id: 31, status: 'confirmed', confirmation_number: 'X9K' } as unknown as Reservation
    render(<PlaceRow {...props} linkedReservations={[linkedRes]} />)

    expect(screen.getByText('dayplan.confirmed · #X9K')).toBeInTheDocument()
    expect(screen.getByText('mobileTrip.resBadge')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-008: a pending booking without a number shows just the status', () => {
    const linkedRes = { id: 31, status: 'pending', confirmation_number: null } as unknown as Reservation
    render(<PlaceRow {...props} linkedReservations={[linkedRes]} />)

    expect(screen.getByText('dayplan.pendingRes')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-009: renders the pool photo of the place in go mode', () => {
    const fullPlace = {
      id: 101, name: 'Museum', image_url: '/uploads/places/museum.jpg',
      google_place_id: null, osm_id: null, lat: 35.71, lng: 139.79,
    } as unknown as Place
    render(<PlaceRow {...props} fullPlace={fullPlace} />)

    expect(screen.getByAltText('Museum')).toHaveAttribute('src', '/uploads/places/museum.jpg')
  })

  it('FE-MOB-PLROW-010: falls back to the assignment projection when the pool entry is missing', () => {
    const a = assignment({
      place: { id: 101, name: 'Museum', image_url: '/uploads/places/thumb.jpg', category: null },
    })
    render(<PlaceRow {...props} assignment={a} fullPlace={undefined} />)

    expect(screen.getByAltText('Museum')).toHaveAttribute('src', '/uploads/places/thumb.jpg')
  })

  it('FE-MOB-PLROW-011: tapping the row opens the place', () => {
    const onOpen = vi.fn()
    render(<PlaceRow {...props} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('Museum'))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('FE-MOB-PLROW-012: edit mode swaps the avatar for edit/remove circles plus the reorder slot', () => {
    const onEdit = vi.fn()
    const onRemove = vi.fn()
    const onOpen = vi.fn()
    render(
      <PlaceRow {...props} chrome={chrome(true)} onEdit={onEdit} onRemove={onRemove} onOpen={onOpen} />,
    )

    expect(screen.getByTestId('reorder')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('common.edit'))
    fireEvent.click(screen.getByLabelText('planner.removeFromDay'))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
    // the circles stop propagation so the row does not also open
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('TransportRow', () => {
  const FLIGHT = {
    id: 21, type: 'flight', title: 'LH 714 to Tokyo', day_id: 2,
    reservation_time: '2026-05-02T08:15', reservation_end_time: '2026-05-02T18:40',
    metadata: { airline: 'Lufthansa', flight_number: 'LH714', departure_airport: 'MUC', arrival_airport: 'HND' },
  } as unknown as TransportEntry

  const base = { dayId: 2, chrome: chrome(), reorder: REORDER, onOpen: vi.fn() }

  it('FE-MOB-PLROW-013: shows a single-day booking as a start–end range with the flight subtitle', () => {
    const { container } = render(<TransportRow {...base} res={FLIGHT} />)

    expect(screen.getByText('LH 714 to Tokyo')).toBeInTheDocument()
    expect(container.textContent).toContain('08:15 – 18:40')
    expect(screen.getByText('Lufthansa · LH714 · MUC → HND')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-014: a multi-day span shows only the day-relevant time', () => {
    const car = {
      id: 22, type: 'car', title: 'Rental car', day_id: 1, end_day_id: 3,
      reservation_time: '2026-05-01T09:00', reservation_end_time: '2026-05-03T17:00',
      location: 'Hertz Shinjuku',
    } as unknown as TransportEntry

    const { container, unmount } = render(<TransportRow {...base} dayId={1} res={car} />)
    expect(container.textContent).toContain('09:00')
    expect(container.textContent).not.toContain('–')
    expect(screen.getByText('Hertz Shinjuku')).toBeInTheDocument()
    unmount()

    const dropOff = render(<TransportRow {...base} dayId={3} res={car} />)
    expect(dropOff.container.textContent).toContain('17:00')
  })

  it('FE-MOB-PLROW-015: a per-leg row is subtitled with its own from → to', () => {
    const leg = { ...FLIGHT, __leg: { index: 1, total: 2, from: 'FRA', to: 'HND' } } as TransportEntry
    render(<TransportRow {...base} res={leg} />)

    expect(screen.getByText('FRA → HND')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-016: a per-leg row without endpoints has no subtitle', () => {
    const leg = { ...FLIGHT, __leg: { index: 0, total: 2, from: null, to: null } } as TransportEntry
    const { container } = render(<TransportRow {...base} res={leg} />)

    expect(container.textContent).not.toContain('Lufthansa')
  })

  it('FE-MOB-PLROW-017: a train subtitle carries number, platform and seat', () => {
    const train = {
      id: 23, type: 'train', title: 'ICE to Hamburg', day_id: 2,
      metadata: JSON.stringify({ train_number: 'ICE 599', platform: '7', seat: '21A' }),
    } as unknown as TransportEntry
    render(<TransportRow {...base} res={train} />)

    expect(screen.getByText('ICE 599 · Gl. 7 · Sitz 21A')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-018: an untimed booking of an unknown type still renders its title', () => {
    const other = { id: 24, type: 'yoga_retreat', title: 'Sunrise yoga', day_id: 2 } as unknown as TransportEntry
    const { container } = render(<TransportRow {...base} res={other} />)

    expect(screen.getByText('Sunrise yoga')).toBeInTheDocument()
    expect(container.textContent).toBe('Sunrise yoga')
  })

  it('FE-MOB-PLROW-019: tapping the row opens it', () => {
    const onOpen = vi.fn()
    render(<TransportRow {...base} res={FLIGHT} onOpen={onOpen} />)

    fireEvent.click(screen.getByText('LH 714 to Tokyo'))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('FE-MOB-PLROW-020: edit mode shows the reorder slot instead of the avatar', () => {
    render(<TransportRow {...base} res={FLIGHT} chrome={chrome(true)} />)

    expect(screen.getByTestId('reorder')).toBeInTheDocument()
  })
})

describe('TransitRow', () => {
  const TRANSIT_RES = {
    id: 25, type: 'transit', title: 'Shibuya → Asakusa', day_id: 2,
    reservation_time: '2026-05-02T10:05', reservation_end_time: '2026-05-02T10:47',
  } as unknown as TransportEntry

  const TRANSIT: TransitMeta = {
    transfers: 1,
    duration: 2520,
    legs: [
      { mode: 'WALK', duration: 240, to: { name: 'Shibuya Sta.' } },
      {
        mode: 'SUBWAY', line: 'G', line_color: '#FF9500', line_text_color: '#ffffff',
        duration: 1500, stops: 9,
        from: { name: 'Shibuya Sta.', time: '10:05', track: '3' },
        to: { name: 'Asakusa Sta.', time: '10:30' },
      },
      { mode: 'WALK', duration: 30, to: { name: 'Hotel' } },
    ],
  }

  const base = {
    res: TRANSIT_RES, transit: TRANSIT, dayId: 2, chrome: chrome(), reorder: REORDER,
    onToggle: vi.fn(), onOpenJourney: vi.fn(),
  }

  it('FE-MOB-PLROW-021: collapsed row shows the from → to headline and the time range', () => {
    const { container } = render(<TransitRow {...base} open={false} />)

    expect(screen.getByText('Shibuya → Asakusa')).toBeInTheDocument()
    expect(container.textContent).toContain('10:05 – 10:47')
  })

  it('FE-MOB-PLROW-022: the strip drops sub-minute walks and keeps the line badge', () => {
    render(<TransitRow {...base} open={false} />)

    // one badge only — the collapsed strip; the 30s walk is filtered out
    expect(screen.getAllByText('G')).toHaveLength(1)
    expect(screen.queryByText('transit.min:1 · transit.walkTo:Hotel')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLROW-041: a walk without a duration stays in the strip, like in the expanded list', () => {
    const transit: TransitMeta = {
      legs: [
        { mode: 'WALK', to: { name: 'Shibuya Sta.' } },
        { mode: 'SUBWAY', line: 'G', duration: 1500, from: { name: 'Shibuya Sta.' }, to: { name: 'Asakusa Sta.' } },
      ],
    }
    const { container } = render(<TransitRow {...base} transit={transit} open={false} />)

    // the strip renders both legs: the footprint chip plus the line badge
    const strip = container.querySelector('.flex-wrap') as HTMLElement
    expect(strip.children).toHaveLength(2)
    expect(screen.getByText('G')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-023: expanding renders every leg with duration, stops and platform', () => {
    render(<TransitRow {...base} open />)

    expect(screen.getAllByText('G')).toHaveLength(2)
    expect(screen.getByText('transit.min:4 · transit.walkTo:Shibuya Sta.')).toBeInTheDocument()
    expect(screen.getByText('Shibuya Sta. → Asakusa Sta.')).toBeInTheDocument()
    expect(screen.getByText('transit.min:25 · transit.stops:9 · transit.platform:3')).toBeInTheDocument()
    expect(screen.getByText('transit.min:1 · transit.walkTo:Hotel')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-024: tapping the header toggles the row', () => {
    const onToggle = vi.fn()
    render(<TransitRow {...base} open={false} onToggle={onToggle} />)

    fireEvent.click(screen.getByText('Shibuya → Asakusa'))

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('FE-MOB-PLROW-025: an untimed single-leg journey falls back to the raw title and the mode badge', () => {
    const res = { id: 26, type: 'transit', title: 'Airport shuttle', day_id: 2 } as unknown as TransportEntry
    const transit: TransitMeta = { legs: [{ mode: 'BUS', line: null, duration: 0, from: {}, to: {} }] }
    const { container } = render(<TransitRow {...base} res={res} transit={transit} open />)

    expect(screen.getByText('Airport shuttle')).toBeInTheDocument()
    expect(screen.getAllByText('BUS')).toHaveLength(2)
    expect(container.textContent).not.toContain('10:05')
  })

  it('FE-MOB-PLROW-038: survives uncoloured lines, missing durations and unnamed stops', () => {
    const res = {
      id: 27, type: 'transit', title: 'Depot → Bridge', day_id: 2, reservation_time: '2026-05-02T06:00',
    } as unknown as TransportEntry
    const transit: TransitMeta = {
      legs: [
        { mode: 'TRAM', line: '17', from: { name: 'Depot' }, to: { name: 'Bridge' } },
        { mode: 'WALK', duration: 600 },
      ],
    }
    const { container } = render(<TransitRow {...base} res={res} transit={transit} open />)

    expect(container.textContent).toContain('06:00')
    // no end time — the chip stays a single value
    expect(container.textContent).not.toContain('–')
    // once as the row headline, once as the expanded leg
    expect(screen.getAllByText('Depot → Bridge')).toHaveLength(2)
    expect(screen.getByText('transit.min:10 · transit.walkTo:')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-026: edit mode opens the journey view and keeps the reorder slot', () => {
    const onOpenJourney = vi.fn()
    render(<TransitRow {...base} open={false} chrome={chrome(true)} onOpenJourney={onOpenJourney} />)

    expect(screen.getByTestId('reorder')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('common.edit'))

    expect(onOpenJourney).toHaveBeenCalledTimes(1)
  })
})

describe('ConnRow', () => {
  it('FE-MOB-PLROW-027: defaults to the driving duration and the distance', () => {
    const { container } = render(<ConnRow seg={SEG} />)

    expect(screen.getByText('14 min')).toBeInTheDocument()
    expect(screen.getByText('· 5.4 km')).toBeInTheDocument()
    expect(container.querySelector('button')).toBeNull()
  })

  it('FE-MOB-PLROW-028: a walking leg shows the walking duration', () => {
    render(<ConnRow seg={{ ...SEG, mode: 'walking' }} />)

    expect(screen.getByText('1 h 5 min')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-029: a plugin leg uses its own duration text and note', () => {
    render(<ConnRow seg={{ ...SEG, mode: 'plugin:ev/fastest', durationText: '22 min', noteText: '25 min charge' }} />)

    expect(screen.getByText('22 min')).toBeInTheDocument()
    expect(screen.getByText('25 min charge')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-030: becomes a button when the leg mode can be changed', () => {
    const onTap = vi.fn()
    render(<ConnRow seg={SEG} onTap={onTap} />)

    fireEvent.click(screen.getByRole('button'))

    expect(onTap).toHaveBeenCalledTimes(1)
  })
})

describe('PlanScheduleRow', () => {
  const item = (over: Partial<PluginDayScheduleItem> = {}): PluginDayScheduleItem => ({
    pluginId: 'ev', id: 'charge-1', dayId: 2, minutes: 95, label: 'Charging stop', tone: 'success',
    ...over,
  })

  it('FE-MOB-PLROW-031: renders the label with formatted minutes and the tone colour', () => {
    const { container } = render(<PlanScheduleRow item={item()} />)

    expect(screen.getByText('Charging stop')).toBeInTheDocument()
    expect(container.textContent).toContain('1 h 35 min')
    expect(container.querySelector('svg')).toHaveStyle({ color: '#10b981' })
  })

  it('FE-MOB-PLROW-032: an unknown tone falls back to the default colour and minutes stay optional', () => {
    const { container } = render(
      <PlanScheduleRow item={item({ minutes: undefined, tone: 'chartreuse' as unknown as PluginDayScheduleItem['tone'] })} />,
    )

    expect(container.textContent).toBe('Charging stop')
    expect(container.querySelector('svg')).toHaveStyle({ color: '#4F46E5' })
  })
})

describe('HotelConnRow', () => {
  it('FE-MOB-PLROW-033: puts the hotel above the leg at the top of the day and below it at the bottom', () => {
    const { container, unmount } = render(<HotelConnRow seg={SEG} name="Hotel Sacher" placement="top" />)
    const top = container.firstElementChild as HTMLElement

    expect(top.children[0].textContent).toBe('Hotel Sacher')
    expect(top.children[1].textContent).toContain('14 min')
    expect(top.children[1].textContent).toContain('· 5.4 km')
    unmount()

    const bottom = render(<HotelConnRow seg={SEG} name="Hotel Sacher" placement="bottom" />)
      .container.firstElementChild as HTMLElement

    expect(bottom.children[0].textContent).toContain('14 min')
    expect(bottom.children[1].textContent).toBe('Hotel Sacher')
  })

  it('FE-MOB-PLROW-039: a bookend leg reads its travel mode like every other connector', () => {
    const seg = { ...SEG, mode: 'plugin:ev/fastest', durationText: '22 min', noteText: '25 min charge' }
    render(<HotelConnRow seg={seg} name="Hotel Sacher" placement="top" />)

    expect(screen.getByText('22 min')).toBeInTheDocument()
    expect(screen.getByText('25 min charge')).toBeInTheDocument()
    expect(screen.queryByText('1 h 5 min')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLROW-040: a walking bookend leg shows the walking duration', () => {
    render(<HotelConnRow seg={{ ...SEG, mode: 'walking' }} name="Hotel Sacher" placement="bottom" />)

    expect(screen.getByText('1 h 5 min')).toBeInTheDocument()
    expect(screen.queryByText('14 min')).not.toBeInTheDocument()
  })
})

describe('NoteRow', () => {
  const note = (over: Record<string, unknown> = {}): DayNote => ({
    id: 41, day_id: 2, text: 'Buy museum tickets\nCash only', time: '09:30 at the kiosk',
    icon: 'Ticket', sort_order: 0,
    ...over,
  } as unknown as DayNote)

  const base = { chrome: chrome(), reorder: REORDER, onEdit: vi.fn() }

  it('FE-MOB-PLROW-034: splits the leading time off and keeps the rest of the note below it', () => {
    render(<NoteRow {...base} note={note()} />)

    expect(screen.getByText('09:30')).toBeInTheDocument()
    expect(screen.getByText('Buy museum tickets')).toBeInTheDocument()
    // Two separate blocks since #1629: the extra title lines are plain text, the
    // detail is rendered Markdown, so they cannot be joined into one string.
    expect(screen.getByText('Cash only')).toBeInTheDocument()
    expect(screen.getByText('at the kiosk')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-039: renders the detail as Markdown and tints the row with the note colour (#1629)', () => {
    render(<NoteRow {...base} note={note({ text: 'Ferry', time: 'book **early**', color: '#dc2626' } as never)} />)

    expect(screen.getByText('early').tagName).toBe('STRONG')
    const card = screen.getByText('Ferry').closest('div[style]') as HTMLElement
    expect(card.style.background).toContain('220, 38, 38')
  })

  it('FE-MOB-PLROW-035: a free-text time stays in the subtitle and shows no time chip', () => {
    render(<NoteRow {...base} note={note({ text: 'Pack the day bag', time: 'before leaving' })} />)

    expect(screen.getByText('before leaving')).toBeInTheDocument()
    expect(screen.queryByText('09:30')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLROW-036: a bare one-line note renders title only', () => {
    const { container } = render(<NoteRow {...base} note={note({ text: 'Pack the day bag', time: null })} />)

    expect(container.textContent).toBe('Pack the day bag')
  })

  it('FE-MOB-PLROW-037: is inert in go mode and editable in edit mode', () => {
    const onEdit = vi.fn()
    const { unmount } = render(<NoteRow {...base} note={note()} onEdit={onEdit} />)
    fireEvent.click(screen.getByText('Buy museum tickets'))
    expect(onEdit).not.toHaveBeenCalled()
    unmount()

    render(<NoteRow {...base} note={note()} chrome={chrome(true)} onEdit={onEdit} />)
    fireEvent.click(screen.getByText('Buy museum tickets'))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('reorder')).toBeInTheDocument()
  })

  it('FE-MOB-PLROW-041: a link in the note body opens the link instead of the sheet', () => {
    const onEdit = vi.fn()
    render(<NoteRow {...base} note={note({ time: 'See [the map](https://example.com)' })} chrome={chrome(true)} onEdit={onEdit} />)

    fireEvent.click(screen.getByRole('link', { name: 'the map' }))
    expect(onEdit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Buy museum tickets'))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
