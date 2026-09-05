/**
 * FE-PDC-001..015 — the detail column beside the add-place search field.
 *
 * mapsApi.placeEnrichment is mocked; these cover the load states, the caches,
 * the abort on selection change, image picking and the attribution rendering
 * that the Commons licences require.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { MapsPlaceEnrichmentResult } from '@trek/shared'
import PlaceDetailsColumn, { __clearEnrichmentCacheForTests, type PlaceDetailsSelection } from './PlaceDetailsColumn'

const placeEnrichment = vi.fn()
vi.mock('../../api/client', () => ({ mapsApi: { placeEnrichment: (...a: unknown[]) => placeEnrichment(...a) } }))

/** Echo the key back, which keeps the assertions readable. */
const t = ((key: string) => key) as never

const SELECTION: PlaceDetailsSelection = { placeId: 'way:1', lat: 50.9, lng: 6.96, name: 'Museum Ludwig' }

const COMMONS_PHOTO = {
  key: 'way:1~p0',
  url: '/api/maps/place-photo/way%3A1~p0/bytes',
  attribution: 'Alice',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
  source: 'wikimedia' as const,
}

const GOOGLE_PHOTO = {
  key: 'way:1~p1',
  url: '/api/maps/place-photo/way%3A1~p1/bytes',
  attribution: null,
  license: null,
  licenseUrl: null,
  sourceUrl: null,
  source: 'google' as const,
}

const RESULT: MapsPlaceEnrichmentResult = {
  photos: [COMMONS_PHOTO],
  facts: [],
  description: {
    text: 'Ein Museum in Köln.',
    source: 'wikipedia',
    sourceUrl: 'https://de.wikipedia.org/wiki/Museum_Ludwig',
    license: 'CC BY-SA 4.0',
  },
}

function renderColumn(props: Partial<React.ComponentProps<typeof PlaceDetailsColumn>> = {}) {
  const onPickImage = vi.fn()
  const onAdoptDescription = vi.fn()
  const utils = render(
    <PlaceDetailsColumn
      selection={SELECTION}
      onPickImage={onPickImage}
      onAdoptDescription={onAdoptDescription}
      hasDescription={false}
      language="de"
      t={t}
      {...props}
    />,
  )
  return { ...utils, onPickImage, onAdoptDescription }
}

