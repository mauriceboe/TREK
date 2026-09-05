/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
interface DragDataPayload { placeId?: string; assignmentId?: string; noteId?: string; reservationId?: string; fromDayId?: string; phase?: 'single' | 'start' | 'middle' | 'end' }
declare global { interface Window { __dragData: DragDataPayload | null } }

import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { avatarSrc } from '../../utils/avatarSrc'
import { safeHttpUrl } from '../../utils/safeUrl'
import { ChevronDown, ChevronRight, ChevronUp, Compass, Navigation, RotateCcw, ExternalLink, Clock, Pencil, GripVertical, Ticket, Plus, FileText, Trash2, Car, Lock, Hotel, Footprints, Route as RouteIcon, Bookmark, StickyNote, TramFront, Zap } from 'lucide-react'
import { type PickedPlace } from './TransitSearchPanel'
import { assignmentsApi, reservationsApi, daysApi } from '../../api/client'
import { calculateRouteWithLegs, optimizeRoute, generateGoogleMapsUrl, generateCoMapsUrl, type NamedWaypoint } from '../Map/RouteCalculator'
import GoogleMapsIcon from '../shared/GoogleMapsIcon'
import PlaceAvatar from '../shared/PlaceAvatar'
import ConfirmDialog from '../shared/ConfirmDialog'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import WeatherWidget from '../Weather/WeatherWidget'
import { useToast } from '../shared/Toast'
import { getCategoryIcon } from '../shared/categoryIcons'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useAddonStore } from '../../store/addonStore'
import { usePluginStore } from '../../store/pluginStore'
import { useSaveToCollectionStore } from '../../store/saveToCollectionStore'
import { placeToSaveTarget } from '../Collections/saveTarget'
import { useTranslation } from '../../i18n'
import { isDayInAccommodationRange, getAccommodationAnchors, getDayBookendHotels, shouldDrawMorningLeg, shouldDrawEveningLeg, type CarrierEdge } from '../../utils/dayOrder'
import {
  TRANSPORT_TYPES, parseTimeToMinutes, getSpanPhase, hidesOnMiddleDay, getDisplayTimeForDay, getTransportRouteEndpoints,
  getTransportForDay as _getTransportForDay, getMergedItems as _getMergedItems, isCarrierTransport, hasCarrierEndpointOnDay,
  getAssignmentReservations,
  type MergedItem,
} from '../../utils/dayMerge'
import { withinDriveRange } from '../../utils/geo'
import { formatDate, formatTime, dayTotalCost, formatMoneySum, splitReservationDateTime } from '../../utils/formatters'
import { useDayNotes } from '../../hooks/useDayNotes'
import { useExchangeRates } from '../../hooks/useExchangeRates'
import { RES_ICONS, getNoteIcon } from './DayPlanSidebar.constants'
import { noteSurface } from './noteSurface'
import { findTodayDayId } from './today'
import { markdownLinkComponents } from '../shared/markdownLink'
import { RouteConnector, HotelRouteConnector } from './DayPlanSidebarRouteConnector'
import { resolveLegMode } from './legMode'
import { usePluginDaySchedule, usePluginDayTints, dayTintBackground, dayTinted, PluginDayScheduleRow, formatScheduleMinutes } from '../Plugins/PluginDaySchedule'
import { MobileAddPlaceButton } from './DayPlanSidebarMobileAddPlaceButton'
import { DayPlanSidebarToolbar } from './DayPlanSidebarToolbar'
import { DayPlanSidebarNoteModal } from './DayPlanSidebarNoteModal'
import { DayPlanSidebarTimeConfirmModal } from './DayPlanSidebarTimeConfirmModal'
import { DayPlanSidebarTransportDetailModal } from './DayPlanSidebarTransportDetailModal'
import { TransitTitle, TransitLegChips, TransitItineraryInline } from './transitDisplay'
import { DayPlanSidebarFooter } from './DayPlanSidebarFooter'
import type { Trip, Day, Place, Category, Assignment, Accommodation, Reservation, AssignmentsMap, RouteResult, RouteSegment, DayNote } from '../../types'
import { getNavigationTargets, openNavigationTarget } from './placeNavigation'

interface DayPlanSidebarProps {
  tripId: number
  trip: Trip
  days: Day[]
  places: Place[]
  categories: Category[]
  assignments: AssignmentsMap
  selectedDayId: number | null
  selectedPlaceId: number | null
  selectedAssignmentId: number | null
  onSelectDay: (dayId: number | null, skipFit?: boolean) => void
  onPlaceClick: (placeId: number | null, assignmentId?: number | null) => void
  onDayDetail: (day: Day | null) => void
  accommodations?: Accommodation[]
  onReorder: (dayId: number, orderedIds: number[]) => void
  onReorderDays?: (orderedIds: number[]) => void
  onAddDay?: (position?: number) => void
  /** Renaming lives in the day-detail panel (#1065); the sidebar only forwards the prop. */
  onUpdateDayTitle: (dayId: number, title: string) => void
  /** The day route is computed by the planner page itself; kept for the existing call sites. */
  onRouteCalculated: (route: RouteResult | null) => void
  onAssignToDay: (placeId: number, dayId: number, position?: number) => void
  onRemoveAssignment: (dayId: number, assignmentId: number) => void
  onEditPlace: (place: Place, assignmentId?: number) => void
  onDeletePlace: (placeId: number) => void
  reservations?: Reservation[]
  visibleConnectionIds?: number[]
  onToggleConnection?: (reservationId: number) => void
  allConnectionsShown?: boolean
  onToggleAllConnections?: () => void
  externalTransportDetail?: Reservation | null
  onExternalTransportDetailHandled?: () => void
  onAddReservation: (dayId: number) => void
  onNavigateToFiles?: () => void
  routeShown?: boolean
  routeProfile?: string
  onToggleRoute?: () => void
  onSetRouteProfile?: (profile: string) => void
  onAddPlace?: () => void
  onAddPlaceToDay?: (placeId: number, dayId: number) => void
  onExpandedDaysChange?: (expandedDayIds: Set<number>) => void
  pushUndo?: (label: string, undoFn: () => Promise<void> | void) => void
  canUndo?: boolean
  lastActionLabel?: string | null
  onUndo?: () => void
  onRouteRefresh?: () => void
  onAddTransport?: (dayId: number) => void
  /** Opens the public-transit route search for a day (#1065). */
  onPlanTransit?: (dayId: number) => void
  /**
   * Opens the public-transit search pre-filled for a single leg (#1281 follow-up):
   * the leg's origin and destination endpoints plus the origin's departure time,
   * so "public transport" becomes an option on any connector, not just the day header.
   */
  onPlanTransitLeg?: (leg: { dayId: number; from: PickedPlace; to: PickedPlace; time: string | null }) => void
  /** Opens the journey view for a saved transit entry (#1065). */
  onOpenTransit?: (reservation: Reservation) => void
  onEditTransport?: (reservation: Reservation) => void
  onEditReservation?: (reservation: Reservation) => void
  onAddBookingToAssignment?: (dayId: number, assignmentId: number) => void
  initialScrollTop?: number
  onScrollTopChange?: (top: number) => void
  /** Mobile: show the route tools footer (Route toggle / Optimize / travel profile) on expanded days, since selecting a day closes the sheet */
  showRouteToolsWhenExpanded?: boolean
  isMobile?: boolean
}

/**
 * Day-plan state + behaviour: expand/collapse, inline title edit, route legs +
 * optimisation, day notes, and the drag-and-drop reorder/move machinery across
 * days (places, transports, notes). Returns everything the timeline view renders
 * from, keeping DayPlanSidebar a thin shell over one large day list.
 */
