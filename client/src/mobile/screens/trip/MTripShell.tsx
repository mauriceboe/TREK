import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { findFocusDayId } from '../../../components/Planner/today'
import {
  CalendarDays, ChevronDown, ChevronLeft, Download, FileDown, List, Map as MapIcon, MoreHorizontal, PackageCheck,
  Plane, Plus, Rows3, Ticket, TrainFront, Trash2, Upload, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTripPlanner } from '../../../pages/tripPlanner/useTripPlanner'
import MIconBtn from '../../components/MIconBtn'
import MPlanTimeline from './plan/MPlanTimeline'
import MMapArea from './map/MMapArea'
import MPlacesBrowser from './places/MPlacesBrowser'
import MTripTabPanel from './tabs/MTripTabPanel'
import MTripSheets from './sheets/MTripSheets'
import MTripLoadingSplash from './MTripLoadingSplash'
import { usePluginDayTints, dayTintBackground } from '../../../components/Plugins/PluginDaySchedule'
import type { Day } from '../../../types'

/**
 * Mobile trip screen frame. Owns the chrome the design shares across every
 * trip view — glass top controls (per-tab centre variants), the day-chip rail,
 * the bottom dock — plus the view/mode machine on top of the planner state.
 * All data and mutations come from useTripPlanner() (same hook the desktop
 * page wires), so WebSocket sync, offline persistence, undo and the
 * ?create=/sessionStorage contracts are inherited unchanged.
 *
 * The actual content areas (plan timeline, map, places browser, tab panels,
 * sheets) are slots: typed component props whose defaults are the real screens
 * under screens/trip/ (the non-plan tab panels route through tabs/MTripTabPanel).
 */

/** Everything useTripPlanner() returns — data, permissions, CRUD, modal state. */
export type TripPlanner = ReturnType<typeof useTripPlanner>

export type MTripView = 'plan' | 'map'
export type MTripMode = 'go' | 'edit' | 'browse'
export type MTripListsTab = 'packing' | 'todo'
export type MTripCollabTab = 'chat' | 'notes' | 'polls'

/**
 * Currently open bottom/floating sheet. Well-known ids (owned by the sheets
 * screen): 'day' (payload { dayId }), 'days', 'mehr', 'note' (payload
 * { dayId, note? }), 'accommodation' (payload { dayId?, accId?, from? }),
 * 'transport' (payload { reservationId }), 'bract'
 * (payload { placeId, dayPicker? }), 'import', 'export', 'members',
 * 'tripedit', 'bags', 'task'. The place inspector keys off the planner's
 * place selection instead of a sheet id, and planner-backed editors (place
 * form, transport, booking, expense) keep using the planner's own modal flags.
 */
export interface MTripSheetState {
  id: string
  payload?: unknown
}

/**
 * Shell-owned UI state handed to every slot. Ownership split: the planner
 * hook owns trip data + CRUD + editor-modal flags; the shell owns chrome
 * state (view/mode machine, active tab, sheet routing, header sub-states).
 */
export interface MTripShellApi {
  /** 'plan' = list chrome, 'map' = fullscreen map. Plan tab only. */
  view: MTripView
  /** Travel/Plan/Places segment: go | edit | browse. */
  mode: MTripMode
  /** Legacy tab ids: plan · transports · buchungen · listen · finanzplan · dateien · collab · plugin:* */
  trTab: string
  /** Switch trip tab (persists to sessionStorage['trip-tab-{id}'], resets browse → go). */
  setTrTab: (tabId: string) => void
  /** Set go/edit/browse — forces the plan tab and the plan view. */
  setTravelMode: (mode: MTripMode) => void
  /** Plan ⇄ map. Leaving to the map resets browse → go. */
  toggleView: () => void
  /** True while browse was entered from edit — the places browser seeds its 'unplanned' filter. */
  browseFromEdit: boolean
  sheet: MTripSheetState | null
  openSheet: (id: string, payload?: unknown) => void
  closeSheet: () => void
  /** Lists header segment; persisted per trip like the desktop sub-tab. */
  listsTab: MTripListsTab
  setListsTab: (tab: MTripListsTab) => void
  collabTab: MTripCollabTab
  setCollabTab: (tab: MTripCollabTab) => void
  /** Header compact toggles for the transports / bookings lists. */
  transportsCompact: boolean
  bookingsCompact: boolean
  /** Header intent signals — increment-only counters, consumed by the tab panels. */
  addExpenseSignal: number
  exportCostsCsvSignal: number
  uploadFilesSignal: number
  openFilesTrashSignal: number
}