beforeEach(() => {
  placeEnrichment.mockReset()
  placeEnrichment.mockResolvedValue(RESULT)
  sessionStorage.clear()
  __clearEnrichmentCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaceDetailsColumn', () => {
  it('FE-PDC-001: shows the empty state and calls nothing while nothing is selected', () => {
    renderColumn({ selection: null })

    expect(screen.getByText('places.details.empty')).toBeInTheDocument()
    expect(placeEnrichment).not.toHaveBeenCalled()
  })

  it('FE-PDC-002: shows a loading state, then the result', async () => {
    let settle: (v: MapsPlaceEnrichmentResult) => void = () => {}
    placeEnrichment.mockReturnValue(new Promise<MapsPlaceEnrichmentResult>((r) => { settle = r }))

    renderColumn()
    expect(screen.getByText('places.details.loading')).toBeInTheDocument()

    settle(RESULT)
    await waitFor(() => expect(screen.getByText('Ein Museum in Köln.')).toBeInTheDocument())
  })

  it('FE-PDC-003: sends the selection and the language to the endpoint', async () => {
    renderColumn()

    await waitFor(() => expect(placeEnrichment).toHaveBeenCalled())
    expect(placeEnrichment.mock.calls[0][0]).toEqual({
      placeId: 'way:1',
      lat: 50.9,
      lng: 6.96,
      name: 'Museum Ludwig',
      lang: 'de',
    })
  })

  it('FE-PDC-004: renders author and licence under every Commons picture', async () => {
    renderColumn()

    const credit = await screen.findByText('Alice')
    // Links to the file description page, where the full terms are.
    expect(credit.closest('a')).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:X.jpg')
    const licence = screen.getByText('CC BY-SA 4.0', { selector: 'a' })
    expect(licence).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/')
  })

  it('FE-PDC-005: names the source when a picture has no author, instead of inventing one', async () => {
    placeEnrichment.mockResolvedValue({ photos: [GOOGLE_PHOTO], description: null, facts: [] })
    renderColumn()

    expect(await screen.findByText('Google')).toBeInTheDocument()
  })

  it('FE-PDC-006: picking a picture reports its proxy URL', async () => {
    const { onPickImage } = renderColumn()

    fireEvent.click(await screen.findByRole('button', { name: /places.details.pickImage/ }))

    expect(onPickImage).toHaveBeenCalledWith('/api/maps/place-photo/way%3A1~p0/bytes')
  })

  it('FE-PDC-007: clicking the picked picture again clears the hero image', async () => {
    const { onPickImage } = renderColumn({ selectedImageUrl: COMMONS_PHOTO.url })

    const tile = await screen.findByRole('button', { name: /places.details.pickImage/ })
    expect(tile).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(tile)

    expect(onPickImage).toHaveBeenCalledWith(null)
  })

  it('FE-PDC-008: adopting the description hands the text up', async () => {
    const { onAdoptDescription } = renderColumn()

    fireEvent.click(await screen.findByRole('button', { name: 'places.details.adopt' }))

    expect(onAdoptDescription).toHaveBeenCalledWith('Ein Museum in Köln.')
  })

  it('FE-PDC-009: will not overwrite a description the user already wrote', async () => {
    renderColumn({ hasDescription: true })

    expect(await screen.findByRole('button', { name: 'places.details.adopt' })).toBeDisabled()
  })

  it('FE-PDC-010: shows where the description came from', async () => {
    renderColumn()

    const link = await screen.findByRole('link', { name: /Wikipedia/ })
    expect(link).toHaveAttribute('href', 'https://de.wikipedia.org/wiki/Museum_Ludwig')
    // The photo credit carries the same licence string, so scope to the source
    // line that sits directly under the description.
    expect(link.parentElement).toHaveTextContent('CC BY-SA 4.0')
  })

  it('FE-PDC-010b: credits a website description by host', async () => {
    // The source labels used to be a ternary chain ending in 'Wikipedia', so a
    // restaurant's own marketing copy would have been credited to an
    // encyclopaedia. There is no fixed name for "the place's own website", and
    // the host is the honest one.
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: {
        text: 'Pizza in Rostock, seit 2015.',
        source: 'website',
        sourceUrl: 'https://www.losteria.net/rostock',
        license: null,
      },
    })
    renderColumn()

    const link = await screen.findByRole('link', { name: /losteria\.net/ })
    expect(link).toHaveAttribute('href', 'https://www.losteria.net/rostock')
    expect(screen.queryByText(/Wikipedia/)).not.toBeInTheDocument()
  })

  it('FE-PDC-011: says so when the admin switched enrichment off', async () => {
    placeEnrichment.mockResolvedValue({ photos: [], description: null, facts: [], disabled: true })
    renderColumn()

    expect(await screen.findByText('places.details.disabled')).toBeInTheDocument()
  })

  it('FE-PDC-012: says so when a place yields nothing at all', async () => {
    placeEnrichment.mockResolvedValue({ photos: [], description: null, facts: [] })
    renderColumn()

    expect(await screen.findByText('places.details.nothing')).toBeInTheDocument()
  })

  it('FE-PDC-016: shows the OpenStreetMap facts, which is all a restaurant gets', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      description: null,
      facts: [
        { kind: 'cuisine', value: 'regional', url: null },
        // A payload written before hours became a field of their own. The chip
        // list drops it rather than showing a truncated week beside the block.
        { kind: 'openingHours', value: 'Mo-Sa 17:30+', url: null },
        { kind: 'menu', value: null, url: 'https://example.org/menu' },
        { kind: 'outdoorSeating', value: null, url: null },
      ],
    })
    renderColumn()

    // A value is shown verbatim; a plain yes falls back to the translated label.
    expect(await screen.findByText('regional')).toBeInTheDocument()
    expect(screen.queryByText('Mo-Sa 17:30+')).not.toBeInTheDocument()
    expect(screen.getByText('places.details.fact.outdoorSeating')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /places.details.fact.menu/ })).toHaveAttribute(
      'href',
      'https://example.org/menu',
    )
  })

  it('FE-PDC-038: a fact url that is not http(s) stays a chip, never a link', async () => {
    // fact.url comes straight from an OSM tag anyone can edit, so a
    // javascript: value must not end up in an href.
    placeEnrichment.mockResolvedValue({
      photos: [],
      description: null,
      facts: [{ kind: 'menu', value: 'Menu', url: 'javascript:alert(1)' }],
    })
    renderColumn()

    expect(await screen.findByText('Menu')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Menu/ })).not.toBeInTheDocument()
  })

  it('FE-PDC-017: renders facts even when there is neither a picture nor a description', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      description: null,
      facts: [{ kind: 'cuisine', value: 'pizza', url: null }],
    })
    renderColumn()

    expect(await screen.findByText('pizza')).toBeInTheDocument()
    expect(screen.queryByText('places.details.nothing')).not.toBeInTheDocument()
  })

  it('FE-PDC-018: names Wikivoyage as the source when the text came from there', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: {
        text: 'Berlin ist das politische Zentrum Deutschlands.',
        source: 'wikivoyage',
        sourceUrl: 'https://de.wikivoyage.org/wiki/Berlin',
        license: 'CC BY-SA 4.0',
      },
    })
    renderColumn()

    const link = await screen.findByRole('link', { name: /Wikivoyage/ })
    expect(link).toHaveAttribute('href', 'https://de.wikivoyage.org/wiki/Berlin')
  })

  it('FE-PDC-013: shows an error state when the request fails', async () => {
    placeEnrichment.mockRejectedValue(new Error('network'))
    renderColumn()

    expect(await screen.findByText('places.details.error')).toBeInTheDocument()
  })

  it('FE-PDC-014: serves a second look at the same place from cache', async () => {
    const first = renderColumn()
    await screen.findByText('Ein Museum in Köln.')
    first.unmount()

    renderColumn()
    await screen.findByText('Ein Museum in Köln.')

    expect(placeEnrichment).toHaveBeenCalledTimes(1)
  })

  it('FE-PDC-015: aborts the pending request when the selection changes', async () => {
    placeEnrichment.mockReturnValue(new Promise(() => {})) // never settles
    const { rerender, onPickImage, onAdoptDescription } = renderColumn()

    await waitFor(() => expect(placeEnrichment).toHaveBeenCalledTimes(1))
    const firstSignal = placeEnrichment.mock.calls[0][1] as AbortSignal
    expect(firstSignal.aborted).toBe(false)

    rerender(
      <PlaceDetailsColumn
        selection={{ placeId: 'way:2', lat: 1, lng: 2, name: 'Somewhere else' }}
        onPickImage={onPickImage}
        onAdoptDescription={onAdoptDescription}
        hasDescription={false}
        language="de"
        t={t}
      />,
    )

    await waitFor(() => expect(firstSignal.aborted).toBe(true))
    expect(placeEnrichment).toHaveBeenCalledTimes(2)
  })
})