function useDayPlanSidebar(props: DayPlanSidebarProps) {
  const {
  tripId,
  trip, days, places, categories, assignments,
  selectedDayId, selectedPlaceId, selectedAssignmentId,
  onSelectDay, onPlaceClick, onDayDetail, accommodations = [],
  onReorder, onReorderDays, onAddDay,
  onAssignToDay, onRemoveAssignment, onEditPlace, onDeletePlace,
  reservations = [],
  visibleConnectionIds = [],
  onToggleConnection,
  allConnectionsShown = false,
  onToggleAllConnections,
  externalTransportDetail,
  onExternalTransportDetailHandled,
  onAddReservation,
  onAddPlace,
  onAddPlaceToDay,
  onNavigateToFiles,
  routeShown = false,
  routeProfile = 'driving',
  onToggleRoute,
  onSetRouteProfile,
  onExpandedDaysChange,
  pushUndo,
  canUndo = false,
  lastActionLabel = null,
  onUndo,
  onRouteRefresh,
  onAddTransport,
  onPlanTransit,
  onPlanTransitLeg,
  onOpenTransit,
  onEditTransport,
  onEditReservation,
  onAddBookingToAssignment,
  initialScrollTop,
  onScrollTopChange,
  showRouteToolsWhenExpanded = false,
  isMobile = false,
  } = props
  // Below lg the plan and the places sit in separate tabs, so there is nothing
  // to drag between. A coarse pointer is no longer a reason of its own: tablets
  // reach the same drag through a long press (#1616).
  const dragDisabled = isMobile
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const ctxMenu = useContextMenu()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const tripActions = useRef(useTripStore.getState()).current
  const can = useCanDo()
  const canEditDays = can('day_edit', trip)
  // The calendar subscription hands out a link that reads the trip without an
  // account, so it sits behind the same permission as the public share link.
  const canManageShare = can('share_manage', trip)

  const { noteUi, setNoteUi, noteInputRef, dayNotes, openAddNote: _openAddNote, openEditNote: _openEditNote, cancelNote, saveNote, deleteNote: _deleteNote, moveNote: _moveNote } = useDayNotes(tripId)

  const [expandedDays, setExpandedDays] = useState(() => {
    try {
      const saved = localStorage.getItem(`day-expanded-${tripId}`)
      if (saved) return new Set<number>(JSON.parse(saved) as number[])
    } catch {}
    return new Set<number>(days.map(d => d.id))
  })
  useEffect(() => { onExpandedDaysChange?.(expandedDays) }, [expandedDays])
  // Per-segment legs keyed by day id, then by the start place's assignment id (or the
  // transport's reservation id). Nested per day so several Route-toggled mobile days
  // can't collide in one flat map — assignment ids and reservation ids come from
  // independent sequences and would overwrite each other across days (#1374).
  const [routeLegs, setRouteLegs] = useState<Record<number, Record<number, RouteSegment>>>({})
  // Hotel bookend legs keyed by day id. Desktop keys only the selected day; mobile
  // keys every day whose Route toggle is on, so each shows its own bookends (#1374).
  const [hotelLegs, setHotelLegs] = useState<Record<number, { top?: { seg: RouteSegment; name: string; targetId?: number }; bottom?: { seg: RouteSegment; name: string; targetId?: number } }>>({})
  // Mobile only: days the user tapped "Route" on. Their leg distances show inline in
  // the expanded day, so seeing distances doesn't require selecting the day (which
  // closes the mobile sheet) — #1374.
  const [expandedRouteDayIds, setExpandedRouteDayIds] = useState<Set<number>>(new Set())
  const optimizeFromAccommodation = useSettingsStore(s => s.settings.optimize_from_accommodation)
  // Recompute the hotel/route legs when the user flips km↔mi so the connector
  // distances refresh instead of showing stale cached text (#1300).
  const distanceUnit = useSettingsStore(s => s.settings.distance_unit)
  const legsAbortRef = useRef<AbortController | null>(null)
  const [draggingId, setDraggingId] = useState(null)
  const [lockedIds, setLockedIds] = useState(new Set())
  const [lockHoverId, setLockHoverId] = useState(null)
  const [undoHover, setUndoHover] = useState(false)
  const [hoveredAssignmentId, setHoveredAssignmentId] = useState<number | null>(null)
  // Transit rows fold their itinerary out inline (#1065).
  const [expandedTransitIds, setExpandedTransitIds] = useState<Set<number>>(new Set())
  const [dropTargetKey, _setDropTargetKey] = useState(null)
  const dropTargetRef = useRef(null)
  const setDropTargetKey = (key) => { dropTargetRef.current = key; _setDropTargetKey(key) }
  const [dragOverDayId, setDragOverDayId] = useState(null)
  const [transportDetail, setTransportDetail] = useState(null)
  const [transportPosVersion, setTransportPosVersion] = useState(0)

  useEffect(() => {
    if (externalTransportDetail) {
      setTransportDetail(externalTransportDetail)
      onExternalTransportDetailHandled?.()
    }
  }, [externalTransportDetail, onExternalTransportDetailHandled])
  const [timeConfirm, setTimeConfirm] = useState<{
    dayId: number; fromId: number; time: string;
    // Target slot of the pending move — drag & drop and the arrow buttons both
    // describe it as "put fromId before/after this merged row".
    fromType?: string; toType?: string; toId?: number; insertAfter?: boolean; toLegIndex?: number | null;
  } | null>(null)
  const dragDataRef = useRef(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const dayRefs = useRef<Map<number, HTMLElement>>(new Map())

  /** The day that is today, or null when the trip is not running right now. */
  const todayDayId = useMemo(() => findTodayDayId(days), [days])

  const scrollToDay = useCallback((dayId: number) => {
    const el = dayRefs.current.get(dayId)
    const container = scrollContainerRef.current
    if (!el || !container) return
    // Positioned against the container, not scrollIntoView: the sidebar sits in
    // a page that also scrolls, and scrollIntoView would drag the whole layout
    // around to satisfy a scroll inside one column.
    container.scrollTo({ top: el.offsetTop - container.offsetTop - 8, behavior: 'smooth' })
  }, [])

  const jumpToToday = useCallback(() => {
    if (todayDayId == null) return
    onSelectDay(todayDayId, true)
    setExpandedDays(prev => new Set(prev).add(todayDayId))
    // After the expand has rendered, or the target is measured at its old height.
    requestAnimationFrame(() => scrollToDay(todayDayId))
  }, [todayDayId, onSelectDay, scrollToDay])

  // On opening a trip that is running, land on today rather than on day 1 (#1567).
  // Once per mount, and only while nothing is selected yet: a deep link into a
  // specific day, or a day the user picked before switching tabs, must win.
  const autoJumpedRef = useRef(false)
  useEffect(() => {
    if (autoJumpedRef.current || todayDayId == null || selectedDayId != null || days.length === 0) return
    autoJumpedRef.current = true
    jumpToToday()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayDayId, days.length])
  useLayoutEffect(() => {
    if (scrollContainerRef.current && initialScrollTop) {
      scrollContainerRef.current.scrollTop = initialScrollTop
    }
  }, [])
  const initedTransportIds = useRef(new Set<number>()) // Speichert Drag-Daten als Backup (dataTransfer geht bei Re-Render verloren)
  // Remember which assignment we last auto-scrolled into view so we don't
  // keep yanking the user back whenever they scroll away while the same
  // place stays selected.
  const lastAutoScrolledIdRef = useRef<string | number | null>(null)
  useEffect(() => {
    // Reset the scroll-lock whenever selection moves, so the next selected
    // row triggers a fresh scroll-into-view on its ref.
    if (!selectedAssignmentId && !selectedPlaceId) {
      lastAutoScrolledIdRef.current = null
    }
  }, [selectedAssignmentId, selectedPlaceId])

  const currency = trip?.currency || 'EUR'
  // Cost totals render in the user's display currency (falling back to the
  // trip's), converting foreign-currency place prices via live FX rates —
  // same base resolution as BookingCostsSection / the Costs panel (#1561).
  const displayCurrency = useSettingsStore(s => s.settings.default_currency)
  const costBase = (displayCurrency || currency).toUpperCase()
  const { rates: fxRates } = useExchangeRates(costBase)

  // Drag-Daten aus dataTransfer, Ref oder window lesen (dataTransfer geht bei Re-Render verloren)
  const getDragData = (e) => {
    const dt = e?.dataTransfer
    // Interner Drag hat Vorrang (Ref wird nur bei assignmentId/noteId/reservationId gesetzt)
    if (dragDataRef.current) {
      return {
        placeId: '',
        assignmentId: dragDataRef.current.assignmentId || '',
        noteId: dragDataRef.current.noteId || '',
        reservationId: dragDataRef.current.reservationId || '',
        fromDayId: Number.parseInt(dragDataRef.current.fromDayId) || 0,
        phase: (dragDataRef.current.phase || 'single') as 'single' | 'start' | 'middle' | 'end',
      }
    }
    // Externer Drag (aus PlacesSidebar)
    const ext = window.__dragData || {}
    const placeId = dt?.getData('placeId') || ext.placeId || ''
    return { placeId, assignmentId: '', noteId: '', reservationId: '', fromDayId: 0, phase: 'single' as const }
  }

  // Only auto-expand genuinely new days (not on initial load from storage)
  const prevDayCount = React.useRef(days.length)
  useEffect(() => {
    if (days.length > prevDayCount.current) {
      // New days added — expand only those
      setExpandedDays(prev => {
        const n = new Set(prev)
        days.forEach(d => { if (!prev.has(d.id)) n.add(d.id) })
        try { localStorage.setItem(`day-expanded-${tripId}`, JSON.stringify([...n])) } catch {}
        return n
      })
    }
    prevDayCount.current = days.length
  }, [days.length, tripId])

  // Globaler Aufräum-Listener: wenn ein Drag endet ohne Drop, alles zurücksetzen
  useEffect(() => {
    const cleanup = () => {
      setDraggingId(null)
      setDropTargetKey(null)
      setDragOverDayId(null)
      dragDataRef.current = null
      window.__dragData = null
    }
    document.addEventListener('dragend', cleanup)
    return () => document.removeEventListener('dragend', cleanup)
  }, [])

  // Initialize missing transport positions outside of render to avoid setState-during-render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { days.forEach(day => initTransportPositions(day.id)) }, [days, reservations])

  const toggleDay = (dayId, e) => {
    e.stopPropagation()
    setExpandedDays(prev => {
      const n = new Set(prev)
      n.has(dayId) ? n.delete(dayId) : n.add(dayId)
      try { localStorage.setItem(`day-expanded-${tripId}`, JSON.stringify([...n])) } catch {}
      return n
    })
  }

  // Get phase label for multi-day badge
  const getSpanLabel = (r: Reservation, phase: string): string | null => {
    if (phase === 'single') return null
    if (r.type === 'flight') return t(`reservations.span.${phase === 'start' ? 'departure' : phase === 'end' ? 'arrival' : 'inTransit'}`)
    if (r.type === 'car') return t(`reservations.span.${phase === 'start' ? 'pickup' : phase === 'end' ? 'return' : 'active'}`)
    // Parking reuses span.pickup for its end day on purpose: you drop the car off and
    // later pick it up again, so the rental car's wording fits without a second key.
    if (r.type === 'parking') return t(`reservations.span.${phase === 'start' ? 'dropOff' : phase === 'end' ? 'pickup' : 'ongoing'}`)
    return t(`reservations.span.${phase === 'start' ? 'start' : phase === 'end' ? 'end' : 'ongoing'}`)
  }

  const getDayOrder = (day: (typeof days)[number]) => (day as any).day_number ?? days.indexOf(day)

  const computeMultiDayMove = (r: Reservation, targetDayId: number, phase: 'single' | 'start' | 'middle' | 'end') => {
    const startId = r.day_id ?? targetDayId
    const endId = r.end_day_id ?? startId
    const order = (id: number) => { const d = days.find(x => x.id === id); return d ? getDayOrder(d) : 0 }
    if (phase === 'single' || startId === endId) return { day_id: targetDayId, end_day_id: targetDayId }
    if (phase === 'start') {
      if (order(targetDayId) > order(endId)) return { day_id: targetDayId, end_day_id: targetDayId }
      return { day_id: targetDayId, end_day_id: endId }
    }
    // phase === 'end'
    if (order(targetDayId) < order(startId)) return { day_id: targetDayId, end_day_id: targetDayId }
    return { day_id: startId, end_day_id: targetDayId }
  }

  const getTransportForDay = (dayId: number) =>
    _getTransportForDay({ reservations, dayId, dayAssignmentIds: (assignments[String(dayId)] || []).map(a => a.id), days })

  // Get car rentals that are in "active" (middle) phase for a day — shown in day header, not timeline
  const getActiveRentalsForDay = (dayId: number) => {
    return reservations.filter(r => {
      if (r.type !== 'car') return false
      const startDayId = r.day_id
      const endDayId = r.end_day_id
      if (!startDayId || !endDayId || endDayId === startDayId) return false
      const startDay = days.find(d => d.id === startDayId)
      const endDay = days.find(d => d.id === endDayId)
      const thisDay = days.find(d => d.id === dayId)
      if (!startDay || !endDay || !thisDay) return false
      return getDayOrder(thisDay) > getDayOrder(startDay) && getDayOrder(thisDay) < getDayOrder(endDay)
    })
  }

  const getDayAssignments = (dayId) =>
    (assignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)

  // Compute initial day_plan_position for a transport based on time
  const computeTransportPosition = (r, da) => {
    const minutes = parseTimeToMinutes(r.reservation_time) ?? 0
    // Find the last place with time <= transport time
    let afterIdx = -1
    for (const a of da) {
      const pm = parseTimeToMinutes(a.place?.place_time)
      if (pm !== null && pm <= minutes) afterIdx = a.order_index
    }
    // Position: midpoint between afterIdx and afterIdx+1 (leaves room for other items)
    return afterIdx >= 0 ? afterIdx + 0.5 : da.length + 0.5
  }

  // Auto-initialize transport positions on first render if not set
  const initTransportPositions = (dayId) => {
    const da = getDayAssignments(dayId)
    const transport = getTransportForDay(dayId)
    const needsInit = transport.filter(r => r.day_plan_position == null && !initedTransportIds.current.has(r.id))
    if (needsInit.length === 0) return

    const sorted = [...needsInit].sort((a, b) =>
      (parseTimeToMinutes(a.reservation_time) ?? 0) - (parseTimeToMinutes(b.reservation_time) ?? 0)
    )
    const positions = sorted.map((r, idx) => ({
      id: r.id,
      day_plan_position: computeTransportPosition(r, da) + idx * 0.01,
    }))
    // Mark as initialized immediately to prevent re-entry
    for (const p of positions) initedTransportIds.current.add(p.id)
    const before = positions.map(p => ({
      id: p.id,
      day_plan_position: useTripStore.getState().reservations.find(r => r.id === p.id)?.day_plan_position ?? null,
    }))
    // Update store so subscribers see the new positions
    useTripStore.setState(state => ({
      reservations: state.reservations.map(r => {
        const p = positions.find(x => x.id === r.id)
        if (!p) return r
        return { ...r, day_plan_position: p.day_plan_position }
      })
    }))
    // Persist to server. No toast — this is a bootstrap write nobody asked for —
    // but the store has to go back to what the server still holds, otherwise the
    // day shows an order that only exists in this tab.
    // The ids stay marked as initialised: the effect reruns on every reservations
    // change, so clearing them here would retry the same failing write in a loop.
    reservationsApi.updatePositions(tripId, positions).catch(() => {
      useTripStore.setState(state => ({
        reservations: state.reservations.map(r => {
          const p = before.find(x => x.id === r.id)
          if (!p) return r
          return { ...r, day_plan_position: p.day_plan_position }
        })
      }))
    })
  }

  const getMergedItems = (dayId: number): MergedItem[] =>
    _getMergedItems({
      dayAssignments: getDayAssignments(dayId),
      dayNotes: (dayNotes[String(dayId)] || []).slice().sort((a, b) => a.sort_order - b.sort_order),
      dayTransports: getTransportForDay(dayId),
      dayId,
      getDisplayTime: getDisplayTimeForDay,
    })

  // Pre-compute merged items for all days so the render loop doesn't recompute on unrelated state changes (e.g. hover)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mergedItemsMap = useMemo(() => {
    const map: Record<number, ReturnType<typeof getMergedItems>> = {}
    days.forEach(day => { map[day.id] = getMergedItems(day.id) })
    return map
  // getMergedItems is redefined each render but captures assignments/dayNotes/reservations/days via closure
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, assignments, dayNotes, reservations, transportPosVersion])

  // Days whose inline route legs should be computed & shown. Desktop: the selected
  // day while the Route toggle is on. Mobile: each expanded day the user tapped
  // "Route" on — shown inline so seeing distances between places doesn't require
  // selecting the day, which would close the mobile sheet (#1374).
  const routeDayIds = useMemo<number[]>(() => (
    showRouteToolsWhenExpanded
      ? days.filter(d => expandedRouteDayIds.has(d.id) && expandedDays.has(d.id)).map(d => d.id)
      : (routeShown && selectedDayId ? [selectedDayId] : [])
  ), [showRouteToolsWhenExpanded, expandedRouteDayIds, expandedDays, days, routeShown, selectedDayId])
  const routeDayKey = routeDayIds.join(',')

  // Per-segment travel times shown as connectors between a day's located stops.
  // Groups located places into runs (split at transports), one cached OSRM call per
  // run keyed by the start place's assignment id, plus the hotel bookend legs. Shares
  // RouteCalculator's cache with the map. Runs for every day in routeDayIds — one
  // selected day on desktop, each Route-toggled day on mobile (#1374).
  useEffect(() => {
    if (legsAbortRef.current) legsAbortRef.current.abort()
    if (routeDayIds.length === 0) { setRouteLegs({}); setHotelLegs({}); return }

    const hotelName = (a: Accommodation) => (a as any).place_name || (a as any).reservation_title || ''

    // Pure per-day plan: the drive runs (each ≥2 waypoints) and which hotel bookend
    // legs to draw. Side-effect free, so the async loop below only does OSRM I/O.
    const planDay = (dayId: number) => {
      const merged = mergedItemsMap[dayId] || []
      // Each run point carries the ORIGIN assignment's per-segment travel mode
      // (#1281): the leg from this point to the next is routed with `mode` (null =
      // inherit the day default). Transport endpoints carry no mode → day default.
      const runs: { id: number; lat: number; lng: number; isPlace: boolean; leg_transport_mode?: string | null; incoming_leg_transport_mode?: string | null }[][] = []
      let cur: { id: number; lat: number; lng: number; isPlace: boolean; leg_transport_mode?: string | null; incoming_leg_transport_mode?: string | null }[] = []
      // A run is only a real drive when it holds an actual place. Two back-to-back
      // transports (e.g. two flights on one day) would otherwise pair the first's
      // arrival with the second's departure into a phantom airport→airport leg — the
      // flight, not a drive — and surface it as a bogus connector distance (#1394).
      let curHasPlace = false
      for (const it of merged) {
        if (it.type === 'place' && it.data.place?.lat && it.data.place?.lng) {
          // Mirror of the guard below: the open run may hold nothing but a far-away
          // arrival endpoint, which is no more drivable in this direction (#2133).
          const prev = cur[cur.length - 1]
          if (prev && !prev.isPlace && !withinDriveRange(prev, { lat: it.data.place.lat, lng: it.data.place.lng })) {
            if (cur.length >= 2 && curHasPlace) runs.push(cur)
            cur = []
            curHasPlace = false
          }
          cur.push({ id: it.data.id, lat: it.data.place.lat, lng: it.data.place.lng, isPlace: true, leg_transport_mode: it.data.leg_transport_mode ?? null, incoming_leg_transport_mode: it.data.incoming_leg_transport_mode ?? null })
          curHasPlace = true
        } else if (it.type === 'transport') {
          const r = it.data
          const { from, to } = getTransportRouteEndpoints(r, dayId)
          if (from || to) {
            // Located transport: route to its departure point, break the run (the
            // flight/train itself isn't driven), and let its arrival start the next.
            // ...but only when you could have driven there from the stop before it. A
            // long-haul departure airport that sorted in after the day's local stops is
            // not the end of a drive, and pairing them produces a phantom connector with
            // an ocean-crossing distance (#2133).
            const prev = cur[cur.length - 1]
            if (from && (!prev || withinDriveRange(prev, from))) cur.push({ id: r.id, lat: from.lat, lng: from.lng, isPlace: false })
            if (cur.length >= 2 && curHasPlace) runs.push(cur)
            cur = []
            curHasPlace = false
            if (to) cur.push({ id: r.id, lat: to.lat, lng: to.lng, isPlace: false })
          } else if (cur.length > 0 && !(r.type === 'car' && getSpanPhase(r, dayId) === 'middle') && !hidesOnMiddleDay(r, dayId)) {
            // No location: ignore for routing, but attribute the through-leg to the
            // booking so its distance/duration shows under it (purely cosmetic).
            // Not for a car rental's middle days or a multi-day parking's though:
            // those rows aren't rendered in the timeline, so re-keying would drop
            // the leg entirely (#1504).
            cur[cur.length - 1] = { ...cur[cur.length - 1], id: r.id }
          }
        }
      }
      if (cur.length >= 2 && curHasPlace) runs.push(cur)

      // Hotel bookend legs: the drive from the day's accommodation to the first located
      // waypoint of the day (morning) and from the last one back to it (evening). Only when
      // the "optimize from accommodation" setting is on and the day has a hotel.
      const day = days.find(d => d.id === dayId)
      const bookends = day && optimizeFromAccommodation !== false
        ? getDayBookendHotels(day, days, accommodations)
        : null
      const startHotel = bookends?.morning
      const endHotel = bookends?.evening
      // Waypoints include transport endpoints (a car return, a taxi/train arrival), so the hotel
      // legs connect even when the day starts or ends with a booking rather than a place. Track
      // whether each is a place and its time so the bookend decision can drop a leg that isn't
      // real: a check-in hotel never drove to a departure airport (#1321), and a place timed before
      // check-in / after check-out means you weren't at the hotel then (#1465).
      // A carrier endpoint (flight/train/ferry/cruise/coach — not a hire car you keep
      // driving) also records WHICH end it is, so the hotel leg can be dropped when it
      // is one you flew out of or landed at rather than drove between (#2133).
      const wayPts: { lat: number; lng: number; isPlace: boolean; time: string | null; carrierEdge?: CarrierEdge; leg_transport_mode?: string | null; incoming_leg_transport_mode?: string | null; id?: number }[] = []
      for (const it of merged) {
        if (it.type === 'place' && it.data.place?.lat && it.data.place?.lng) {
          wayPts.push({ lat: it.data.place.lat, lng: it.data.place.lng, isPlace: true, time: it.data.place?.place_time ?? null, leg_transport_mode: it.data.leg_transport_mode ?? null, incoming_leg_transport_mode: it.data.incoming_leg_transport_mode ?? null, id: it.data.id })
        } else if (it.type === 'transport') {
          const { from, to } = getTransportRouteEndpoints(it.data, dayId)
          const carrier = isCarrierTransport(it.data)
          if (from) wayPts.push({ lat: from.lat, lng: from.lng, isPlace: false, time: null, carrierEdge: carrier ? 'departure' : null })
          if (to) wayPts.push({ lat: to.lat, lng: to.lng, isPlace: false, time: null, carrierEdge: carrier ? 'arrival' : null })
        }
      }
      const firstWay = wayPts[0]
      const lastWay = wayPts[wayPts.length - 1]
      const reachable = (h: { place_lat?: number | null; place_lng?: number | null } | undefined, w: typeof firstWay) =>
        !h || !w || w.isPlace || h.place_lat == null || h.place_lng == null
        || withinDriveRange({ lat: h.place_lat, lng: h.place_lng }, w)
      // Same carrier evidence the map route uses (#2157): with a located carrier
      // endpoint on the day, the no-time default must not open a hotel leg.
      const dayHasCarrier = wayPts.some(w => w.carrierEdge != null)
      const wantTop = !!(startHotel && firstWay && bookends && day && shouldDrawMorningLeg(bookends, day, firstWay, dayHasCarrier)) && reachable(startHotel, firstWay)
      const wantBottom = !!(endHotel && lastWay && bookends && day && shouldDrawEveningLeg(bookends, day, lastWay, dayHasCarrier)) && reachable(endHotel, lastWay)
      return { runs, startHotel, endHotel, firstWay, lastWay, wantTop, wantBottom }
    }

    const controller = new AbortController()
    legsAbortRef.current = controller
    ;(async () => {
      const legsByDay: Record<number, Record<number, RouteSegment>> = {}
      const hotelByDay: Record<number, { top?: { seg: RouteSegment; name: string; targetId?: number }; bottom?: { seg: RouteSegment; name: string; targetId?: number } }> = {}

      // One cached OSRM/plugin call per waypoint pair; shares RouteCalculator's cache.
      // tripId/dayId ride along for plugin route profiles (the server access-checks them).
      // Resolve a leg's mode (#1281): an explicit per-segment override wins, then
      // the day's saved default, then the live picker value. Sticky by design — the
      // day default never touches a leg that carries its own mode.
      const dayDefaultMode = (dayId: number): string =>
        days.find(d => d.id === dayId)?.default_transport_mode || routeProfile

      const legBetween = async (a: { lat: number; lng: number }, b: { lat: number; lng: number }, dayId: number, mode: string): Promise<RouteSegment | undefined> => {
        try {
          const r = await calculateRouteWithLegs([a, b], { signal: controller.signal, profile: mode, tripId, dayId })
          return r.legs[0] ? { ...r.legs[0], mode } : undefined
        } catch { return undefined }
      }

      // Collect every leg of every day first, then fetch them a few at a time.
      // Each result is stored under its own key, so nothing here depends on the
      // order they come back in — which is what lets them overlap at all.
      const tasks: (() => Promise<void>)[] = []

      for (const dayId of routeDayIds) {
        const { runs, startHotel, endHotel, firstWay, lastWay, wantTop, wantBottom } = planDay(dayId)
        const dfMode = dayDefaultMode(dayId)
        const dayLegs: Record<number, RouteSegment> = {}
        legsByDay[dayId] = dayLegs
        for (const run of runs) {
          // One routing call per LEG, each with its own resolved mode, so a day can
          // mix walking/driving/plugin legs. RouteCalculator's cache is keyed per
          // profile+coords, so per-leg calls stay cheap (a single-mode day reuses
          // the same entries) and each leg is tagged with the mode it was drawn in.
          for (let i = 0; i < run.length - 1; i++) {
            const from = run[i]
            const to = run[i + 1]
            const mode = resolveLegMode(from, to, dfMode)
            tasks.push(async () => {
              const seg = await legBetween({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, dayId, mode)
              if (seg) dayLegs[from.id] = seg
            })
          }
        }
        const hotel: { top?: { seg: RouteSegment; name: string; targetId?: number }; bottom?: { seg: RouteSegment; name: string; targetId?: number } } = {}
        hotelByDay[dayId] = hotel
        if (wantTop) {
          const mode = resolveLegMode({ isPlace: false }, firstWay!, dfMode)
          tasks.push(async () => {
            const seg = await legBetween({ lat: startHotel!.place_lat as number, lng: startHotel!.place_lng as number }, { lat: firstWay!.lat, lng: firstWay!.lng }, dayId, mode)
            if (seg) hotel.top = { seg, name: hotelName(startHotel!), targetId: firstWay!.isPlace ? firstWay!.id : undefined }
          })
        }
        if (wantBottom) {
          const mode = resolveLegMode(lastWay!, { isPlace: false }, dfMode)
          tasks.push(async () => {
            const seg = await legBetween({ lat: lastWay!.lat, lng: lastWay!.lng }, { lat: endHotel!.place_lat as number, lng: endHotel!.place_lng as number }, dayId, mode)
            if (seg) hotel.bottom = { seg, name: hotelName(endHotel!), targetId: lastWay!.isPlace ? lastWay!.id : undefined }
          })
        }
      }

      // Small pool on purpose: a week of days is dozens of legs and the routing
      // host is often a shared OSRM.
      let nextTask = 0
      const runTasks = async () => {
        while (nextTask < tasks.length && !controller.signal.aborted) await tasks[nextTask++]()
      }
      await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, runTasks))

      if (controller.signal.aborted) return
      // Days that ended up without a single leg were never in the map before.
      for (const dayId of Object.keys(legsByDay).map(Number)) {
        if (!Object.keys(legsByDay[dayId]).length) delete legsByDay[dayId]
      }
      for (const dayId of Object.keys(hotelByDay).map(Number)) {
        if (!hotelByDay[dayId].top && !hotelByDay[dayId].bottom) delete hotelByDay[dayId]
      }
      setRouteLegs(legsByDay)
      setHotelLegs(hotelByDay)
    })()
    // routeDayIds is memoized from the same inputs as routeDayKey below, so keying the
    // effect on the string is equivalent while staying stable across unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDayKey, routeProfile, mergedItemsMap, accommodations, days, optimizeFromAccommodation, distanceUnit])

  const openAddNote = (dayId, e) => {
    e?.stopPropagation()
    _openAddNote(dayId, getMergedItems, (id) => {
      if (!expandedDays.has(id)) setExpandedDays(prev => new Set([...prev, id]))
    })
  }

  const openEditNote = (dayId: number, note: DayNote) => _openEditNote(dayId, note)

  // Deleting a note asks for confirmation first — the edit/delete icons sit close together and are
  // easy to mis-tap on touch devices, where an accidental delete was previously unrecoverable.
  const [pendingDeleteNote, setPendingDeleteNote] = useState<{ dayId: number; noteId: number } | null>(null)

  const deleteNote = (dayId: number, noteId: number) => _deleteNote(dayId, noteId)

  // Unified reorder: assigns positions to ALL item types based on new visual order
  const applyMergedOrder = async (dayId: number, newOrder: { type: string; data: any }[]) => {
    // Capture previous place order for undo
    const prevAssignmentIds = getDayAssignments(dayId).map(a => a.id)
    // …and, per booking, the fields this call is about to overwrite, so a failed write
    // can put the visible order back instead of leaving a phantom one behind the error
    // toast. Restoring the whole array instead would also drop what a collaborator's
    // socket event applied while the requests were in flight.
    const pendingRollback: (Partial<Reservation> & { id: number })[] = []
    const dropRollback = (id: number) => {
      const i = pendingRollback.findIndex(p => p.id === id)
      if (i >= 0) pendingRollback.splice(i, 1)
    }
    const rollBackReservations = () => {
      if (!pendingRollback.length) return
      useTripStore.setState(state => ({
        reservations: state.reservations.map(r => {
          const p = pendingRollback.find(x => x.id === r.id)
          return p ? { ...r, ...p } : r
        })
      }))
      setTransportPosVersion(v => v + 1)
    }

    // Places get sequential integer positions (0, 1, 2, ...)
    // Non-place items between place N-1 and place N get fractional positions
    const assignmentIds: number[] = []
    const noteUpdates: { id: number; sort_order: number }[] = []
    const transportUpdates: { id: number; day_plan_position: number }[] = []
    // Multi-leg flight legs share a reservation id, so their positions can't live in
    // the single per-booking slot — collect them per leg, keyed reservationId → legIndex → pos.
    const legPosUpdates: Record<number, Record<number, number>> = {}

    let placeCount = 0
    let i = 0
    while (i < newOrder.length) {
      if (newOrder[i].type === 'place') {
        assignmentIds.push(newOrder[i].data.id)
        placeCount++
        i++
      } else {
        // Collect consecutive non-place items
        const group: { type: string; data: any }[] = []
        while (i < newOrder.length && newOrder[i].type !== 'place') {
          group.push(newOrder[i])
          i++
        }
        // Fractional positions between (placeCount-1) and placeCount
        const base = placeCount > 0 ? placeCount - 1 : -1
        group.forEach((g, idx) => {
          const pos = base + (idx + 1) / (group.length + 1)
          if (g.type === 'note') noteUpdates.push({ id: g.data.id, sort_order: pos })
          else if (g.type === 'transport') {
            if (g.data.__leg) ((legPosUpdates[g.data.id] ??= {})[g.data.__leg.index] = pos)
            else transportUpdates.push({ id: g.data.id, day_plan_position: pos })
          }
        })
      }
    }

    try {
      // Update transport positions in store FIRST so the useEffect triggered by
      // onReorder's optimistic assignment update reads the correct positions.
      if (transportUpdates.length) {
        for (const tu of transportUpdates) {
          const r = useTripStore.getState().reservations.find(x => x.id === tu.id)
          if (r) pendingRollback.push({ id: r.id, day_plan_position: r.day_plan_position, day_positions: r.day_positions })
        }
        useTripStore.setState(state => ({
          reservations: state.reservations.map(r => {
            const tu = transportUpdates.find(u => u.id === r.id)
            if (!tu) return r
            const day_positions = { ...(r.day_positions || {}), [dayId]: tu.day_plan_position }
            return { ...r, day_plan_position: tu.day_plan_position, day_positions }
          })
        }))
        setTransportPosVersion(v => v + 1)
      }
      // Per-leg positions of multi-leg flights live in metadata.legs[i].day_positions
      // (the single per-booking slot can't hold one position per leg).
      const legResIds = Object.keys(legPosUpdates)
      if (legResIds.length) {
        for (const ridStr of legResIds) {
          const rid = Number(ridStr)
          const r = useTripStore.getState().reservations.find(x => x.id === rid)
          if (!r) continue
          let parsed: any = {}
          try { parsed = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {}) } catch { parsed = {} }
          if (!Array.isArray(parsed.legs)) continue
          const legs = parsed.legs.map((leg: any, i: number) => {
            const pos = legPosUpdates[rid][i]
            return pos == null ? leg : { ...leg, day_positions: { ...(leg.day_positions || {}), [dayId]: pos } }
          })
          // Send metadata as an OBJECT (like the form does) — passing a JSON string
          // here double-encodes it on the server, which wipes metadata.legs on read
          // and collapses the flight back to a single span.
          const newMeta = { ...parsed, legs }
          pendingRollback.push({ id: rid, metadata: r.metadata })
          useTripStore.setState(state => ({ reservations: state.reservations.map(x => (x.id === rid ? { ...x, metadata: newMeta } : x)) }))
          await tripActions.updateReservation(tripId, rid, { metadata: newMeta })
          // Stored, so a later step failing must not put the old legs back.
          dropRollback(rid)
        }
        setTransportPosVersion(v => v + 1)
      }
      if (assignmentIds.length) await onReorder(dayId, assignmentIds)
      if (transportUpdates.length) {
        onRouteRefresh?.()
        await reservationsApi.updatePositions(tripId, transportUpdates, dayId)
        for (const tu of transportUpdates) dropRollback(tu.id)
      }
      for (const n of noteUpdates) {
        await tripActions.updateDayNote(tripId, dayId, n.id, { sort_order: n.sort_order })
      }
      if (prevAssignmentIds.length) {
        const capturedDayId = dayId
        const capturedPrevIds = prevAssignmentIds
        pushUndo?.(t('undo.reorder'), async () => {
          await tripActions.reorderAssignments(tripId, capturedDayId, capturedPrevIds)
        })
      }
    } catch (err: unknown) {
      rollBackReservations()
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    }
  }

  const handleMergedDrop = async (dayId, fromType, fromId, toType, toId, insertAfter = false, toLegIndex = null) => {
    const m = getMergedItems(dayId)
    // Multi-leg flights expose one item per leg sharing the same reservation id;
    // disambiguate the drop target by leg index so you can drop BETWEEN legs.
    const matchTo = (i: any) => i.type === toType && i.data.id === toId && (toLegIndex == null || i.data?.__leg?.index === toLegIndex)

    // Check if a timed place is being moved → would it break chronological order?
    if (fromType === 'place') {
      const fromItem = m.find(i => i.type === 'place' && i.data.id === fromId)
      const fromMinutes = parseTimeToMinutes(fromItem?.data?.place?.place_time)
      if (fromItem && fromMinutes !== null) {
        const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
        const toIdx = m.findIndex(matchTo)
        if (fromIdx !== -1 && toIdx !== -1) {
          const simulated = [...m]
          const [moved] = simulated.splice(fromIdx, 1)
          let insertIdx = simulated.findIndex(matchTo)
          if (insertIdx === -1) insertIdx = simulated.length
          if (insertAfter) insertIdx += 1
          simulated.splice(insertIdx, 0, moved)

          const timedInOrder = simulated
            .map(i => {
              if (i.type === 'transport') return parseTimeToMinutes(i.data?.reservation_time)
              if (i.type === 'place') return parseTimeToMinutes(i.data?.place?.place_time)
              return null
            })
            .filter(t => t !== null)
          const isChronological = timedInOrder.every((t, i) => i === 0 || t >= timedInOrder[i - 1])

          if (!isChronological) {
            const placeTime = fromItem.data.place.place_time
            const timeStr = placeTime.includes(':') ? placeTime.substring(0, 5) : placeTime
            setTimeConfirm({ dayId, fromType, fromId, toType, toId, insertAfter, toLegIndex, time: timeStr })
            setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
            return
          }
        }
      }
    }

    // Build new order: remove the dragged item, insert at target position
    const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
    const toIdx = m.findIndex(matchTo)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
      return
    }

    const newOrder = [...m]
    const [moved] = newOrder.splice(fromIdx, 1)
    let adjustedTo = newOrder.findIndex(matchTo)
    if (adjustedTo === -1) adjustedTo = newOrder.length
    if (insertAfter) adjustedTo += 1
    newOrder.splice(adjustedTo, 0, moved)

    await applyMergedOrder(dayId, newOrder)
    setDraggingId(null)
    setDropTargetKey(null)
    dragDataRef.current = null
  }

  const confirmTimeRemoval = async () => {
    if (!timeConfirm) return
    const saved = { ...timeConfirm }
    const { dayId, fromId, fromType, toType, toId, insertAfter, toLegIndex } = saved
    setTimeConfirm(null)

    // Remove time from assignment
    try {
      await assignmentsApi.updateTime(tripId, fromId, { place_time: null, end_time: null })
      const key = String(dayId)
      const currentAssignments = { ...assignments }
      if (currentAssignments[key]) {
        currentAssignments[key] = currentAssignments[key].map(a =>
          a.id === fromId ? { ...a, place: { ...a.place, place_time: null, end_time: null } } : a
        )
        tripActions.setAssignments(currentAssignments)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
      return
    }

    // Re-apply the pending move against the current merged list
    const m = getMergedItems(dayId)

    if (fromType && toType) {
      const matchTo = (i: any) => i.type === toType && i.data.id === toId && (toLegIndex == null || i.data?.__leg?.index === toLegIndex)
      const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
      const toIdx = m.findIndex(matchTo)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

      const newOrder = [...m]
      const [moved] = newOrder.splice(fromIdx, 1)
      let adjustedTo = newOrder.findIndex(matchTo)
      if (adjustedTo === -1) adjustedTo = newOrder.length
      if (insertAfter) adjustedTo += 1
      newOrder.splice(adjustedTo, 0, moved)

      await applyMergedOrder(dayId, newOrder)
    }
  }

  const moveNote = async (dayId, noteId, direction) => {
    await _moveNote(dayId, noteId, direction, getMergedItems)
  }

  const toggleLock = (assignmentId) => {
    const prevLocked = new Set(lockedIds)
    setLockedIds(prev => {
      const next = new Set(prev)
      if (next.has(assignmentId)) next.delete(assignmentId)
      else next.add(assignmentId)
      return next
    })
    pushUndo?.(t('undo.lock'), () => { setLockedIds(prevLocked) })
  }

  const handleOptimize = async (dayId: number) => {
    const da = getDayAssignments(dayId)
    if (da.length < 3) return

    const prevIds = da.map(a => a.id)

    // Separate fixed (stay at their index) and movable assignments. A place is
    // fixed if it's locked OR has a set time — timed places are anchored by their
    // time, so the optimizer must not reshuffle them.
    const locked = new Map() // index -> assignment
    const unlocked = []
    da.forEach((a, i) => {
      if (lockedIds.has(a.id) || a.place?.place_time) locked.set(i, a)
      else unlocked.push(a)
    })

    // Optimize only unlocked assignments (work on assignments, not places)
    const unlockedWithCoords = unlocked.filter(a => a.place?.lat && a.place?.lng)
    const unlockedNoCoords = unlocked.filter(a => !a.place?.lat || !a.place?.lng)
    // Anchor the route on the day's accommodation (when enabled): a loop out from and back to the
    // hotel, or — on a transfer day — a run from the hotel you leave to the one you arrive at.
    const day = days.find(d => d.id === dayId)
    const anchors = day && useSettingsStore.getState().settings.optimize_from_accommodation !== false
      ? getAccommodationAnchors(
          day, days, accommodations,
          unlockedWithCoords.map(a => ({ lat: a.place!.lat!, lng: a.place!.lng! })),
          (mergedItemsMap[dayId] || []).some(i => i.type === 'transport' && hasCarrierEndpointOnDay(i.data, dayId)),
        )
      : {}
    const optimizedAssignments = unlockedWithCoords.length >= 2
      ? optimizeRoute(unlockedWithCoords.map(a => ({ ...a.place, _assignmentId: a.id })), anchors).map(p => unlockedWithCoords.find(a => a.id === p._assignmentId)).filter(Boolean)
      : unlockedWithCoords
    const optimizedQueue = [...optimizedAssignments, ...unlockedNoCoords]

    // Merge: locked stay at their index, fill gaps with optimized
    const result = new Array(da.length)
    locked.forEach((a, i) => { result[i] = a })
    let qi = 0
    for (let i = 0; i < result.length; i++) {
      if (!result[i]) result[i] = optimizedQueue[qi++]
    }

    await onReorder(dayId, result.map(a => a.id))
    const usedHotel = !!(anchors.start || anchors.end)
    toast.success(usedHotel ? t('dayplan.toast.routeOptimizedFromHotel') : t('dayplan.toast.routeOptimized'))
    const capturedDayId = dayId
    pushUndo?.(t('undo.optimize'), async () => {
      await tripActions.reorderAssignments(tripId, capturedDayId, prevIds)
    })
  }


  const handleDropOnDay = (e, dayId) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverDayId(null)
    const { placeId, assignmentId, noteId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
    if (fromReservationId && fromDayId !== dayId) {
      const r = reservations.find(x => x.id === Number(fromReservationId))
      if (r) { const update = computeMultiDayMove(r, dayId, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null; return
    }
    if (placeId) {
      onAssignToDay?.(Number.parseInt(placeId), dayId)
    } else if (assignmentId && fromDayId !== dayId) {
      const srcAssignment = (useTripStore.getState().assignments[String(fromDayId)] || []).find(a => a.id === Number(assignmentId))
      const capturedFromDayId = fromDayId
      const capturedOrderIndex = srcAssignment?.order_index ?? 0
      tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, dayId)
        .then(() => {
          pushUndo?.(t('undo.moveDay'), async () => {
            await tripActions.moveAssignment(tripId, Number(assignmentId), dayId, capturedFromDayId, capturedOrderIndex)
          })
        })
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
    } else if (noteId && fromDayId !== dayId) {
      tripActions.moveDayNote(tripId, fromDayId, dayId, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
    }
    setDraggingId(null)
    setDropTargetKey(null)
    dragDataRef.current = null
    window.__dragData = null
  }

  const totalCostLabel = useMemo(() => {
    const entries = days.flatMap(d => (assignments[String(d.id)] || []).map(a => ({
      amount: Number(a.place?.price) || 0,
      currency: a.place?.currency || currency,
    })))
    return formatMoneySum(entries, costBase, locale, fxRates)
  }, [days, assignments, currency, costBase, locale, fxRates])

  return {
    tripId,
    trip,
    days,
    places,
    categories,
    assignments,
    selectedDayId,
    selectedPlaceId,
    selectedAssignmentId,
    onSelectDay,
    onPlaceClick,
    onDayDetail,
    accommodations,
    onReorder,
    onReorderDays,
    onAddDay,
    onAssignToDay,
    onRemoveAssignment,
    onEditPlace,
    onDeletePlace,
    reservations,
    visibleConnectionIds,
    onToggleConnection,
    allConnectionsShown,
    onToggleAllConnections,
    externalTransportDetail,
    onExternalTransportDetailHandled,
    onAddReservation,
    onAddPlace,
    onAddPlaceToDay,
    onNavigateToFiles,
    routeShown,
    routeProfile,
    onToggleRoute,
    onSetRouteProfile,
    onExpandedDaysChange,
    pushUndo,
    canUndo,
    lastActionLabel,
    onUndo,
    onRouteRefresh,
    onAddTransport,
    onPlanTransit,
    onPlanTransitLeg,
    onOpenTransit,
    onEditTransport,
    expandedTransitIds,
    setExpandedTransitIds,
    onEditReservation,
    onAddBookingToAssignment,
    initialScrollTop,
    onScrollTopChange,
    showRouteToolsWhenExpanded,
    isMobile,
    dragDisabled,
    toast,
    t,
    language,
    locale,
    ctxMenu,
    timeFormat,
    tripActions,
    can,
    canEditDays,
    canManageShare,
    noteUi,
    setNoteUi,
    noteInputRef,
    dayNotes,
    openAddNote,
    openEditNote,
    cancelNote,
    saveNote,
    deleteNote,
    pendingDeleteNote,
    setPendingDeleteNote,
    moveNote,
    expandedDays,
    setExpandedDays,
    routeLegs,
    setRouteLegs,
    hotelLegs,
    setHotelLegs,
    legsAbortRef,
    draggingId,
    setDraggingId,
    lockedIds,
    setLockedIds,
    lockHoverId,
    setLockHoverId,
    undoHover,
    setUndoHover,
    hoveredAssignmentId,
    setHoveredAssignmentId,
    dropTargetKey,
    _setDropTargetKey,
    dropTargetRef,
    setDropTargetKey,
    dragOverDayId,
    setDragOverDayId,
    transportDetail,
    setTransportDetail,
    transportPosVersion,
    setTransportPosVersion,
    timeConfirm,
    setTimeConfirm,
    dragDataRef,
    scrollContainerRef,
    dayRefs,
    initedTransportIds,
    lastAutoScrolledIdRef,
    currency,
    costBase,
    fxRates,
    getDragData,
    prevDayCount,
    toggleDay,
    getSpanLabel,
    getDayOrder,
    computeMultiDayMove,
    getTransportForDay,
    getActiveRentalsForDay,
    getDayAssignments,
    computeTransportPosition,
    initTransportPositions,
    getMergedItems,
    mergedItemsMap,
    applyMergedOrder,
    handleMergedDrop,
    confirmTimeRemoval,
    toggleLock,
    handleOptimize,
    handleDropOnDay,
    totalCostLabel,
    expandedRouteDayIds,
    setExpandedRouteDayIds,
  }
}

const DayPlanSidebar = React.memo(function DayPlanSidebar(props: DayPlanSidebarProps) {
  const S = useDayPlanSidebar(props)
  // A stable key for the current selection. A multi-day place renders one row per
  // day (same place_id, different assignment ids); selecting it by place_id alone
  // (e.g. clicking an accommodation) marks every one of those rows selected, so a
  // per-assignment scroll-lock would let each day's row scroll the list in turn.
  // Keying the lock on the selection identity makes only the first row scroll (#1375).
  const selectionScrollKey = S.selectedAssignmentId != null ? `a${S.selectedAssignmentId}` : S.selectedPlaceId != null ? `p${S.selectedPlaceId}` : null
  // Needed by the route-tools visibility gate in the render below (#1330); the hook
  // keeps its own copy, so read it reactively here in the component scope too.
  const optimizeFromAccommodation = useSettingsStore(s => s.settings.optimize_from_accommodation)
  const collectionsEnabled = useAddonStore(s => s.isEnabled('collections'))
  // Route-profile picker entries: the two built-ins plus every profile an active
  // routeProvider plugin declared (keyed 'plugin:<id>/<profile>', labeled by the
  // plugin's manifest). The feed only lists granted providers.
  const activePlugins = usePluginStore(s => s.plugins)
  // Plugin time contributions in the day plan (dayScheduleProvider hook).
  const daySchedule = usePluginDaySchedule(S.tripId)
  // Per-day colours from the dayTintProvider hook — e.g. which leg of the trip a
  // day belongs to. Empty unless a granted plugin provides them.
  const dayTints = usePluginDayTints(S.tripId)
  const routeProfileOptions = useMemo(() => {
    const opts: Array<{ key: string; label: string }> = [
      { key: 'driving', label: 'Driving' },
      { key: 'walking', label: 'Walking' },
    ]
    for (const p of activePlugins) {
      for (const prof of p.routeProfiles ?? []) opts.push({ key: `plugin:${p.id}/${prof.id}`, label: prof.label })
    }
    return opts
  }, [activePlugins])
  const {
    tripId,
    trip,
    days,
    places,
    categories,
    assignments,
    selectedDayId,
    selectedPlaceId,
    selectedAssignmentId,
    onSelectDay,
    onPlaceClick,
    onDayDetail,
    accommodations,
    onReorder,
    onReorderDays,
    onAddDay,
    onAssignToDay,
    onRemoveAssignment,
    onEditPlace,
    onDeletePlace,
    reservations,
    visibleConnectionIds,
    onToggleConnection,
    allConnectionsShown,
    onToggleAllConnections,
    externalTransportDetail,
    onExternalTransportDetailHandled,
    onAddReservation,
    onAddPlace,
    onAddPlaceToDay,
    onNavigateToFiles,
    routeShown,
    routeProfile,
    onToggleRoute,
    onSetRouteProfile,
    onExpandedDaysChange,
    pushUndo,
    canUndo,
    lastActionLabel,
    onUndo,
    onRouteRefresh,
    onAddTransport,
    onPlanTransit,
    onPlanTransitLeg,
    onOpenTransit,
    onEditTransport,
    expandedTransitIds,
    setExpandedTransitIds,
    onEditReservation,
    onAddBookingToAssignment,
    initialScrollTop,
    onScrollTopChange,
    showRouteToolsWhenExpanded,
    isMobile,
    dragDisabled,
    toast,
    t,
    language,
    locale,
    ctxMenu,
    timeFormat,
    tripActions,
    can,
    canEditDays,
    canManageShare,
    noteUi,
    setNoteUi,
    noteInputRef,
    dayNotes,
    openAddNote,
    openEditNote,
    cancelNote,
    saveNote,
    deleteNote,
    pendingDeleteNote,
    setPendingDeleteNote,
    moveNote,
    expandedDays,
    setExpandedDays,
    routeLegs,
    setRouteLegs,
    hotelLegs,
    setHotelLegs,
    legsAbortRef,
    draggingId,
    setDraggingId,
    lockedIds,
    setLockedIds,
    lockHoverId,
    setLockHoverId,
    undoHover,
    setUndoHover,
    hoveredAssignmentId,
    setHoveredAssignmentId,
    dropTargetKey,
    _setDropTargetKey,
    dropTargetRef,
    setDropTargetKey,
    dragOverDayId,
    setDragOverDayId,
    transportDetail,
    setTransportDetail,
    transportPosVersion,
    setTransportPosVersion,
    timeConfirm,
    setTimeConfirm,
    dragDataRef,
    scrollContainerRef,
    dayRefs,
    initedTransportIds,
    lastAutoScrolledIdRef,
    currency,
    costBase,
    fxRates,
    getDragData,
    prevDayCount,
    toggleDay,
    getSpanLabel,
    getDayOrder,
    computeMultiDayMove,
    getTransportForDay,
    getActiveRentalsForDay,
    getDayAssignments,
    computeTransportPosition,
    initTransportPositions,
    getMergedItems,
    mergedItemsMap,
    applyMergedOrder,
    handleMergedDrop,
    confirmTimeRemoval,
    toggleLock,
    handleOptimize,
    handleDropOnDay,
    totalCostLabel,
    expandedRouteDayIds,
    setExpandedRouteDayIds,
  } = S

  // ── Per-segment / per-day travel mode (#1281) ──────────────────────────────
  // Icon per mode, matching the route picker (driving→Car, walking→Footprints,
  // any plugin profile→Zap).
  const modeIcon = (key: string) => (key === 'walking' ? Footprints : key.startsWith('plugin:') ? Zap : Car)

  // Set the mode of the leg LEAVING this stop. Optimistic (the connector + map
  // recompute from the store), then persisted; null clears the override so the leg
  // falls back to the day default. The whole-day picker never writes here — that is
  // what keeps a chosen segment sticky against the Foot/Car button (#1281).
  const setLegMode = (assignmentId: number, dayId: number, mode: string | null) => {
    const key = String(dayId)
    if (assignments[key]) {
      tripActions.setAssignments({
        ...assignments,
        [key]: assignments[key].map(a => (a.id === assignmentId ? { ...a, leg_transport_mode: mode } : a)),
      })
    }
    assignmentsApi.updateTransport(tripId, assignmentId, mode).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
      tripActions.refreshDays(tripId)
    })
  }

  // The whole-day default (the Car/Foot picker). Persisted so it survives a reload,
  // and mirrored into routeProfile so the live map redraws at once. Legs that carry
  // their own mode are left untouched.
  const setDayDefaultMode = (dayId: number, mode: string) => {
    useTripStore.setState(state => ({ days: state.days.map(d => (d.id === dayId ? { ...d, default_transport_mode: mode } : d)) }))
    onSetRouteProfile?.(mode)
    daysApi.updateTransport(tripId, dayId, mode).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
      tripActions.refreshDays(tripId)
    })
  }

  // A connector's endpoints carry only coordinates (RouteSegment.from/to, both
  // [lat, lng]); resolve them back to the NAMES the transit search shows by indexing
  // every located place, hotel and booking endpoint on the trip. Name is a property
  // of a coordinate, so a trip-wide index is fine; a connector only renders when both
  // ends are located, so a coordinate that misses the index is rare (nameless pick).
  const transitNameIndex = useMemo(() => {
    const m = new Map<string, string>()
    const put = (lat?: number | null, lng?: number | null, name?: string | null) => {
      if (lat == null || lng == null || !name) return
      const k = `${lat},${lng}`
      if (!m.has(k)) m.set(k, name)
    }
    for (const list of Object.values(assignments)) {
      for (const a of list) put(a.place?.lat, a.place?.lng, a.place?.name)
    }
    for (const acc of accommodations) put(acc.place_lat, acc.place_lng, acc.place_name)
    for (const r of reservations) {
      for (const ep of (r.endpoints || [])) put(ep.lat, ep.lng, ep.name)
    }
    return m
  }, [assignments, accommodations, reservations])

  // The leg's departure time must be resolved WITHIN its day: the same located POI can
  // be revisited on another day at a different time (a supported pattern), so a
  // trip-wide coordinate index would return the wrong day's time. Scope to this day's
  // assignments (and the reservations that touch it) so a revisit keeps its own time.
  const originDepartureTime = (originKey: string, dayId: number): string | null => {
    for (const a of assignments[String(dayId)] ?? []) {
      if (a.place?.lat != null && a.place?.lng != null && `${a.place.lat},${a.place.lng}` === originKey) return a.place.place_time ?? null
    }
    for (const r of reservations) {
      if (r.day_id !== dayId && r.end_day_id !== dayId) continue
      for (const ep of (r.endpoints || [])) {
        if (ep.lat != null && ep.lng != null && `${ep.lat},${ep.lng}` === originKey) return ep.local_time ?? null
      }
    }
    return null
  }

  // Build the "public transport" prefill for a leg from its RouteSegment: MOTIS is
  // driven off the coordinates, the names come from the index and the departure time
  // from the origin's own day. Accepts 'H:mm' or 'HH:mm[:ss]', normalised to 'HH:mm'.
  const buildTransitLeg = (seg: RouteSegment | undefined, dayId: number): { from: PickedPlace; to: PickedPlace; time: string | null } | null => {
    if (!seg?.from || !seg?.to) return null
    const pick = (c: [number, number]): PickedPlace => ({ name: transitNameIndex.get(`${c[0]},${c[1]}`) || '', lat: c[0], lng: c[1] })
    const rawTime = originDepartureTime(`${seg.from[0]},${seg.from[1]}`, dayId)
    const m = rawTime ? /^(\d{1,2}):(\d{2})/.exec(rawTime) : null
    return { from: pick(seg.from), to: pick(seg.to), time: m ? `${m[1].padStart(2, '0')}:${m[2]}` : null }
  }

  // The extra connector-menu entry (#1281 follow-up): search public transit for this
  // leg instead of drawing a road route. Only when a handler is wired (day has dates).
  const transitLegMenuItem = (dayId: number, seg?: RouteSegment) => {
    if (!onPlanTransitLeg) return []
    const leg = buildTransitLeg(seg, dayId)
    if (!leg) return []
    return [{ label: t('transit.title'), icon: TramFront, onClick: () => onPlanTransitLeg({ dayId, from: leg.from, to: leg.to, time: leg.time }) }]
  }

  // Open the mode menu at the clicked connector: every route profile, the optional
  // "public transport" entry, plus a "use day default" entry that clears the override.
  const openLegModeMenu = (e: React.MouseEvent, assignmentId: number, dayId: number, seg?: RouteSegment) => {
    ctxMenu.open(e, [
      ...routeProfileOptions.map(o => ({ label: o.label, icon: modeIcon(o.key), onClick: () => setLegMode(assignmentId, dayId, o.key) })),
      ...transitLegMenuItem(dayId, seg),
      { divider: true },
      { label: t('dayplan.transportMode.useDefault'), icon: RotateCcw, onClick: () => setLegMode(assignmentId, dayId, null) },
    ])
  }

  // Set the mode of the leg ENTERING this stop (a booking arrival or the morning
  // hotel bookend). Optimistic, then persisted with direction:'incoming'.
  const setIncomingLegMode = (assignmentId: number, dayId: number, mode: string | null) => {
    const key = String(dayId)
    if (assignments[key]) {
      tripActions.setAssignments({
        ...assignments,
        [key]: assignments[key].map(a => (a.id === assignmentId ? { ...a, incoming_leg_transport_mode: mode } : a)),
      })
    }
    assignmentsApi.updateTransport(tripId, assignmentId, mode, 'incoming').catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
      tripActions.refreshDays(tripId)
    })
  }

  const openIncomingLegModeMenu = (e: React.MouseEvent, assignmentId: number, dayId: number, seg?: RouteSegment) => {
    ctxMenu.open(e, [
      ...routeProfileOptions.map(o => ({ label: o.label, icon: modeIcon(o.key), onClick: () => setIncomingLegMode(assignmentId, dayId, o.key) })),
      ...transitLegMenuItem(dayId, seg),
      { divider: true },
      { label: t('dayplan.transportMode.useDefault'), icon: RotateCcw, onClick: () => setIncomingLegMode(assignmentId, dayId, null) },
    ])
  }

  // Enter/Space on a route connector opens the same mode menu a click opens. A key
  // event carries no pointer position, so the menu is anchored to the connector.
  const openLegMenuByKey = (e: React.KeyboardEvent<HTMLDivElement>, open: (m: React.MouseEvent) => void) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const rect = e.currentTarget.getBoundingClientRect()
    open({
      clientX: rect.left,
      clientY: rect.bottom,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
    } as unknown as React.MouseEvent)
  }

  return (
    <div data-touch-drag={dragDisabled ? undefined : ''} style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', fontFamily: "var(--font-system)" }}>
      {/* Toolbar */}
      <DayPlanSidebarToolbar
        tripId={tripId}
        trip={trip}
        days={days}
        places={places}
        categories={categories}
        assignments={assignments}
        reservations={reservations}
        allConnectionsShown={allConnectionsShown}
        onToggleAllConnections={onToggleAllConnections}
        dayNotes={dayNotes}
        t={t}
        locale={locale}
        toast={toast}
        expandedDays={expandedDays}
        setExpandedDays={setExpandedDays}
        onUndo={onUndo}
        canUndo={canUndo}
        undoHover={undoHover}
        setUndoHover={setUndoHover}
        lastActionLabel={lastActionLabel}
        canEditDays={canEditDays}
        canManageShare={canManageShare}
        onReorderDays={onReorderDays}
        onAddDay={onAddDay}
      />

      {/* Tagesliste */}
      <div className={`scroll-container${draggingId ? '' : ' trek-stagger'}`} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }} ref={scrollContainerRef} onScroll={(e) => onScrollTopChange?.((e.currentTarget as HTMLElement).scrollTop)}>
        {days.map((day, index) => {
          const isSelected = selectedDayId === day.id
          // Shared by the click and the key handler so the two can never drift
          // apart — pressing Enter on the row has to toggle, not just select.
          // Named for the selection, not the expand/collapse `toggleDay` above.
          const toggleDaySelection = () => {
            if (isSelected) { onSelectDay(null); if (onDayDetail) onDayDetail(null) }
            else { onSelectDay(day.id); if (onDayDetail) onDayDetail(day) }
          }
          const isExpanded = expandedDays.has(day.id)
          const da = getDayAssignments(day.id)
          const cost = dayTotalCost(day.id, assignments, costBase, currency, locale, fxRates)
          const formattedDate = formatDate(day.date, locale)
          const loc = da.find(a => a.place?.lat && a.place?.lng)
          // Route tools normally need 2+ stops, but a single located place is still
          // routable when accommodation optimization can bookend it with a hotel
          // (hotel → place → hotel, the same line the map draws) — otherwise the tools
          // vanish on such a day (#1330). Purely additive to the 2+ case.
          // The weather anchor below must not depend on the optimize-from-accommodation
          // setting — where you wake up is a fact about the day, not a routing choice —
          // so the bookend lookup runs unconditionally (mirrors useMPlanTimeline) while
          // the route tools keep honoring the setting via routeBookends.
          const dayBookends = getDayBookendHotels(day, days, accommodations)
          const routeBookends = optimizeFromAccommodation !== false ? dayBookends : null
          const hasRouteBookend = !!(
            (routeBookends?.morning?.place_lat != null && routeBookends?.morning?.place_lng != null) ||
            (routeBookends?.evening?.place_lat != null && routeBookends?.evening?.place_lng != null)
          )
          // Transfer day with no stops at all: you check out of one hotel and into another, so
          // the map already draws a hotel → hotel leg (see the transfer branch in
          // useRouteCalculation) even with zero places. Mirror that exact gate here — two
          // distinct bookend hotels you actually slept in / sleep in tonight — so the route
          // tools appear when you click the day (#1297). A same-hotel rest day or a plain
          // arrival/departure day has morning === evening and stays excluded.
          const transferMorning = routeBookends?.morning
          const transferEvening = routeBookends?.evening
          const hasHotelTransfer = !!(
            routeBookends?.morningIsSleptHere && routeBookends?.eveningIsOvernight &&
            transferMorning?.place_lat != null && transferMorning?.place_lng != null &&
            transferEvening?.place_lat != null && transferEvening?.place_lng != null &&
            (transferMorning.place_lat !== transferEvening.place_lat || transferMorning.place_lng !== transferEvening.place_lng)
          )
          const routeToolsRoutable = da.length >= 2 || (loc != null && hasRouteBookend) || hasHotelTransfer
          /**
           * The day's located stops in planned order, bookended by the accommodation
           * the same way the drawn map route is (routeBookends is null when "optimize
           * from accommodation" is off), so hotels aren't dropped from an exported
           * route (#1372) — but only when the leg is real: no hotel prepended before an
           * early check-in-day stop, none appended after a post-check-out stop (#1465).
           * Names ride along for the deep links that can label a pin with one.
           */
          const dayExportStops = (): NamedWaypoint[] => {
            const dayStops = getDayAssignments(day.id).filter(a => a.place?.lat != null && a.place?.lng != null)
            const stops = dayStops.map(a => ({ lat: a.place!.lat!, lng: a.place!.lng!, name: a.place!.name }))
            const first = dayStops[0] ? { isPlace: true, time: dayStops[0].place?.place_time ?? null, lat: dayStops[0].place!.lat!, lng: dayStops[0].place!.lng! } : undefined
            const lastAssignment = dayStops[dayStops.length - 1]
            const last = lastAssignment ? { isPlace: true, time: lastAssignment.place?.place_time ?? null, lat: lastAssignment.place!.lat!, lng: lastAssignment.place!.lng! } : undefined
            // Same carrier gate as the drawn route (#2157): the exported link must not
            // start at a hotel you only reach tonight or lead back to one you left.
            const dayHasCarrier = (mergedItemsMap[day.id] || []).some(i => i.type === 'transport' && hasCarrierEndpointOnDay(i.data, day.id))
            const drawMorning = !!routeBookends && shouldDrawMorningLeg(routeBookends, day, first, dayHasCarrier)
            const drawEvening = !!routeBookends && shouldDrawEveningLeg(routeBookends, day, last, dayHasCarrier)
            const morning = drawMorning && routeBookends?.morning?.place_lat != null && routeBookends?.morning?.place_lng != null
              ? { lat: routeBookends.morning.place_lat, lng: routeBookends.morning.place_lng, name: routeBookends.morning.place_name } : null
            const evening = drawEvening && routeBookends?.evening?.place_lat != null && routeBookends?.evening?.place_lng != null
              ? { lat: routeBookends.evening.place_lat, lng: routeBookends.evening.place_lng, name: routeBookends.evening.place_name } : null
            return [...(morning ? [morning] : []), ...stops, ...(evening ? [evening] : [])]
          }
          // Is this day's inline route currently on? Mobile toggles it per day (its
          // own expandedRouteDayIds entry); desktop uses the global Route toggle on
          // the selected day (#1374).
          const routeActive = showRouteToolsWhenExpanded ? expandedRouteDayIds.has(day.id) : (routeShown && isSelected)
          const isDragTarget = dragOverDayId === day.id
          const merged = mergedItemsMap[day.id] || []
          const dayNoteUi = noteUi[day.id]
          const placeItems = merged.filter(i => i.type === 'place')
          // A row hidden on a middle day still sits in `merged` (the route builder above
          // has to see it), so the empty-day hint counts what actually renders. Without
          // that, a day whose only entry is a spanning parking would show a blank gap.
          const visibleCount = merged.filter(i => !(i.type === 'transport' && hidesOnMiddleDay(i.data, day.id))).length
          const dayTint = dayTints[day.id]
          // Resolved once per day: the header owns a background that its hover
          // handlers reassign imperatively, so both the base and the hover value have
          // to be tint-aware or the first hover-out would wipe the colour.
          const headerTintBg = dayTintBackground(dayTint, 'header', '--day-tint-header') ?? 'transparent'
          const headerTintHoverBg = dayTintBackground(dayTint, 'header', '--day-tint-header-hover') ?? 'var(--bg-tertiary)'

          return (
            // The card wrapper stays untinted — its three regions (badge, header,
            // activity list) paint themselves, so a plugin controls them separately.
            <div key={day.id} ref={el => { if (el) dayRefs.current.set(day.id, el); else dayRefs.current.delete(day.id) }}
              title={dayTint?.label || undefined} style={{ borderBottom: '1px solid var(--border-faint)' }}>
              {/* Tages-Header — akzeptiert Drops aus der PlacesSidebar */}
              <div
                className="dp-day-header"
                data-selected={isSelected}
                // Clicking the selected day again deselects it — same as the day panel's × (#2024).
                // Selecting the day has no other trigger, so the row carries the
                // button role itself. The badges inside it are buttons of their
                // own, hence the key handler only answers for the row — and it
                // toggles exactly like the click, rather than only selecting.
                role="button"
                // No press-scale on the wide row — it would shift the nested
                // buttons out from under the pointer mid-click (#2158).
                data-no-press
                tabIndex={0}
                onClick={() => toggleDaySelection()}
                onKeyDown={e => {
                  if (e.target !== e.currentTarget) return
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  toggleDaySelection()
                }}
                onDragOver={e => { e.preventDefault(); if (dragOverDayId !== day.id) setDragOverDayId(day.id) }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOverDayId(null) }}
                onDrop={e => handleDropOnDay(e, day.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 14px 11px 16px',
                  cursor: 'pointer',
                  background: isDragTarget ? 'rgba(17,24,39,0.07)' : (isSelected ? 'var(--bg-selected)' : headerTintBg),
                  transition: 'background 0.12s',
                  userSelect: 'none',
                  outline: isDragTarget ? '2px dashed rgba(17,24,39,0.25)' : 'none',
                  outlineOffset: -2,
                  borderRadius: isDragTarget ? 8 : 0,
                  touchAction: 'manipulation',
                }}
                // A tinted header hovers to a deeper mix of its own tone rather than to
                // the neutral --bg-tertiary, so hovering reads as a state change on
                // this day instead of momentarily losing its colour. Selection keeps
                // winning outright, so a selected day is never ambiguous.
                onMouseEnter={e => { if (!isSelected && !isDragTarget) e.currentTarget.style.background = headerTintHoverBg }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isDragTarget ? 'rgba(17,24,39,0.07)' : headerTintBg }}
              >
                {/* Tages-Badge: Nummer oben, darunter (falls vorhanden) das Wetter des Tages */}
                {(() => {
                  // Day-local anchor only (#2167): the day's first located stop, else the
                  // hotel you wake up in. No trip-wide fallback — on a roadtrip that
                  // silently showed another city's weather with nothing naming the place.
                  const weatherHotel = loc == null ? dayBookends.morning : undefined
                  const wLat = loc?.place?.lat ?? weatherHotel?.place_lat
                  const wLng = loc?.place?.lng ?? weatherHotel?.place_lng
                  const weatherName = loc?.place?.name ?? weatherHotel?.place_name ?? null
                  const hasWeather = !!(day.date && wLat != null && wLng != null)
                  return (
                    <div style={{
                      // With weather the badge is a tall stack and has to start at
                      // the top of the row; without it, it is a lone 26px circle and
                      // pinning it to the top leaves it floating above the day title.
                      flexShrink: 0, alignSelf: hasWeather ? 'flex-start' : 'center',
                      width: hasWeather ? 34 : 26,
                      borderRadius: hasWeather ? 11 : '50%',
                      // Selection still wins. A tinted badge mixes the tone INTO
                      // --bg-hover so it stays the same pill component, and takes
                      // --text-secondary: the number is 11px bold, so 4.5:1 applies
                      // and --text-muted is already borderline on the untinted pill.
                      background: isSelected ? 'var(--accent)' : (dayTintBackground(dayTint, 'badge', '--day-tint-badge', 'var(--bg-hover)') ?? 'var(--bg-hover)'),
                      color: isSelected ? 'var(--accent-text)' : (dayTinted(dayTint, 'badge') ? 'var(--text-secondary)' : 'var(--text-muted)'),
                      display: 'flex', flexDirection: 'column', alignItems: 'center', overflow: 'hidden',
                    }}>
                      {/* lineHeight 1, or the digit rides the line box's leading and
                          sits above centre on the plain badge — visible as soon as
                          there is no weather block under it to distract from it. */}
                      <div style={{ width: '100%', height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 700, lineHeight: 1 }}>
                        {index + 1}
                      </div>
                      {hasWeather && (
                        <>
                          <div style={{ width: '64%', height: 1, background: 'currentColor', opacity: 0.25 }} />
                          <div style={{ padding: '3px 0 4px' }}>
                            <WeatherWidget lat={wLat ?? null} lng={wLng ?? null} date={day.date} stacked locationName={weatherName} />
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()}

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
                      {day.title || t('dayplan.dayN', { n: index + 1 })}
                    </span>
                    {formattedDate && (
                      <>
                        <span style={{ flexShrink: 0, width: 1, height: 11, background: 'var(--border-primary)' }} />
                        <span style={{ flexShrink: 0, fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 400, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                          {formattedDate}
                        </span>
                      </>
                    )}
                  </div>
                  {(() => {
                    const hasAccs = accommodations.some(a => isDayInAccommodationRange(day, a.start_day_id, a.end_day_id, days))
                    const hasRentals = getActiveRentalsForDay(day.id).length > 0
                    if (!hasAccs && !hasRentals) return null
                    return <div style={{ height: 1, background: 'var(--border-faint)', margin: '5px 0 5px' }} />
                  })()}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap', minWidth: 0 }}>
                    {(() => {
                      const dayAccs = accommodations.filter(a => isDayInAccommodationRange(day, a.start_day_id, a.end_day_id, days))
                        // Sort: check-out first, then ongoing stays, then check-in last
                        .sort((a, b) => {
                          const aIsOut = a.end_day_id === day.id && a.start_day_id !== day.id
                          const bIsOut = b.end_day_id === day.id && b.start_day_id !== day.id
                          const aIsIn = a.start_day_id === day.id
                          const bIsIn = b.start_day_id === day.id
                          if (aIsOut && !bIsOut) return -1
                          if (!aIsOut && bIsOut) return 1
                          if (aIsIn && !bIsIn) return 1
                          if (!aIsIn && bIsIn) return -1
                          return 0
                        })
                      if (dayAccs.length === 0) return null
                      return dayAccs.map(acc => {
                        const isCheckIn = acc.start_day_id === day.id
                        const isCheckOut = acc.end_day_id === day.id
                        const iconColor = isCheckOut && !isCheckIn ? '#ef4444' : isCheckIn ? '#22c55e' : 'var(--text-faint)'
                        return (
                          <button type="button" key={acc.id} onClick={e => { e.stopPropagation(); if ((acc as any).place_id) onPlaceClick((acc as any).place_id) }} className="bg-surface-hover" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, cursor: (acc as any).place_id ? 'pointer' : 'default', borderRadius: 7, padding: '2px 7px 2px 6px', border: 'none', font: 'inherit', textAlign: 'left' }}>
                            <Hotel size={11} strokeWidth={1.8} style={{ color: iconColor, flexShrink: 0 }} />
                            <span className="text-content-muted" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(acc as any).place_name || (acc as any).reservation_title}</span>
                          </button>
                        )
                      })
                    })()}
                    {/* Active rental car badges */}
                    {(() => {
                      const activeRentals = getActiveRentalsForDay(day.id)
                      if (activeRentals.length === 0) return null
                      return activeRentals.map(r => (
                        <button type="button" key={`rental-${r.id}`} onClick={e => { e.stopPropagation(); setTransportDetail(r) }} className="bg-surface-hover" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, cursor: 'pointer', borderRadius: 7, padding: '2px 7px 2px 6px', border: 'none', font: 'inherit', textAlign: 'left' }}>
                          <Car size={11} strokeWidth={1.8} className="text-content-faint" style={{ flexShrink: 0 }} />
                          <span className="text-content-muted" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                        </button>
                      ))
                    })()}
                  </div>
                  {cost && (
                    <div style={{ marginTop: 2 }}>
                      <span className="text-[#059669]" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>{cost}</span>
                    </div>
                  )}
                </div>

                {canEditDays ? (
                  (() => {
                    const cell = { padding: 7, cursor: 'pointer', display: 'grid', placeItems: 'center' } as const
                    const div = '1px solid var(--border-faint)'
                    return (
                      <div className="dp-day-actions" style={{ alignSelf: 'flex-start', flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', border: div, borderRadius: 9, overflow: 'hidden' }}>
                        {/* Public transit search (#1065) — replaced the rename pencil,
                            which moved next to the day name in the day detail view. */}
                        {onPlanTransit ? (
                          <button type="button" onClick={e => { e.stopPropagation(); onPlanTransit(day.id) }} title={t('transit.title')} aria-label={t('transit.title')} style={{ ...cell, border: 'none', borderRight: div, borderBottom: div }}>
                            <TramFront size={14} strokeWidth={1.8} />
                          </button>
                        ) : <div style={{ borderRight: div, borderBottom: div }} />}
                        {onAddTransport ? (
                          <button type="button" onClick={e => { e.stopPropagation(); onAddTransport(day.id) }} title={t('transport.addTransport')} style={{ ...cell, border: 'none', borderBottom: div }}>
                            <Plus size={14} strokeWidth={1.8} />
                          </button>
                        ) : <div style={{ borderBottom: div }} />}
                        <button type="button" onClick={e => openAddNote(day.id, e)} aria-label={t('dayplan.addNote')} style={{ ...cell, border: 'none', borderRight: div }}>
                          <FileText size={14} strokeWidth={1.8} />
                        </button>
                        <button type="button" onClick={e => toggleDay(day.id, e)} title={isExpanded ? t('common.collapse') : t('common.expand')} style={{ ...cell, border: 'none' }}>
                          {isExpanded ? <ChevronDown size={15} strokeWidth={1.8} /> : <ChevronRight size={15} strokeWidth={1.8} />}
                        </button>
                      </div>
                    )
                  })()
                ) : (
                  <button type="button" onClick={e => toggleDay(day.id, e)} className="text-content-faint" style={{ alignSelf: 'flex-start', flexShrink: 0, background: 'none', border: 'none', padding: 6, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                    {isExpanded ? <ChevronDown size={16} strokeWidth={1.8} /> : <ChevronRight size={16} strokeWidth={1.8} />}
                  </button>
                )}
              </div>

              {/* Aufgeklappte Orte + Notizen */}
              {isExpanded && (
                <div
                  // The activity list — the largest region and the one behind the
                  // densest text, so its tint is the faintest of the three.
                  style={{ background: dayTintBackground(dayTint, 'activity', '--day-tint-activity', 'var(--bg-hover)') ?? 'var(--bg-hover)', paddingTop: 6 }}
                  onDragOver={e => { e.preventDefault(); const cur = dropTargetRef.current; if (draggingId && (!cur || cur.startsWith('end-'))) setDropTargetKey(`end-${day.id}`) }}
                  onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const { placeId, assignmentId, noteId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
                    // Drop on transport card (detected via dropTargetRef for sync accuracy)
                    if (dropTargetRef.current?.startsWith('transport-')) {
                      const isAfter = dropTargetRef.current.startsWith('transport-after-')
                      const parts = dropTargetRef.current.replace('transport-after-', '').replace('transport-', '').split('-')
                      const transportId = Number(parts[0])
                      const legPart = parts.find(p => /^leg\d+$/.test(p))
                      const toLegIndex = legPart ? Number(legPart.slice(3)) : null

                      if (placeId) {
                        onAssignToDay?.(Number.parseInt(placeId), day.id)
                      } else if (fromReservationId && fromDayId !== day.id) {
                        const r = reservations.find(x => x.id === Number(fromReservationId))
                        if (r) { const update = computeMultiDayMove(r, day.id, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                      } else if (fromReservationId) {
                        handleMergedDrop(day.id, 'transport', Number(fromReservationId), 'transport', transportId, isAfter, toLegIndex)
                      } else if (assignmentId && fromDayId !== day.id) {
                        tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                      } else if (assignmentId) {
                        handleMergedDrop(day.id, 'place', Number(assignmentId), 'transport', transportId, isAfter, toLegIndex)
                      } else if (noteId && fromDayId !== day.id) {
                        tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                      } else if (noteId) {
                        handleMergedDrop(day.id, 'note', Number(noteId), 'transport', transportId, isAfter, toLegIndex)
                      }
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null
                      return
                    }

                    if (fromReservationId && fromDayId !== day.id) {
                      const r = reservations.find(x => x.id === Number(fromReservationId))
                      if (r) { const update = computeMultiDayMove(r, day.id, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    if (!assignmentId && !noteId && !placeId) { dragDataRef.current = null; window.__dragData = null; return }
                    if (placeId) {
                      onAssignToDay?.(Number.parseInt(placeId), day.id)
                      setDropTargetKey(null); window.__dragData = null; return
                    }
                    if (assignmentId && fromDayId !== day.id) {
                      tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    if (noteId && fromDayId !== day.id) {
                      tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    const m = getMergedItems(day.id)
                    if (m.length === 0) return
                    const lastItem = m[m.length - 1]
                    if (assignmentId && String(lastItem?.data?.id) !== assignmentId)
                      handleMergedDrop(day.id, 'place', Number(assignmentId), lastItem.type, lastItem.data.id, true)
                    else if (noteId && String(lastItem?.data?.id) !== noteId)
                      handleMergedDrop(day.id, 'note', Number(noteId), lastItem.type, lastItem.data.id, true)
                  }}
                >
                  {hotelLegs[day.id]?.top && (() => {
                    const targetId = hotelLegs[day.id]?.top?.targetId
                    const connector = <HotelRouteConnector seg={hotelLegs[day.id]!.top!.seg} name={hotelLegs[day.id]!.top!.name} profile={routeProfile} placement="top" />
                    return canEditDays && targetId != null ? (
                      <div role="button" tabIndex={0} title={t('dayplan.transportMode.change')} onClick={e => openIncomingLegModeMenu(e, targetId, day.id, hotelLegs[day.id]!.top!.seg)} onKeyDown={e => openLegMenuByKey(e, m => openIncomingLegModeMenu(m, targetId, day.id, hotelLegs[day.id]!.top!.seg))} style={{ cursor: 'pointer' }}>
                        {connector}
                      </div>
                    ) : connector
                  })()}
                  {daySchedule.byPosition[day.id]?.start.map(si => <PluginDayScheduleRow key={`${si.pluginId}:${si.id}`} item={si} />)}
                  {visibleCount === 0 && !dayNoteUi ? (
                    <div
                      onDragOver={e => { e.preventDefault(); if (dragOverDayId !== day.id) setDragOverDayId(day.id) }}
                      onDrop={e => handleDropOnDay(e, day.id)}
                      className={dragOverDayId === day.id ? 'bg-[rgba(17,24,39,0.05)]' : 'bg-transparent'}
                      style={{ padding: '16px', textAlign: 'center', borderRadius: 8,
                        border: dragOverDayId === day.id ? '2px dashed rgba(17,24,39,0.2)' : '2px dashed transparent',
                      }}
                    >
                      <span className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>{t('dayplan.emptyDay')}</span>
                    </div>
                  ) : (
                    merged.map((item, idx) => {
                      const legSuffix = item.data?.__leg ? `-leg${item.data.__leg.index}` : ''
                      const itemKey = item.type === 'transport' ? `transport-${item.data.id}${legSuffix}-${day.id}` : (item.type === 'place' ? `place-${item.data.id}` : `note-${item.data.id}`)
                      const showDropLine = (!!draggingId || !!dropTargetKey) && dropTargetKey === itemKey
                      const showDropLineAfter = item.type === 'transport' && (!!draggingId || !!dropTargetKey) && dropTargetKey === `transport-after-${item.data.id}${legSuffix}-${day.id}`

                      if (item.type === 'place') {
                        const assignment = item.data
                        const place = assignment.place
                        if (!place) return null
                        const cat = categories.find(c => c.id === place.category_id)
                        const isPlaceSelected = selectedAssignmentId ? assignment.id === selectedAssignmentId : place.id === selectedPlaceId
                        const isDraggingThis = draggingId === assignment.id
                        const placeIdx = placeItems.findIndex(i => i.data.id === assignment.id)

                        const arrowMove = (direction: 'up' | 'down') => {
                          const m = getMergedItems(day.id)
                          const myIdx = m.findIndex(i => i.type === 'place' && i.data.id === assignment.id)
                          if (myIdx === -1) return
                          const targetIdx = direction === 'up' ? myIdx - 1 : myIdx + 1
                          if (targetIdx < 0 || targetIdx >= m.length) return

                          // Build new order: swap this item with its neighbor in the merged list
                          const newOrder = [...m]
                          ;[newOrder[myIdx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[myIdx]]

                          // Check chronological order of all timed items in the new order
                          const placeTime = place.place_time
                          if (parseTimeToMinutes(placeTime) !== null) {
                            const timedInNewOrder = newOrder
                              .map(i => {
                                if (i.type === 'transport') return parseTimeToMinutes(i.data?.reservation_time)
                                if (i.type === 'place') return parseTimeToMinutes(i.data?.place?.place_time)
                                return null
                              })
                              .filter(t => t !== null)
                            const isChronological = timedInNewOrder.every((t, i) => i === 0 || t >= timedInNewOrder[i - 1])
                            if (!isChronological) {
                              const timeStr = placeTime.includes(':') ? placeTime.substring(0, 5) : placeTime
                              // Describe the swap by its neighbour so the confirm step can
                              // replay it against the merged list — a place-id projection
                              // would drop moves across a booking or note.
                              const neighbour = m[targetIdx]
                              setTimeConfirm({
                                dayId: day.id, fromId: assignment.id, time: timeStr,
                                fromType: 'place', toType: neighbour.type, toId: neighbour.data.id,
                                insertAfter: direction === 'down',
                                toLegIndex: neighbour.data?.__leg?.index ?? null,
                              })
                              return
                            }
                          }
                          applyMergedOrder(day.id, newOrder)
                        }
                        const moveUp = (e) => { e.stopPropagation(); arrowMove('up') }
                        const moveDown = (e) => { e.stopPropagation(); arrowMove('down') }
                        const selectPlace = () => { onPlaceClick(isPlaceSelected ? null : place.id, isPlaceSelected ? null : assignment.id); if (!isPlaceSelected) onSelectDay(day.id, true) }

                        return (
                          <React.Fragment key={`place-${assignment.id}`}>
                          <div
                            className="dp-row"
                            // Picking the place out of the day has no other trigger, so
                            // the row is the control. Its grip, lock and arrows are
                            // buttons in their own right, hence the key handler only
                            // answers for the row itself. No press-scale — see the
                            // day header above (#2158).
                            role="button"
                            data-no-press
                            tabIndex={0}
                            draggable={canEditDays && !dragDisabled}
                            onDragStart={e => {
                              if (!canEditDays || dragDisabled) { e.preventDefault(); return }
                              e.dataTransfer.setData('assignmentId', String(assignment.id))
                              e.dataTransfer.setData('fromDayId', String(day.id))
                              e.dataTransfer.effectAllowed = 'move'
                              dragDataRef.current = { assignmentId: String(assignment.id), fromDayId: String(day.id) }
                              setDraggingId(assignment.id)
                            }}
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverDayId(null); if (dropTargetKey !== `place-${assignment.id}`) setDropTargetKey(`place-${assignment.id}`) }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation()
                              const { placeId, assignmentId: fromAssignmentId, noteId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
                              if (placeId) {
                                const pos = placeItems.findIndex(i => i.data.id === assignment.id)
                                onAssignToDay?.(Number.parseInt(placeId), day.id, pos >= 0 ? pos : undefined)
                                setDropTargetKey(null); window.__dragData = null
                              } else if (fromReservationId && fromDayId !== day.id) {
                                const r = reservations.find(x => x.id === Number(fromReservationId))
                                if (r) { const update = computeMultiDayMove(r, day.id, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (fromReservationId) {
                                handleMergedDrop(day.id, 'transport', Number(fromReservationId), 'place', assignment.id)
                              } else if (fromAssignmentId && fromDayId !== day.id) {
                                const toIdx = getDayAssignments(day.id).findIndex(a => a.id === assignment.id)
                                tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (fromAssignmentId) {
                                handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'place', assignment.id)
                              } else if (noteId && fromDayId !== day.id) {
                                const tm = getMergedItems(day.id)
                                const toIdx = tm.findIndex(i => i.type === 'place' && i.data.id === assignment.id)
                                const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                                tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (noteId) {
                                handleMergedDrop(day.id, 'note', Number(noteId), 'place', assignment.id)
                              }
                            }}
                            ref={el => {
                              // Auto-scroll the selected row into view — but only on
                              // the transition "just became selected". Once we've
                              // scrolled for this assignment id, we won't scroll
                              // again until selection actually moves somewhere else.
                              if (el && isPlaceSelected && selectionScrollKey != null && lastAutoScrolledIdRef.current !== selectionScrollKey) {
                                const rect = el.getBoundingClientRect()
                                const nearTop = rect.top < 80
                                const nearBottom = rect.bottom > window.innerHeight - 80
                                if (nearTop || nearBottom) {
                                  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                }
                                lastAutoScrolledIdRef.current = selectionScrollKey
                              }
                            }}
                            onDragEnd={() => { setDraggingId(null); setDragOverDayId(null); setDropTargetKey(null); dragDataRef.current = null }}
                            onClick={selectPlace}
                            onKeyDown={e => {
                              if (e.target !== e.currentTarget) return
                              if (e.key !== 'Enter' && e.key !== ' ') return
                              e.preventDefault()
                              selectPlace()
                            }}
                            onContextMenu={e => {
                              // Flat entries, one per app: the menu has room to
                              // grow and a submenu would need a component that
                              // does not exist here.
                              const navTargets = getNavigationTargets(place)
                              ctxMenu.open(e, [
                                canEditDays && onEditPlace && { label: t('common.edit'), icon: Pencil, onClick: () => onEditPlace(place, assignment.id) },
                                canEditDays && onRemoveAssignment && { label: t('planner.removeFromDay'), icon: Trash2, onClick: () => onRemoveAssignment(day.id, assignment.id) },
                                safeHttpUrl(place.website) && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(safeHttpUrl(place.website)!, '_blank', 'noopener,noreferrer') },
                                ...navTargets.map(target => ({ label: target.label, icon: Navigation, onClick: () => openNavigationTarget(target) })),
                                collectionsEnabled && { label: t('inspector.saveToCollection'), icon: Bookmark, onClick: () => useSaveToCollectionStore.getState().open(placeToSaveTarget(place)) },
                                { divider: true },
                                canEditDays && onDeletePlace && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => onDeletePlace(place.id) },
                              ])
                            }}
                            onMouseEnter={e => {
                              if (!isPlaceSelected && !lockedIds.has(assignment.id))
                                e.currentTarget.style.background = 'var(--bg-hover)'
                              const grip = e.currentTarget.querySelector('.dp-grip') as HTMLElement | null
                              if (grip) grip.style.opacity = '1'
                              setHoveredAssignmentId(assignment.id)
                            }}
                            onMouseLeave={e => {
                              if (!isPlaceSelected && !lockedIds.has(assignment.id))
                                e.currentTarget.style.background = 'transparent'
                              const grip = e.currentTarget.querySelector('.dp-grip') as HTMLElement | null
                              if (grip) grip.style.opacity = '0.3'
                              setHoveredAssignmentId(null)
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 8px 7px 10px',
                              cursor: 'pointer',
                              background: lockedIds.has(assignment.id)
                                ? 'rgba(220,38,38,0.08)'
                                : isPlaceSelected ? 'var(--bg-selected)' : 'transparent',
                              borderLeft: lockedIds.has(assignment.id)
                                ? '3px solid #dc2626'
                                : '3px solid transparent',
                              borderTop: showDropLine ? '2px solid var(--text-primary)' : undefined,
                              transition: 'background 0.15s, border-color 0.15s',
                              opacity: isDraggingThis ? 0.4 : 1,
                            }}
                          >
                            {canEditDays && !dragDisabled && <div className="dp-grip" style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                              <GripVertical size={13} strokeWidth={1.8} />
                            </div>}
                            <button
                              type="button"
                              aria-label={lockedIds.has(assignment.id) ? t('planner.clickToUnlock') : t('planner.keepPosition')}
                              onClick={e => { e.stopPropagation(); toggleLock(assignment.id) }}
                              onMouseEnter={e => { e.stopPropagation(); setLockHoverId(assignment.id) }}
                              onMouseLeave={() => setLockHoverId(null)}
                              style={{ position: 'relative', flexShrink: 0, cursor: 'pointer', display: 'flex', background: 'none', border: 'none', padding: 0, font: 'inherit' }}
                            >
                              <PlaceAvatar place={place} category={cat} size={28} />
                              {/* Hover/locked overlay */}
                              {(lockHoverId === assignment.id || lockedIds.has(assignment.id)) && (
                                <div style={{
                                  position: 'absolute', inset: 0, borderRadius: '50%',
                                  background: lockedIds.has(assignment.id) ? 'rgba(220,38,38,0.6)' : 'rgba(220,38,38,0.4)',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  transition: 'background 0.15s',
                                }}>
                                  <Lock size={14} strokeWidth={2.5} style={{ color: 'white', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }} />
                                </div>
                              )}
                              {/* Custom tooltip */}
                              {lockHoverId === assignment.id && (
                                <div style={{
                                  position: 'absolute', left: '100%', top: '50%', transform: 'translateY(-50%)',
                                  marginLeft: 8, whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 50,
                                  background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
                                  fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 500, padding: '5px 10px', borderRadius: 8,
                                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint, #e5e7eb)',
                                }}>
                                  {lockedIds.has(assignment.id)
                                    ? t('planner.clickToUnlock')
                                    : t('planner.keepPosition')}
                                </div>
                              )}
                            </button>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                                {cat && (() => {
                                  const CatIcon = getCategoryIcon(cat.icon)
                                  return <span title={cat.name} style={{ display: 'inline-flex', flexShrink: 0 }}><CatIcon size={10} strokeWidth={2} color={cat.color || 'var(--text-muted)'} /></span>
                                })()}
                                <span style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                                  {place.name}
                                </span>
                                {place.place_time && (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                                    <Clock size={9} strokeWidth={2} />
                                    {formatTime(place.place_time, locale, timeFormat)}{place.end_time ? ` – ${formatTime(place.end_time, locale, timeFormat)}` : ''}
                                  </span>
                                )}
                              </div>
                              {(place.description || place.address || cat?.name) && (
                                <div className="collab-note-md" style={{ marginTop: 2, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2, maxHeight: '1.2em' }}>
                                  <Markdown remarkPlugins={[remarkGfm]}>{place.description || place.address || cat?.name || ''}</Markdown>
                                </div>
                              )}
                              {assignment.notes && (
                                // Day-specific note on this stop (#2163) — one muted
                                // caption line so the timeline shows the note exists
                                // without swallowing the row.
                                <div title={t('places.assignmentNotes')} style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', overflow: 'hidden' }}>
                                  <StickyNote size={9} strokeWidth={2} style={{ flexShrink: 0 }} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>{assignment.notes}</span>
                                </div>
                              )}
                              {(() => {
                                const linked = getAssignmentReservations(reservations, assignment.id)
                                if (linked.length === 0) return null
                                // A stop can carry more than one booking (a parking pass and the
                                // tickets for the same zoo), and every one of them is kept out of
                                // the timeline, so this row is where they have to appear (#2201).
                                // Stacked, because the chip lines are inline-flex and would
                                // otherwise run together on one.
                                return (
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                                    {linked.map(res => {
                                      const confirmed = res.status === 'confirmed'
                                      const hasEndpoints = onToggleConnection && (res.endpoints || []).length >= 2
                                      const active = hasEndpoints ? visibleConnectionIds.includes(res.id) : false
                                      // The status, the time and the flight/train number used to sit in one
                                      // pill strung together on a middle dot, which read as one run-on
                                      // sentence. They are separate chips now: same tint so they still
                                      // belong together, own outline so the eye can take them one at a time.
                                      const RI = RES_ICONS[res.type] || Ticket
                                      const tint = confirmed ? 'bg-[rgba(22,163,74,0.1)] text-[#16a34a]' : 'bg-[rgba(217,119,6,0.1)] text-[#d97706]'
                                      const chip: React.CSSProperties = {
                                        display: 'inline-flex', alignItems: 'center', gap: 3,
                                        padding: '1px 6px', borderRadius: 5,
                                        fontSize: 'calc(9px * var(--fs-scale-caption, 1))', fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                      }
                                      const { time: st } = splitReservationDateTime(res.reservation_time)
                                      const { time: et } = splitReservationDateTime(res.reservation_end_time)
                                      const timeLabel = st || et
                                        ? `${st ? formatTime(st, locale, timeFormat) : ''}${et ? ` – ${formatTime(et, locale, timeFormat)}` : ''}`
                                        : ''
                                      let meta: any = {}
                                      try { meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {}) } catch { meta = {} }
                                      const carrierLabel = meta
                                        ? (meta.airline && meta.flight_number ? `${meta.airline} ${meta.flight_number}` : meta.flight_number || meta.train_number || '')
                                        : ''
                                      return (
                                        // No wrapping: the time belongs to the status it qualifies, so the
                                        // chips stay on one line even when the row gets narrow.
                                        <div key={res.id} style={{ marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'nowrap' }}>
                                          <div className={tint} style={chip}>
                                            <RI size={8} />
                                            <span className="hidden sm:inline">{confirmed ? t('planner.resConfirmed') : t('planner.resPending')}</span>
                                          </div>
                                          {timeLabel && <span className={tint} style={{ ...chip, fontWeight: 500 }}>{timeLabel}</span>}
                                          {carrierLabel && <span className={tint} style={{ ...chip, fontWeight: 500 }}>{carrierLabel}</span>}
                                          {hasEndpoints && (
                                            <button
                                              type="button"
                                              onClick={e => { e.stopPropagation(); onToggleConnection!(res.id) }}
                                              title={t(active ? 'map.hideConnections' : 'map.showConnections')}
                                              className={active ? 'bg-[#3b82f6] text-[#fff]' : 'bg-transparent text-content-faint'}
                                              style={{
                                                flexShrink: 0, appearance: 'none',
                                                width: 20, height: 20, borderRadius: 4,
                                                display: 'grid', placeItems: 'center', cursor: 'pointer',
                                                border: 'none',
                                                transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), background 120ms cubic-bezier(0.23,1,0.32,1)',
                                              }}
                                              onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-primary)' }}
                                              onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-faint)' }}
                                            >
                                              <RouteIcon size={11} />
                                            </button>
                                          )}
                                          {canEditDays && (() => {
                                            const isTransport = TRANSPORT_TYPES.has(res.type)
                                            const handler = isTransport ? onEditTransport : onEditReservation
                                            if (!handler) return null
                                            return (
                                              <button
                                                type="button"
                                                onClick={e => { e.stopPropagation(); handler(res) }}
                                                title={t('common.edit')}
                                                className="bg-transparent text-content-faint"
                                                style={{
                                                  flexShrink: 0, appearance: 'none',
                                                  width: 20, height: 20, borderRadius: 4,
                                                  display: 'grid', placeItems: 'center', cursor: 'pointer',
                                                  border: 'none',
                                                  transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), background 120ms cubic-bezier(0.23,1,0.32,1)',
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
                                                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-faint)' }}
                                              >
                                                <Pencil size={11} />
                                              </button>
                                            )
                                          })()}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )
                              })()}
                              {assignment.participants?.length > 0 && (
                                <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: -4 }}>
                                  {assignment.participants.slice(0, 5).map((p, pi) => (
                                    <div key={p.user_id} className="bg-surface-tertiary text-content-muted" style={{
                                      width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--bg-card)',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(7px * var(--fs-scale-caption, 1))', fontWeight: 700,
                                      marginLeft: pi > 0 ? -4 : 0, flexShrink: 0,
                                      overflow: 'hidden',
                                    }}>
                                      {p.avatar ? <img src={avatarSrc(p.avatar)!} alt={p.username ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : p.username?.[0]?.toUpperCase()}
                                    </div>
                                  ))}
                                  {assignment.participants.length > 5 && (
                                    <span className="text-content-faint" style={{ fontSize: 'calc(8px * var(--fs-scale-caption, 1))', marginLeft: 2 }}>+{assignment.participants.length - 5}</span>
                                  )}
                                </div>
                              )}
                            </div>
                            {canEditDays && <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, transition: 'opacity 0.15s' }}>
                              <button type="button" onClick={moveUp} disabled={idx === 0} className={idx === 0 ? 'text-[var(--border-primary)]' : 'text-content-faint'} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: idx === 0 ? 'default' : 'pointer', display: 'flex', lineHeight: 1 }}>
                                <ChevronUp size={12} strokeWidth={2} />
                              </button>
                              <button type="button" onClick={moveDown} disabled={idx === merged.length - 1} className={idx === merged.length - 1 ? 'text-[var(--border-primary)]' : 'text-content-faint'} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: idx === merged.length - 1 ? 'default' : 'pointer', display: 'flex', lineHeight: 1 }}>
                                <ChevronDown size={12} strokeWidth={2} />
                              </button>
                            </div>}
                            {canEditDays && onAddBookingToAssignment && hoveredAssignmentId === assignment.id && (
                              <button type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  onAddBookingToAssignment(day.id, assignment.id)
                                }}
                                title={t('reservations.addBooking')}
                                style={{
                                  flexShrink: 0,
                                  background: 'none',
                                  border: '1px solid var(--border-primary)',
                                  borderRadius: 5,
                                  padding: '2px 6px',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 3,
                                  fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                                  fontWeight: 500,
                                  color: 'var(--text-muted)',
                                  fontFamily: 'inherit',
                                }}
                              >
                                <Plus size={11} strokeWidth={2} />
                              </button>
                            )}
                          </div>
                          {daySchedule.byAssignment[day.id]?.[assignment.id]?.map(si => <PluginDayScheduleRow key={`${si.pluginId}:${si.id}`} item={si} />)}
                          {routeLegs[day.id]?.[assignment.id] && (canEditDays ? (
                            <div role="button" tabIndex={0} title={t('dayplan.transportMode.change')} onClick={e => openLegModeMenu(e, assignment.id, day.id, routeLegs[day.id]![assignment.id])} onKeyDown={e => openLegMenuByKey(e, m => openLegModeMenu(m, assignment.id, day.id, routeLegs[day.id]![assignment.id]))} style={{ cursor: 'pointer' }}>
                              <RouteConnector seg={routeLegs[day.id]![assignment.id]} profile={routeProfile} />
                            </div>
                          ) : (
                            <RouteConnector seg={routeLegs[day.id]![assignment.id]} profile={routeProfile} />
                          ))}
                          </React.Fragment>
                        )
                      }

                      // Transport booking (flight, train, bus, car, cruise)
                      if (item.type === 'transport') {
                        const res = item.data
                        const spanPhase = getSpanPhase(res, day.id)

                        // Car "active" (middle) days are shown in the day header, skip here
                        if (res.type === 'car' && spanPhase === 'middle') return null
                        // A multi-day parking says nothing on the days in between and gets
                        // no header badge either, only drop-off and pickup (#1937)
                        if (hidesOnMiddleDay(res, day.id)) return null

                        const TransportIcon = RES_ICONS[res.type] || Ticket
                        const color = '#3b82f6'
                        let meta: any = {}
                        try { meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {}) } catch { meta = {} }

                        // Subtitle aus Metadaten zusammensetzen
                        let subtitle = ''
                        if (res.__leg) {
                          // One leg of a multi-leg flight/train — show this segment's own detail.
                          const parts = res.type === 'train'
                            ? [res.__leg.train_number, res.__leg.platform ? `Gl. ${res.__leg.platform}` : '', res.__leg.seat ? `Sitz ${res.__leg.seat}` : ''].filter(Boolean)
                            : [res.__leg.airline, res.__leg.flight_number].filter(Boolean)
                          if (res.__leg.from || res.__leg.to)
                            parts.push([res.__leg.from, res.__leg.to].filter(Boolean).join(' → '))
                          subtitle = parts.join(' · ')
                        } else if (res.type === 'flight') {
                          const parts = [meta.airline, meta.flight_number].filter(Boolean)
                          if (meta.departure_airport || meta.arrival_airport)
                            parts.push([meta.departure_airport, meta.arrival_airport].filter(Boolean).join(' → '))
                          subtitle = parts.join(' · ')
                        } else if (res.type === 'train') {
                          subtitle = [meta.train_number, meta.platform ? `Gl. ${meta.platform}` : '', meta.seat ? `Sitz ${meta.seat}` : ''].filter(Boolean).join(' · ')
                        }

                        // A transit journey (#1065) renders its itinerary inline —
                        // line badges in their colors instead of a plain subtitle,
                        // so the connection is recognisable at a glance.
                        const transitMeta = res.type === 'transit' && meta.transit && Array.isArray(meta.transit.legs) ? meta.transit : null

                        // Multi-day span phase (single-leg / non-flight only — a
                        // multi-leg flight is shown as one row per leg, see below).
                        const spanLabel = res.__leg ? null : getSpanLabel(res, spanPhase)
                        const displayTime = getDisplayTimeForDay(res, day.id)
                        const legKey = res.__leg ? `leg${res.__leg.index}` : 'x'

                        const openTransportRow = () => {
                          const target = reservations.find(x => x.id === res.id) ?? res
                          // A transit journey opens its own journey view — the rich
                          // stop-by-stop breakdown with its booking fields, never the
                          // generic edit form (#1065).
                          if (transitMeta) {
                            if (onOpenTransit) onOpenTransit(target)
                            else setTransportDetail(target)
                            return
                          }
                          if (!canEditDays) return
                          if (TRANSPORT_TYPES.has(res.type)) onEditTransport?.(target)
                          else onEditReservation?.(target)
                        }

                        return (
                          <React.Fragment key={`transport-${res.id}-${legKey}-${day.id}`}>
                          <div
                            // Opening the booking has no other trigger, so the row is
                            // the control; the buttons inside it answer for themselves.
                            // No press-scale — see the day header above (#2158).
                            role="button"
                            data-no-press
                            tabIndex={0}
                            onClick={openTransportRow}
                            onKeyDown={e => {
                              if (e.target !== e.currentTarget) return
                              if (e.key !== 'Enter' && e.key !== ' ') return
                              e.preventDefault()
                              openTransportRow()
                            }}
                            onDragOver={e => {
                              e.preventDefault(); e.stopPropagation()
                              const rect = e.currentTarget.getBoundingClientRect()
                              const inBottom = e.clientY > rect.top + rect.height / 2
                              const ls = res.__leg ? `-leg${res.__leg.index}` : ''
                              const key = inBottom ? `transport-after-${res.id}${ls}-${day.id}` : `transport-${res.id}${ls}-${day.id}`
                              if (dropTargetRef.current !== key) setDropTargetKey(key)
                            }}
                            draggable={canEditDays && spanPhase !== 'middle' && !res.__leg && !dragDisabled}
                            onDragStart={e => {
                              if (!canEditDays || spanPhase === 'middle' || res.__leg || dragDisabled) { e.preventDefault(); return }
                              // setData is required for the drag to start reliably (Firefox) and
                              // matches how place/note items initiate their drag.
                              e.dataTransfer.setData('reservationId', String(res.id))
                              e.dataTransfer.setData('fromDayId', String(day.id))
                              e.dataTransfer.effectAllowed = 'move'
                              dragDataRef.current = { reservationId: String(res.id), fromDayId: String(day.id), phase: spanPhase }
                              setDraggingId(res.id)
                            }}
                            onDragEnd={() => { setDraggingId(null); setDragOverDayId(null); setDropTargetKey(null); dragDataRef.current = null }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation()
                              const rect = e.currentTarget.getBoundingClientRect()
                              const insertAfter = e.clientY > rect.top + rect.height / 2
                              const { placeId, assignmentId: fromAssignmentId, noteId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
                              if (placeId) {
                                onAssignToDay?.(Number.parseInt(placeId), day.id)
                              } else if (fromReservationId && fromDayId !== day.id) {
                                const r2 = reservations.find(x => x.id === Number(fromReservationId))
                                if (r2) { const update = computeMultiDayMove(r2, day.id, phase); tripActions.updateReservation(tripId, r2.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                              } else if (fromReservationId) {
                                handleMergedDrop(day.id, 'transport', Number(fromReservationId), 'transport', res.id, insertAfter, res.__leg?.index ?? null)
                              } else if (fromAssignmentId && fromDayId !== day.id) {
                                tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                              } else if (fromAssignmentId) {
                                handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'transport', res.id, insertAfter, res.__leg?.index ?? null)
                              } else if (noteId && fromDayId !== day.id) {
                                tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                              } else if (noteId) {
                                handleMergedDrop(day.id, 'note', Number(noteId), 'transport', res.id, insertAfter, res.__leg?.index ?? null)
                              }
                              setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = `${color}12` }}
                            onMouseLeave={e => { e.currentTarget.style.background = `${color}08` }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 8px 7px 10px',
                              margin: '1px 8px',
                              borderRadius: 6,
                              border: `1px solid ${color}33`,
                              borderTop: showDropLine ? '2px solid var(--text-primary)' : undefined,
                              borderBottom: showDropLineAfter ? '2px solid var(--text-primary)' : undefined,
                              background: `${color}08`,
                              cursor: (transitMeta || (canEditDays && onEditTransport)) ? 'pointer' : 'default', userSelect: 'none',
                              transition: 'background 0.1s',
                              opacity: draggingId === res.id ? 0.4 : spanPhase === 'middle' ? 0.65 : 1,
                            }}
                          >
                            {canEditDays && spanPhase !== 'middle' && !res.__leg && !dragDisabled && (
                              <div className="dp-grip" style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                                <GripVertical size={13} strokeWidth={1.8} />
                              </div>
                            )}
                            <div style={{
                              width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              borderRadius: '50%', background: `${color}18`,
                            }}>
                              <TransportIcon size={14} strokeWidth={1.8} color={color} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {spanLabel && (
                                  <span style={{
                                    fontSize: 'calc(9px * var(--fs-scale-caption, 1))', fontWeight: 700, padding: '1px 5px', borderRadius: 4, flexShrink: 0,
                                    background: `${color}20`, color: color, textTransform: 'uppercase', letterSpacing: '0.03em',
                                  }}>
                                    {spanLabel}
                                  </span>
                                )}
                                <span style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                                  {transitMeta ? <TransitTitle title={res.title} iconSize={11} /> : res.title}
                                </span>
                                {(() => {
                                  const { time: dispTime } = splitReservationDateTime(displayTime)
                                  const { time: endTime } = splitReservationDateTime(res.reservation_end_time)
                                  if (!dispTime && !endTime) return null
                                  return (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                                      <Clock size={9} strokeWidth={2} />
                                      {dispTime ? formatTime(dispTime, locale, timeFormat) : ''}
                                      {spanPhase === 'single' && endTime ? ` – ${formatTime(endTime, locale, timeFormat)}` : ''}
                                      {meta.departure_timezone && spanPhase === 'start' && ` ${meta.departure_timezone}`}
                                      {meta.arrival_timezone && spanPhase === 'end' && ` ${meta.arrival_timezone}`}
                                    </span>
                                  )
                                })()}
                              </div>
                              {transitMeta ? (
                                <div style={{ display: 'flex', alignItems: 'center', marginTop: 3 }}>
                                  <TransitLegChips legs={transitMeta.legs} size="sm" t={t} />
                                </div>
                              ) : subtitle && (
                                <div style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', color: 'var(--text-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {subtitle}
                                </div>
                              )}
                            </div>
                            {transitMeta && (() => {
                              const expanded = expandedTransitIds.has(res.id)
                              return (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation()
                                    setExpandedTransitIds(prev => {
                                      const next = new Set(prev)
                                      if (next.has(res.id)) next.delete(res.id); else next.add(res.id)
                                      return next
                                    })
                                  }}
                                  title={t(expanded ? 'common.collapse' : 'common.expand')}
                                  aria-label={t(expanded ? 'common.collapse' : 'common.expand')}
                                  style={{
                                    flexShrink: 0, appearance: 'none', width: 26, height: 26, borderRadius: 6,
                                    display: 'grid', placeItems: 'center', cursor: 'pointer', border: 'none',
                                    background: 'transparent', color: 'var(--text-faint)',
                                  }}
                                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
                                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-faint)' }}
                                >
                                  {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                </button>
                              )
                            })()}
                            {!transitMeta && onToggleConnection && (!res.__leg || res.__leg.index === 0) && (res.endpoints || []).length >= 2 && (() => {
                              const active = visibleConnectionIds.includes(res.id)
                              return (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); onToggleConnection(res.id) }}
                                  title={t(active ? 'map.hideConnections' : 'map.showConnections')}
                                  style={{
                                    flexShrink: 0, appearance: 'none',
                                    width: 26, height: 26, borderRadius: 6,
                                    display: 'grid', placeItems: 'center', cursor: 'pointer',
                                    border: 'none',
                                    background: active ? color : 'transparent',
                                    color: active ? '#fff' : 'var(--text-faint)',
                                    transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), background 120ms cubic-bezier(0.23,1,0.32,1)',
                                  }}
                                  onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--text-primary)' }}
                                  onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--text-faint)' }}
                                >
                                  <RouteIcon size={13} />
                                </button>
                              )
                            })()}
                          </div>
                          {transitMeta && expandedTransitIds.has(res.id) && (
                            <div style={{ margin: '2px 8px 4px', padding: '9px 10px 9px 12px', borderRadius: 6, border: `1px solid ${color}26`, background: `${color}05` }}>
                              <TransitItineraryInline legs={transitMeta.legs} t={t} />
                            </div>
                          )}
                          {daySchedule.byReservation[day.id]?.[res.id]?.map(si => <PluginDayScheduleRow key={`${si.pluginId}:${si.id}`} item={si} />)}
                          {routeLegs[day.id]?.[res.id] && (() => {
                            const nextPlaceId = merged.slice(idx + 1).find(i => i.type === 'place' && i.data.place?.lat && i.data.place?.lng)?.data.id
                            const connector = <RouteConnector seg={routeLegs[day.id]![res.id]} profile={routeProfile} />
                            return canEditDays && nextPlaceId != null ? (
                              <div role="button" tabIndex={0} title={t('dayplan.transportMode.change')} onClick={e => openIncomingLegModeMenu(e, Number(nextPlaceId), day.id, routeLegs[day.id]![res.id])} onKeyDown={e => openLegMenuByKey(e, m => openIncomingLegModeMenu(m, Number(nextPlaceId), day.id, routeLegs[day.id]![res.id]))} style={{ cursor: 'pointer' }}>
                                {connector}
                              </div>
                            ) : connector
                          })()}
                          </React.Fragment>
                        )
                      }

                      // Notizkarte
                      const note = item.data
                      const NoteIcon = getNoteIcon(note.icon)
                      const noteSkin = noteSurface(note.color)
                      const noteIdx = idx
                      return (
                        <React.Fragment key={`note-${note.id}`}>
                        <div
                          className="dp-row"
                          draggable={canEditDays && !dragDisabled}
                          onDragStart={e => { if (!canEditDays || dragDisabled) { e.preventDefault(); return } e.dataTransfer.setData('noteId', String(note.id)); e.dataTransfer.setData('fromDayId', String(day.id)); e.dataTransfer.effectAllowed = 'move'; dragDataRef.current = { noteId: String(note.id), fromDayId: String(day.id) }; setDraggingId(`note-${note.id}`) }}
                          onDragEnd={() => { setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null }}
                          onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dropTargetKey !== `note-${note.id}`) setDropTargetKey(`note-${note.id}`) }}
                          onDrop={e => {
                            e.preventDefault(); e.stopPropagation()
                            const { placeId, noteId: fromNoteId, assignmentId: fromAssignmentId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
                            if (placeId) {
                              // New place dropped onto a note: insert it among the
                              // assignments at the note's position (after the places
                              // above it), so it lands right where the note sits.
                              const tm = getMergedItems(day.id)
                              const noteIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const pos = tm.slice(0, noteIdx).filter(i => i.type === 'place').length
                              onAssignToDay?.(Number.parseInt(placeId), day.id, pos)
                              setDropTargetKey(null); window.__dragData = null
                            } else if (fromReservationId && fromDayId !== day.id) {
                              const r = reservations.find(x => x.id === Number(fromReservationId))
                              if (r) { const update = computeMultiDayMove(r, day.id, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                              setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                            } else if (fromReservationId) {
                              handleMergedDrop(day.id, 'transport', Number(fromReservationId), 'note', note.id)
                            } else if (fromNoteId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const toIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                              tripActions.moveDayNote(tripId, fromDayId, day.id, Number(fromNoteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromNoteId && fromNoteId !== String(note.id)) {
                              handleMergedDrop(day.id, 'note', Number(fromNoteId), 'note', note.id)
                            } else if (fromAssignmentId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const noteIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const toIdx = tm.slice(0, noteIdx).filter(i => i.type === 'place').length
                              tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromAssignmentId) {
                              handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'note', note.id)
                            }
                          }}
                          onContextMenu={canEditDays ? e => ctxMenu.open(e, [
                            { label: t('common.edit'), icon: Pencil, onClick: () => openEditNote(day.id, note) },
                            { divider: true },
                            { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => setPendingDeleteNote({ dayId: day.id, noteId: note.id }) },
                          ]) : undefined}
                          {...(canEditDays ? {
                            role: 'button' as const,
                            // No press-scale: index.css shrinks every [role=button] on
                            // :active, which on a draggable row fights the drag (#2158).
                            'data-no-press': '',
                            tabIndex: 0,
                            // The row is the note's edit affordance — the same gesture the
                            // phone shell already uses (#2249). Links inside the rendered
                            // body and the reorder buttons keep their own click.
                            onClick: (e: React.MouseEvent) => {
                              if ((e.target as HTMLElement).closest('a, button')) return
                              openEditNote(day.id, note)
                            },
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.target !== e.currentTarget) return
                              if (e.key !== 'Enter' && e.key !== ' ') return
                              e.preventDefault()
                              openEditNote(day.id, note)
                            },
                          } : {})}
                          onMouseEnter={e => {
                            const grip = e.currentTarget.querySelector('.dp-grip') as HTMLElement | null
                            if (grip) grip.style.opacity = '1'
                          }}
                          onMouseLeave={e => {
                            const grip = e.currentTarget.querySelector('.dp-grip') as HTMLElement | null
                            if (grip) grip.style.opacity = '0.3'
                          }}
                          style={{
                            position: 'relative',
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 8px 7px 2px',
                            margin: '1px 8px',
                            borderRadius: 6,
                            border: `1px solid ${noteSkin.border}`,
                            borderTop: showDropLine ? '2px solid var(--text-primary)' : undefined,
                            background: noteSkin.background,
                            opacity: draggingId === `note-${note.id}` ? 0.4 : 1,
                            transition: 'background 0.1s', cursor: canEditDays ? 'pointer' : 'default', userSelect: 'none',
                          }}
                        >
                          {canEditDays && !dragDisabled && <div className="dp-grip" style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                            <GripVertical size={13} strokeWidth={1.8} />
                          </div>}
                          <div style={{ width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: noteSkin.iconBackground, overflow: 'hidden' }}>
                            <NoteIcon size={13} strokeWidth={1.8} color={noteSkin.iconColor} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                              {note.text}
                            </span>
                            {note.time && (
                              <div className="collab-note-md" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', fontWeight: 400, color: 'var(--text-faint)', lineHeight: '1.4', marginTop: 2, wordBreak: 'break-word' }}>
                                {/* A link in a note goes to its own tab, and remarkBreaks
                                    keeps a single newline a line break — people write notes
                                    as lines, not as Markdown paragraphs. */}
                                <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownLinkComponents}>{note.time}</Markdown>
                              </div>
                            )}
                          </div>
                        {canEditDays && <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, transition: 'opacity 0.15s' }}>
                          <button type="button" onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'up') }} disabled={noteIdx === 0} className={noteIdx === 0 ? 'text-[var(--border-primary)]' : 'text-content-faint'} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === 0 ? 'default' : 'pointer', display: 'flex', lineHeight: 1 }}><ChevronUp size={12} strokeWidth={2} /></button>
                          <button type="button" onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'down') }} disabled={noteIdx === merged.length - 1} className={noteIdx === merged.length - 1 ? 'text-[var(--border-primary)]' : 'text-content-faint'} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === merged.length - 1 ? 'default' : 'pointer', display: 'flex', lineHeight: 1 }}><ChevronDown size={12} strokeWidth={2} /></button>
                        </div>}
                        </div>
                        </React.Fragment>
                      )
                    })
                  )}
                  {daySchedule.byPosition[day.id]?.end.map(si => <PluginDayScheduleRow key={`${si.pluginId}:${si.id}`} item={si} />)}
                  {hotelLegs[day.id]?.bottom && (() => {
                    const targetId = hotelLegs[day.id]?.bottom?.targetId
                    const connector = <HotelRouteConnector seg={hotelLegs[day.id]!.bottom!.seg} name={hotelLegs[day.id]!.bottom!.name} profile={routeProfile} placement="bottom" />
                    return canEditDays && targetId != null ? (
                      <div role="button" tabIndex={0} title={t('dayplan.transportMode.change')} onClick={e => openLegModeMenu(e, targetId, day.id, hotelLegs[day.id]!.bottom!.seg)} onKeyDown={e => openLegMenuByKey(e, m => openLegModeMenu(m, targetId, day.id, hotelLegs[day.id]!.bottom!.seg))} style={{ cursor: 'pointer' }}>
                        {connector}
                      </div>
                    ) : connector
                  })()}
                  {/* Drop-Zone am Listenende — immer vorhanden als Drop-Target */}
                  <div
                    style={{ minHeight: 12, padding: '2px 8px' }}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dropTargetKey !== `end-${day.id}`) setDropTargetKey(`end-${day.id}`) }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation()
                      const { placeId, assignmentId, noteId, reservationId: fromReservationId, fromDayId, phase } = getDragData(e)
                      // Neuer Ort von der Orte-Liste
                      if (placeId) {
                        onAssignToDay?.(Number.parseInt(placeId), day.id)
                        setDropTargetKey(null); window.__dragData = null; return
                      }
                      if (fromReservationId && fromDayId !== day.id) {
                        const r = reservations.find(x => x.id === Number(fromReservationId))
                        if (r) { const update = computeMultiDayMove(r, day.id, phase); tripActions.updateReservation(tripId, r.id, update).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError'))) }
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null; return
                      }
                      if (!assignmentId && !noteId && !fromReservationId) { dragDataRef.current = null; window.__dragData = null; return }
                      if (assignmentId && fromDayId !== day.id) {
                        tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                      }
                      if (noteId && fromDayId !== day.id) {
                        tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                      }
                      const m = getMergedItems(day.id)
                      if (m.length === 0) return
                      const lastItem = m[m.length - 1]
                      if (assignmentId && String(lastItem?.data?.id) !== assignmentId)
                        handleMergedDrop(day.id, 'place', Number(assignmentId), lastItem.type, lastItem.data.id, true)
                      else if (noteId && String(lastItem?.data?.id) !== noteId)
                        handleMergedDrop(day.id, 'note', Number(noteId), lastItem.type, lastItem.data.id, true)
                      else if (fromReservationId && String(lastItem?.data?.id) !== fromReservationId)
                        handleMergedDrop(day.id, 'transport', Number(fromReservationId), lastItem.type, lastItem.data.id, true)
                      setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null
                    }}
                  >
                    {dropTargetKey === `end-${day.id}` && (
                      <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1 }} />
                    )}
                  </div>

                  {/* Routen-Werkzeuge (ausgewählter Tag, 2+ Orte — oder 1 Ort mit Hotel-Bookend #1330 — oder Hotel-zu-Hotel-Transfertag ohne Orte #1297) */}
                  {(isSelected || (showRouteToolsWhenExpanded && isExpanded)) && routeToolsRoutable && (
                    <div style={{ padding: '10px 16px 12px', borderTop: '1px solid var(--border-faint)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                        <button type="button"
                          onClick={() => {
                            if (showRouteToolsWhenExpanded) {
                              // Mobile: toggle this day's inline leg distances in place.
                              // Selecting the day would close the sheet, so we don't — the
                              // distances between places appear right here instead (#1374).
                              setExpandedRouteDayIds(prev => {
                                const next = new Set(prev)
                                next.has(day.id) ? next.delete(day.id) : next.add(day.id)
                                return next
                              })
                            } else {
                              // Desktop: the tools only render for the selected day, so the
                              // toggle always applies to it.
                              onToggleRoute?.()
                            }
                          }}
                          className={routeActive ? 'bg-accent text-accent-text' : 'bg-transparent text-content-secondary'}
                          style={{
                            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                            padding: '6px 0', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600, borderRadius: 8,
                            border: routeActive ? 'none' : '1px solid var(--border-faint)',
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <RouteIcon size={12} strokeWidth={2} />
                          {t('dayplan.route')}
                        </button>
                        {/* Open the day's stops as a route in Google Maps (planned order). #1255 */}
                        <button type="button"
                          onClick={() => {
                            const url = generateGoogleMapsUrl(dayExportStops())
                            if (url) window.open(url, '_blank', 'noopener,noreferrer')
                          }}
                          aria-label={t('planner.openGoogleMaps')}
                          title={t('planner.openGoogleMaps')}
                          className="bg-transparent text-content-secondary"
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-faint)',
                            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                          }}
                        >
                          <GoogleMapsIcon size={14} />
                        </button>
                        {/* The same day, handed to CoMaps for offline navigation (#1904). The
                            day's own travel mode rides along, so the route it builds walks
                            when the plan walks. */}
                        <button type="button"
                          onClick={() => {
                            const url = generateCoMapsUrl(dayExportStops(), day.default_transport_mode ?? routeProfile)
                            if (url) window.open(url, '_blank', 'noopener,noreferrer')
                          }}
                          aria-label={t('planner.openCoMaps')}
                          title={t('planner.openCoMaps')}
                          className="bg-transparent text-content-secondary"
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-faint)',
                            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                          }}
                        >
                          <Compass size={14} strokeWidth={2} />
                        </button>
                        {/* Icon-only, like the two map hand-offs beside it (#1981). It
                            was the one button here carrying a label with no room for
                            it: `flex: 1` alongside `padding: '6px 0'` meant the text
                            sat against both edges as soon as the row filled up, and
                            the row gained a button when CoMaps arrived. The label
                            stays as the accessible name and the tooltip. */}
                        <button type="button"
                          onClick={() => handleOptimize(day.id)}
                          aria-label={t('dayplan.optimize')}
                          title={t('dayplan.optimize')}
                          className="bg-surface-hover text-content-secondary"
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: '6px 10px', borderRadius: 8, border: 'none',
                            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                          }}
                        >
                          <RotateCcw size={14} strokeWidth={2} />
                        </button>
                        <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-faint)', flexShrink: 0 }}>
                          {routeProfileOptions.map(p => {
                            const ModeIcon = p.key === 'driving' ? Car : p.key === 'walking' ? Footprints : Zap
                            const active = (day.default_transport_mode ?? routeProfile) === p.key
                            return (
                              <button type="button"
                                key={p.key}
                                onClick={() => setDayDefaultMode(day.id, p.key)}
                                aria-label={p.label}
                                title={p.label}
                                className={active ? 'bg-accent text-accent-text' : 'bg-transparent text-content-secondary'}
                                style={{
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  padding: '6px 10px', border: 'none', cursor: 'pointer',
                                }}
                              >
                                <ModeIcon size={13} strokeWidth={2} />
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      {/* Time plugins contributed to this day (charging, buffers) — the
                          dayScheduleProvider minutes folded into the footer total. */}
                      {isSelected && daySchedule.minutesByDay[day.id] ? (
                        <div className="text-content-secondary bg-surface-hover" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, fontSize: 'calc(12px * var(--fs-scale-body, 1))', borderRadius: 8, padding: '5px 10px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Zap size={11} strokeWidth={2} />
                            +{formatScheduleMinutes(daySchedule.minutesByDay[day.id])}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Mobile: Add Place from list */}
                  <MobileAddPlaceButton
                    dayId={day.id}
                    places={places}
                    assignments={assignments}
                    onAssign={onAssignToDay}
                    onAddNew={onAddPlace}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Notiz-Popup-Modal — über Portal gerendert, um den backdropFilter-Stapelkontext zu umgehen */}
      <DayPlanSidebarNoteModal
        noteUi={noteUi}
        setNoteUi={setNoteUi}
        noteInputRef={noteInputRef}
        cancelNote={cancelNote}
        saveNote={saveNote}
        onRequestDelete={(dayId, noteId) => setPendingDeleteNote({ dayId, noteId })}
        t={t}
      />

      {/* Confirm: remove time when reordering a timed place */}
      <DayPlanSidebarTimeConfirmModal
        timeConfirm={timeConfirm}
        setTimeConfirm={setTimeConfirm}
        confirmTimeRemoval={confirmTimeRemoval}
        t={t}
      />

      {/* Confirm: delete a day note — guards against accidental taps on touch devices */}
      <ConfirmDialog
        isOpen={!!pendingDeleteNote}
        onClose={() => setPendingDeleteNote(null)}
        onConfirm={() => {
          if (!pendingDeleteNote) return
          // Close the edit modal behind the confirm; leaving it open would go on
          // editing a note that no longer exists.
          cancelNote(pendingDeleteNote.dayId)
          deleteNote(pendingDeleteNote.dayId, pendingDeleteNote.noteId)
        }}
        title={t('dayplan.confirmDeleteNoteTitle')}
        message={t('dayplan.confirmDeleteNoteBody')}
      />

      {/* Transport-Detail-Modal */}
      <DayPlanSidebarTransportDetailModal
        transportDetail={transportDetail}
        setTransportDetail={setTransportDetail}
        onNavigateToFiles={onNavigateToFiles}
        onEdit={canEditDays && onEditTransport ? (res) => { setTransportDetail(null); onEditTransport(res) } : undefined}
        t={t}
        locale={locale}
        timeFormat={timeFormat}
      />

      {/* Budget-Fußzeile */}
      <DayPlanSidebarFooter totalCostLabel={totalCostLabel} t={t} />
      <ContextMenu menu={ctxMenu.menu} onClose={ctxMenu.close} />
    </div>
  )
})

export default DayPlanSidebar
