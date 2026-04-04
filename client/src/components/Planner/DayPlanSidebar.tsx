/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
interface DragDataPayload {
  placeId?: string
  assignmentId?: string
  noteId?: string
  fromDayId?: string
  recommendedPlace?: string
}
declare global { interface Window { __dragData: DragDataPayload | null } }

import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import { ChevronDown, ChevronRight, ChevronUp, Navigation, RotateCcw, ExternalLink, Clock, Pencil, GripVertical, Ticket, Plus, FileText, Check, Trash2, Info, MapPin, Star, Heart, Camera, Lightbulb, Flag, Bookmark, Train, Bus, Plane, Car, Ship, Coffee, ShoppingBag, AlertTriangle, FileDown, Lock, Hotel, Utensils, Users } from 'lucide-react'

const RES_ICONS = { flight: Plane, hotel: Hotel, restaurant: Utensils, train: Train, car: Car, cruise: Ship, event: Ticket, tour: Users, other: FileText }
import { downloadTripPDF } from '../PDF/TripPDF'
import { calculateRoute, generateGoogleMapsUrl, optimizeRoute } from '../Map/RouteCalculator'
import PlaceAvatar from '../shared/PlaceAvatar'
import { useContextMenu, ContextMenu } from '../shared/ContextMenu'
import WeatherWidget from '../Weather/WeatherWidget'
import { useToast } from '../shared/Toast'
import { getCategoryIcon } from '../shared/categoryIcons'
import { useTripStore } from '../../store/tripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useTranslation } from '../../i18n'
import { formatDate, formatTime, dayTotalCost, currencyDecimals } from '../../utils/formatters'
import { useDayNotes } from '../../hooks/useDayNotes'
import type { Trip, Day, Place, Category, Assignment, Reservation, AssignmentsMap, RecommendedPlace, RouteResult } from '../../types'

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
  tripId: number | string
  trip: Trip | null
  days: Day[]
  places: Place[]
  categories: Category[]
  assignments: AssignmentsMap
  selectedDayId: number | string | null
  selectedPlaceId: number | string | null
  selectedAssignmentId: number | string | null
  onSelectDay: (dayId: number | string, skipFit?: boolean) => void
  onPlaceClick: (placeId: number | string | null, assignmentId?: number | string | null) => void
  onDayDetail: (day: Day) => void
  accommodations?: any[]
  onReorder: (dayId: number | string, orderedIds: (number | string)[]) => void
  onUpdateDayTitle: (dayId: number | string, title: string) => void
  onRouteCalculated: (route: RouteResult | null) => void
  onAssignToDay: (placeId: number | string, dayId: number | string, position?: number) => void
  onDropRecommendedPlace?: (recommendation: RecommendedPlace, dayId: number | string, position?: number) => Promise<void> | void
  onRemoveAssignment: (dayId: number | string, assignmentId: number | string) => void
  onEditPlace: (place: Place, assignmentId?: number | string | null) => void
  onDeletePlace: (placeId: number | string) => void
  reservations?: Reservation[]
  onAddReservation: (dayId: number | string) => void
}