/**
 * FE-PDC-019..026 — opening hours and the rating.
 *
 * Both used to be chips in the fact row: a whole week joined with dots inside a
 * `truncate` span, which in a 288px column read "Monday: 11:30 AM – 11:00 PM ·
 * Tuesday:…", and a rating rendered as the text "3.8 (873)".
 */
describe('PlaceDetailsColumn — hours and rating', () => {
  const WEEK = [
    'Monday: 09:00-18:00',
    'Tuesday: 09:00-18:00',
    'Wednesday: 09:00-18:00',
    'Thursday: 09:00-18:00',
    'Friday: 09:00-18:00',
    'Saturday: 10:00-14:00',
    'Sunday: ?',
  ]

  const withHours = (over: Record<string, unknown> = {}) => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: null,
      hours: { weekdayDescriptions: WEEK, periods: null, specialDays: null },
      ...over,
    })
  }

  // The collapsed row shows the CURRENT day in the place's timezone, so a test
  // that names a specific line has to say which day it is standing on. Without
  // this the suite passed Monday to Friday and failed every weekend, which reads
  // as a broken build rather than a test that forgot to pin its clock.
  // SELECTION is in Cologne, so midday UTC is safely the same date in Berlin.
  const pinDay = (iso: string) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(iso))
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('FE-PDC-019: shows only today collapsed, not the whole week', async () => {
    pinDay('2026-08-12T12:00:00Z') // Wednesday
    withHours()
    renderColumn()

    // Tuesday and Wednesday carry the same text as Monday, so count instead of
    // asserting absence: exactly one line is on screen before expanding.
    await screen.findByText('inspector.openingHours')
    expect(screen.queryAllByText('09:00-18:00')).toHaveLength(1)
    expect(screen.queryByText('10:00-14:00')).not.toBeInTheDocument()
  })

  it('FE-PDC-019b: the collapsed row follows the day, it is not just the first line', async () => {
    // The case that used to take the suite down every Saturday. Worth keeping as
    // a test rather than only pinning 019: it is the assertion that the day
    // lookup happens at all.
    pinDay('2026-08-15T12:00:00Z') // Saturday
    withHours()
    renderColumn()

    await screen.findByText('inspector.openingHours')
    expect(screen.queryAllByText('10:00-14:00')).toHaveLength(1)
    expect(screen.queryByText('09:00-18:00')).not.toBeInTheDocument()
  })

  it('FE-PDC-020: opens the full week on click', async () => {
    withHours()
    renderColumn()

    fireEvent.click(await screen.findByRole('button', { expanded: false }))

    // Assert on the list rather than on text counts: the collapsed header shows
    // today's line too, so a count would depend on which day the suite runs.
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(7)
    expect(rows[5]).toHaveTextContent('10:00-14:00')
    // A day the tag said nothing about reads as a dash, not a question mark.
    expect(rows[6]).toHaveTextContent('–')
  })

  it('FE-PDC-021: honours the 12-hour clock preference', async () => {
    withHours()
    renderColumn({ timeFormat: '12h' })

    fireEvent.click(await screen.findByRole('button', { expanded: false }))
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('9:00 AM-6:00 PM')
  })

  it('FE-PDC-022: says nothing about open or closed without usable periods', async () => {
    // An hours line the parser could not read is not evidence that somewhere is
    // shut, and a confident wrong badge is worse than a missing one.
    withHours()
    renderColumn()

    await screen.findByText('inspector.openingHours')
    expect(screen.queryByText('inspector.opened')).not.toBeInTheDocument()
    expect(screen.queryByText('inspector.closed')).not.toBeInTheDocument()
  })

  it('FE-PDC-023: reports a place open around the clock as open', async () => {
    // The 24/7 shape: one period that never closes. Airports and main stations
    // are tagged this way, and they showed no hours at all before.
    withHours({
      hours: {
        weekdayDescriptions: WEEK.map((_, i) => `${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]}: 00:00-24:00`),
        periods: [{ open: { day: 0, hour: 0, minute: 0 }, close: null }],
        specialDays: null,
      },
    })
    renderColumn()

    expect(await screen.findByText('inspector.opened')).toBeInTheDocument()
  })

  it('FE-PDC-024: renders the rating as stars with its count', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: null,
      rating: { value: 3.8, count: 873 },
    })
    renderColumn({ locale: 'de-DE' })

    expect(await screen.findByText('3.8')).toBeInTheDocument()
    expect(screen.getByText('(873)')).toBeInTheDocument()
  })

  it('FE-PDC-025: leaves the brackets off when there is no count', async () => {
    // Google's search results carry a rating but never a count.
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: null,
      rating: { value: 4, count: null },
    })
    renderColumn()

    expect(await screen.findByText('4.0')).toBeInTheDocument()
    expect(screen.queryByText('()')).not.toBeInTheDocument()
  })

  it('FE-PDC-026: hours alone are content, not an empty column', async () => {
    withHours()
    renderColumn()

    await screen.findByText('inspector.openingHours')
    expect(screen.queryByText('places.details.nothing')).not.toBeInTheDocument()
  })
})
/**
 * FE-PDC-027..029 — the nudge towards a Google key.
 *
 * Deliberately narrow: it appears only when the free sources came up empty AND
 * no key is configured. On an instance with a key there is nothing to suggest,
 * and on a place the free sources described it would read as an advert.
 */
