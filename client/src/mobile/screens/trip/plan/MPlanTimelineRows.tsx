import { BedDouble, Car, ChevronDown, ChevronUp, Clock, Footprints, Pencil, Route, StickyNote, Ticket, X, Zap } from 'lucide-react'
import type { ReactNode, MouseEvent, CSSProperties } from 'react'
import PlaceAvatar from '../../../../components/shared/PlaceAvatar'
import { getCategoryIcon } from '../../../../components/shared/categoryIcons'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { RES_ICONS, getNoteIcon } from '../../../../components/Planner/DayPlanSidebar.constants'
import { noteSurface } from '../../../../components/Planner/noteSurface'
import { markdownLinkComponents } from '../../../../components/shared/markdownLink'
import { getDisplayTimeForDay, getSpanPhase } from '../../../../utils/dayMerge'
import { formatTime, splitReservationDateTime } from '../../../../utils/formatters'
import { transportSubtitle, type TransitMeta, type TransportEntry } from './planTimelineModel'
import { splitNoteTime } from '../lib/dayNotes'
import type { DragRowProps } from './useMPlanDragReorder'
import type { TransitLegDisplay } from '../../../../components/Planner/transitDisplay'
import type { Assignment, DayNote, Place, Reservation, RouteSegment, TranslationFn } from '../../../../types'
import { formatScheduleMinutes } from '../../../../components/Plugins/PluginDaySchedule'
import type { PluginDayScheduleItem } from '../../../../api/client'

/**
 * The five row types of the mobile day timeline (place / manual transport /
 * auto-transit with collapsible legs / travel-time connector / note), each in
 * its go and edit variant. Edit rows swap the left avatar for right-hand action
 * circles.
 *
 * Reordering has two paths: the up/down stack, and — since #1997 — a long-press
 * drag carried by `utils/touchDragBridge`. `drag` below is the second one's props;
 * it is undefined outside edit mode, which is what keeps a plain scroll a scroll.
 */

interface RowChrome {
  editing: boolean
  t: TranslationFn
  language: string
  timeFormat: string
}

/** Native drag props from useMPlanDragReorder, plus the row's own drag state. */
export interface RowDrag extends DragRowProps {
  dragging: boolean
  dropTarget: boolean
}

/** Dims the travelling row and rules a line where the drop would land. */
const dragClass = (d?: RowDrag): string =>
  !d ? '' : `${d.dragging ? 'opacity-40' : ''} ${d.dropTarget && !d.dragging ? 'shadow-[inset_0_2px_0_0_var(--m-act)]' : ''}`

/** Only the props a DOM node takes — `dragging`/`dropTarget` are ours. */
const dragProps = (d?: RowDrag) =>
  d ? { draggable: d.draggable, onDragStart: d.onDragStart, onDragOver: d.onDragOver, onDrop: d.onDrop, onDragEnd: d.onDragEnd } : {}

const fmtTime = (time: string | null | undefined, c: RowChrome): string =>
  time ? formatTime(time.slice(0, 5), c.language, c.timeFormat) : ''

/** Stacked up/down buttons in the demo's 30px action-circle footprint. */
export function ReorderStack({ onUp, onDown, canUp, canDown, t }: {
  onUp: () => void
  onDown: () => void
  canUp: boolean
  canDown: boolean
  t: TranslationFn
}) {
  return (
    <span className="flex h-[30px] w-[30px] flex-none flex-col overflow-hidden rounded-full bg-[color:var(--m-ic)]">
      <button
        type="button"
        aria-label={t('dayplan.moveUp')}
        disabled={!canUp}
        onClick={e => { e.stopPropagation(); onUp() }}
        className="flex h-[15px] w-full items-center justify-center text-m-faint disabled:opacity-30"
      >
        <ChevronUp size={12} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        aria-label={t('dayplan.moveDown')}
        disabled={!canDown}
        onClick={e => { e.stopPropagation(); onDown() }}
        className="flex h-[15px] w-full items-center justify-center text-m-faint disabled:opacity-30"
      >
        <ChevronDown size={12} strokeWidth={2.2} />
      </button>
    </span>
  )
}

