import React, { useEffect, useRef, useState } from 'react'
import {
  Accessibility,
  ArrowRight,
  Bike,
  Building2,
  Check,
  ChefHat,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  ImageOff,
  Landmark,
  Leaf,
  Loader2,
  ScrollText,
  ShoppingBag,
  Sparkles,
  Sprout,
  Star,
  Sun,
  Wifi,
} from 'lucide-react'
import type { MapsPlaceEnrichmentResult, PlaceFact, PlaceHours, PlacePhotoCandidate, PlaceRating } from '@trek/shared'
import { mapsApi } from '../../api/client'
import { resolveOpenNow, resolvePlaceTimeZone, placeWeekdayIndex } from './placeOpenState'
import { convertHoursLine, isUnknownHoursLine, splitHoursLine } from './placeHoursFormat'
import { safeHttpUrl } from '../../utils/safeUrl'
import type { TranslationFn } from '../../types'

/** The place the column is describing. Null while nothing is selected. */
export interface PlaceDetailsSelection {
  placeId?: string
  lat: number
  lng: number
  name: string
  /** The picked search result, so the server can skip its own details lookup. */
  details?: Record<string, unknown>
}

interface PlaceDetailsColumnProps {
  selection: PlaceDetailsSelection | null
  /** Currently chosen hero image, so the picked tile can show as picked. */
  selectedImageUrl?: string
  onPickImage: (url: string | null) => void
  onAdoptDescription: (text: string) => void
  /** True once the form's description field has something in it. */
  hasDescription: boolean
  language: string
  /** The user's clock preference, so hours read the same as in the inspector. */
  timeFormat?: string
  /** For grouping the rating count's digits. */
  locale?: string
  /** False on an instance with no Google key, which is most of them. */
  hasMapsKey?: boolean
  t: TranslationFn
}

/**
 * Module-level cache plus sessionStorage, same shape as usePlaceDetails in
 * PlaceInspector. Clicking back and forth between two search results must not
 * pay for the provider fan-out twice.
 */
const enrichmentCache = new Map<string, MapsPlaceEnrichmentResult>()

/** Test seam: the module-level cache otherwise leaks between cases. */
export function __clearEnrichmentCacheForTests(): void {
  enrichmentCache.clear()
}

function readSession(key: string): MapsPlaceEnrichmentResult | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as MapsPlaceEnrichmentResult) : undefined
  } catch {
    return undefined
  }
}

function writeSession(key: string, value: MapsPlaceEnrichmentResult): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — the in-memory cache still helps for this session */
  }
}

/**
 * Bumped with the server's CACHE_VERSION. sessionStorage outlives a deploy, so
 * without it the tab that was open while the fix shipped keeps replaying the
 * answer the fix was about — and reports it as still broken.
 */
const ENRICH_CACHE_V = 4