describe('PlaceDetailsColumn — no Google key', () => {
  const empty = () => placeEnrichment.mockResolvedValue({ photos: [], facts: [], description: null })

  it('FE-PDC-027: suggests a key when nothing was found and none is set', async () => {
    empty()
    renderColumn({ hasMapsKey: false })

    expect(await screen.findByText('places.details.noKeyTitle')).toBeInTheDocument()
    expect(screen.getByText('places.details.noKeyHint')).toBeInTheDocument()
  })

  it('FE-PDC-028: stays quiet when a key is already configured', async () => {
    empty()
    renderColumn({ hasMapsKey: true })

    await screen.findByText('places.details.nothing')
    expect(screen.queryByText('places.details.noKeyTitle')).not.toBeInTheDocument()
  })

  it('FE-PDC-029: stays quiet when the free sources did find something', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: { text: 'Ein Museum.', source: 'wikipedia', sourceUrl: null, license: 'CC BY-SA 4.0' },
    })
    renderColumn({ hasMapsKey: false })

    await screen.findByText('Ein Museum.')
    expect(screen.queryByText('places.details.noKeyTitle')).not.toBeInTheDocument()
  })
})
/**
 * FE-PDC-030..031 — a description that is about the chain, not the place.
 *
 * The whole safety argument for showing it rests on the heading saying so.
 */