function ActionCircle({ label, onClick, faint = false, children }: {
  label: string
  onClick: () => void
  faint?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={e => { e.stopPropagation(); onClick() }}
      className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[color:var(--m-ic)] ${faint ? 'text-m-faint' : 'text-m-muted'}`}
    >
      {children}
    </button>
  )
}

/** 30px go-mode avatar ring (photo for places, icon circle for transports/notes). */
function AvatarRing({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span
      className={`flex h-[30px] w-[30px] flex-none items-center justify-center overflow-hidden rounded-full border-[1.5px] border-[color:var(--m-avbr)] bg-[color:var(--m-ic)] ${className}`}
      style={style}
    >
      {children}
    </span>
  )
}

const TIME_CHIP = 'flex-none whitespace-nowrap rounded-[6px] bg-[color:var(--m-ic)] px-[6px] py-px font-geist text-[0.65625rem] font-semibold'

// ── b3) Place row ────────────────────────────────────────────────────────────

export function PlaceRow({ assignment, fullPlace, linkedReservations, chrome, reorder, drag, onOpen, onEdit, onRemove }: {
  assignment: Assignment
  fullPlace: Place | undefined
  linkedReservations: Reservation[]
  chrome: RowChrome
  reorder: ReactNode
  drag?: RowDrag
  onOpen: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const { t } = chrome
  const place = assignment.place
  const CatIcon = getCategoryIcon(place?.category?.icon)
  const time = fmtTime(place?.place_time, chrome)
  // One line per booking on the stop (#2201). A single one keeps the bare
  // status line it always had; once there are several, the title tells them
  // apart, since "Confirmed" twice over says nothing.
  const bookingLines = linkedReservations.map(r => ({
    id: r.id,
    text: [
      linkedReservations.length > 1 ? r.title : '',
      r.status === 'confirmed' ? t('dayplan.confirmed') : t('dayplan.pendingRes'),
      r.confirmation_number ? `#${r.confirmation_number}` : '',
    ].filter(Boolean).join(' · '),
  }))
  const sub = bookingLines.length > 0
    ? bookingLines[0].text
    : place?.address || place?.description || ''

  return (
    // Stays a div: in editing mode the row carries its own action circles and
    // reorder controls, which may not be nested inside a <button>. The key
    // handler is guarded on currentTarget so Enter/Space on one of those
    // controls does not also open the row — a mouse click would not either.
    <div
      {...dragProps(drag)}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      className={`flex cursor-pointer items-center gap-2.5 py-1.5 ${dragClass(drag)}`}
    >
      {!chrome.editing && (
        <AvatarRing className="shadow-[0_3px_8px_-3px_rgba(0,0,0,.4)]">
          <PlaceAvatar
            place={fullPlace ?? {
              id: place?.id ?? assignment.place_id,
              name: place?.name ?? '',
              image_url: place?.image_url ?? null,
              google_place_id: place?.google_place_id ?? null,
              osm_id: null,
              lat: place?.lat ?? null,
              lng: place?.lng ?? null,
            }}
            size={27}
            category={place?.category ? { color: place.category.color ?? undefined, icon: place.category.icon ?? undefined } : null}
          />
        </AvatarRing>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <CatIcon size={12} strokeWidth={2.2} className="flex-none text-m-muted" />
          <span className="min-w-0 truncate text-[0.875rem] font-semibold">{place?.name}</span>
          {bookingLines.length > 0 && (
            <span className="flex flex-none items-center gap-1 rounded-full bg-[color:var(--m-ic)] px-[7px] py-[2px] text-[0.5625rem] font-bold tracking-[.04em]">
              <Ticket size={10} strokeWidth={2.2} />
              {t('mobileTrip.resBadge')}
            </span>
          )}
        </div>
        {(time || sub) && (
          <div className="mt-[2px] flex min-w-0 items-center gap-1.5">
            {time && <span className={TIME_CHIP}>{time}</span>}
            {sub && <span className="min-w-0 truncate font-geist text-[0.71875rem] text-m-muted">{sub}</span>}
          </div>
        )}
        {bookingLines.slice(1).map(line => (
          <div key={line.id} className="mt-[2px] flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-geist text-[0.71875rem] text-m-muted">{line.text}</span>
          </div>
        ))}
        {assignment.notes && (
          // Day-specific note on this stop (#2163) — mirror of the desktop
          // timeline's caption line, so the phone shows the note exists
          // without opening the place sheet.
          <div className="mt-[2px] flex min-w-0 items-center gap-1">
            <StickyNote size={10} strokeWidth={2.2} className="flex-none text-m-faint" />
            <span className="min-w-0 truncate font-geist text-[0.65625rem] text-m-faint">{assignment.notes}</span>
          </div>
        )}
      </div>
      {chrome.editing && (
        <span className="flex flex-none items-center gap-1.5">
          <ActionCircle label={t('common.edit')} onClick={onEdit}>
            <Pencil size={14} strokeWidth={2} />
          </ActionCircle>
          <ActionCircle label={t('planner.removeFromDay')} onClick={onRemove}>
            <X size={14} strokeWidth={2} />
          </ActionCircle>
          {reorder}
        </span>
      )}
    </div>
  )
}

// ── b1) Manual transport / booking row ───────────────────────────────────────

export function TransportRow({ res, dayId, chrome, reorder, drag, onOpen }: {
  res: TransportEntry
  dayId: number
  chrome: RowChrome
  reorder: ReactNode
  drag?: RowDrag
  onOpen: () => void
}) {
  const Icon = RES_ICONS[res.type as keyof typeof RES_ICONS] || Ticket
  const phase = getSpanPhase(res, dayId)
  const start = splitReservationDateTime(getDisplayTimeForDay(res, dayId)).time
  const end = splitReservationDateTime(res.reservation_end_time).time
  const time = start
    ? `${fmtTime(start, chrome)}${phase === 'single' && end ? ` – ${fmtTime(end, chrome)}` : ''}`
    : ''
  const sub = transportSubtitle(res)

  return (
    <div
      {...dragProps(drag)}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      className={`mt-1.5 flex cursor-pointer items-center gap-2.5 ${dragClass(drag)}`}
    >
      {!chrome.editing && (
        <AvatarRing>
          <Icon size={14} strokeWidth={2} />
        </AvatarRing>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-4 rounded-[13px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-[11px] py-[7px]">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-[7px]">
            <span className="min-w-0 truncate text-[0.875rem] font-semibold">{res.title}</span>
            {time && <span className={TIME_CHIP}>{time}</span>}
          </div>
          {sub && <div className="mt-px truncate font-geist text-[0.71875rem] text-m-muted">{sub}</div>}
        </div>
        <Route size={15} strokeWidth={2} className="flex-none text-m-faint" />
      </div>
      {chrome.editing && <span className="flex flex-none items-center gap-1.5">{reorder}</span>}
    </div>
  )
}

// ── b2) Auto-transit row with collapsible legs ───────────────────────────────

function LineBadge({ leg, className = '' }: { leg: TransitLegDisplay; className?: string }) {
  return (
    <span
      className={`rounded-[6px] px-[7px] py-px text-[0.59375rem] font-extrabold ${className}`}
      style={{
        background: leg.line_color || 'var(--m-faint)',
        color: leg.line_color ? (leg.line_text_color || '#fff') : 'var(--m-actfg)',
      }}
    >
      {leg.line || leg.mode}
    </span>
  )
}

function TransitStrip({ legs }: { legs: TransitLegDisplay[] }) {
  // Sub-minute walks are noise; a walk without a duration is not — dropping it
  // would make the strip disagree with the expanded leg list.
  const shown = legs.filter(l => l.mode !== 'WALK' || l.duration == null || l.duration >= 60)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-m-faint">
      {shown.map((leg, i) => (
        <span key={i} className="inline-flex items-center gap-[2px]">
          {i > 0 && <span className="text-[0.5rem]">›</span>}
          {leg.mode === 'WALK' ? (
            <span className="inline-flex items-center gap-[2px] font-geist text-[0.625rem] font-bold">
              <Footprints size={11} strokeWidth={2.2} />
              {leg.duration != null ? Math.round(leg.duration / 60) : ''}
            </span>
          ) : (
            <LineBadge leg={leg} />
          )}
        </span>
      ))}
    </div>
  )
}

function TransitLegRows({ legs, t }: { legs: TransitLegDisplay[]; t: TranslationFn }) {
  const walkDash = 'repeating-linear-gradient(180deg, var(--m-faint) 0 3px, transparent 3px 7px)'
  return (
    <div className="border-t border-[color:var(--m-rowbr)] px-3 pb-3 pt-1">
      {legs.map((leg, i) => {
        const isWalk = leg.mode === 'WALK'
        const mins = leg.duration ? Math.round(leg.duration / 60) : null
        const hasSeg = i < legs.length - 1
        return (
          <div key={i} className="flex gap-[9px]">
            <span className="w-9 flex-none pt-[9px] text-right font-geist text-[0.65625rem] font-semibold tabular-nums text-m-muted">
              {isWalk ? '' : leg.from?.time?.slice(0, 5) || ''}
            </span>
            <div className="flex w-3 flex-none flex-col items-center">
              {isWalk ? (
                <span className="mt-[11px] h-[7px] w-[7px] flex-none rounded-full border-2 border-[color:var(--m-faint)]" />
              ) : (
                <span
                  className="mt-[10px] h-[9px] w-[9px] flex-none rounded-full border-[3px]"
                  style={{ borderColor: leg.line_color || 'var(--m-faint)' }}
                />
              )}
              {hasSeg && (
                <span
                  className="mt-[3px] min-h-[14px] w-[3px] flex-1 rounded-[2px]"
                  style={{ background: isWalk ? walkDash : leg.line_color || 'var(--m-faint)' }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 py-[7px]">
              {isWalk ? (
                <div className="truncate font-geist text-[0.6875rem] font-semibold text-m-muted">
                  <Footprints size={10} strokeWidth={2.2} className="mr-1 inline-block align-[-1px]" />
                  {[mins ? t('transit.min', { count: mins }) : '', t('transit.walkTo', { name: leg.to?.name || '' })]
                    .filter(Boolean).join(' · ')}
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-1.5">
                    <LineBadge leg={leg} className="flex-none" />
                    <span className="truncate text-[0.78125rem] font-bold">
                      {[leg.from?.name, leg.to?.name].filter(Boolean).join(' → ')}
                    </span>
                  </div>
                  <div className="mt-[2px] font-geist text-[0.625rem] text-m-faint">
                    {[
                      mins ? t('transit.min', { count: mins }) : null,
                      leg.stops ? t('transit.stops', { count: leg.stops }) : null,
                      leg.from?.track ? t('transit.platform', { track: leg.from.track }) : null,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function TransitRow({ res, transit, dayId, open, chrome, reorder, drag, onToggle, onOpenJourney }: {
  res: TransportEntry
  transit: TransitMeta
  dayId: number
  open: boolean
  chrome: RowChrome
  reorder: ReactNode
  drag?: RowDrag
  onToggle: () => void
  onOpenJourney: () => void
}) {
  const { t } = chrome
  const Icon = RES_ICONS.transit
  const [from, to] = res.title.split(' → ')
  const start = splitReservationDateTime(getDisplayTimeForDay(res, dayId)).time
  const end = splitReservationDateTime(res.reservation_end_time).time
  const Chevron = open ? ChevronUp : ChevronDown

  return (
    <div {...dragProps(drag)} className={`mt-1.5 flex items-start gap-2.5 ${dragClass(drag)}`}>
      {!chrome.editing && (
        <AvatarRing className="mt-1">
          <Icon size={14} strokeWidth={2} />
        </AvatarRing>
      )}
      <div className="min-w-0 flex-1 overflow-hidden rounded-[14px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)]">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={onToggle}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
          className="cursor-pointer px-3 py-[9px]"
        >
          <div className="flex items-center gap-[7px]">
            <span className="min-w-0 truncate text-[0.84375rem] font-bold">
              {to ? `${from} → ${to}` : res.title}
            </span>
            {start && (
              <span className="ml-auto flex-none whitespace-nowrap rounded-[6px] bg-[color:var(--m-ic)] px-[6px] py-px font-geist text-[0.6875rem] font-semibold tabular-nums">
                <Clock size={10} strokeWidth={2.2} className="mr-[3px] inline-block align-[-1px]" />
                {fmtTime(start, chrome)}{end ? ` – ${fmtTime(end, chrome)}` : ''}
              </span>
            )}
            <Chevron size={15} strokeWidth={2} className={`flex-none text-m-faint ${start ? '' : 'ml-auto'}`} />
          </div>
          <TransitStrip legs={transit.legs} />
        </div>
        {open && <TransitLegRows legs={transit.legs} t={t} />}
      </div>
      {chrome.editing && (
        <span className="mt-1 flex flex-none items-center gap-1.5">
          <ActionCircle label={t('common.edit')} onClick={onOpenJourney}>
            <Pencil size={14} strokeWidth={2} />
          </ActionCircle>
          {reorder}
        </span>
      )}
    </div>
  )
}

// ── b4) Walk/drive connector between two located places ─────────────────────

/** The connector line of a routed leg — the leg's own mode (#1281) picks icon and duration. */
function TravelLine({ seg }: { seg: RouteSegment }) {
  const mode = seg.mode
  const Icon = mode === 'walking' ? Footprints : mode?.startsWith('plugin:') ? Zap : Car
  const durationText = seg.durationText ?? (mode === 'walking' ? seg.walkingText : seg.drivingText)
  return (
    <>
      <span className="h-px flex-1 bg-[color:var(--m-rowbr)]" />
      <span className="inline-flex items-center gap-[3px] whitespace-nowrap font-geist text-[0.59375rem] font-semibold text-m-faint">
        <Icon size={10} strokeWidth={2} />
        {durationText}
      </span>
      <span className="whitespace-nowrap font-geist text-[0.59375rem] font-semibold text-m-faint">
        · {seg.distanceText}
      </span>
      {/* Extra text a plugin route attached to this leg (e.g. "25 min charge"). */}
      {seg.noteText && (
        <span className="inline-flex items-center gap-[3px] whitespace-nowrap font-geist text-[0.59375rem] font-semibold text-m-faint">
          <Zap size={10} strokeWidth={2} />
          {seg.noteText}
        </span>
      )}
      <span className="h-px flex-1 bg-[color:var(--m-rowbr)]" />
    </>
  )
}

export function ConnRow({ seg, onTap }: { seg: RouteSegment; onTap?: (e: MouseEvent) => void }) {
  // Tap to change the leg's mode (#1281).
  const inner = <TravelLine seg={seg} />
  const cls = 'mt-[5px] flex w-full items-center gap-2 py-px text-[color:var(--m-conn)]'
  return onTap
    ? <button type="button" onClick={onTap} className={cls}>{inner}</button>
    : <div className={cls}>{inner}</div>
}

// ── b4a) Plugin schedule contribution ("35 min charging at this stop") ───────
// Host-vetted data from the dayScheduleProvider hook; styled like a connector so
// it reads as schedule information, not as an itinerary item.

const SCHEDULE_TONE_COLORS: Record<string, string> = {
  default: '#4F46E5', success: '#10b981', warn: '#f59e0b', danger: '#ef4444',
}

export function PlanScheduleRow({ item }: { item: PluginDayScheduleItem }) {
  const color = SCHEDULE_TONE_COLORS[item.tone] ?? SCHEDULE_TONE_COLORS.default
  const minutes = item.minutes != null ? formatScheduleMinutes(item.minutes) : null
  return (
    <div className="mt-[5px] flex items-center gap-2 py-px">
      <span className="h-px w-4 shrink-0 bg-[color:var(--m-rowbr)]" />
      <span className="inline-flex min-w-0 items-center gap-[3px] font-geist text-[0.59375rem] font-semibold text-m-faint">
        <Zap size={10} strokeWidth={2} style={{ color }} className="shrink-0" />
        {minutes && <span className="shrink-0">{minutes} ·</span>}
        <span className="truncate">{item.label}</span>
      </span>
      <span className="h-px flex-1 bg-[color:var(--m-rowbr)]" />
    </div>
  )
}

// ── b4b) Accommodation bookend leg (hotel → first stop / last stop → hotel) ──

export function HotelConnRow({ seg, name, placement }: {
  seg: RouteSegment
  name: string
  placement: 'top' | 'bottom'
}) {
  // Same line as the connectors between two stops, so a bookend leg routed with a
  // plugin profile or set to walking reads the same as the rest of the day (#1281).
  const travel = (
    <div className="flex items-center gap-2 py-px text-[color:var(--m-conn)]">
      <TravelLine seg={seg} />
    </div>
  )
  const hotel = (
    <div className="flex items-center justify-center gap-[5px] whitespace-nowrap font-geist text-[0.59375rem] font-semibold text-m-muted">
      <BedDouble size={11} strokeWidth={2} className="flex-none" />
      <span className="min-w-0 truncate">{name}</span>
    </div>
  )
  return (
    <div className="mt-[5px] flex flex-col gap-[3px]">
      {placement === 'top' ? <>{hotel}{travel}</> : <>{travel}{hotel}</>}
    </div>
  )
}

// ── b5) Day-note row ─────────────────────────────────────────────────────────

export function NoteRow({ note, chrome, reorder, drag, onEdit }: {
  note: DayNote
  chrome: RowChrome
  reorder: ReactNode
  drag?: RowDrag
  onEdit: () => void
}) {
  const Icon = getNoteIcon(note.icon)
  const skin = noteSurface(note.color)
  // The time column is a free detail line; only a leading HH:MM is a real time.
  const { time: noteTime, detail } = splitNoteTime(note.time)
  const time = noteTime ? fmtTime(noteTime, chrome) : ''
  const [title, ...rest] = note.text.split('\n')
  const titleExtra = rest.join(' ').trim()

  return (
    <div
      {...dragProps(drag)}
      role={chrome.editing ? 'button' : undefined}
      tabIndex={chrome.editing ? 0 : undefined}
      // A link in the rendered body keeps its own tap; the rest of the row edits.
      onClick={chrome.editing ? (e => { if (!(e.target as HTMLElement).closest('a')) onEdit() }) : undefined}
      onKeyDown={chrome.editing ? (e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onEdit() } }) : undefined}
      className={`my-[2px] flex items-center gap-2.5 ${chrome.editing ? 'cursor-pointer' : ''} ${dragClass(drag)}`}
    >
      {!chrome.editing && (
        <AvatarRing style={note.color ? { background: skin.iconBackground, borderColor: skin.border } : undefined}>
          <Icon size={14} strokeWidth={2} style={{ color: skin.iconColor }} />
        </AvatarRing>
      )}
      <div
        className="min-w-0 flex-1 rounded-[13px] border px-[11px] py-[7px]"
        style={{ borderColor: skin.border, background: note.color ? skin.background : 'var(--m-ic)' }}
      >
        <div className="flex items-center gap-1.5">
          {time && <span className={TIME_CHIP}>{time}</span>}
          <span className="min-w-0 text-[0.875rem] font-semibold">{title}</span>
        </div>
        {titleExtra && (
          <div className="mt-px font-geist text-[0.71875rem] leading-[1.4] text-m-muted">{titleExtra}</div>
        )}
        {detail && (
          // Rendered, not raw: a note written with the formatting bar would
          // otherwise read as `**asterisks**` on the phone.
          <div className="collab-note-md mt-px font-geist text-[0.71875rem] leading-[1.45] text-m-muted [overflow-wrap:anywhere]">
            <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownLinkComponents}>{detail}</Markdown>
          </div>
        )}
      </div>
      {chrome.editing && <span className="flex flex-none items-center gap-1.5">{reorder}</span>}
    </div>
  )
}
