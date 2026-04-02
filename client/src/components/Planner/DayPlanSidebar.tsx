/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
interface DragDataPayload { placeId?: string; assignmentId?: string; noteId?: string; fromDayId?: string }
declare global { interface Window { __dragData: DragDataPayload | null } }

import React, { useState, useEffect, useRef, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { ChevronDown, ChevronRight, ChevronUp, Navigation, RotateCcw, ExternalLink, Clock, Pencil, GripVertical, Ticket, Plus, FileText, Check, Trash2, Info, MapPin, Star, Heart, Camera, Lightbulb, Flag, Bookmark, Train, Bus, Plane, Car, Ship, Coffee, ShoppingBag, AlertTriangle, FileDown, Lock, Hotel, Utensils, Users, Undo2 } from 'lucide-react'

const RES_ICONS = { flight: Plane, hotel: Hotel, restaurant: Utensils, train: Train, car: Car, cruise: Ship, event: Ticket, tour: Users, other: FileText }
import { assignmentsApi, reservationsApi } from '../../api/client'
import { downloadTripPDF } from '../PDF/TripPDF'
import { calculateRoute, generateGoogleMapsUrl, optimizeRoute } from '../Map/RouteCalculator'
import PlaceAvatar from '../shared/PlaceAvatar'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import WeatherWidget from '../Weather/WeatherWidget'
import { useToast } from '../shared/Toast'
import { getCategoryIcon } from '../shared/categoryIcons'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import { formatDate, formatTime, dayTotalCost, currencyDecimals } from '../../utils/formatters'
import { useDayNotes } from '../../hooks/useDayNotes'
import type { Trip, Day, Place, Category, Assignment, Reservation, AssignmentsMap, RouteResult } from '../../types'

const NOTE_ICONS = [
  { id: 'FileText', Icon: FileText },
  { id: 'Info', Icon: Info },
  { id: 'Clock', Icon: Clock },
  { id: 'MapPin', Icon: MapPin },
  { id: 'Navigation', Icon: Navigation },
  { id: 'Train', Icon: Train },
  { id: 'Plane', Icon: Plane },
  { id: 'Bus', Icon: Bus },
  { id: 'Car', Icon: Car },
  { id: 'Ship', Icon: Ship },
  { id: 'Coffee', Icon: Coffee },
  { id: 'Ticket', Icon: Ticket },
  { id: 'Star', Icon: Star },
  { id: 'Heart', Icon: Heart },
  { id: 'Camera', Icon: Camera },
  { id: 'Flag', Icon: Flag },
  { id: 'Lightbulb', Icon: Lightbulb },
  { id: 'AlertTriangle', Icon: AlertTriangle },
  { id: 'ShoppingBag', Icon: ShoppingBag },
  { id: 'Bookmark', Icon: Bookmark },
]
const NOTE_ICON_MAP = Object.fromEntries(NOTE_ICONS.map(({ id, Icon }) => [id, Icon]))
function getNoteIcon(iconId) { return NOTE_ICON_MAP[iconId] || FileText }

const TYPE_ICONS = {
  flight: '✈️', hotel: '🏨', restaurant: '🍽️', train: '🚆',
  car: '🚗', cruise: '🚢', event: '🎫', other: '📋',
}

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
  onSelectDay: (dayId: number | null) => void
  onPlaceClick: (placeId: number) => void
  onDayDetail: (day: Day) => void
  accommodations?: Assignment[]
  onReorder: (dayId: number, orderedIds: number[]) => void
  onUpdateDayTitle: (dayId: number, title: string) => void
  onRouteCalculated: (dayId: number, route: RouteResult | null) => void
  onAssignToDay: (placeId: number, dayId: number) => void
  onRemoveAssignment: (assignmentId: number, dayId: number) => void
  onEditPlace: (place: Place) => void
  onDeletePlace: (placeId: number) => void
  reservations?: Reservation[]
  onAddReservation: () => void
  onNavigateToFiles?: () => void
  onExpandedDaysChange?: (expandedDayIds: Set<number>) => void
  pushUndo?: (label: string, undoFn: () => Promise<void> | void) => void
  canUndo?: boolean
  lastActionLabel?: string | null
  onUndo?: () => void
}