/**
 * Day timeline for go/edit mode (plan tab, plan view). Renders the scrollable
 * day content below the top controls + day chips and above the dock
 * (clearance: top ~158px incl. safe-area, bottom var(--bottom-nav-h)).
 * Reads the active day from planner.selectedDayId.
 */
export interface MPlanTimelineProps {
  planner: TripPlanner
  shell: MTripShellApi
}

/**
 * Fullscreen map area (plan tab). Mounted for the whole plan-tab lifetime so
 * the map stays warm under the timeline; visible when shell.view === 'map'.
 * Marker/route data comes from planner (mapPlaces, dayPlaces, route, …).
 */
export interface MMapAreaProps {
  planner: TripPlanner
  shell: MTripShellApi
}

/**
 * Places browser overlay (mode === 'browse'). Owns its own filter/search/
 * selection state; seeds the 'unplanned' filter when shell.browseFromEdit.
 */
export interface MPlacesBrowserProps {
  planner: TripPlanner
  shell: MTripShellApi
}

/**
 * Non-plan tab panel, rendered as a full overlay above map/chips. `tab` is the
 * active legacy id (transports, buchungen, listen, finanzplan, dateien,
 * collab, plugin:*). Consumes the shell header state for its tab (compact
 * toggles, listsTab/collabTab, intent signals).
 */
export interface MTripTabPanelProps {
  planner: TripPlanner
  shell: MTripShellApi
  tab: string
}

/**
 * Sheet host — always mounted, renders whatever shell.sheet points at plus the
 * planner-flag editors (place form, transport/booking/expense, imports,
 * members, trip edit) as MSheet instances portaled to #m-sheet-root.
 */
export interface MTripSheetsProps {
  planner: TripPlanner
  shell: MTripShellApi
}

interface MTripShellProps {
  PlanTimeline?: ComponentType<MPlanTimelineProps>
  MapArea?: ComponentType<MMapAreaProps>
  PlacesBrowser?: ComponentType<MPlacesBrowserProps>
  TabPanel?: ComponentType<MTripTabPanelProps>
  Sheets?: ComponentType<MTripSheetsProps>
}

/** The 5 dock tabs in demo order; files/collab/plugins live in the Mehr sheet. */
const DOCK_TABS: { id: string; icon: LucideIcon }[] = [
  { id: 'plan', icon: MapIcon },
  { id: 'transports', icon: TrainFront },
  { id: 'buchungen', icon: Ticket },
  { id: 'finanzplan', icon: Wallet },
  { id: 'listen', icon: PackageCheck },
]

function dayChipLabel(day: Day, language: string, fallback: string): string {
  if (day.date) {
    const date = new Date(`${day.date.slice(0, 10)}T00:00:00`)
    if (!Number.isNaN(date.getTime())) {
      return `${new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date)} ${date.getDate()}`
    }
  }
  return fallback
}