function cacheKeyFor(selection: PlaceDetailsSelection, language: string): string {
  const id = selection.placeId || `coords:${selection.lat}:${selection.lng}`
  return `enrich_v${ENRICH_CACHE_V}_${id}_${language}`
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Overline label, the section heading Vacay and the dashboard widgets share.
 * Uppercase with wide tracking, muted, no rule underneath.
 */
function Overline({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="text-caption font-semibold uppercase tracking-[0.14em] text-content-faint">{children}</p>
  )
}

export default function PlaceDetailsColumn({
  selection,
  selectedImageUrl,
  onPickImage,
  onAdoptDescription,
  hasDescription,
  language,
  timeFormat = '24h',
  locale = 'en-US',
  hasMapsKey = false,
  t,
}: PlaceDetailsColumnProps): React.ReactElement {
  const [data, setData] = useState<MapsPlaceEnrichmentResult | null>(null)
  const [state, setState] = useState<LoadState>('idle')
  const abortRef = useRef<AbortController | null>(null)

  const selectionKey = selection ? cacheKeyFor(selection, language) : null

  useEffect(() => {
    // Abort whatever the previous selection started; its answer is no longer
    // about the place on screen.
    abortRef.current?.abort()
    abortRef.current = null

    if (!selection || !selectionKey) {
      setData(null)
      setState('idle')
      return
    }

    const cached = enrichmentCache.get(selectionKey) ?? readSession(selectionKey)
    if (cached) {
      enrichmentCache.set(selectionKey, cached)
      setData(cached)
      setState('ready')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setState('loading')
    setData(null)

    mapsApi
      .placeEnrichment(
        {
          placeId: selection.placeId,
          lat: selection.lat,
          lng: selection.lng,
          name: selection.name,
          lang: language,
          details: selection.details,
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return
        enrichmentCache.set(selectionKey, result)
        writeSession(selectionKey, result)
        setData(result)
        setState('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err as { code?: string })?.code === 'ERR_CANCELED') return
        setState('error')
      })

    return () => controller.abort()
    // selectionKey folds in the place id (or its coordinates) and the language,
    // which is everything the answer depends on. Depending on `selection` itself
    // would refetch whenever the object identity changes without the place
    // having changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, language])

  useEffect(() => () => abortRef.current?.abort(), [])

  const isEmpty =
    state === 'ready' &&
    !data?.disabled &&
    !data?.photos.length &&
    !data?.description &&
    !data?.facts.length &&
    !data?.hours &&
    !data?.rating

  return (
    // 320px, not 288: the picture grid was doing (288 - 24 - 12) / 3 = 84px
    // tiles, which is too small to tell a facade from a foyer. The column is
    // stretched to the form's height by the row it sits in, so the extra room
    // costs nothing that was being used.
    <aside className="w-full sm:w-80 shrink-0 flex flex-col rounded-xl border border-edge bg-surface-secondary overflow-hidden self-stretch">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-edge shrink-0">
        <Landmark size={15} className="text-accent" />
        <span className="text-body font-semibold text-content">{t('places.details.title')}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3.5">
        {!selection && <p className="text-caption text-content-muted">{t('places.details.empty')}</p>}

        {selection && state === 'loading' && (
          <div className="flex items-center gap-2 text-caption text-content-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('places.details.loading')}
          </div>
        )}

        {selection && state === 'error' && <p className="text-caption text-content-muted">{t('places.details.error')}</p>}

        {selection && state === 'ready' && data?.disabled && (
          <p className="text-caption text-content-muted">{t('places.details.disabled')}</p>
        )}

        {isEmpty && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-caption text-content-muted">
              <ImageOff className="w-4 h-4 shrink-0" />
              {t('places.details.nothing')}
            </div>
            {/* Only when both are true. With a key configured there is nothing
                to suggest, and on a place the free sources DID describe the
                suggestion would be an advert. */}
            {!hasMapsKey && <NoKeyHint t={t} />}
          </div>
        )}

        {selection && state === 'ready' && !data?.disabled && !isEmpty && (
          <>
            <PhotoStrip photos={data?.photos ?? []} selectedImageUrl={selectedImageUrl} onPickImage={onPickImage} t={t} />
            <RatingRow rating={data?.rating ?? null} locale={locale} />
            <OpeningHoursBlock
              hours={data?.hours ?? null}
              lat={selection.lat}
              lng={selection.lng}
              timeFormat={timeFormat}
              t={t}
            />
            <FactList facts={data?.facts ?? []} t={t} />
            <DescriptionBlock description={data?.description ?? null} t={t} />
          </>
        )}
      </div>

      {/* Pinned, not scrolled. Adopting the text is the only thing this column
          asks the reader to do, and it used to sit below a description long
          enough to push it out of view — the button was there, just never
          where anyone looked. */}
      {selection && state === 'ready' && !data?.disabled && data?.description && (
        <div className="shrink-0 border-t border-edge p-2.5">
          <button
            type="button"
            onClick={() => onAdoptDescription(data.description!.text)}
            disabled={hasDescription}
            title={hasDescription ? t('places.details.adoptBlocked') : undefined}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-body font-medium bg-accent-subtle text-accent-on hover:bg-accent hover:text-accent-text disabled:opacity-50 disabled:hover:bg-accent-subtle disabled:hover:text-accent-on transition-colors"
          >
            <ArrowRight className="w-3.5 h-3.5" />
            {t('places.details.adopt')}
          </button>
          {hasDescription && (
            <p className="mt-1 text-center text-caption text-content-faint">{t('places.details.adoptBlocked')}</p>
          )}
        </div>
      )}
    </aside>
  )
}

/** The name to put under a picture. Google gives no author, so it gets its own name. */
function creditOf(photo: PlacePhotoCandidate): string {
  return photo.attribution || sourceLabelFor(photo.source)
}

/**
 * The picture grid.
 *
 * A grid rather than one large image: this sits beside a form in a dialog, and
 * a picture that takes half the column pushes the facts and the description out
 * of sight. Three columns at 320px gives ~96px tiles, which is enough to tell
 * the pictures apart while leaving the rest of the column visible.
 *
 * Only the picture in play is credited in full — crediting all of them at once
 * cost two lines each and drowned the column, and the licence obligation
 * attaches to the one that gets used. Every tile still carries the full credit
 * as its tooltip and links to its source page.
 */
function PhotoStrip({
  photos,
  selectedImageUrl,
  onPickImage,
  t,
}: {
  photos: PlacePhotoCandidate[]
  selectedImageUrl?: string
  onPickImage: (url: string | null) => void
  t: TranslationFn
}): React.ReactElement | null {
  const [hovered, setHovered] = useState<string | null>(null)
  if (photos.length === 0) return null

  const shown = photos.find((p) => p.url === (hovered ?? selectedImageUrl)) ?? photos[0]

  return (
    <div className="space-y-2">
      <Overline>{t('places.details.pickImage')}</Overline>
      <div className="grid grid-cols-3 gap-1.5">
        {photos.map((photo) => (
          <PhotoTile
            key={photo.key}
            photo={photo}
            selected={selectedImageUrl === photo.url}
            onPick={onPickImage}
            onHover={setHovered}
            t={t}
          />
        ))}
      </div>
      <p className="text-caption leading-tight text-content-faint truncate">
        <PhotoCredit photo={shown} />
      </p>
    </div>
  )
}

function PhotoTile({
  photo,
  selected,
  onPick,
  onHover,
  t,
}: {
  photo: PlacePhotoCandidate
  selected: boolean
  onPick: (url: string | null) => void
  onHover: (url: string | null) => void
  t: TranslationFn
}): React.ReactElement {
  const credit = creditOf(photo)

  return (
    <button
      type="button"
      onClick={() => onPick(selected ? null : photo.url)}
      onMouseEnter={() => onHover(photo.url)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(photo.url)}
      onBlur={() => onHover(null)}
      aria-pressed={selected}
      aria-label={`${t('places.details.pickImage')} — ${credit}`}
      title={`${credit}${photo.license ? ` · ${photo.license}` : ''}`}
      className={`group relative block w-full aspect-square overflow-hidden rounded-lg transition-shadow ${
        selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-secondary' : 'ring-1 ring-edge hover:ring-content-muted'
      }`}
    >
      <img
        src={photo.url}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
      />
      {selected && (
        <span className="absolute top-1 right-1 rounded-full bg-accent p-0.5 shadow-card">
          <Check className="w-2.5 h-2.5 text-accent-on" />
        </span>
      )}
    </button>
  )
}

/**
 * Who the description came from, as the reader would name them.
 *
 * `website` has no fixed name — it is the place's own site — so it is credited
 * by host: "losteria.net" says where the text is from far better than a generic
 * word would. Deliberately not a ternary chain: the previous one fell through
 * to 'Wikipedia', which would have credited a restaurant's marketing copy to an
 * encyclopaedia.
 */
function descriptionSourceLabel(
  source: NonNullable<MapsPlaceEnrichmentResult['description']>['source'],
  sourceUrl: string | null,
): string {
  switch (source) {
    case 'google':
      return 'Google'
    case 'osm':
      return 'OpenStreetMap'
    case 'wikivoyage':
      return 'Wikivoyage'
    case 'wikipedia':
      return 'Wikipedia'
    case 'website':
      try {
        return new URL(sourceUrl || '').hostname.replace(/^www\./, '')
      } catch {
        return 'Website'
      }
  }
}

function sourceLabelFor(source: PlacePhotoCandidate['source']): string {
  if (source === 'google') return 'Google'
  if (source === 'wikipedia') return 'Wikipedia'
  return 'Wikimedia Commons'
}

/**
 * Author and licence for the picture currently in play.
 *
 * Not decoration: Commons images are largely CC BY / CC BY-SA, and reusing one
 * without naming its author does not satisfy those terms. When a source hands
 * us no author (Google), we say where it came from rather than inventing one.
 * Rendered inline — the container supplies the colour and the truncation.
 */
function PhotoCredit({ photo }: { photo: PlacePhotoCandidate }): React.ReactElement {
  const credit = creditOf(photo)

  return (
    <>
      {photo.sourceUrl ? (
        <a href={photo.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {credit}
        </a>
      ) : (
        credit
      )}
      {photo.license && (
        <>
          {' · '}
          {photo.licenseUrl ? (
            <a href={photo.licenseUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {photo.license}
            </a>
          ) : (
            photo.license
          )}
        </>
      )}
    </>
  )
}

/**
 * Shown when the free sources found nothing and no Google key is configured.
 *
 * Both halves matter. With a key there is nothing to suggest, and on a place
 * the free sources did describe the same card would just be an advert — which
 * is why it lives inside the empty state rather than at the foot of the column.
 *
 * It also names who to ask: the key is an instance-wide setting, so on most
 * installs the person reading this cannot act on it themselves.
 */
function NoKeyHint({ t }: { t: TranslationFn }): React.ReactElement {
  return (
    <div className="rounded-xl border border-accent/25 bg-accent-subtle p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text">
          <Sparkles className="h-3 w-3" />
        </span>
        <p className="text-caption font-semibold text-content">{t('places.details.noKeyTitle')}</p>
      </div>
      <p className="mt-2 text-caption leading-relaxed text-content-secondary">{t('places.details.noKeyHint')}</p>
    </div>
  )
}

/**
 * The star rating, as stars.
 *
 * It used to be a chip reading "3.8 (873)", which is the same information and
 * none of the recognition — a row of stars is read at a glance and a decimal in
 * a pill is read as text. The count only appears when there is one: Google's
 * search results carry a rating without a count, and empty brackets look broken.
 */
function RatingRow({ rating, locale }: { rating: PlaceRating | null; locale: string }): React.ReactElement | null {
  if (!rating) return null
  const filled = Math.round(rating.value)

  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5" aria-hidden>
        {[1, 2, 3, 4, 5].map((step) => (
          <Star
            key={step}
            className={`w-3 h-3 ${step <= filled ? 'fill-current text-accent-on' : 'text-content-faint'}`}
          />
        ))}
      </span>
      <span className="text-caption font-semibold text-content">{rating.value.toFixed(1)}</span>
      {rating.count != null && (
        <span className="text-caption text-content-faint">({rating.count.toLocaleString(locale)})</span>
      )}
    </div>
  )
}

/**
 * The week's opening hours: today up front, the rest a click away.
 *
 * This replaces a single chip holding the entire week joined with dots, which
 * in a 288px column truncated to "Monday: 11:30 AM – 11:00 PM · Tuesday:…" and
 * told a reader nothing at all.
 *
 * Open/closed is recomputed from the structured periods in the place's own
 * timezone rather than taken from whatever the provider reported when the
 * payload was cached — read from another continent that flag is wrong twice
 * over (#1680). When the periods do not support an answer there is no badge:
 * an hours line the parser could not read is not evidence that somewhere is
 * closed, and a confident wrong badge is worse than a missing one.
 */
function OpeningHoursBlock({
  hours,
  lat,
  lng,
  timeFormat,
  t,
}: {
  hours: PlaceHours | null
  lat: number
  lng: number
  timeFormat: string
  t: TranslationFn
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const lines = hours?.weekdayDescriptions
  if (!lines?.length) return null

  const today = placeWeekdayIndex(new Date(), resolvePlaceTimeZone(lat, lng))
  const openNow = resolveOpenNow({ periods: hours?.periods, specialDays: hours?.specialDays }, lat, lng, null)
  const [, todayTimes] = splitHoursLine(convertHoursLine(lines[today] ?? '', timeFormat))
  const todayLabel = todayTimes && !isUnknownHoursLine(todayTimes) ? todayTimes : t('inspector.showHours')

  return (
    <div className="space-y-2">
      <Overline>{t('inspector.openingHours')}</Overline>
      <div className="rounded-lg border border-edge bg-surface overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-surface-hover transition-colors"
        >
          <Clock className="w-3.5 h-3.5 shrink-0 text-content-faint" />
          <span className="min-w-0 flex-1">
            <span className="block text-caption font-medium text-content truncate">{todayLabel}</span>
            {openNow !== null && (
              <span
                className={`mt-1 inline-flex items-center rounded-full px-1.5 py-px text-caption font-semibold ${
                  openNow ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                }`}
              >
                {openNow ? t('inspector.opened') : t('inspector.closed')}
              </span>
            )}
          </span>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 shrink-0 text-content-faint" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-content-faint" />
          )}
        </button>
        {expanded && (
          <ul className="border-t border-edge-faint px-2.5 py-1.5 space-y-0.5">
            {lines.map((line, i) => {
              const [day, times] = splitHoursLine(convertHoursLine(line, timeFormat))
              // No day part means the provider did not phrase it as
              // "Day: times" — render it whole rather than inventing columns.
              if (!day) {
                return (
                  <li key={i} className="text-caption text-content-muted break-words">
                    {times}
                  </li>
                )
              }
              return (
                <li
                  key={i}
                  className={`flex items-baseline justify-between gap-2 text-caption ${
                    i === today ? 'text-content font-semibold' : 'text-content-muted'
                  }`}
                >
                  <span className="shrink-0">{day}</span>
                  {/* Wraps rather than truncates: this is the view someone
                      opened on purpose, and split shifts run long. */}
                  <span className="min-w-0 text-right break-words tabular-nums">
                    {isUnknownHoursLine(times) ? '–' : times}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

const FACT_ICONS: Record<PlaceFact['kind'], typeof ChefHat> = {
  rating: Star,
  cuisine: ChefHat,
  openingHours: Clock,
  menu: ScrollText,
  outdoorSeating: Sun,
  takeaway: ShoppingBag,
  delivery: Bike,
  wheelchair: Accessibility,
  vegetarian: Leaf,
  vegan: Sprout,
  internetAccess: Wifi,
}

/**
 * The OpenStreetMap facts, as chips.
 *
 * For a restaurant this is the whole point of the column: nothing will ever
 * write an encyclopaedia entry about it, but its cuisine, its hours and a link
 * to its menu are in the map data, and they came along with a lookup that had
 * already happened.
 */
function FactList({ facts, t }: { facts: PlaceFact[]; t: TranslationFn }): React.ReactElement | null {
  if (facts.length === 0) return null

  return (
    <div className="space-y-2">
      <Overline>{t('places.details.facts')}</Overline>
      <div className="flex flex-wrap gap-1.5">
        {facts
          .filter((fact) => fact.kind !== 'openingHours' && fact.kind !== 'rating')
          .map((fact) => {
          const Icon = FACT_ICONS[fact.kind]
          const label = fact.value || t(`places.details.fact.${fact.kind}`)
          const body = (
            <>
              <Icon className="w-3 h-3 shrink-0" />
              <span className="truncate">{label}</span>
            </>
          )
          const shared = 'inline-flex items-center gap-1.5 max-w-full rounded-full border border-edge bg-surface px-2 py-1 text-caption text-content-secondary'
          // A fact url is a community-edited OSM tag (website:menu and friends),
          // so anything but http(s) renders as the plain chip instead of a link.
          const href = safeHttpUrl(fact.url)

          return href ? (
            <a
              key={fact.kind}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={label}
              className={`${shared} hover:border-accent hover:text-content transition-colors`}
            >
              {body}
            </a>
          ) : (
            <span key={fact.kind} title={label} className={shared}>
              {body}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The description and where it came from.
 *
 * The adopt button used to live at the bottom of this block, which put it below
 * however much prose the source returned — reliably out of view. It is the
 * column's only action, so it moved to a pinned footer instead.
 */
function DescriptionBlock({
  description,
  t,
}: {
  description: MapsPlaceEnrichmentResult['description']
  t: TranslationFn
}): React.ReactElement | null {
  if (!description) return null

  const sourceLabel = descriptionSourceLabel(description.source, description.sourceUrl)

  // A description of the chain is not a description of this place, and the
  // heading is where that gets said. Without it the reader has no way to tell
  // that "a German restaurant chain serving pizza and pasta" is about the
  // company rather than the branch they are about to add to their trip.
  const aboutBrand = !!description.aboutBrand

  return (
    <div className="space-y-2">
      <Overline>{aboutBrand ? t('places.details.aboutBrand') : t('places.details.description')}</Overline>
      <div className="rounded-lg border border-edge bg-surface p-2.5 space-y-2">
        {aboutBrand && (
          <p className="flex items-start gap-1.5 text-caption leading-tight text-content-faint">
            <Building2 className="mt-px h-3 w-3 shrink-0" />
            <span>{t('places.details.aboutBrandNote')}</span>
          </p>
        )}
        <p className="text-caption leading-relaxed text-content whitespace-pre-line">{description.text}</p>
        <p className="text-caption leading-tight text-content-faint">
          {description.sourceUrl ? (
            <a
              href={description.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 hover:underline"
            >
              {sourceLabel}
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          ) : (
            sourceLabel
          )}
          {description.license && ` · ${description.license}`}
        </p>
      </div>
    </div>
  )
}