const DayPlanSidebar = React.memo(function DayPlanSidebar({
  tripId,
  trip, days, places, categories, assignments,
  selectedDayId, selectedPlaceId, selectedAssignmentId,
  onSelectDay, onPlaceClick, onDayDetail, accommodations = [],
  onReorder, onUpdateDayTitle, onRouteCalculated,
  onAssignToDay, onRemoveAssignment, onEditPlace, onDeletePlace,
  reservations = [],
  onAddReservation,
  onNavigateToFiles,
  onExpandedDaysChange,
  pushUndo,
  canUndo = false,
  lastActionLabel = null,
  onUndo,
}: DayPlanSidebarProps) {
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const ctxMenu = useContextMenu()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const tripActions = useRef(useTripStore.getState()).current
  const can = useCanDo()
  const canEditDays = can('day_edit', trip)

  const { noteUi, setNoteUi, noteInputRef, dayNotes, openAddNote: _openAddNote, openEditNote: _openEditNote, cancelNote, saveNote, deleteNote: _deleteNote, moveNote: _moveNote } = useDayNotes(tripId)

  const [expandedDays, setExpandedDays] = useState(() => {
    try {
      const saved = sessionStorage.getItem(`day-expanded-${tripId}`)
      if (saved) return new Set(JSON.parse(saved))
    } catch {}
    return new Set(days.map(d => d.id))
  })
  useEffect(() => { onExpandedDaysChange?.(expandedDays) }, [expandedDays])
  const [editingDayId, setEditingDayId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [isCalculating, setIsCalculating] = useState(false)
  const [routeInfo, setRouteInfo] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [lockedIds, setLockedIds] = useState(new Set())
  const [lockHoverId, setLockHoverId] = useState(null)
  const [undoHover, setUndoHover] = useState(false)
  const [pdfHover, setPdfHover] = useState(false)
  const [icsHover, setIcsHover] = useState(false)
  const [dropTargetKey, _setDropTargetKey] = useState(null)
  const dropTargetRef = useRef(null)
  const setDropTargetKey = (key) => { dropTargetRef.current = key; _setDropTargetKey(key) }
  const [dragOverDayId, setDragOverDayId] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [transportDetail, setTransportDetail] = useState(null)
  const [timeConfirm, setTimeConfirm] = useState<{
    dayId: number; fromId: number; time: string;
    // For drag & drop reorder
    fromType?: string; toType?: string; toId?: number; insertAfter?: boolean;
    // For arrow reorder
    reorderIds?: number[];
  } | null>(null)
  const inputRef = useRef(null)
  const dragDataRef = useRef(null)
  const initedTransportIds = useRef(new Set<number>()) // Speichert Drag-Daten als Backup (dataTransfer geht bei Re-Render verloren)

  const currency = trip?.currency || 'EUR'

  // Drag-Daten aus dataTransfer, Ref oder window lesen (dataTransfer geht bei Re-Render verloren)
  const getDragData = (e) => {
    const dt = e?.dataTransfer
    // Interner Drag hat Vorrang (Ref wird nur bei assignmentId/noteId gesetzt)
    if (dragDataRef.current) {
      return {
        placeId: '',
        assignmentId: dragDataRef.current.assignmentId || '',
        noteId: dragDataRef.current.noteId || '',
        fromDayId: parseInt(dragDataRef.current.fromDayId) || 0,
      }
    }
    // Externer Drag (aus PlacesSidebar)
    const ext = window.__dragData || {}
    const placeId = dt?.getData('placeId') || ext.placeId || ''
    return { placeId, assignmentId: '', noteId: '', fromDayId: 0 }
  }

  // Only auto-expand genuinely new days (not on initial load from storage)
  const prevDayCount = React.useRef(days.length)
  useEffect(() => {
    if (days.length > prevDayCount.current) {
      // New days added — expand only those
      setExpandedDays(prev => {
        const n = new Set(prev)
        days.forEach(d => { if (!prev.has(d.id)) n.add(d.id) })
        try { sessionStorage.setItem(`day-expanded-${tripId}`, JSON.stringify([...n])) } catch {}
        return n
      })
    }
    prevDayCount.current = days.length
  }, [days.length, tripId])

  useEffect(() => {
    if (editingDayId && inputRef.current) inputRef.current.focus()
  }, [editingDayId])

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

  const toggleDay = (dayId, e) => {
    e.stopPropagation()
    setExpandedDays(prev => {
      const n = new Set(prev)
      n.has(dayId) ? n.delete(dayId) : n.add(dayId)
      try { sessionStorage.setItem(`day-expanded-${tripId}`, JSON.stringify([...n])) } catch {}
      return n
    })
  }

  const TRANSPORT_TYPES = new Set(['flight', 'train', 'bus', 'car', 'cruise'])

  const getTransportForDay = (dayId: number) => {
    const day = days.find(d => d.id === dayId)
    if (!day?.date) return []
    return reservations.filter(r => {
      if (!r.reservation_time || !TRANSPORT_TYPES.has(r.type)) return false
      const resDate = r.reservation_time.split('T')[0]
      return resDate === day.date
    })
  }

  const getDayAssignments = (dayId) =>
    (assignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)

  // Helper: parse time string ("HH:MM" or ISO) to minutes since midnight, or null
  const parseTimeToMinutes = (time?: string | null): number | null => {
    if (!time) return null
    // ISO-Format "2025-03-30T09:00:00"
    if (time.includes('T')) {
      const [h, m] = time.split('T')[1].split(':').map(Number)
      return h * 60 + m
    }
    // Einfaches "HH:MM" Format
    const parts = time.split(':').map(Number)
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1]
    return null
  }

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
    for (const p of positions) {
      initedTransportIds.current.add(p.id)
      const res = reservations.find(x => x.id === p.id)
      if (res) res.day_plan_position = p.day_plan_position
    }
    // Persist to server (fire and forget)
    reservationsApi.updatePositions(tripId, positions).catch(() => {})
  }

  const getMergedItems = (dayId) => {
    const da = getDayAssignments(dayId)
    const dn = (dayNotes[String(dayId)] || []).slice().sort((a, b) => a.sort_order - b.sort_order)
    const transport = getTransportForDay(dayId)

    // Initialize positions for transports that don't have one yet
    if (transport.some(r => r.day_plan_position == null)) {
      initTransportPositions(dayId)
    }

    // Build base list: untimed places + notes sorted by order_index/sort_order
    const timedPlaces = da.filter(a => parseTimeToMinutes(a.place?.place_time) !== null)
    const freePlaces = da.filter(a => parseTimeToMinutes(a.place?.place_time) === null)

    const baseItems = [
      ...freePlaces.map(a => ({ type: 'place' as const, sortKey: a.order_index, data: a })),
      ...dn.map(n => ({ type: 'note' as const, sortKey: n.sort_order, data: n })),
    ].sort((a, b) => a.sortKey - b.sortKey)

    // Timed places + transports: compute sortKeys based on time, inserted among base items
    const allTimed = [
      ...timedPlaces.map(a => ({ type: 'place' as const, data: a, minutes: parseTimeToMinutes(a.place?.place_time)! })),
      ...transport.map(r => ({ type: 'transport' as const, data: r, minutes: parseTimeToMinutes(r.reservation_time) ?? 0 })),
    ].sort((a, b) => a.minutes - b.minutes)

    if (allTimed.length === 0) return baseItems
    if (baseItems.length === 0) {
      return allTimed.map((item, i) => ({ ...item, sortKey: i }))
    }

    // Insert timed items among base items using time-to-position mapping.
    // Each timed item finds the last base place whose order_index corresponds
    // to a reasonable position, then gets a fractional sortKey after it.
    const result = [...baseItems]
    for (let ti = 0; ti < allTimed.length; ti++) {
      const timed = allTimed[ti]
      const minutes = timed.minutes

      // For transports, use persisted position if available
      if (timed.type === 'transport' && timed.data.day_plan_position != null) {
        result.push({ type: timed.type, sortKey: timed.data.day_plan_position, data: timed.data })
        continue
      }

      // Find insertion position: after the last base item with time <= this item's time
      let insertAfterKey = -Infinity
      for (const item of result) {
        if (item.type === 'place') {
          const pm = parseTimeToMinutes(item.data?.place?.place_time)
          if (pm !== null && pm <= minutes) insertAfterKey = item.sortKey
        } else if (item.type === 'transport') {
          const tm = parseTimeToMinutes(item.data?.reservation_time)
          if (tm !== null && tm <= minutes) insertAfterKey = item.sortKey
        }
      }

      const lastKey = result.length > 0 ? Math.max(...result.map(i => i.sortKey)) : 0
      const sortKey = insertAfterKey === -Infinity
        ? lastKey + 0.5 + ti * 0.01
        : insertAfterKey + 0.01 + ti * 0.001

      result.push({ type: timed.type, sortKey, data: timed.data })
    }

    return result.sort((a, b) => a.sortKey - b.sortKey)
  }

  // Pre-compute merged items for all days so the render loop doesn't recompute on unrelated state changes (e.g. hover)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mergedItemsMap = useMemo(() => {
    const map: Record<number, ReturnType<typeof getMergedItems>> = {}
    days.forEach(day => { map[day.id] = getMergedItems(day.id) })
    return map
  // getMergedItems is redefined each render but captures assignments/dayNotes/reservations/days via closure
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, assignments, dayNotes, reservations])

  const openAddNote = (dayId, e) => {
    e?.stopPropagation()
    _openAddNote(dayId, getMergedItems, (id) => {
      if (!expandedDays.has(id)) setExpandedDays(prev => new Set([...prev, id]))
    })
  }

  // Check if a proposed reorder of place IDs would break chronological order
  // of ALL timed items (places with time + transport bookings)
  const wouldBreakChronology = (dayId: number, newPlaceIds: number[]) => {
    const da = getDayAssignments(dayId)
    const transport = getTransportForDay(dayId)

    // Simulate the merged list with places in new order + transports at their positions
    // Places get sequential integer positions
    const simItems: { pos: number; minutes: number }[] = []
    newPlaceIds.forEach((id, idx) => {
      const a = da.find(x => x.id === id)
      const m = parseTimeToMinutes(a?.place?.place_time)
      if (m !== null) simItems.push({ pos: idx, minutes: m })
    })

    // Transports: compute where they'd go with the new place order
    for (const r of transport) {
      const rMin = parseTimeToMinutes(r.reservation_time)
      if (rMin === null) continue
      // Find the last place (in new order) with time <= transport time
      let afterIdx = -1
      newPlaceIds.forEach((id, idx) => {
        const a = da.find(x => x.id === id)
        const pm = parseTimeToMinutes(a?.place?.place_time)
        if (pm !== null && pm <= rMin) afterIdx = idx
      })
      const pos = afterIdx >= 0 ? afterIdx + 0.5 : newPlaceIds.length + 0.5
      simItems.push({ pos, minutes: rMin })
    }

    // Sort by position and check chronological order
    simItems.sort((a, b) => a.pos - b.pos)
    return !simItems.every((item, i) => i === 0 || item.minutes >= simItems[i - 1].minutes)
  }

  const openEditNote = (dayId, note, e) => {
    e?.stopPropagation()
    _openEditNote(dayId, note)
  }

  const deleteNote = async (dayId, noteId, e) => {
    e?.stopPropagation()
    await _deleteNote(dayId, noteId)
  }

  // Unified reorder: assigns positions to ALL item types based on new visual order
  const applyMergedOrder = async (dayId: number, newOrder: { type: string; data: any }[]) => {
    // Capture previous place order for undo
    const prevAssignmentIds = getDayAssignments(dayId).map(a => a.id)

    // Places get sequential integer positions (0, 1, 2, ...)
    // Non-place items between place N-1 and place N get fractional positions
    const assignmentIds: number[] = []
    const noteUpdates: { id: number; sort_order: number }[] = []
    const transportUpdates: { id: number; day_plan_position: number }[] = []

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
          else if (g.type === 'transport') transportUpdates.push({ id: g.data.id, day_plan_position: pos })
        })
      }
    }

    try {
      if (assignmentIds.length) await onReorder(dayId, assignmentIds)
      for (const n of noteUpdates) {
        await tripActions.updateDayNote(tripId, dayId, n.id, { sort_order: n.sort_order })
      }
      if (transportUpdates.length) {
        for (const tu of transportUpdates) {
          const res = reservations.find(r => r.id === tu.id)
          if (res) res.day_plan_position = tu.day_plan_position
        }
        await reservationsApi.updatePositions(tripId, transportUpdates)
      }
      if (prevAssignmentIds.length) {
        const capturedDayId = dayId
        const capturedPrevIds = prevAssignmentIds
        pushUndo?.(t('undo.reorder'), async () => {
          await tripActions.reorderAssignments(tripId, capturedDayId, capturedPrevIds)
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }

  const handleMergedDrop = async (dayId, fromType, fromId, toType, toId, insertAfter = false) => {
    // Transport bookings themselves cannot be dragged
    if (fromType === 'transport') {
      toast.error(t('dayplan.cannotReorderTransport'))
      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
      return
    }

    const m = getMergedItems(dayId)

    // Check if a timed place is being moved → would it break chronological order?
    if (fromType === 'place') {
      const fromItem = m.find(i => i.type === 'place' && i.data.id === fromId)
      const fromMinutes = parseTimeToMinutes(fromItem?.data?.place?.place_time)
      if (fromItem && fromMinutes !== null) {
        const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
        const toIdx = m.findIndex(i => i.type === toType && i.data.id === toId)
        if (fromIdx !== -1 && toIdx !== -1) {
          const simulated = [...m]
          const [moved] = simulated.splice(fromIdx, 1)
          let insertIdx = simulated.findIndex(i => i.type === toType && i.data.id === toId)
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
            setTimeConfirm({ dayId, fromType, fromId, toType, toId, insertAfter, time: timeStr })
            setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
            return
          }
        }
      }
    }

    // Build new order: remove the dragged item, insert at target position
    const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
    const toIdx = m.findIndex(i => i.type === toType && i.data.id === toId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
      return
    }

    const newOrder = [...m]
    const [moved] = newOrder.splice(fromIdx, 1)
    let adjustedTo = newOrder.findIndex(i => i.type === toType && i.data.id === toId)
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
    const { dayId, fromId, reorderIds, fromType, toType, toId, insertAfter } = saved
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
      toast.error(err instanceof Error ? err.message : 'Unknown error')
      return
    }

    // Build new merged order from either arrow reorderIds or drag & drop params
    const m = getMergedItems(dayId)

    if (reorderIds) {
      // Arrow reorder: rebuild merged list with places in the new order,
      // keeping transports and notes at their relative positions
      const newMerged: typeof m = []
      let rIdx = 0
      for (const item of m) {
        if (item.type === 'place') {
          // Replace with the place from reorderIds at this position
          const nextId = reorderIds[rIdx++]
          const replacement = m.find(i => i.type === 'place' && i.data.id === nextId)
          if (replacement) newMerged.push(replacement)
        } else {
          newMerged.push(item)
        }
      }
      await applyMergedOrder(dayId, newMerged)
      return
    }

    // Drag & drop reorder
    if (fromType && toType) {
      const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
      const toIdx = m.findIndex(i => i.type === toType && i.data.id === toId)
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

      const newOrder = [...m]
      const [moved] = newOrder.splice(fromIdx, 1)
      let adjustedTo = newOrder.findIndex(i => i.type === toType && i.data.id === toId)
      if (adjustedTo === -1) adjustedTo = newOrder.length
      if (insertAfter) adjustedTo += 1
      newOrder.splice(adjustedTo, 0, moved)

      await applyMergedOrder(dayId, newOrder)
    }
  }

  const moveNote = async (dayId, noteId, direction) => {
    await _moveNote(dayId, noteId, direction, getMergedItems)
  }

  const startEditTitle = (day, e) => {
    e.stopPropagation()
    setEditTitle(day.title || '')
    setEditingDayId(day.id)
  }

  const saveTitle = async (dayId) => {
    setEditingDayId(null)
    await onUpdateDayTitle?.(dayId, editTitle.trim())
  }

  const handleCalculateRoute = async () => {
    if (!selectedDayId) return
    const da = getDayAssignments(selectedDayId)
    const waypoints = da.map(a => a.place).filter(p => p?.lat && p?.lng).map(p => ({ lat: p.lat, lng: p.lng }))
    if (waypoints.length < 2) { toast.error(t('dayplan.toast.needTwoPlaces')); return }
    setIsCalculating(true)
    try {
      const result = await calculateRoute(waypoints, 'walking')
      // Luftlinien zwischen Wegpunkten anzeigen
      const lineCoords = waypoints.map(p => [p.lat, p.lng])
      setRouteInfo({ distance: result.distanceText, duration: result.durationText })
      onRouteCalculated?.({ ...result, coordinates: lineCoords })
    } catch { toast.error(t('dayplan.toast.routeError')) }
    finally { setIsCalculating(false) }
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

  const handleOptimize = async () => {
    if (!selectedDayId) return
    const da = getDayAssignments(selectedDayId)
    if (da.length < 3) return

    const prevIds = da.map(a => a.id)

    // Separate locked (stay at their index) and unlocked assignments
    const locked = new Map() // index -> assignment
    const unlocked = []
    da.forEach((a, i) => {
      if (lockedIds.has(a.id)) locked.set(i, a)
      else unlocked.push(a)
    })

    // Optimize only unlocked assignments (work on assignments, not places)
    const unlockedWithCoords = unlocked.filter(a => a.place?.lat && a.place?.lng)
    const unlockedNoCoords = unlocked.filter(a => !a.place?.lat || !a.place?.lng)
    const optimizedAssignments = unlockedWithCoords.length >= 2
      ? optimizeRoute(unlockedWithCoords.map(a => ({ ...a.place, _assignmentId: a.id }))).map(p => unlockedWithCoords.find(a => a.id === p._assignmentId)).filter(Boolean)
      : unlockedWithCoords
    const optimizedQueue = [...optimizedAssignments, ...unlockedNoCoords]

    // Merge: locked stay at their index, fill gaps with optimized
    const result = new Array(da.length)
    locked.forEach((a, i) => { result[i] = a })
    let qi = 0
    for (let i = 0; i < result.length; i++) {
      if (!result[i]) result[i] = optimizedQueue[qi++]
    }

    await onReorder(selectedDayId, result.map(a => a.id))
    toast.success(t('dayplan.toast.routeOptimized'))
    const capturedDayId = selectedDayId
    pushUndo?.(t('undo.optimize'), async () => {
      await tripActions.reorderAssignments(tripId, capturedDayId, prevIds)
    })
  }

  const handleGoogleMaps = () => {
    if (!selectedDayId) return
    const da = getDayAssignments(selectedDayId)
    const url = generateGoogleMapsUrl(da.map(a => a.place).filter(p => p?.lat && p?.lng))
    if (url) window.open(url, '_blank')
    else toast.error(t('dayplan.toast.noGeoPlaces'))
  }

  const handleDropOnDay = (e, dayId) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverDayId(null)
    const { placeId, assignmentId, noteId, fromDayId } = getDragData(e)
    if (placeId) {
      onAssignToDay?.(parseInt(placeId), dayId)
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
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
    } else if (noteId && fromDayId !== dayId) {
      tripActions.moveDayNote(tripId, fromDayId, dayId, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
    }
    setDraggingId(null)
    setDropTargetKey(null)
    dragDataRef.current = null
    window.__dragData = null
  }

  const handleDropOnRow = (e, dayId, toIdx) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverDayId(null)
    const placeId = e.dataTransfer.getData('placeId')
    const fromAssignmentId = e.dataTransfer.getData('assignmentId')

    if (placeId) {
      onAssignToDay?.(parseInt(placeId), dayId)
    } else if (fromAssignmentId) {
      const da = getDayAssignments(dayId)
      const fromIdx = da.findIndex(a => String(a.id) === fromAssignmentId)
      if (fromIdx === -1 || fromIdx === toIdx) { setDraggingId(null); dragDataRef.current = null; return }
      const ids = da.map(a => a.id)
      const [removed] = ids.splice(fromIdx, 1)
      ids.splice(toIdx, 0, removed)
      onReorder(dayId, ids)
    }
    setDraggingId(null)
  }

  const totalCost = useMemo(() => days.reduce((s, d) => {
    const da = assignments[String(d.id)] || []
    return s + da.reduce((s2, a) => s2 + (parseFloat(a.place?.price) || 0), 0)
  }, 0), [days, assignments])

  // Bester verfügbarer Standort für Wetter: zugewiesene Orte zuerst, dann beliebiger Reiseort
  const anyGeoAssignment = Object.values(assignments).flatMap(da => da).find(a => a.place?.lat && a.place?.lng)
  const anyGeoPlace = anyGeoAssignment || (places || []).find(p => p.lat && p.lng)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Reise-Titel */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--border-faint)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: '1.3' }}>{trip?.title}</div>
            {(trip?.start_date || trip?.end_date) && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
                {[trip.start_date, trip.end_date].filter(Boolean).map(d => new Date(d + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })).join(' – ')}
                {days.length > 0 && ` · ${days.length} ${t('dayplan.days')}`}
              </div>
            )}
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={async () => {
                const flatNotes = Object.entries(dayNotes).flatMap(([dayId, notes]) =>
                  notes.map(n => ({ ...n, day_id: Number(dayId) }))
                )
                try {
                  await downloadTripPDF({ trip, days, places, assignments, categories, dayNotes: flatNotes, reservations, t, locale })
                } catch (e) {
                  console.error('PDF error:', e)
                  toast.error(t('dayplan.pdfError') + ': ' + (e?.message || String(e)))
                }
              }}
              onMouseEnter={() => setPdfHover(true)}
              onMouseLeave={() => setPdfHover(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 8, border: 'none',
                background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 11, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <FileDown size={13} strokeWidth={2} />
              {t('dayplan.pdf')}
            </button>
            {pdfHover && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 200,
                background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
                fontSize: 11, fontWeight: 500, padding: '5px 10px',
                borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                border: '1px solid var(--border-faint, #e5e7eb)',
              }}>
                {t('dayplan.pdfTooltip')}
              </div>
            )}
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              onClick={async () => {
                try {
                  const res = await fetch(`/api/trips/${tripId}/export.ics`, {
                    credentials: 'include',
                  })
                  if (!res.ok) throw new Error()
                  const blob = await res.blob()
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${trip?.title || 'trip'}.ics`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch { toast.error('ICS export failed') }
              }}
              onMouseEnter={() => setIcsHover(true)}
              onMouseLeave={() => setIcsHover(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 8,
                border: '1px solid var(--border-primary)', background: 'none',
                color: 'var(--text-muted)', fontSize: 11, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <FileDown size={13} strokeWidth={2} />
              ICS
            </button>
            {icsHover && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 200,
                background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
                fontSize: 11, fontWeight: 500, padding: '5px 10px',
                borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                border: '1px solid var(--border-faint, #e5e7eb)',
              }}>
                {t('dayplan.icsTooltip')}
              </div>
            )}
          </div>
          {onUndo && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={onUndo}
                disabled={!canUndo}
                onMouseEnter={() => setUndoHover(true)}
                onMouseLeave={() => setUndoHover(false)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 30, height: 30, borderRadius: 8,
                  border: '1px solid var(--border-primary)', background: 'none',
                  color: canUndo ? 'var(--text-primary)' : 'var(--border-primary)',
                  cursor: canUndo ? 'pointer' : 'default', fontFamily: 'inherit',
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                <Undo2 size={14} strokeWidth={2} />
              </button>
              {undoHover && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0,
                  whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 200,
                  background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
                  fontSize: 11, fontWeight: 500, padding: '5px 10px',
                  borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  border: '1px solid var(--border-faint, #e5e7eb)',
                }}>
                  {canUndo && lastActionLabel ? t('undo.tooltip', { action: lastActionLabel }) : t('undo.button')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tagesliste */}
      <div className="scroll-container" style={{ flex: 1, overflowY: 'auto', minHeight: 0, scrollbarWidth: 'thin', scrollbarColor: 'var(--scrollbar-thumb) transparent' }}>
        {days.map((day, index) => {
          const isSelected = selectedDayId === day.id
          const isExpanded = expandedDays.has(day.id)
          const da = getDayAssignments(day.id)
          const cost = dayTotalCost(day.id, assignments, currency)
          const formattedDate = formatDate(day.date, locale)
          const loc = da.find(a => a.place?.lat && a.place?.lng)
          const isDragTarget = dragOverDayId === day.id
          const merged = mergedItemsMap[day.id] || []
          const dayNoteUi = noteUi[day.id]
          const placeItems = merged.filter(i => i.type === 'place')

          return (
            <div key={day.id} style={{ borderBottom: '1px solid var(--border-faint)', contentVisibility: 'auto', containIntrinsicSize: '0 64px' }}>
              {/* Tages-Header — akzeptiert Drops aus der PlacesSidebar */}
              <div
                onClick={() => { onSelectDay(day.id); if (onDayDetail) onDayDetail(day) }}
                onDragOver={e => { e.preventDefault(); setDragOverDayId(day.id) }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverDayId(null) }}
                onDrop={e => handleDropOnDay(e, day.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 14px 11px 16px',
                  cursor: 'pointer',
                  background: isDragTarget ? 'rgba(17,24,39,0.07)' : (isSelected ? 'var(--bg-tertiary)' : 'transparent'),
                  transition: 'background 0.12s',
                  userSelect: 'none',
                  outline: isDragTarget ? '2px dashed rgba(17,24,39,0.25)' : 'none',
                  outlineOffset: -2,
                  borderRadius: isDragTarget ? 8 : 0,
                }}
                onMouseEnter={e => { if (!isSelected && !isDragTarget) e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isDragTarget ? 'rgba(17,24,39,0.07)' : 'transparent' }}
              >
                {/* Tages-Badge */}
                <div style={{
                  width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                  background: isSelected ? 'var(--accent)' : 'var(--bg-hover)',
                  color: isSelected ? 'var(--accent-text)' : 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700,
                }}>
                  {index + 1}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingDayId === day.id ? (
                    <input
                      ref={inputRef}
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onBlur={() => saveTitle(day.id)}
                      onKeyDown={e => { if (e.key === 'Enter') saveTitle(day.id); if (e.key === 'Escape') setEditingDayId(null) }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        width: '100%', border: 'none', outline: 'none',
                        fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                        background: 'transparent', padding: 0, fontFamily: 'inherit',
                        borderBottom: '1.5px solid var(--text-primary)',
                      }}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
                        {day.title || t('dayplan.dayN', { n: index + 1 })}
                      </span>
                      {canEditDays && <button
                        onClick={e => startEditTitle(day, e)}
                        style={{ flexShrink: 0, background: 'none', border: 'none', padding: '4px', cursor: 'pointer', opacity: 0.35, display: 'flex', alignItems: 'center' }}
                      >
                        <Pencil size={15} strokeWidth={1.8} color="var(--text-secondary)" />
                      </button>}
                      {(() => {
                        const dayAccs = accommodations.filter(a => day.id >= a.start_day_id && day.id <= a.end_day_id)
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
                          const bg = isCheckOut && !isCheckIn ? 'rgba(239,68,68,0.08)' : isCheckIn ? 'rgba(34,197,94,0.08)' : 'var(--bg-secondary)'
                          const border = isCheckOut && !isCheckIn ? 'rgba(239,68,68,0.2)' : isCheckIn ? 'rgba(34,197,94,0.2)' : 'var(--border-primary)'
                          const iconColor = isCheckOut && !isCheckIn ? '#ef4444' : isCheckIn ? '#22c55e' : 'var(--text-muted)'
                          return (
                            <span key={acc.id} onClick={e => { e.stopPropagation(); onPlaceClick(acc.place_id) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 5, background: bg, border: `1px solid ${border}`, flexShrink: 1, minWidth: 0, maxWidth: '40%', cursor: 'pointer' }}>
                              <Hotel size={8} style={{ color: iconColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.place_name}</span>
                            </span>
                          )
                        })
                      })()}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                    {formattedDate && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{formattedDate}</span>}
                    {cost && <span style={{ fontSize: 11, color: '#059669' }}>{cost}</span>}
                    {day.date && anyGeoPlace && <span style={{ width: 1, height: 10, background: 'var(--text-faint)', opacity: 0.3, flexShrink: 0 }} />}
                    {day.date && anyGeoPlace && (() => {
                      const wLat = loc?.place.lat ?? anyGeoPlace?.place?.lat ?? anyGeoPlace?.lat
                      const wLng = loc?.place.lng ?? anyGeoPlace?.place?.lng ?? anyGeoPlace?.lng
                      return <WeatherWidget lat={wLat} lng={wLng} date={day.date} compact />
                    })()}
                  </div>
                </div>

                {canEditDays && <button
                  onClick={e => openAddNote(day.id, e)}
                  title={t('dayplan.addNote')}
                  style={{ flexShrink: 0, background: 'none', border: 'none', padding: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
                >
                  <FileText size={16} strokeWidth={2} />
                </button>}
                <button
                  onClick={e => toggleDay(day.id, e)}
                  style={{ flexShrink: 0, background: 'none', border: 'none', padding: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}
                >
                  {isExpanded ? <ChevronDown size={18} strokeWidth={2} /> : <ChevronRight size={18} strokeWidth={2} />}
                </button>
              </div>

              {/* Aufgeklappte Orte + Notizen */}
              {isExpanded && (
                <div
                  style={{ background: 'var(--bg-hover)', paddingTop: 6 }}
                  onDragOver={e => { e.preventDefault(); const cur = dropTargetRef.current; if (draggingId && (!cur || cur.startsWith('end-'))) setDropTargetKey(`end-${day.id}`) }}
                  onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const { placeId, assignmentId, noteId, fromDayId } = getDragData(e)
                    // Drop on transport card (detected via dropTargetRef for sync accuracy)
                    if (dropTargetRef.current?.startsWith('transport-')) {
                      const transportId = Number(dropTargetRef.current.replace('transport-', ''))

                      if (placeId) {
                        onAssignToDay?.(parseInt(placeId), day.id)
                      } else if (assignmentId && fromDayId !== day.id) {
                        tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                      } else if (assignmentId) {
                        handleMergedDrop(day.id, 'place', Number(assignmentId), 'transport', transportId)
                      } else if (noteId && fromDayId !== day.id) {
                        tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                      } else if (noteId) {
                        handleMergedDrop(day.id, 'note', Number(noteId), 'transport', transportId)
                      }
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null
                      return
                    }

                    if (!assignmentId && !noteId && !placeId) { dragDataRef.current = null; window.__dragData = null; return }
                    if (placeId) {
                      onAssignToDay?.(parseInt(placeId), day.id)
                      setDropTargetKey(null); window.__dragData = null; return
                    }
                    if (assignmentId && fromDayId !== day.id) {
                      tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    if (noteId && fromDayId !== day.id) {
                      tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
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
                  {merged.length === 0 && !dayNoteUi ? (
                    <div
                      onDragOver={e => { e.preventDefault(); setDragOverDayId(day.id) }}
                      onDrop={e => handleDropOnDay(e, day.id)}
                      style={{ padding: '16px', textAlign: 'center', borderRadius: 8,
                        background: dragOverDayId === day.id ? 'rgba(17,24,39,0.05)' : 'transparent',
                        border: dragOverDayId === day.id ? '2px dashed rgba(17,24,39,0.2)' : '2px dashed transparent',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('dayplan.emptyDay')}</span>
                    </div>
                  ) : (
                    merged.map((item, idx) => {
                      const itemKey = item.type === 'transport' ? `transport-${item.data.id}` : (item.type === 'place' ? `place-${item.data.id}` : `note-${item.data.id}`)
                      const showDropLine = (!!draggingId || !!dropTargetKey) && dropTargetKey === itemKey

                      if (item.type === 'place') {
                        const assignment = item.data
                        const place = assignment.place
                        if (!place) return null
                        const cat = categories.find(c => c.id === place.category_id)
                        const isPlaceSelected = selectedAssignmentId ? assignment.id === selectedAssignmentId : place.id === selectedPlaceId
                        const isDraggingThis = draggingId === assignment.id
                        const isHovered = hoveredId === assignment.id
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
                              // Store the new merged order for confirm action
                              setTimeConfirm({ dayId: day.id, fromId: assignment.id, time: timeStr, reorderIds: newOrder.filter(i => i.type === 'place').map(i => i.data.id) })
                              return
                            }
                          }
                          applyMergedOrder(day.id, newOrder)
                        }
                        const moveUp = (e) => { e.stopPropagation(); arrowMove('up') }
                        const moveDown = (e) => { e.stopPropagation(); arrowMove('down') }

                        return (
                          <React.Fragment key={`place-${assignment.id}`}>
                            {showDropLine && <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1, margin: '2px 8px' }} />}
                          <div
                            draggable={canEditDays}
                            onDragStart={e => {
                              if (!canEditDays) { e.preventDefault(); return }
                              e.dataTransfer.setData('assignmentId', String(assignment.id))
                              e.dataTransfer.setData('fromDayId', String(day.id))
                              e.dataTransfer.effectAllowed = 'move'
                              dragDataRef.current = { assignmentId: String(assignment.id), fromDayId: String(day.id) }
                              setDraggingId(assignment.id)
                            }}
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverDayId(null); if (dropTargetKey !== `place-${assignment.id}`) setDropTargetKey(`place-${assignment.id}`) }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation()
                              const { placeId, assignmentId: fromAssignmentId, noteId, fromDayId } = getDragData(e)
                              if (placeId) {
                                const pos = placeItems.findIndex(i => i.data.id === assignment.id)
                                onAssignToDay?.(parseInt(placeId), day.id, pos >= 0 ? pos : undefined)
                                setDropTargetKey(null); window.__dragData = null
                              } else if (fromAssignmentId && fromDayId !== day.id) {
                                const toIdx = getDayAssignments(day.id).findIndex(a => a.id === assignment.id)
                                tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (fromAssignmentId) {
                                handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'place', assignment.id)
                              } else if (noteId && fromDayId !== day.id) {
                                const tm = getMergedItems(day.id)
                                const toIdx = tm.findIndex(i => i.type === 'place' && i.data.id === assignment.id)
                                const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                                tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (noteId) {
                                handleMergedDrop(day.id, 'note', Number(noteId), 'place', assignment.id)
                              }
                            }}
                            onDragEnd={() => { setDraggingId(null); setDragOverDayId(null); setDropTargetKey(null); dragDataRef.current = null }}
                            onClick={() => { onPlaceClick(isPlaceSelected ? null : place.id, isPlaceSelected ? null : assignment.id); if (!isPlaceSelected) onSelectDay(day.id, true) }}
                            onContextMenu={e => ctxMenu.open(e, [
                              canEditDays && onEditPlace && { label: t('common.edit'), icon: Pencil, onClick: () => onEditPlace(place, assignment.id) },
                              canEditDays && onRemoveAssignment && { label: t('planner.removeFromDay'), icon: Trash2, onClick: () => onRemoveAssignment(day.id, assignment.id) },
                              place.website && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(place.website, '_blank') },
                              (place.lat && place.lng) && { label: 'Google Maps', icon: Navigation, onClick: () => window.open(`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`, '_blank') },
                              { divider: true },
                              canEditDays && onDeletePlace && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => onDeletePlace(place.id) },
                            ])}
                            onMouseEnter={() => setHoveredId(assignment.id)}
                            onMouseLeave={() => setHoveredId(null)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 8px 7px 10px',
                              cursor: 'pointer',
                              background: lockedIds.has(assignment.id)
                                ? 'rgba(220,38,38,0.08)'
                                : isPlaceSelected ? 'var(--bg-hover)' : (isHovered ? 'var(--bg-hover)' : 'transparent'),
                              borderLeft: lockedIds.has(assignment.id)
                                ? '3px solid #dc2626'
                                : '3px solid transparent',
                              transition: 'background 0.15s, border-color 0.15s',
                              opacity: isDraggingThis ? 0.4 : 1,
                            }}
                          >
                            {canEditDays && <div style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: isHovered ? 1 : 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                              <GripVertical size={13} strokeWidth={1.8} />
                            </div>}
                            <div
                              onClick={e => { e.stopPropagation(); toggleLock(assignment.id) }}
                              onMouseEnter={e => { e.stopPropagation(); setLockHoverId(assignment.id) }}
                              onMouseLeave={() => setLockHoverId(null)}
                              style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
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
                                  fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
                                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint, #e5e7eb)',
                                }}>
                                  {lockedIds.has(assignment.id)
                                    ? t('planner.clickToUnlock')
                                    : t('planner.keepPosition')}
                                </div>
                              )}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                                {cat && (() => {
                                  const CatIcon = getCategoryIcon(cat.icon)
                                  return <CatIcon size={10} strokeWidth={2} color={cat.color || 'var(--text-muted)'} title={cat.name} style={{ flexShrink: 0 }} />
                                })()}
                                <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                                  {place.name}
                                </span>
                                {place.place_time && (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10, color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                                    <Clock size={9} strokeWidth={2} />
                                    {formatTime(place.place_time, locale, timeFormat)}{place.end_time ? ` – ${formatTime(place.end_time, locale, timeFormat)}` : ''}
                                  </span>
                                )}
                              </div>
                              {(place.description || place.address || cat?.name) && (
                                <div className="collab-note-md" style={{ marginTop: 2, fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2, maxHeight: '1.2em' }}>
                                  <Markdown remarkPlugins={[remarkGfm]}>{place.description || place.address || cat?.name || ''}</Markdown>
                                </div>
                              )}
                              {(() => {
                                const res = reservations.find(r => r.assignment_id === assignment.id)
                                if (!res) return null
                                const confirmed = res.status === 'confirmed'
                                return (
                                  <div style={{ marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 5, fontSize: 9, fontWeight: 600,
                                    background: confirmed ? 'rgba(22,163,74,0.1)' : 'rgba(217,119,6,0.1)',
                                    color: confirmed ? '#16a34a' : '#d97706',
                                  }}>
                                    {(() => { const RI = RES_ICONS[res.type] || Ticket; return <RI size={8} /> })()}
                                    <span className="hidden sm:inline">{confirmed ? t('planner.resConfirmed') : t('planner.resPending')}</span>
                                    {res.reservation_time?.includes('T') && (
                                      <span style={{ fontWeight: 400 }}>
                                        {new Date(res.reservation_time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })}
                                        {res.reservation_end_time && ` – ${res.reservation_end_time}`}
                                      </span>
                                    )}
                                    {(() => {
                                      const meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {})
                                      if (!meta) return null
                                      if (meta.airline && meta.flight_number) return <span style={{ fontWeight: 400 }}>{meta.airline} {meta.flight_number}</span>
                                      if (meta.flight_number) return <span style={{ fontWeight: 400 }}>{meta.flight_number}</span>
                                      if (meta.train_number) return <span style={{ fontWeight: 400 }}>{meta.train_number}</span>
                                      return null
                                    })()}
                                  </div>
                                )
                              })()}
                              {assignment.participants?.length > 0 && (
                                <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: -4 }}>
                                  {assignment.participants.slice(0, 5).map((p, pi) => (
                                    <div key={p.user_id} style={{
                                      width: 16, height: 16, borderRadius: '50%', background: 'var(--bg-tertiary)', border: '1.5px solid var(--bg-card)',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 700, color: 'var(--text-muted)',
                                      marginLeft: pi > 0 ? -4 : 0, flexShrink: 0,
                                      overflow: 'hidden',
                                    }}>
                                      {p.avatar ? <img src={`/uploads/avatars/${p.avatar}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : p.username?.[0]?.toUpperCase()}
                                    </div>
                                  ))}
                                  {assignment.participants.length > 5 && (
                                    <span style={{ fontSize: 8, color: 'var(--text-faint)', marginLeft: 2 }}>+{assignment.participants.length - 5}</span>
                                  )}
                                </div>
                              )}
                            </div>
                            {canEditDays && <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, opacity: isHovered ? 1 : undefined, transition: 'opacity 0.15s' }}>
                              <button onClick={moveUp} disabled={idx === 0} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: idx === 0 ? 'default' : 'pointer', color: idx === 0 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}>
                                <ChevronUp size={12} strokeWidth={2} />
                              </button>
                              <button onClick={moveDown} disabled={idx === merged.length - 1} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: idx === merged.length - 1 ? 'default' : 'pointer', color: idx === merged.length - 1 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}>
                                <ChevronDown size={12} strokeWidth={2} />
                              </button>
                            </div>}
                          </div>
                          </React.Fragment>
                        )
                      }

                      // Transport booking (flight, train, bus, car, cruise)
                      if (item.type === 'transport') {
                        const res = item.data
                        const TransportIcon = RES_ICONS[res.type] || Ticket
                        const color = '#3b82f6'
                        const meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {})
                        const isTransportHovered = hoveredId === `transport-${res.id}`

                        // Subtitle aus Metadaten zusammensetzen
                        let subtitle = ''
                        if (res.type === 'flight') {
                          const parts = [meta.airline, meta.flight_number].filter(Boolean)
                          if (meta.departure_airport || meta.arrival_airport)
                            parts.push([meta.departure_airport, meta.arrival_airport].filter(Boolean).join(' → '))
                          subtitle = parts.join(' · ')
                        } else if (res.type === 'train') {
                          subtitle = [meta.train_number, meta.platform ? `Gl. ${meta.platform}` : '', meta.seat ? `Sitz ${meta.seat}` : ''].filter(Boolean).join(' · ')
                        }

                        return (
                          <React.Fragment key={`transport-${res.id}`}>
                          {showDropLine && <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1, margin: '2px 8px' }} />}
                          <div
                            onClick={() => setTransportDetail(res)}
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTargetKey(`transport-${res.id}`) }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation()
                              const { placeId, assignmentId: fromAssignmentId, noteId, fromDayId } = getDragData(e)
                              if (placeId) {
                                onAssignToDay?.(parseInt(placeId), day.id)
                              } else if (fromAssignmentId && fromDayId !== day.id) {
                                tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              } else if (fromAssignmentId) {
                                handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'transport', res.id)
                              } else if (noteId && fromDayId !== day.id) {
                                tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              } else if (noteId) {
                                handleMergedDrop(day.id, 'note', Number(noteId), 'transport', res.id)
                              }
                              setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; window.__dragData = null
                            }}
                            onMouseEnter={() => setHoveredId(`transport-${res.id}`)}
                            onMouseLeave={() => setHoveredId(null)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 8px 7px 10px',
                              margin: '1px 8px',
                              borderRadius: 6,
                              border: `1px solid ${color}33`,
                              background: isTransportHovered ? `${color}12` : `${color}08`,
                              cursor: 'pointer', userSelect: 'none',
                              transition: 'background 0.1s',
                            }}
                          >
                            <div style={{
                              width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              borderRadius: '50%', background: `${color}18`,
                            }}>
                              <TransportIcon size={14} strokeWidth={1.8} color={color} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {res.title}
                                </span>
                                {res.reservation_time?.includes('T') && (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10, color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6 }}>
                                    <Clock size={9} strokeWidth={2} />
                                    {new Date(res.reservation_time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })}
                                    {res.reservation_end_time?.includes('T') && ` – ${new Date(res.reservation_end_time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })}`}
                                  </span>
                                )}
                              </div>
                              {subtitle && (
                                <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {subtitle}
                                </div>
                              )}
                            </div>
                          </div>
                          </React.Fragment>
                        )
                      }

                      // Notizkarte
                      const note = item.data
                      const isNoteHovered = hoveredId === `note-${note.id}`
                      const NoteIcon = getNoteIcon(note.icon)
                      const noteIdx = idx
                      return (
                        <React.Fragment key={`note-${note.id}`}>
                          {showDropLine && <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1, margin: '2px 8px' }} />}
                        <div
                          draggable={canEditDays}
                          onDragStart={e => { if (!canEditDays) { e.preventDefault(); return } e.dataTransfer.setData('noteId', String(note.id)); e.dataTransfer.setData('fromDayId', String(day.id)); e.dataTransfer.effectAllowed = 'move'; dragDataRef.current = { noteId: String(note.id), fromDayId: String(day.id) }; setDraggingId(`note-${note.id}`) }}
                          onDragEnd={() => { setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null }}
                          onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dropTargetKey !== `note-${note.id}`) setDropTargetKey(`note-${note.id}`) }}
                          onDrop={e => {
                            e.preventDefault(); e.stopPropagation()
                            const { noteId: fromNoteId, assignmentId: fromAssignmentId, fromDayId } = getDragData(e)
                            if (fromNoteId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const toIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                              tripActions.moveDayNote(tripId, fromDayId, day.id, Number(fromNoteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromNoteId && fromNoteId !== String(note.id)) {
                              handleMergedDrop(day.id, 'note', Number(fromNoteId), 'note', note.id)
                            } else if (fromAssignmentId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const noteIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const toIdx = tm.slice(0, noteIdx).filter(i => i.type === 'place').length
                              tripActions.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromAssignmentId) {
                              handleMergedDrop(day.id, 'place', Number(fromAssignmentId), 'note', note.id)
                            }
                          }}
                          onContextMenu={canEditDays ? e => ctxMenu.open(e, [
                            { label: t('common.edit'), icon: Pencil, onClick: () => openEditNote(day.id, note) },
                            { divider: true },
                            { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => deleteNote(day.id, note.id) },
                          ]) : undefined}
                          onMouseEnter={() => setHoveredId(`note-${note.id}`)}
                          onMouseLeave={() => setHoveredId(null)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 8px 7px 2px',
                            margin: '1px 8px',
                            borderRadius: 6,
                            border: '1px solid var(--border-faint)',
                            background: isNoteHovered ? 'var(--bg-hover)' : 'var(--bg-hover)',
                            opacity: draggingId === `note-${note.id}` ? 0.4 : 1,
                            transition: 'background 0.1s', cursor: 'grab', userSelect: 'none',
                          }}
                        >
                          {canEditDays && <div style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: isNoteHovered ? 1 : 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                            <GripVertical size={13} strokeWidth={1.8} />
                          </div>}
                          <div style={{ width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--bg-hover)', overflow: 'hidden' }}>
                            <NoteIcon size={13} strokeWidth={1.8} color="var(--text-muted)" />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                              {note.text}
                            </span>
                            {note.time && (
                              <div className="collab-note-md" style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-faint)', lineHeight: '1.3', marginTop: 2, wordBreak: 'break-word' }}><Markdown remarkPlugins={[remarkGfm]}>{note.time}</Markdown></div>
                            )}
                          </div>
                          {canEditDays && <div className="note-edit-buttons" style={{ display: 'flex', gap: 1, flexShrink: 0, opacity: isNoteHovered ? 1 : 0, transition: 'opacity 0.15s' }}>
                            <button onClick={e => openEditNote(day.id, note, e)} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}><Pencil size={10} /></button>
                            <button onClick={e => deleteNote(day.id, note.id, e)} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}><Trash2 size={10} /></button>
                          </div>}
                          {canEditDays && <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, opacity: isNoteHovered ? 1 : undefined, transition: 'opacity 0.15s' }}>
                            <button onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'up') }} disabled={noteIdx === 0} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === 0 ? 'default' : 'pointer', color: noteIdx === 0 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}><ChevronUp size={12} strokeWidth={2} /></button>
                            <button onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'down') }} disabled={noteIdx === merged.length - 1} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === merged.length - 1 ? 'default' : 'pointer', color: noteIdx === merged.length - 1 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}><ChevronDown size={12} strokeWidth={2} /></button>
                          </div>}
                        </div>
                        </React.Fragment>
                      )
                    })
                  )}
                  {/* Drop-Zone am Listenende — immer vorhanden als Drop-Target */}
                  <div
                    style={{ minHeight: 12, padding: '2px 8px' }}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dropTargetKey !== `end-${day.id}`) setDropTargetKey(`end-${day.id}`) }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation()
                      const { placeId, assignmentId, noteId, fromDayId } = getDragData(e)
                      // Neuer Ort von der Orte-Liste
                      if (placeId) {
                        onAssignToDay?.(parseInt(placeId), day.id)
                        setDropTargetKey(null); window.__dragData = null; return
                      }
                      if (!assignmentId && !noteId) { dragDataRef.current = null; window.__dragData = null; return }
                      if (assignmentId && fromDayId !== day.id) {
                        tripActions.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                      }
                      if (noteId && fromDayId !== day.id) {
                        tripActions.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
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
                    {dropTargetKey === `end-${day.id}` && (
                      <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1 }} />
                    )}
                  </div>

                  {/* Routen-Werkzeuge (ausgewählter Tag, 2+ Orte) */}
                  {isSelected && getDayAssignments(day.id).length >= 2 && (
                    <div style={{ padding: '10px 16px 12px', borderTop: '1px solid var(--border-faint)', display: 'flex', flexDirection: 'column', gap: 7 }}>
                      {routeInfo && (
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-hover)', borderRadius: 8, padding: '5px 10px' }}>
                          <span>{routeInfo.distance}</span>
                          <span style={{ color: 'var(--text-faint)' }}>·</span>
                          <span>{routeInfo.duration}</span>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={handleOptimize} style={{
                          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          padding: '6px 0', fontSize: 11, fontWeight: 500, borderRadius: 8, border: 'none',
                          background: 'var(--bg-hover)', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
                        }}>
                          <RotateCcw size={12} strokeWidth={2} />
                          {t('dayplan.optimize')}
                        </button>
                        <button onClick={handleGoogleMaps} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          padding: '6px 10px', fontSize: 11, fontWeight: 500, borderRadius: 8,
                          border: '1px solid var(--border-faint)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
                        }}>
                          <ExternalLink size={12} strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Notiz-Popup-Modal — über Portal gerendert, um den backdropFilter-Stapelkontext zu umgehen */}
      {Object.entries(noteUi).map(([dayId, ui]) => ui && ReactDOM.createPortal(
        <div key={dayId} style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(3px)',
        }} onClick={() => cancelNote(Number(dayId))}>
          <div style={{
            width: 340, background: 'var(--bg-card)', borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
            display: 'flex', flexDirection: 'column', gap: 12,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {ui.mode === 'add' ? t('dayplan.noteAdd') : t('dayplan.noteEdit')}
            </div>
            {/* Icon-Auswahl */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {NOTE_ICONS.map(({ id, Icon }) => (
                <button key={id} onClick={() => setNoteUi(prev => ({ ...prev, [dayId]: { ...prev[dayId], icon: id } }))}
                  title={id}
                  style={{ width: 45, height: 45, borderRadius: 8, border: ui.icon === id ? '2px solid var(--text-primary)' : '2px solid var(--border-faint)', background: ui.icon === id ? 'var(--bg-hover)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                  <Icon size={18} strokeWidth={1.8} color={ui.icon === id ? 'var(--text-primary)' : 'var(--text-muted)'} />
                </button>
              ))}
            </div>
            <input
              ref={noteInputRef}
              type="text"
              value={ui.text}
              onChange={e => setNoteUi(prev => ({ ...prev, [dayId]: { ...prev[dayId], text: e.target.value } }))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveNote(Number(dayId)) } if (e.key === 'Escape') cancelNote(Number(dayId)) }}
              placeholder={t('dayplan.noteTitle')}
              style={{ fontSize: 13, fontWeight: 500, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '8px 10px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', color: 'var(--text-primary)' }}
            />
            <textarea
              value={ui.time}
              maxLength={150}
              rows={3}
              onChange={e => setNoteUi(prev => ({ ...prev, [dayId]: { ...prev[dayId], time: e.target.value } }))}
              onKeyDown={e => { if (e.key === 'Escape') cancelNote(Number(dayId)) }}
              placeholder={t('dayplan.noteSubtitle')}
              style={{ fontSize: 12, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '7px 10px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box', color: 'var(--text-primary)', resize: 'none', lineHeight: 1.4 }}
            />
            <div style={{ textAlign: 'right', fontSize: 11, color: (ui.time?.length || 0) >= 140 ? '#d97706' : 'var(--text-faint)', marginTop: -2 }}>{ui.time?.length || 0}/150</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => cancelNote(Number(dayId))} style={{ fontSize: 12, background: 'none', border: '1px solid var(--border-primary)', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit' }}>{t('common.cancel')}</button>
              <button onClick={() => saveNote(Number(dayId))} style={{ fontSize: 12, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}>
                {ui.mode === 'add' ? t('common.add') : t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      ))}

      {/* Confirm: remove time when reordering a timed place */}
      {timeConfirm && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(3px)',
        }} onClick={() => setTimeConfirm(null)}>
          <div style={{
            width: 340, background: 'var(--bg-card)', borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
            display: 'flex', flexDirection: 'column', gap: 12,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%', background: 'rgba(239,68,68,0.12)',
              }}>
                <Clock size={18} strokeWidth={1.8} color="#ef4444" />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('dayplan.confirmRemoveTimeTitle')}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {t('dayplan.confirmRemoveTimeBody', { time: timeConfirm.time })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setTimeConfirm(null)} style={{
                fontSize: 12, background: 'none', border: '1px solid var(--border-primary)',
                borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit',
              }}>{t('common.cancel')}</button>
              <button onClick={confirmTimeRemoval} style={{
                fontSize: 12, background: '#ef4444', color: 'white',
                border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
              }}>{t('common.confirm')}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Transport-Detail-Modal */}
      {transportDetail && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(3px)',
        }} onClick={() => setTransportDetail(null)}>
          <div style={{
            width: 380, maxHeight: '80vh', overflowY: 'auto',
            background: 'var(--bg-card)', borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
            display: 'flex', flexDirection: 'column', gap: 14,
          }} onClick={e => e.stopPropagation()}>
            {(() => {
              const res = transportDetail
              const TransportIcon = RES_ICONS[res.type] || Ticket
              const TRANSPORT_COLORS = { flight: '#3b82f6', train: '#06b6d4', bus: '#f59e0b', car: '#6b7280', cruise: '#0ea5e9' }
              const color = TRANSPORT_COLORS[res.type] || 'var(--text-muted)'
              const meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {})

              const detailFields = []
              if (res.type === 'flight') {
                if (meta.airline) detailFields.push({ label: t('reservations.meta.airline'), value: meta.airline })
                if (meta.flight_number) detailFields.push({ label: t('reservations.meta.flightNumber'), value: meta.flight_number })
                if (meta.departure_airport) detailFields.push({ label: t('reservations.meta.from'), value: meta.departure_airport })
                if (meta.arrival_airport) detailFields.push({ label: t('reservations.meta.to'), value: meta.arrival_airport })
                if (meta.seat) detailFields.push({ label: t('reservations.meta.seat'), value: meta.seat })
              } else if (res.type === 'train') {
                if (meta.train_number) detailFields.push({ label: t('reservations.meta.trainNumber'), value: meta.train_number })
                if (meta.platform) detailFields.push({ label: t('reservations.meta.platform'), value: meta.platform })
                if (meta.seat) detailFields.push({ label: t('reservations.meta.seat'), value: meta.seat })
              }
              if (res.confirmation_number) detailFields.push({ label: t('reservations.confirmationCode'), value: res.confirmation_number, sensitive: true })
              if (res.location) detailFields.push({ label: t('reservations.locationAddress'), value: res.location })

              return (
                <>
                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: '50%', background: `${color}18`,
                    }}>
                      <TransportIcon size={18} strokeWidth={1.8} color={color} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{res.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                        {res.reservation_time?.includes('T')
                          ? new Date(res.reservation_time).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })
                          : res.reservation_time
                            ? new Date(res.reservation_time + 'T00:00:00').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
                            : ''
                        }
                        {res.reservation_end_time?.includes('T') && ` – ${new Date(res.reservation_end_time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })}`}
                      </div>
                    </div>
                    <div style={{
                      padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                      background: res.status === 'confirmed' ? 'rgba(22,163,74,0.1)' : 'rgba(217,119,6,0.1)',
                      color: res.status === 'confirmed' ? '#16a34a' : '#d97706',
                    }}>
                      {(res.status === 'confirmed' ? t('planner.resConfirmed') : t('planner.resPending')).replace(/\s*·\s*$/, '')}
                    </div>
                  </div>

                  {/* Detail-Felder */}
                  {detailFields.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {detailFields.map((f, i) => {
                        const shouldBlur = f.sensitive && useSettingsStore.getState().settings.blur_booking_codes
                        return (
                          <div key={i} style={{ padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{f.label}</div>
                            <div
                              onMouseEnter={e => { if (shouldBlur) e.currentTarget.style.filter = 'none' }}
                              onMouseLeave={e => { if (shouldBlur) e.currentTarget.style.filter = 'blur(5px)' }}
                              onClick={e => { if (shouldBlur) { const el = e.currentTarget; el.style.filter = el.style.filter === 'none' ? 'blur(5px)' : 'none' } }}
                              style={{
                                fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', wordBreak: 'break-word',
                                filter: shouldBlur ? 'blur(5px)' : 'none', transition: 'filter 0.2s',
                                cursor: shouldBlur ? 'pointer' : 'default',
                                userSelect: shouldBlur ? 'none' : 'auto',
                              }}
                            >{f.value}</div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Notizen */}
                  {res.notes && (
                    <div style={{ padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                      <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.notes')}</div>
                      <div className="collab-note-md" style={{ fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-word' }}><Markdown remarkPlugins={[remarkGfm]}>{res.notes}</Markdown></div>
                    </div>
                  )}

                  {/* Dateien */}
                  {(() => {
                    const resFiles = (useTripStore.getState().files || []).filter(f =>
                      !f.deleted_at && (
                        f.reservation_id === res.id ||
                        (f.linked_reservation_ids && f.linked_reservation_ids.includes(res.id))
                      )
                    )
                    if (resFiles.length === 0) return null
                    return (
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{t('files.title')}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {resFiles.map(f => (
                            <div key={f.id}
                              onClick={() => { setTransportDetail(null); onNavigateToFiles?.() }}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                                background: 'var(--bg-tertiary)', borderRadius: 8, cursor: 'pointer',
                                transition: 'background 0.1s',
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                            >
                              <FileText size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                              <span style={{ flex: 1, fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {f.original_name}
                              </span>
                              <ExternalLink size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Schließen */}
                  <div style={{ textAlign: 'right' }}>
                    <button onClick={() => setTransportDetail(null)} style={{
                      fontSize: 12, background: 'var(--accent)', color: 'var(--accent-text)',
                      border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                    }}>
                      {t('common.close')}
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        </div>,
        document.body
      )}

      {/* Budget-Fußzeile */}
      {totalCost > 0 && (
        <div style={{ flexShrink: 0, padding: '10px 16px', borderTop: '1px solid var(--border-faint)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('dayplan.totalCost')}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{totalCost.toFixed(currencyDecimals(currency))} {currency}</span>
        </div>
      )}
      <ContextMenu menu={ctxMenu.menu} onClose={ctxMenu.close} />
    </div>
  )
})

export default DayPlanSidebar