export default function DayPlanSidebar({
  tripId,
  trip, days, places, categories, assignments,
  selectedDayId, selectedPlaceId, selectedAssignmentId,
  onSelectDay, onPlaceClick, onDayDetail, accommodations = [],
  onReorder, onUpdateDayTitle, onRouteCalculated,
  onAssignToDay, onDropRecommendedPlace, onRemoveAssignment, onEditPlace, onDeletePlace,
  reservations = [],
  onAddReservation,
}: DayPlanSidebarProps) {
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const ctxMenu = useContextMenu()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const tripStore = useTripStore()

  const { noteUi, setNoteUi, noteInputRef, dayNotes, openAddNote: _openAddNote, openEditNote: _openEditNote, cancelNote, saveNote, deleteNote: _deleteNote, moveNote: _moveNote } = useDayNotes(tripId)

  const [expandedDays, setExpandedDays] = useState(() => {
    try {
      const saved = sessionStorage.getItem(`day-expanded-${tripId}`)
      if (saved) return new Set(JSON.parse(saved))
    } catch {}
    return new Set(days.map(d => d.id))
  })
  const [editingDayId, setEditingDayId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [isCalculating, setIsCalculating] = useState(false)
  const [routeInfo, setRouteInfo] = useState(null)
  const [draggingId, setDraggingId] = useState(null)
  const [lockedIds, setLockedIds] = useState(new Set())
  const [lockHoverId, setLockHoverId] = useState(null)
  const [dropTargetKey, setDropTargetKey] = useState(null)
  const [dragOverDayId, setDragOverDayId] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const inputRef = useRef(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const dragDataRef = useRef(null) // Speichert Drag-Daten als Backup (dataTransfer geht bei Re-Render verloren)

  const currency = trip?.currency || 'EUR'

  const parseRecommendedPlace = (serialized: string): RecommendedPlace | null => {
    try {
      return JSON.parse(serialized) as RecommendedPlace
    } catch {
      toast.error('Could not read dragged recommendation')
      return null
    }
  }

  const handleRecommendedDrop = (serialized: string, dayId: number, position?: number): void => {
    const recommendation = parseRecommendedPlace(serialized)
    if (!recommendation) return
    Promise.resolve(onDropRecommendedPlace?.(recommendation, dayId, position)).catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Unknown error')
    })
  }

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
    const recommendedPlace = dt?.getData('recommendedPlace') || ext.recommendedPlace || ''
    return { placeId, recommendedPlace, assignmentId: '', noteId: '', fromDayId: 0 }
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

  const getDayAssignments = (dayId) =>
    (assignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)

  const getMergedItems = (dayId: number | string) => {
    const da = getDayAssignments(dayId)
    const dn = (dayNotes[String(dayId)] || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    return [
      ...da.map(a => ({ type: 'assignment' as const, sortKey: a.order_index, data: a as any })),
      ...dn.map(n => ({ type: 'note' as const, sortKey: n.sort_order ?? 0, data: n as any })),
    ].sort((a, b) => a.sortKey - b.sortKey)
  }

  const openAddNote = (dayId, e) => {
    e?.stopPropagation()
    _openAddNote(dayId, getMergedItems, (id) => {
      if (!expandedDays.has(id)) setExpandedDays(prev => new Set([...prev, id]))
    })
  }

  const openEditNote = (dayId: any, note: any, e?: any) => {
    e?.stopPropagation()
    _openEditNote(dayId, note)
  }

  const deleteNote = async (dayId: any, noteId: any, e?: any) => {
    e?.stopPropagation()
    await _deleteNote(dayId, noteId)
  }

  const handleMergedDrop = async (dayId, fromType, fromId, toType, toId, insertAfter = false) => {
    const m = getMergedItems(dayId)
    const fromIdx = m.findIndex(i => i.type === fromType && i.data.id === fromId)
    const toIdx = m.findIndex(i => i.type === toType && i.data.id === toId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

    // Neue Reihenfolge erstellen — VOR dem Ziel einfügen (Standard), oder NACH dem Ziel wenn insertAfter
    const newOrder = [...m]
    const [moved] = newOrder.splice(fromIdx, 1)
    let adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx
    if (insertAfter) adjustedTo += 1
    newOrder.splice(adjustedTo, 0, moved)

    // Orte: neuer order_index über onReorder
    const assignmentIds = newOrder.filter(i => i.type === 'assignment').map(i => i.data.id as number)

    // Notizen: sort_order muss ZWISCHEN den umgebenden order_indices der Orte liegen, niemals gleich sein.
    // Formel: Notiz zwischen placesBefore-1 und placesBefore ergibt (placesBefore - 1) + rank/(count+1)
    // z.B. einzelne Notiz nach 2 Orten → (2-1) + 0.5 = 1.5  (zwischen order_index 1 und 2)
    const groups: Record<number, any[]> = {}
    let pc = 0
    newOrder.forEach(item => {
      if (item.type === 'assignment') { pc++ }
      else { if (!groups[pc]) groups[pc] = []; groups[pc].push(item.data.id) }
    })
    const noteChanges: { id: any; sort_order: number }[] = []
    Object.entries(groups).forEach(([pb, ids]) => {
      (ids as any[]).forEach((id, i) => {
        noteChanges.push({ id, sort_order: (Number(pb) - 1) + (i + 1) / (ids.length + 1) })
      })
    })

    try {
      if (assignmentIds.length) await onReorder(dayId, assignmentIds)
      for (const n of noteChanges) {
        await tripStore.updateDayNote(tripId, dayId, n.id, { sort_order: n.sort_order })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
    setDraggingId(null)
    setDropTargetKey(null)
    dragDataRef.current = null
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
      const lineCoords = waypoints.map(p => [p.lat, p.lng] as [number, number])
      setRouteInfo({ distance: result.distanceText, duration: result.durationText })
      onRouteCalculated?.({ ...result, coordinates: lineCoords })
    } catch { toast.error(t('dayplan.toast.routeError')) }
    finally { setIsCalculating(false) }
  }

  const toggleLock = (assignmentId) => {
    setLockedIds(prev => {
      const next = new Set(prev)
      if (next.has(assignmentId)) next.delete(assignmentId)
      else next.add(assignmentId)
      return next
    })
  }

  const handleOptimize = async () => {
    if (!selectedDayId) return
    const da = getDayAssignments(selectedDayId)
    if (da.length < 3) return

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
    const { placeId, recommendedPlace, assignmentId, noteId, fromDayId } = getDragData(e)
    if (placeId) {
      onAssignToDay?.(parseInt(placeId), dayId)
    } else if (recommendedPlace) {
      handleRecommendedDrop(recommendedPlace, dayId)
    } else if (assignmentId && fromDayId !== dayId) {
      tripStore.moveAssignment(tripId, Number(assignmentId), fromDayId, dayId).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
    } else if (noteId && fromDayId !== dayId) {
      tripStore.moveDayNote(tripId, fromDayId, dayId, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
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
    const { placeId, recommendedPlace, assignmentId: fromAssignmentId } = getDragData(e)

    if (placeId) {
      onAssignToDay?.(parseInt(placeId), dayId)
    } else if (recommendedPlace) {
      handleRecommendedDrop(recommendedPlace, dayId, toIdx)
    } else if (fromAssignmentId) {
      const da = getDayAssignments(dayId)
      const fromIdx = da.findIndex(a => String(a.id) === fromAssignmentId)
      if (fromIdx === -1 || fromIdx === toIdx) { setDraggingId(null); dragDataRef.current = null; return }
      const ids = da.map(a => a.id as number)
      const [removed] = ids.splice(fromIdx, 1)
      ids.splice(toIdx, 0, removed)
      onReorder(dayId, ids)
    }
    setDraggingId(null)
  }

  const handleSidebarDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const edgeThreshold = 56
    const scrollStep = 24

    if (e.clientY < rect.top + edgeThreshold) {
      container.scrollTop -= scrollStep
    } else if (e.clientY > rect.bottom - edgeThreshold) {
      container.scrollTop += scrollStep
    }
  }

  const totalCost = days.reduce((s, d) => {
    const da = assignments[String(d.id)] || []
    return s + da.reduce((s2, a) => s2 + (parseFloat(a.place?.price) || 0), 0)
  }, 0)

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
          <button
            onClick={async () => {
              const flatNotes = Object.entries(dayNotes).flatMap(([dayId, notes]) =>
                notes.map(n => ({ ...n, day_id: Number(dayId) }))
              )
              try {
                await downloadTripPDF({ trip, days, places, assignments, categories, dayNotes: flatNotes as any, t, locale })
              } catch (e) {
                console.error('PDF error:', e)
                toast.error(t('dayplan.pdfError') + ': ' + (e?.message || String(e)))
              }
            }}
            title={t('dayplan.pdfTooltip')}
            style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 8, border: 'none',
              background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 11, fontWeight: 500,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <FileDown size={13} strokeWidth={2} />
            {t('dayplan.pdf')}
          </button>
        </div>
      </div>

      {/* Tagesliste */}
      <div
        ref={scrollContainerRef}
        className="scroll-container"
        onDragOver={handleSidebarDragOver}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingBottom: 24, scrollbarWidth: 'thin', scrollbarColor: 'var(--scrollbar-thumb) transparent' }}
      >
        {days.map((day, index) => {
          const isSelected = selectedDayId === day.id
          const isExpanded = expandedDays.has(day.id)
          const da = getDayAssignments(day.id)
          const cost = dayTotalCost(day.id as number, assignments, currency)
          const formattedDate = formatDate(day.date, locale)
          const loc = da.find(a => a.place?.lat && a.place?.lng)
          const isDragTarget = dragOverDayId === day.id
          const merged = getMergedItems(day.id)
          const dayNoteUi = noteUi[day.id]
          const placeItems = merged.filter(i => i.type === 'assignment')

          return (
            <div key={day.id} style={{ borderBottom: '1px solid var(--border-faint)' }}>
              {/* Tages-Header — akzeptiert Drops aus der PlacesSidebar */}
              <div
                onClick={() => { onSelectDay(day.id as number); if (onDayDetail) onDayDetail(day) }}
                onDragOver={e => { e.preventDefault(); setDragOverDayId(day.id) }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverDayId(null) }}
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
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
                        {day.title || t('dayplan.dayN', { n: index + 1 })}
                      </span>
                      <button
                        onClick={e => startEditTitle(day, e)}
                        style={{ flexShrink: 0, background: 'none', border: 'none', padding: '2px', cursor: 'pointer', opacity: 0.35, display: 'flex', alignItems: 'center' }}
                      >
                        <Pencil size={10} strokeWidth={1.8} color="var(--text-secondary)" />
                      </button>
                      {(() => {
                        const dayAccs = accommodations.filter(a => day.id >= a.start_day_id && day.id <= a.end_day_id)
                        if (dayAccs.length === 0) return null
                        return dayAccs.map(acc => {
                          const isCheckIn = acc.start_day_id === day.id
                          const isCheckOut = acc.end_day_id === day.id
                          const bg = isCheckOut && !isCheckIn ? 'rgba(239,68,68,0.08)' : isCheckIn ? 'rgba(34,197,94,0.08)' : 'var(--bg-secondary)'
                          const border = isCheckOut && !isCheckIn ? 'rgba(239,68,68,0.2)' : isCheckIn ? 'rgba(34,197,94,0.2)' : 'var(--border-primary)'
                          const iconColor = isCheckOut && !isCheckIn ? '#ef4444' : isCheckIn ? '#22c55e' : 'var(--text-muted)'
                          return (
                            <span key={acc.id} onClick={e => { e.stopPropagation(); onPlaceClick(acc.place_id as number) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 5, background: bg, border: `1px solid ${border}`, flexShrink: 1, minWidth: 0, maxWidth: '40%', cursor: 'pointer' }}>
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
                      const wLat = loc?.place.lat ?? (anyGeoPlace as any)?.place?.lat ?? (anyGeoPlace as any)?.lat
                      const wLng = loc?.place.lng ?? (anyGeoPlace as any)?.place?.lng ?? (anyGeoPlace as any)?.lng
                      return <WeatherWidget lat={wLat} lng={wLng} date={day.date} compact />
                    })()}
                  </div>
                </div>

                <button
                  onClick={e => openAddNote(day.id, e)}
                  title={t('dayplan.addNote')}
                  style={{ flexShrink: 0, background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
                >
                  <FileText size={13} strokeWidth={2} />
                </button>
                <button
                  onClick={e => toggleDay(day.id, e)}
                  style={{ flexShrink: 0, background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-faint)' }}
                >
                  {isExpanded ? <ChevronDown size={15} strokeWidth={2} /> : <ChevronRight size={15} strokeWidth={2} />}
                </button>
              </div>

              {/* Aufgeklappte Orte + Notizen */}
              {isExpanded && (
                <div
                  style={{ background: 'var(--bg-hover)', paddingTop: 6 }}
                  onDragOver={e => { e.preventDefault(); if (draggingId) setDropTargetKey(`end-${day.id}`) }}
                  onDrop={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    const { placeId, recommendedPlace, assignmentId, noteId, fromDayId } = getDragData(e)
                    if (placeId) {
                      onAssignToDay?.(parseInt(placeId), day.id as number)
                      setDropTargetKey(null)
                      window.__dragData = null
                      return
                    }
                    if (recommendedPlace) {
                      handleRecommendedDrop(recommendedPlace, day.id as number)
                      setDropTargetKey(null)
                      window.__dragData = null
                      return
                    }
                    if (!assignmentId && !noteId) { dragDataRef.current = null; window.__dragData = null; return }
                    if (assignmentId && fromDayId !== day.id) {
                      tripStore.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    if (noteId && fromDayId !== day.id) {
                      tripStore.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                      setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                    }
                    const m = getMergedItems(day.id)
                    if (m.length === 0) return
                    const lastItem = m[m.length - 1]
                    if (assignmentId && String(lastItem?.data?.id) !== assignmentId)
                      handleMergedDrop(day.id, 'assignment', Number(assignmentId), lastItem.type, lastItem.data.id, true)
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
                      const itemKey = item.type === 'assignment' ? `place-${item.data.id}` : `note-${item.data.id}`
                      const showDropLine = (!!draggingId || !!dropTargetKey) && dropTargetKey === itemKey

                      if (item.type === 'assignment') {
                        const assignment = item.data as any
                        const place = assignment.place
                        if (!place) return null
                        const cat = categories.find(c => c.id === place.category_id)
                        const isPlaceSelected = selectedAssignmentId ? assignment.id === selectedAssignmentId : place.id === selectedPlaceId
                        const isDraggingThis = draggingId === assignment.id
                        const isHovered = hoveredId === assignment.id
                        const placeIdx = placeItems.findIndex(i => i.data.id === assignment.id)

                        const moveUp = (e) => {
                          e.stopPropagation()
                          if (placeIdx === 0) return
                          const ids = placeItems.map(i => i.data.id as number)
                          ;[ids[placeIdx - 1], ids[placeIdx]] = [ids[placeIdx], ids[placeIdx - 1]]
                          onReorder(day.id as number, ids)
                        }
                        const moveDown = (e) => {
                          e.stopPropagation()
                          if (placeIdx === placeItems.length - 1) return
                          const ids = placeItems.map(i => i.data.id as number)
                          ;[ids[placeIdx], ids[placeIdx + 1]] = [ids[placeIdx + 1], ids[placeIdx]]
                          onReorder(day.id as number, ids)
                        }

                        return (
                          <React.Fragment key={`place-${assignment.id}`}>
                            {showDropLine && <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1, margin: '2px 8px' }} />}
                          <div
                            draggable
                            onDragStart={e => {
                              e.dataTransfer.setData('assignmentId', String(assignment.id))
                              e.dataTransfer.setData('fromDayId', String(day.id))
                              e.dataTransfer.effectAllowed = 'move'
                              dragDataRef.current = { assignmentId: String(assignment.id), fromDayId: String(day.id) }
                              setDraggingId(assignment.id)
                            }}
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverDayId(null); if (dropTargetKey !== `place-${assignment.id}`) setDropTargetKey(`place-${assignment.id}`) }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation()
                              const { placeId, recommendedPlace, assignmentId: fromAssignmentId, noteId, fromDayId } = getDragData(e)
                              if (placeId) {
                                const pos = placeItems.findIndex(i => i.data.id === assignment.id)
                                onAssignToDay?.(parseInt(placeId), day.id as number, pos >= 0 ? pos : undefined)
                                setDropTargetKey(null); window.__dragData = null
                              } else if (recommendedPlace) {
                                const pos = placeItems.findIndex(i => i.data.id === assignment.id)
                                handleRecommendedDrop(recommendedPlace, day.id as number, pos >= 0 ? pos : undefined)
                                setDropTargetKey(null); window.__dragData = null
                              } else if (fromAssignmentId && fromDayId !== day.id) {
                                const toIdx = getDayAssignments(day.id).findIndex(a => a.id === assignment.id)
                                tripStore.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (fromAssignmentId) {
                                handleMergedDrop(day.id, 'assignment', Number(fromAssignmentId), 'assignment', assignment.id)
                              } else if (noteId && fromDayId !== day.id) {
                                const tm = getMergedItems(day.id)
                                const toIdx = tm.findIndex(i => i.type === 'assignment' && i.data.id === assignment.id)
                                const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                                tripStore.moveDayNote(tripId, fromDayId, day.id, Number(noteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                                setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null
                              } else if (noteId) {
                                handleMergedDrop(day.id, 'note', Number(noteId), 'assignment', assignment.id)
                              }
                            }}
                            onDragEnd={() => { setDraggingId(null); setDragOverDayId(null); setDropTargetKey(null); dragDataRef.current = null }}
                            onClick={() => { onPlaceClick(isPlaceSelected ? null : place.id as number, isPlaceSelected ? null : assignment.id as number); if (!isPlaceSelected) onSelectDay(day.id as number, true) }}
                            onContextMenu={e => ctxMenu.open(e, [
                              onEditPlace && { label: t('common.edit'), icon: Pencil, onClick: () => onEditPlace(place, assignment.id as number) },
                              onRemoveAssignment && { label: t('planner.removeFromDay'), icon: Trash2, onClick: () => onRemoveAssignment(day.id as number, assignment.id as number) },
                              place.website && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(place.website, '_blank') },
                              (place.lat && place.lng) && { label: 'Google Maps', icon: Navigation, onClick: () => window.open(`https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`, '_blank') },
                              { divider: true },
                              onDeletePlace && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => onDeletePlace(place.id as number) },
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
                            <div style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: isHovered ? 1 : 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                              <GripVertical size={13} strokeWidth={1.8} />
                            </div>
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
                                  return <CatIcon size={10} strokeWidth={2} color={cat.color || 'var(--text-muted)'} style={{ flexShrink: 0 }} />
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
                                <div style={{ marginTop: 2 }}>
                                  <span style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', lineHeight: 1.2 }}>
                                    {place.description || place.address || cat?.name}
                                  </span>
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
                            <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, opacity: isHovered ? 1 : undefined, transition: 'opacity 0.15s' }}>
                              <button onClick={moveUp} disabled={placeIdx === 0} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: placeIdx === 0 ? 'default' : 'pointer', color: placeIdx === 0 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}>
                                <ChevronUp size={12} strokeWidth={2} />
                              </button>
                              <button onClick={moveDown} disabled={placeIdx === placeItems.length - 1} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: placeIdx === placeItems.length - 1 ? 'default' : 'pointer', color: placeIdx === placeItems.length - 1 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}>
                                <ChevronDown size={12} strokeWidth={2} />
                              </button>
                            </div>
                          </div>
                          </React.Fragment>
                        )
                      }

                      // Notizkarte
                      const note = item.data as any
                      const isNoteHovered = hoveredId === `note-${note.id}`
                      const NoteIcon = getNoteIcon(note.icon)
                      const noteIdx = idx
                      return (
                        <React.Fragment key={`note-${note.id}`}>
                          {showDropLine && <div style={{ height: 2, background: 'var(--text-primary)', borderRadius: 1, margin: '2px 8px' }} />}
                        <div
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('noteId', String(note.id)); e.dataTransfer.setData('fromDayId', String(day.id)); e.dataTransfer.effectAllowed = 'move'; dragDataRef.current = { noteId: String(note.id), fromDayId: String(day.id) }; setDraggingId(`note-${note.id}`) }}
                          onDragEnd={() => { setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null }}
                          onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dropTargetKey !== `note-${note.id}`) setDropTargetKey(`note-${note.id}`) }}
                          onDrop={e => {
                            e.preventDefault(); e.stopPropagation()
                            const { noteId: fromNoteId, assignmentId: fromAssignmentId, fromDayId } = getDragData(e)
                            if (fromNoteId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const toIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const so = toIdx <= 0 ? (tm[0]?.sortKey ?? 0) - 1 : (tm[toIdx - 1].sortKey + tm[toIdx].sortKey) / 2
                              tripStore.moveDayNote(tripId, fromDayId, day.id, Number(fromNoteId), so).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromNoteId && fromNoteId !== String(note.id)) {
                              handleMergedDrop(day.id, 'note', Number(fromNoteId), 'note', note.id)
                            } else if (fromAssignmentId && fromDayId !== day.id) {
                              const tm = getMergedItems(day.id)
                              const noteIdx = tm.findIndex(i => i.type === 'note' && i.data.id === note.id)
                              const toIdx = tm.slice(0, noteIdx).filter(i => i.type === 'assignment').length
                              tripStore.moveAssignment(tripId, Number(fromAssignmentId), fromDayId, day.id, toIdx).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                              setDraggingId(null); setDropTargetKey(null)
                            } else if (fromAssignmentId) {
                              handleMergedDrop(day.id, 'assignment', Number(fromAssignmentId), 'note', note.id)
                            }
                          }}
                          onContextMenu={e => ctxMenu.open(e, [
                            { label: t('common.edit'), icon: Pencil, onClick: () => openEditNote(day.id, note) },
                            { divider: true },
                            { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => deleteNote(day.id, note.id) },
                          ])}
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
                          <div style={{ flexShrink: 0, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', opacity: isNoteHovered ? 1 : 0.3, transition: 'opacity 0.15s', cursor: 'grab' }}>
                            <GripVertical size={13} strokeWidth={1.8} />
                          </div>
                          <div style={{ width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', background: 'var(--bg-hover)', overflow: 'hidden' }}>
                            <NoteIcon size={13} strokeWidth={1.8} color="var(--text-muted)" />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                              {note.text}
                            </span>
                            {note.time && (
                              <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-faint)', lineHeight: '1.3', marginTop: 2, wordBreak: 'break-word' }}>{note.time}</div>
                            )}
                          </div>
                          <div className="note-edit-buttons" style={{ display: 'flex', gap: 1, flexShrink: 0, opacity: isNoteHovered ? 1 : 0, transition: 'opacity 0.15s' }}>
                            <button onClick={e => openEditNote(day.id, note, e)} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}><Pencil size={10} /></button>
                            <button onClick={e => deleteNote(day.id, note.id, e)} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-faint)', display: 'flex' }}><Trash2 size={10} /></button>
                          </div>
                          <div className="reorder-buttons" style={{ flexShrink: 0, display: 'flex', gap: 1, opacity: isNoteHovered ? 1 : undefined, transition: 'opacity 0.15s' }}>
                            <button onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'up') }} disabled={noteIdx === 0} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === 0 ? 'default' : 'pointer', color: noteIdx === 0 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}><ChevronUp size={12} strokeWidth={2} /></button>
                            <button onClick={e => { e.stopPropagation(); moveNote(day.id, note.id, 'down') }} disabled={noteIdx === merged.length - 1} style={{ background: 'none', border: 'none', padding: '1px 2px', cursor: noteIdx === merged.length - 1 ? 'default' : 'pointer', color: noteIdx === merged.length - 1 ? 'var(--border-primary)' : 'var(--text-faint)', display: 'flex', lineHeight: 1 }}><ChevronDown size={12} strokeWidth={2} /></button>
                          </div>
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
                      const { placeId, recommendedPlace, assignmentId, noteId, fromDayId } = getDragData(e)
                      // Neuer Ort von der Orte-Liste
                      if (placeId) {
                        onAssignToDay?.(parseInt(placeId), day.id as number)
                        setDropTargetKey(null); window.__dragData = null; return
                      }
                      if (recommendedPlace) {
                        handleRecommendedDrop(recommendedPlace, day.id as number)
                        setDropTargetKey(null); window.__dragData = null; return
                      }
                      if (!assignmentId && !noteId) { dragDataRef.current = null; window.__dragData = null; return }
                      if (assignmentId && fromDayId !== day.id) {
                        tripStore.moveAssignment(tripId, Number(assignmentId), fromDayId, day.id).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                      }
                      if (noteId && fromDayId !== day.id) {
                        tripStore.moveDayNote(tripId, fromDayId, day.id, Number(noteId)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Unknown error'))
                        setDraggingId(null); setDropTargetKey(null); dragDataRef.current = null; return
                      }
                      const m = getMergedItems(day.id)
                      if (m.length === 0) return
                      const lastItem = m[m.length - 1]
                      if (assignmentId && String(lastItem?.data?.id) !== assignmentId)
                        handleMergedDrop(day.id, 'assignment', Number(assignmentId), lastItem.type, lastItem.data.id, true)
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
          position: 'fixed', inset: 0, zIndex: 1000,
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
                  style={{ width: 34, height: 34, borderRadius: 8, border: ui.icon === id ? '2px solid var(--text-primary)' : '2px solid var(--border-faint)', background: ui.icon === id ? 'var(--bg-hover)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
                  <Icon size={15} strokeWidth={1.8} color={ui.icon === id ? 'var(--text-primary)' : 'var(--text-muted)'} />
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
            <div style={{ textAlign: 'right', fontSize: 9, color: (ui.time?.length || 0) >= 140 ? '#d97706' : 'var(--text-faint)', marginTop: -2 }}>{ui.time?.length || 0}/150</div>
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
}