describe('PlaceDetailsColumn — chain description', () => {
  it('FE-PDC-030: heads a brand text differently and says what it describes', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: {
        text: 'L’Osteria ist eine deutsche Restaurantkette.',
        source: 'wikipedia',
        sourceUrl: 'https://de.wikipedia.org/wiki/L%E2%80%99Osteria',
        license: 'CC BY-SA 4.0',
        aboutBrand: true,
      },
    })
    renderColumn()

    expect(await screen.findByText('places.details.aboutBrand')).toBeInTheDocument()
    expect(screen.getByText('places.details.aboutBrandNote')).toBeInTheDocument()
    expect(screen.queryByText('places.details.description')).not.toBeInTheDocument()
  })

  it('FE-PDC-031: a description of the place itself keeps the plain heading', async () => {
    placeEnrichment.mockResolvedValue({
      photos: [],
      facts: [],
      description: { text: 'Ein Museum.', source: 'wikipedia', sourceUrl: null, license: 'CC BY-SA 4.0' },
    })
    renderColumn()

    expect(await screen.findByText('places.details.description')).toBeInTheDocument()
    expect(screen.queryByText('places.details.aboutBrand')).not.toBeInTheDocument()
    expect(screen.queryByText('places.details.aboutBrandNote')).not.toBeInTheDocument()
  })
})

/**
 * FE-PDC-032..037 — the picture grid.
 *
 * A lead image plus a thumbnail rail was tried and dropped: it took too much of
 * a column that also has to show facts, hours and a description. What must hold
 * either way is that picking a picture stays one click.
 */
describe('PlaceDetailsColumn — picture layout', () => {
  const photo = (n: number, over: Record<string, unknown> = {}) => ({
    key: `way:1~p${n}`,
    url: `/api/maps/place-photo/p${n}/bytes`,
    attribution: `Author ${n}`,
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: `https://commons.wikimedia.org/wiki/File:P${n}.jpg`,
    source: 'wikimedia' as const,
    ...over,
  })

  const withPhotos = (n: number) =>
    placeEnrichment.mockResolvedValue({
      photos: Array.from({ length: n }, (_, i) => photo(i)),
      facts: [],
      description: null,
    })

  // alt="" makes an image presentational, so it carries no `img` role — these
  // read the DOM directly, the way the strip cases above already do.
  const shownImages = () => Array.from(document.querySelectorAll('img'))

  it('FE-PDC-032: shows one tile per picture and nothing else', async () => {
    withPhotos(4)
    renderColumn()

    await screen.findByText('places.details.pickImage')
    expect(shownImages()).toHaveLength(4)
  })

  it('FE-PDC-033: a single picture is a single tile', async () => {
    withPhotos(1)
    renderColumn()

    await screen.findByText('places.details.pickImage')
    expect(shownImages()).toHaveLength(1)
  })

  it('FE-PDC-034: picking a picture is one click', async () => {
    withPhotos(3)
    const { onPickImage } = renderColumn()

    await screen.findByText('places.details.pickImage')
    const tiles = screen.getAllByRole('button', { name: /places.details.pickImage/ })
    fireEvent.click(tiles[1])

    expect(onPickImage).toHaveBeenCalledWith('/api/maps/place-photo/p1/bytes')
    expect(onPickImage).toHaveBeenCalledTimes(1)
  })

  it('FE-PDC-035: clicking the picked tile again clears the choice', async () => {
    withPhotos(2)
    const { onPickImage } = renderColumn({ selectedImageUrl: '/api/maps/place-photo/p1/bytes' })

    await screen.findByText('places.details.pickImage')
    const tiles = screen.getAllByRole('button', { name: /places.details.pickImage/ })
    fireEvent.click(tiles[1])

    expect(onPickImage).toHaveBeenCalledWith(null)
  })

  it('FE-PDC-036: hovering a tile moves the credit to it without picking it', async () => {
    withPhotos(3)
    const { onPickImage } = renderColumn()

    await screen.findByText('Author 0')
    const tiles = screen.getAllByRole('button', { name: /places.details.pickImage/ })
    fireEvent.mouseEnter(tiles[2])

    expect(screen.getByText('Author 2')).toBeInTheDocument()
    expect(onPickImage).not.toHaveBeenCalled()
  })

  it('FE-PDC-037: credits the picture in play, licence included', async () => {
    withPhotos(2)
    renderColumn()

    expect(await screen.findByText('Author 0')).toBeInTheDocument()
    expect(screen.getByText('Author 0').closest('a')).toHaveAttribute(
      'href',
      'https://commons.wikimedia.org/wiki/File:P0.jpg',
    )
    expect(screen.getAllByText('CC BY-SA 4.0')[0].closest('a')).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    )
  })
})