export default function MTripShell({
  PlanTimeline = MPlanTimeline,
  MapArea = MMapArea,
  PlacesBrowser = MPlacesBrowser,
  TabPanel = MTripTabPanel,
  Sheets = MTripSheets,
}: MTripShellProps) {
  const planner = useTripPlanner()
  const { t, language, tripId, days, trip, navigate, packingItems, todoItems } = planner

  // Per-day colours from the dayTintProvider plugin hook — the mobile counterpart
  // of the desktop day-card wash, carried on the day chips. Empty without a plugin.
  const dayTints = usePluginDayTints(tripId)

  const [view, setView] = useState<MTripView>('plan')
  const [mode, setMode] = useState<MTripMode>('go')
  const [browseFromEdit, setBrowseFromEdit] = useState(false)
  const [sheet, setSheet] = useState<MTripSheetState | null>(null)
  const [listsTab, setListsTabState] = useState<MTripListsTab>(() => {
    const saved = sessionStorage.getItem(`trip-lists-subtab-${tripId}`)
    return saved === 'todo' ? 'todo' : 'packing'
  })
  const [collabTab, setCollabTab] = useState<MTripCollabTab>('chat')
  const [transportsCompact, setTransportsCompact] = useState(false)
  const [bookingsCompact, setBookingsCompact] = useState(false)
  const [addExpenseSignal, setAddExpenseSignal] = useState(0)
  const [exportCostsCsvSignal, setExportCostsCsvSignal] = useState(0)
  const [uploadFilesSignal, setUploadFilesSignal] = useState(0)
  const [openFilesTrashSignal, setOpenFilesTrashSignal] = useState(0)

  // The mobile plan is single-day: make sure a day is active once days arrive.
  // Only seed once so an intentional deselect elsewhere is not fought. Open on
  // today while the trip is running, otherwise on the next day that is still
  // ahead — a gap in the dates should not throw you back to day 1 — and fall
  // back to the first day once the whole trip is behind us.
  const seededDayRef = useRef(false)
  useEffect(() => {
    if (seededDayRef.current) return
    // A day that is already active counts as seeded: a later deselect is the
    // user's, and re-seeding it here would be exactly the fight this guard
    // exists to avoid.
    if (planner.selectedDayId != null) { seededDayRef.current = true; return }
    if (days.length === 0) return
    seededDayRef.current = true
    // Off the same helper file as the desktop day plan (#1567), so the two
    // cannot drift on what "today" means.
    planner.tripActions.setSelectedDay(findFocusDayId(days) ?? days[0].id)
  }, [planner.selectedDayId, days, planner.tripActions])

  // Swiping the day panel (#2051) can move the day well past the chips on
  // screen — the rail overflows from roughly six days on — so the active chip
  // pulls itself back into view. Only when it is really clipped, so tapping a
  // chip you can already see never shifts the rail under your thumb.
  const chipRefs = useRef(new Map<number, HTMLButtonElement>())
  useEffect(() => {
    const chip = planner.selectedDayId != null ? chipRefs.current.get(planner.selectedDayId) : undefined
    const rail = chip?.parentElement
    if (!chip || !rail) return
    const c = chip.getBoundingClientRect()
    const r = rail.getBoundingClientRect()
    if (c.left >= r.left - 1 && c.right <= r.right + 1) return
    // block:'nearest' is not optional: the shell root is `fixed inset-0`, and
    // 'center' would scroll the document behind it instead.
    chip.scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth',
      inline: 'center',
      block: 'nearest',
    })
  }, [planner.selectedDayId, days])

  const trTab = planner.activeTab

  const setTrTab = (tabId: string) => {
    planner.handleTabChange(tabId)
    if (mode === 'browse') setMode('go')
  }

  const setTravelMode = (next: MTripMode) => {
    setBrowseFromEdit(next === 'browse' && mode === 'edit')
    setMode(next)
    setView('plan')
    if (trTab !== 'plan') planner.handleTabChange('plan')
  }

  // Map focus on the selected day. Drives the same declutter the desktop sidebar's
  // collapse chevron drives (#216) rather than adding a second filter — the phone
  // lost that affordance when this shell replaced DayPlanSidebar, so a day's pins
  // could not be told apart from the rest of the trip at all (#1962). Unplanned
  // places stay visible either way, which is what the collapse path has always done.
  const focusMapOnDay = (dayId: number | null) => {
    planner.setExpandedDayIds(dayId == null ? null : new Set([dayId]))
  }

  // The map's day selection: frame the day, draw its route, drop the other days'
  // pins. Shared by the chip tap and the all-days toggle so the two cannot drift.
  const selectDayOnMap = (dayId: number) => {
    planner.handleSelectDay(dayId, false)
    planner.autoShowRoute()
    focusMapOnDay(dayId)
  }

  // The day an "all days" deselect came from, so the toggle can put it back.
  // A remote day:deleted can retire it while it is parked here, hence the
  // membership check before it is trusted.
  const lastDayRef = useRef<number | null>(null)
  const dayToRestore = (): number | null =>
    (lastDayRef.current != null && days.some(d => d.id === lastDayRef.current)
      ? lastDayRef.current
      : findFocusDayId(days) ?? days[0]?.id) ?? null

  // Whole trip ⇄ one day on the map (#2257). Its own control rather than a
  // second tap on the active chip: that tap already opens the day sheet, the
  // only route to it that also exists in map view. Never skipFit — changing
  // what the map is filtered to is exactly when it should reframe.
  const toggleAllDays = () => {
    if (planner.selectedDayId != null) {
      lastDayRef.current = planner.selectedDayId
      focusMapOnDay(null)
      planner.handleSelectDay(null, false)
      return
    }
    const back = dayToRestore()
    if (back != null) selectDayOnMap(back)
  }

  const toggleView = () => {
    const next = view === 'plan' ? 'map' : 'plan'
    setView(next)
    if (mode === 'browse') setMode('go')
    // Entering the map: draw the current day's route and frame it — the
    // BoundsController re-fits to include the polyline once OSRM resolves.
    if (next === 'map') {
      planner.autoShowRoute()
      if (planner.selectedDayId != null) planner.handleSelectDay(planner.selectedDayId, false)
      focusMapOnDay(planner.selectedDayId)
    } else {
      // Leaving the map: nothing is filtered while the timeline is up, so the next
      // visit starts from the whole trip unless a day is picked again.
      focusMapOnDay(null)
      // The timeline is single-day and renders empty without one, so an "all days"
      // deselect on the map must not follow the user back into the plan. Same day
      // the toggle would restore, so the two ways back agree.
      if (planner.selectedDayId == null) {
        const back = dayToRestore()
        if (back != null) planner.handleSelectDay(back, true)
      }
    }
  }

  const setListsTab = (tab: MTripListsTab) => {
    setListsTabState(tab)
    sessionStorage.setItem(`trip-lists-subtab-${tripId}`, tab)
  }

  const openSheet = (id: string, payload?: unknown) => setSheet({ id, payload })
  const closeSheet = () => setSheet(null)

  const shell: MTripShellApi = {
    view, mode, trTab, setTrTab, setTravelMode, toggleView, browseFromEdit,
    sheet, openSheet, closeSheet,
    listsTab, setListsTab, collabTab, setCollabTab,
    transportsCompact, bookingsCompact,
    addExpenseSignal, exportCostsCsvSignal, uploadFilesSignal, openFilesTrashSignal,
  }

  // Splash — same gate as the desktop page, in the mobile design language.
  if (planner.isLoading || !planner.splashDone) {
    return <MTripLoadingSplash title={trip?.title || ''} />
  }
  if (!trip) return null

  const enabledTabIds = new Set(planner.TRIP_TABS.map(tab => tab.id))
  const dockTabs = DOCK_TABS.filter(d => enabledTabIds.has(d.id))
  const tabLabel = (id: string) => planner.TRIP_TABS.find(tab => tab.id === id)?.label ?? id

  const onDayChipTap = (dayId: number) => {
    if (dayId === planner.selectedDayId) openSheet('day', { dayId })
    // In map mode a day tap fits to that day's places, draws its route and drops
    // the other days' pins, so the day it framed is the day it shows.
    else if (view === 'map') selectDayOnMap(dayId)
    else planner.handleSelectDay(dayId, true)
  }

  const packedCount = packingItems.filter(i => i.checked).length
  const todoOpenCount = todoItems.filter(i => !i.checked).length

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[color:var(--m-bg)] bg-[image:var(--m-scr)] text-m-ink">
      {/* ── Content layers ─────────────────────────────────────────────── */}
      {trTab === 'plan' && (
        <div className="absolute inset-0">
          <MapArea planner={planner} shell={shell} />
          {view === 'plan' && mode !== 'browse' && (
            <div className="absolute inset-0 z-10 bg-[color:var(--m-bg)] bg-[image:var(--m-scr)]">
              <PlanTimeline planner={planner} shell={shell} />
            </div>
          )}
          {mode === 'browse' && (
            <div className="absolute inset-0 z-30 bg-[color:var(--m-bg)] bg-[image:var(--m-scr)]">
              <PlacesBrowser planner={planner} shell={shell} />
            </div>
          )}
        </div>
      )}
      {trTab !== 'plan' && (
        <div className="absolute inset-0 z-30 bg-[color:var(--m-bg)] bg-[image:var(--m-scr)]">
          <TabPanel planner={planner} shell={shell} tab={trTab} />
        </div>
      )}

      {/* ── Day chips (z-25 — covered by non-plan tab overlays, stays mounted) ── */}
      {days.length > 0 && (
        <div className="absolute left-4 right-4 z-[25] flex gap-[6px] top-[calc(var(--m-safe-top,12px)+50px)]">
          <div className="flex flex-1 items-center gap-[2px] overflow-x-auto rounded-full border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] p-[3px] backdrop-blur-[24px] backdrop-saturate-[1.7]">
            {days.map((day, idx) => {
              const active = day.id === planner.selectedDayId
              const tint = dayTints[day.id]
              return (
                <button
                  key={day.id}
                  ref={el => { if (el) chipRefs.current.set(day.id, el); else chipRefs.current.delete(day.id) }}
                  type="button"
                  onClick={() => onDayChipTap(day.id)}
                  aria-current={active ? 'true' : undefined}
                  title={tint?.label || undefined}
                  // The chip is mobile's day-number badge, so it follows badgeTone.
                  // Inactive chips only — an inline background would otherwise beat
                  // the active chip's bg-m-act class.
                  style={active ? undefined : { background: dayTintBackground(tint, 'badge', '--day-tint-chip') }}
                  className={`flex flex-1 items-center justify-center gap-[3px] whitespace-nowrap rounded-full px-3 py-[5px] text-center text-[0.75rem] font-semibold ${
                    active ? 'bg-m-act text-m-actfg shadow-[0_6px_16px_-6px_rgba(0,0,0,.4)]' : 'text-m-ink'
                  }`}
                >
                  {dayChipLabel(day, language, t('planner.dayN', { n: day.day_number ?? idx + 1 }))}
                  {/* Marks the second tap as "opens the day", the only day-sheet
                      route that also exists in map view. */}
                  {active && <ChevronDown size={11} strokeWidth={2.6} aria-hidden="true" className="flex-none opacity-70" />}
                </button>
              )
            })}
          </div>
          {/* Drop the day filter and show the whole trip (#2257). Map only: the
              plan timeline is single-day, so there is nothing to widen there.
              Stays mounted while a day is active rather than appearing on
              selection, which would shove the rail sideways under the thumb. */}
          {view === 'map' && (
            <button
              type="button"
              onClick={toggleAllDays}
              aria-pressed={planner.selectedDayId == null}
              aria-label={t('mobileTrip.allDays')}
              title={t('mobileTrip.allDays')}
              className={`flex w-9 flex-none items-center justify-center rounded-full border border-[color:var(--m-gbr)] backdrop-blur-[24px] backdrop-saturate-[1.7] ${
                planner.selectedDayId == null
                  ? 'bg-m-act text-m-actfg shadow-[0_6px_16px_-6px_rgba(0,0,0,.4)]'
                  : 'bg-[color:var(--m-glass)] text-m-ink'
              }`}
            >
              <CalendarDays size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* ── Top controls (z-42 — above every layer incl. tab overlays) ── */}
      <div className="absolute left-4 right-4 z-[42] flex h-10 items-center justify-between top-[var(--m-safe-top,12px)]">
        <MIconBtn ariaLabel={t('common.back')} onClick={() => navigate('/dashboard')} className="backdrop-blur-[24px] backdrop-saturate-[1.7]">
          <ChevronLeft size={19} strokeWidth={2.2} />
        </MIconBtn>

        {trTab === 'plan' && (
          <GlassSegment>
            {([
              { value: 'go' as const, label: t('mobileTrip.travel') },
              { value: 'edit' as const, label: t('trip.mobilePlan') },
              { value: 'browse' as const, label: t('trip.mobilePlaces') },
            ]).map(seg => (
              <button
                key={seg.value}
                type="button"
                onClick={() => setTravelMode(seg.value)}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-[0.8125rem] ${
                  mode === seg.value && view !== 'map' ? 'bg-m-act font-semibold text-m-actfg' : 'font-medium text-m-ink'
                }`}
              >
                {seg.label}
              </button>
            ))}
          </GlassSegment>
        )}

        {trTab === 'transports' && (
          <div className="absolute left-[52px] right-2 top-1/2 flex -translate-y-1/2 items-center justify-center gap-[7px]">
            <PrimaryPill
              label={t('transport.addTransport')}
              onClick={() => {
                planner.setEditingTransport(null)
                planner.setTransitPrefill(null)
                planner.setTransportModalAutomated(false)
                planner.setShowTransportModal(true)
              }}
            />
            {planner.bookingImportAvailable && (
              <MIconBtn ariaLabel={t('reservations.import.title')} onClick={() => { planner.setBookingImportKind('transports'); planner.setShowBookingImport(true) }} size={40} className="text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]">
                <Download size={15} strokeWidth={2} />
              </MIconBtn>
            )}
            {planner.airTrailAvailable && (
              <MIconBtn ariaLabel={t('reservations.airtrail.title')} onClick={() => planner.setShowAirTrailImport(true)} size={40} className="text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]">
                <Plane size={15} strokeWidth={2} />
              </MIconBtn>
            )}
            <CompactToggle active={transportsCompact} onToggle={() => setTransportsCompact(v => !v)} label={t('mobileTrip.compactView')} />
          </div>
        )}

        {trTab === 'buchungen' && (
          <div className="absolute left-[52px] right-2 top-1/2 flex -translate-y-1/2 items-center justify-center gap-[7px]">
            <PrimaryPill
              label={t('mobileTrip.newReservation')}
              onClick={() => { planner.setEditingReservation(null); planner.setShowReservationModal(true) }}
            />
            {planner.bookingImportAvailable && (
              <MIconBtn ariaLabel={t('reservations.import.title')} onClick={() => { planner.setBookingImportKind('bookings'); planner.setShowBookingImport(true) }} size={40} className="text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]">
                <Download size={15} strokeWidth={2} />
              </MIconBtn>
            )}
            <CompactToggle active={bookingsCompact} onToggle={() => setBookingsCompact(v => !v)} label={t('mobileTrip.compactView')} />
          </div>
        )}

        {trTab === 'finanzplan' && (
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-[7px]">
            <PrimaryPill label={t('costs.addExpense')} onClick={() => setAddExpenseSignal(s => s + 1)} />
            <MIconBtn ariaLabel={t('budget.exportCsv')} onClick={() => setExportCostsCsvSignal(s => s + 1)} size={40} className="text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]">
              <FileDown size={15} strokeWidth={2} />
            </MIconBtn>
          </div>
        )}

        {trTab === 'listen' && (
          <GlassSegment>
            {([
              { value: 'packing' as const, label: t('todo.subtab.packing'), count: `${packedCount}/${packingItems.length}` },
              { value: 'todo' as const, label: t('todo.subtab.todo'), count: t('mobileTrip.todoOpenCount', { count: todoOpenCount }) },
            ]).map(seg => (
              <button
                key={seg.value}
                type="button"
                onClick={() => setListsTab(seg.value)}
                className={`flex items-center gap-[5px] whitespace-nowrap rounded-full px-4 py-2 text-[0.8125rem] ${
                  listsTab === seg.value ? 'bg-m-act font-semibold text-m-actfg' : 'font-medium text-m-ink'
                }`}
              >
                {seg.label}
                <span className="inline-flex rounded-full bg-[rgba(127,127,130,.22)] px-[7px] py-px font-geist text-[0.5625rem] font-bold leading-[1.6]">
                  {seg.count}
                </span>
              </button>
            ))}
          </GlassSegment>
        )}

        {trTab === 'collab' && (
          <GlassSegment>
            {([
              { value: 'chat' as const, label: t('collab.tabs.chat') },
              { value: 'notes' as const, label: t('collab.tabs.notes') },
              { value: 'polls' as const, label: t('collab.tabs.polls') },
            ]).map(seg => (
              <button
                key={seg.value}
                type="button"
                onClick={() => setCollabTab(seg.value)}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-[0.8125rem] ${
                  collabTab === seg.value ? 'bg-m-act font-semibold text-m-actfg' : 'font-medium text-m-ink'
                }`}
              >
                {seg.label}
              </button>
            ))}
          </GlassSegment>
        )}

        {trTab === 'dateien' && (
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-[7px]">
            <PrimaryPill icon={<Upload size={13} strokeWidth={2.2} />} label={t('common.upload')} onClick={() => setUploadFilesSignal(s => s + 1)} />
            <MIconBtn ariaLabel={t('files.trash')} onClick={() => setOpenFilesTrashSignal(s => s + 1)} size={40} className="text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]">
              <Trash2 size={15} strokeWidth={2} />
            </MIconBtn>
          </div>
        )}

        {/* A plugin tab is the only one that used to arrive without a name: it is
            not in the dock, so nothing was lit up there either, and the screen
            gave no clue which plugin was open. Same treatment as the others, from
            the tab entry the planner already builds (id, label, icon). */}
        {trTab.startsWith('plugin:') && (() => {
          const tab = planner.TRIP_TABS.find(x => x.id === trTab)
          if (!tab) return null
          const Icon = tab.icon
          return (
            <div className="pointer-events-none absolute left-[52px] right-[52px] top-1/2 flex -translate-y-1/2 items-center justify-center gap-[7px]">
              <div className="flex min-w-0 items-center gap-[7px] rounded-full border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] px-[13px] py-[7px] backdrop-blur-[24px] backdrop-saturate-[1.7]">
                {Icon && <Icon size={14} strokeWidth={2} className="flex-none text-m-muted" />}
                <span className="truncate text-[0.8125rem] font-semibold text-m-ink">{tab.label}</span>
              </div>
            </div>
          )
        })()}

        {trTab === 'plan' ? (
          <MIconBtn
            ariaLabel={view === 'plan' ? t('mobileTrip.mapView') : t('mobileTrip.listView')}
            onClick={toggleView}
            className="backdrop-blur-[24px] backdrop-saturate-[1.7]"
          >
            {view === 'plan' ? <MapIcon size={18} strokeWidth={2} /> : <List size={18} strokeWidth={2} />}
          </MIconBtn>
        ) : (
          <span className="w-[38px] flex-none" />
        )}
      </div>

      {/* ── Bottom dock (replaces the global bottom nav on this screen) ── */}
      <nav className="absolute left-4 right-4 z-40 flex h-[62px] items-center justify-around rounded-[31px] border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] px-[14px] shadow-[0_16px_44px_-14px_rgba(0,0,0,.35)] backdrop-blur-[30px] backdrop-saturate-[1.8] bottom-[calc(env(safe-area-inset-bottom,0px)+12px)]">
        {dockTabs.map(({ id, icon: Icon }) => {
          const active = trTab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTrTab(id)}
              aria-label={tabLabel(id)}
              aria-current={active ? 'page' : undefined}
              className={`flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full ${
                active ? 'bg-m-act text-m-actfg' : 'text-m-muted'
              }`}
            >
              <Icon size={19} strokeWidth={2} />
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => openSheet('mehr')}
          aria-label={t('mobileTrip.more')}
          className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full text-m-muted"
        >
          <MoreHorizontal size={19} strokeWidth={2.2} />
        </button>
      </nav>

      <Sheets planner={planner} shell={shell} />
    </div>
  )
}

/** Centre glass pill of the top controls (segments for plan/lists/collab). */
function GlassSegment({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 rounded-full border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] p-[3px] backdrop-blur-[24px] backdrop-saturate-[1.7]">
      {children}
    </div>
  )
}

/** Primary header action (Add transport / New reservation / Add expense / Upload). */
function PrimaryPill({ label, onClick, icon }: { label: string; onClick: () => void; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full bg-m-act px-[18px] text-[0.8125rem] font-semibold text-m-actfg shadow-[0_10px_24px_-10px_rgba(0,0,0,.45)]"
    >
      {icon ?? <Plus size={14} strokeWidth={2.2} />}
      {label}
    </button>
  )
}

/** 40px list-density toggle on the transports/bookings headers. */
function CompactToggle({ active, onToggle, label }: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-10 w-10 flex-none items-center justify-center rounded-full border ${
        active
          ? 'border-[color:var(--m-act)] bg-m-act text-m-actfg'
          : 'border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] text-m-muted backdrop-blur-[24px] backdrop-saturate-[1.7]'
      }`}
    >
      {active ? <Rows3 size={15} strokeWidth={2} /> : <List size={15} strokeWidth={2} />}
    </button>
  )
}
