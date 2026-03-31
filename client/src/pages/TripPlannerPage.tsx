import React, { useState, useEffect, useCallback, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useTripStore } from '../store/tripStore'
import { useSettingsStore } from '../store/settingsStore'
import { MapView } from '../components/Map/MapView'
import DayPlanSidebar from '../components/Planner/DayPlanSidebar'
import PlacesSidebar from '../components/Planner/PlacesSidebar'
import PlaceInspector from '../components/Planner/PlaceInspector'
import DayDetailPanel from '../components/Planner/DayDetailPanel'
import PlaceFormModal from '../components/Planner/PlaceFormModal'
import TripFormModal from '../components/Trips/TripFormModal'
import TripMembersModal from '../components/Trips/TripMembersModal'
import { ReservationModal } from '../components/Planner/ReservationModal'
import MemoriesPanel from '../components/Memories/MemoriesPanel'
import ReservationsPanel from '../components/Planner/ReservationsPanel'
import PackingListPanel from '../components/Packing/PackingListPanel'
import FileManager from '../components/Files/FileManager'
import BudgetPanel from '../components/Budget/BudgetPanel'
import CollabPanel from '../components/Collab/CollabPanel'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { Map, X, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useTranslation } from '../i18n'
import { addonsApi, accommodationsApi, authApi, tripsApi, assignmentsApi } from '../api/client'
import ConfirmDialog from '../components/shared/ConfirmDialog'
import { useResizablePanels } from '../hooks/useResizablePanels'
import { useTripWebSocket } from '../hooks/useTripWebSocket'
import { useRouteCalculation } from '../hooks/useRouteCalculation'
import { usePlaceSelection } from '../hooks/usePlaceSelection'
import type { Accommodation, TripMember, Day, Place, Reservation } from '../types'

export default function TripPlannerPage(): React.ReactElement | null {
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const { t, language } = useTranslation()
  const { settings } = useSettingsStore()
  const tripStore = useTripStore()
  const { trip, days, places, assignments, packingItems, categories, reservations, budgetItems, files, selectedDayId, isLoading } = tripStore

  const [enabledAddons, setEnabledAddons] = useState<Record<string, boolean>>({ packing: true, budget: true, documents: true })
  const [tripAccommodations, setTripAccommodations] = useState<Accommodation[]>([])
  const [allowedFileTypes, setAllowedFileTypes] = useState<string | null>(null)
  const [tripMembers, setTripMembers] = useState<TripMember[]>([])

  const loadAccommodations = useCallback(() => {
    if (tripId) {
      accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
      tripStore.loadReservations(tripId)
    }
  }, [tripId])

  useEffect(() => {
    addonsApi.enabled().then(data => {
      const map = {}
      data.addons.forEach(a => { map[a.id] = true })
      setEnabledAddons({ packing: !!map.packing, budget: !!map.budget, documents: !!map.documents, collab: !!map.collab, memories: !!map.memories })
    }).catch(() => {})
    authApi.getAppConfig().then(config => {
      if (config.allowed_file_types) setAllowedFileTypes(config.allowed_file_types)
    }).catch(() => {})
  }, [])

  const TRIP_TABS = [
    { id: 'plan', label: t('trip.tabs.plan') },
    { id: 'buchungen', label: t('trip.tabs.reservations'), shortLabel: t('trip.tabs.reservationsShort') },
    ...(enabledAddons.packing ? [{ id: 'packliste', label: t('trip.tabs.packing'), shortLabel: t('trip.tabs.packingShort') }] : []),
    ...(enabledAddons.budget ? [{ id: 'finanzplan', label: t('trip.tabs.budget') }] : []),
    ...(enabledAddons.documents ? [{ id: 'dateien', label: t('trip.tabs.files') }] : []),
    ...(enabledAddons.memories ? [{ id: 'memories', label: t('memories.title') }] : []),
    ...(enabledAddons.collab ? [{ id: 'collab', label: t('admin.addons.catalog.collab.name') }] : []),
  ]

  const [activeTab, setActiveTab] = useState<string>(() => {
    const saved = sessionStorage.getItem(`trip-tab-${tripId}`)
    return saved || 'plan'
  })

  const handleTabChange = (tabId: string): void => {
    setActiveTab(tabId)
    sessionStorage.setItem(`trip-tab-${tripId}`, tabId)
    if (tabId === 'finanzplan') tripStore.loadBudgetItems?.(tripId)
    if (tabId === 'dateien' && (!files || files.length === 0)) tripStore.loadFiles?.(tripId)
  }
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed, startResizeLeft, startResizeRight } = useResizablePanels()
  const { selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment } = usePlaceSelection()
  const [showDayDetail, setShowDayDetail] = useState<Day | null>(null)
  const [showPlaceForm, setShowPlaceForm] = useState<boolean>(false)
  const [editingPlace, setEditingPlace] = useState<Place | null>(null)
  const [prefillCoords, setPrefillCoords] = useState<{ lat: number; lng: number; name?: string; address?: string } | null>(null)
  const [editingAssignmentId, setEditingAssignmentId] = useState<number | null>(null)
  const [showTripForm, setShowTripForm] = useState<boolean>(false)
  const [showMembersModal, setShowMembersModal] = useState<boolean>(false)
  const [showReservationModal, setShowReservationModal] = useState<boolean>(false)
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null)
  const [fitKey, setFitKey] = useState<number>(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<'left' | 'right' | null>(null)
  const [deletePlaceId, setDeletePlaceId] = useState<number | null>(null)

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Load trip + files (needed for place inspector file section)
  useEffect(() => {
    if (tripId) {
      tripStore.loadTrip(tripId).catch(() => { toast.error(t('trip.toast.loadError')); navigate('/dashboard') })
      tripStore.loadFiles(tripId)
      loadAccommodations()
      tripsApi.getMembers(tripId).then(d => {
        // Combine owner + members into one list
        const all = [d.owner, ...(d.members || [])].filter(Boolean)
        setTripMembers(all)
      }).catch(() => {})
    }
  }, [tripId])

  useEffect(() => {
    if (tripId) tripStore.loadReservations(tripId)
  }, [tripId])

  useTripWebSocket(tripId)

  const [mapCategoryFilter, setMapCategoryFilter] = useState<string>('')

  const mapPlaces = useMemo(() => {
    return places.filter(p => {
      if (!p.lat || !p.lng) return false
      if (mapCategoryFilter && String(p.category_id) !== String(mapCategoryFilter)) return false
      return true
    })
  }, [places, mapCategoryFilter])

  const { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay } = useRouteCalculation(tripStore, selectedDayId)

  const handleSelectDay = useCallback((dayId, skipFit) => {
    const changed = dayId !== selectedDayId
    tripStore.setSelectedDay(dayId)
    if (changed && !skipFit) setFitKey(k => k + 1)
    setMobileSidebarOpen(null)
    updateRouteForDay(dayId)
  }, [tripStore, updateRouteForDay, selectedDayId])

  const handlePlaceClick = useCallback((placeId, assignmentId) => {
    if (assignmentId) {
      selectAssignment(assignmentId, placeId)
    } else {
      setSelectedPlaceId(placeId)
    }
    if (placeId) { setShowDayDetail(null); setLeftCollapsed(false); setRightCollapsed(false) }
  }, [selectAssignment, setSelectedPlaceId])

  const handleMarkerClick = useCallback((placeId) => {
    const opening = placeId !== undefined
    setSelectedPlaceId(prev => prev === placeId ? null : placeId)
    if (opening) { setLeftCollapsed(false); setRightCollapsed(false) }
  }, [])

  const handleMapClick = useCallback(() => {
    setSelectedPlaceId(null)
  }, [])

  const handleMapContextMenu = useCallback(async (e) => {
    e.originalEvent?.preventDefault()
    const { lat, lng } = e.latlng
    setPrefillCoords({ lat, lng })
    setEditingPlace(null)
    setEditingAssignmentId(null)
    setShowPlaceForm(true)
    try {
      const { mapsApi } = await import('../api/client')
      const data = await mapsApi.reverse(lat, lng, language)
      if (data.name || data.address) {
        setPrefillCoords(prev => prev ? { ...prev, name: data.name || '', address: data.address || '' } : prev)
      }
    } catch { /* best effort */ }
  }, [language])

  const handleSavePlace = useCallback(async (data) => {
    const pendingFiles = data._pendingFiles
    delete data._pendingFiles
    if (editingPlace) {
      // Always strip time fields from place update — time is per-assignment only
      const { place_time, end_time, ...placeData } = data
      await tripStore.updatePlace(tripId, editingPlace.id, placeData)
      // If editing from assignment context, save time per-assignment
      if (editingAssignmentId) {
        await assignmentsApi.updateTime(tripId, editingAssignmentId, { place_time: place_time || null, end_time: end_time || null })
        await tripStore.refreshDays(tripId)
      }
      // Upload pending files with place_id
      if (pendingFiles?.length > 0) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('place_id', editingPlace.id)
          try { await tripStore.addFile(tripId, fd) } catch {}
        }
      }
      toast.success(t('trip.toast.placeUpdated'))
    } else {
      const place = await tripStore.addPlace(tripId, data)
      if (pendingFiles?.length > 0 && place?.id) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('place_id', place.id)
          try { await tripStore.addFile(tripId, fd) } catch {}
        }
      }
      toast.success(t('trip.toast.placeAdded'))
    }
  }, [editingPlace, editingAssignmentId, tripId, tripStore, toast])

  const handleDeletePlace = useCallback((placeId) => {
    setDeletePlaceId(placeId)
  }, [])

  const confirmDeletePlace = useCallback(async () => {
    if (!deletePlaceId) return
    try {
      await tripStore.deletePlace(tripId, deletePlaceId)
      if (selectedPlaceId === deletePlaceId) setSelectedPlaceId(null)
      toast.success(t('trip.toast.placeDeleted'))
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }, [deletePlaceId, tripId, tripStore, toast, selectedPlaceId])

  const handleAssignToDay = useCallback(async (placeId, dayId, position) => {
    const target = dayId || selectedDayId
    if (!target) { toast.error(t('trip.toast.selectDay')); return }
    try {
      await tripStore.assignPlaceToDay(tripId, target, placeId, position)
      toast.success(t('trip.toast.assignedToDay'))
      updateRouteForDay(target)
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }, [selectedDayId, tripId, tripStore, toast, updateRouteForDay])

  const handleRemoveAssignment = useCallback(async (dayId, assignmentId) => {
    try {
      await tripStore.removeAssignment(tripId, dayId, assignmentId)
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }, [tripId, tripStore, toast, updateRouteForDay])

  const handleReorder = useCallback((dayId, orderedIds) => {
    try {
      tripStore.reorderAssignments(tripId, dayId, orderedIds).catch(() => {})
      // Update route immediately from orderedIds
      const dayItems = tripStore.assignments[String(dayId)] || []
      const ordered = orderedIds.map(id => dayItems.find(a => a.id === id)).filter(Boolean)
      const waypoints = ordered.map(a => a.place).filter(p => p?.lat && p?.lng)
      if (waypoints.length >= 2) setRoute(waypoints.map(p => [p.lat, p.lng]))
      else setRoute(null)
      setRouteInfo(null)
    }
    catch { toast.error(t('trip.toast.reorderError')) }
  }, [tripId, tripStore, toast])

  const handleUpdateDayTitle = useCallback(async (dayId, title) => {
    try { await tripStore.updateDayTitle(tripId, dayId, title) }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }, [tripId, tripStore, toast])

  const handleSaveReservation = async (data) => {
    try {
      if (editingReservation) {
        const r = await tripStore.updateReservation(tripId, editingReservation.id, data)
        toast.success(t('trip.toast.reservationUpdated'))
        setShowReservationModal(false)
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      } else {
        const r = await tripStore.addReservation(tripId, { ...data, day_id: selectedDayId || null })
        toast.success(t('trip.toast.reservationAdded'))
        setShowReservationModal(false)
        // Refresh accommodations if hotel was created
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }

  const handleDeleteReservation = async (id) => {
    try {
      await tripStore.deleteReservation(tripId, id)
      toast.success(t('trip.toast.deleted'))
      // Refresh accommodations in case a hotel booking was deleted
      accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') }
  }

  const selectedPlace = selectedPlaceId ? places.find(p => p.id === selectedPlaceId) : null

  // Build placeId → order-number map from the selected day's assignments
  const dayOrderMap = useMemo(() => {
    if (!selectedDayId) return {}
    const da = assignments[String(selectedDayId)] || []
    const sorted = [...da].sort((a, b) => a.order_index - b.order_index)
    const map = {}
    sorted.forEach((a, i) => {
      if (!a.place?.id) return
      if (!map[a.place.id]) map[a.place.id] = []
      map[a.place.id].push(i + 1)
    })
    return map
  }, [selectedDayId, assignments])

  // Places assigned to selected day (with coords) — used for map fitting
  const dayPlaces = useMemo(() => {
    if (!selectedDayId) return []
    const da = assignments[String(selectedDayId)] || []
    return da.map(a => a.place).filter(p => p?.lat && p?.lng)
  }, [selectedDayId, assignments])

  const mapTileUrl = settings.map_tile_url || 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
  const defaultCenter = [settings.default_lat || 48.8566, settings.default_lng || 2.3522]
  const defaultZoom = settings.default_zoom || 10

  const fontStyle = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif" }

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb', ...fontStyle }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, border: '3px solid rgba(0,0,0,0.1)', borderTopColor: '#111827', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <span style={{ fontSize: 13, color: '#9ca3af' }}>{t('trip.loading')}</span>
        </div>
      </div>
    )
  }
  if (!trip) return null

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...fontStyle }}>
      <Navbar tripTitle={trip.title} tripId={tripId} showBack onBack={() => navigate('/dashboard')} onShare={() => setShowMembersModal(true)} />

      <div style={{
        position: 'fixed', top: 'var(--nav-h)', left: 0, right: 0, zIndex: 40,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 12px',
        background: 'var(--bg-elevated)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border-faint)',
        height: 44,
        overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none',
        gap: 2,
      }}>
        {TRIP_TABS.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              style={{
                flexShrink: 0,
                padding: '5px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: isActive ? 600 : 400,
                background: isActive ? 'var(--accent)' : 'transparent',
                color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                fontFamily: 'inherit', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = isActive ? 'var(--accent-text)' : 'var(--text-primary)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = isActive ? 'var(--accent-text)' : 'var(--text-muted)' }}
            >{tab.shortLabel
                ? <><span className="sm:hidden">{tab.shortLabel}</span><span className="hidden sm:inline">{tab.label}</span></>
                : tab.label
              }</button>
          )
        })}
      </div>

      {/* Offset by navbar + tab bar (44px) */}
      <div style={{ position: 'fixed', top: 'calc(var(--nav-h) + 44px)', left: 0, right: 0, bottom: 0, overflow: 'hidden', overscrollBehavior: 'contain' }}>

        {activeTab === 'plan' && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <MapView
              places={mapPlaces}
              dayPlaces={dayPlaces}
              route={route}
              routeSegments={routeSegments}
              selectedPlaceId={selectedPlaceId}
              onMarkerClick={handleMarkerClick}
              onMapClick={handleMapClick}
              onMapContextMenu={handleMapContextMenu}
              center={defaultCenter}
              zoom={defaultZoom}
              tileUrl={mapTileUrl}
              fitKey={fitKey}
              dayOrderMap={dayOrderMap}
              leftWidth={leftCollapsed ? 0 : leftWidth}
              rightWidth={rightCollapsed ? 0 : rightWidth}
              hasInspector={!!selectedPlace}
            />


            <div className="hidden md:block" style={{ position: 'absolute', left: 10, top: 10, bottom: 10, zIndex: 20 }}>
              <button onClick={() => setLeftCollapsed(c => !c)}
                style={{
                  position: leftCollapsed ? 'fixed' : 'absolute', top: leftCollapsed ? 'calc(var(--nav-h) + 44px + 14px)' : 14, left: leftCollapsed ? 10 : undefined, right: leftCollapsed ? undefined : -28, zIndex: -1,
                  width: 36, height: 36, borderRadius: leftCollapsed ? 10 : '0 10px 10px 0',
                  background: leftCollapsed ? '#000' : 'var(--sidebar-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: leftCollapsed ? '0 2px 12px rgba(0,0,0,0.2)' : 'none', border: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: leftCollapsed ? '#fff' : 'var(--text-faint)', transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!leftCollapsed) e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { if (!leftCollapsed) e.currentTarget.style.color = 'var(--text-faint)' }}>
                {leftCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>

              <div style={{
                width: leftCollapsed ? 0 : leftWidth, height: '100%',
                background: 'var(--sidebar-bg)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                boxShadow: leftCollapsed ? 'none' : 'var(--sidebar-shadow)',
                borderRadius: 16,
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
                transition: 'width 0.25s ease',
                opacity: leftCollapsed ? 0 : 1,
              }}>
                <DayPlanSidebar
                  tripId={tripId}
                  trip={trip}
                  days={days}
                  places={places}
                  categories={categories}
                  assignments={assignments}
                  selectedDayId={selectedDayId}
                  selectedPlaceId={selectedPlaceId}
                  selectedAssignmentId={selectedAssignmentId}
                  onSelectDay={handleSelectDay}
                  onPlaceClick={handlePlaceClick}
                  onReorder={handleReorder}
                  onUpdateDayTitle={handleUpdateDayTitle}
                  onAssignToDay={handleAssignToDay}
                  onRouteCalculated={(r) => { if (r) { setRoute(r.coordinates); setRouteInfo({ distance: r.distanceText, duration: r.durationText, walkingText: r.walkingText, drivingText: r.drivingText }) } else { setRoute(null); setRouteInfo(null) } }}
                  reservations={reservations}
                  onAddReservation={(dayId) => { setEditingReservation(null); tripStore.setSelectedDay(dayId); setShowReservationModal(true) }}
                  onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); selectAssignment(null) }}
                  onRemoveAssignment={handleRemoveAssignment}
                  onEditPlace={(place, assignmentId) => { setEditingPlace(place); setEditingAssignmentId(assignmentId || null); setShowPlaceForm(true) }}
                  onDeletePlace={(placeId) => handleDeletePlace(placeId)}
                  accommodations={tripAccommodations}
                  onNavigateToFiles={() => handleTabChange('dateien')}
                />
                {!leftCollapsed && (
                  <div
                    onMouseDown={startResizeLeft}
                    style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', background: 'transparent' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  />
                )}
              </div>
            </div>

            <div className="hidden md:block" style={{ position: 'absolute', right: 10, top: 10, bottom: 10, zIndex: 20 }}>
              <button onClick={() => setRightCollapsed(c => !c)}
                style={{
                  position: rightCollapsed ? 'fixed' : 'absolute', top: rightCollapsed ? 'calc(var(--nav-h) + 44px + 14px)' : 14, right: rightCollapsed ? 10 : undefined, left: rightCollapsed ? undefined : -28, zIndex: -1,
                  width: 36, height: 36, borderRadius: rightCollapsed ? 10 : '10px 0 0 10px',
                  background: rightCollapsed ? '#000' : 'var(--sidebar-bg)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  boxShadow: rightCollapsed ? '0 2px 12px rgba(0,0,0,0.2)' : 'none', border: 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: rightCollapsed ? '#fff' : 'var(--text-faint)', transition: 'color 0.15s',
                }}
                onMouseEnter={e => { if (!rightCollapsed) e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { if (!rightCollapsed) e.currentTarget.style.color = 'var(--text-faint)' }}>
                {rightCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
              </button>

              <div style={{
                width: rightCollapsed ? 0 : rightWidth, height: '100%',
                background: 'var(--sidebar-bg)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                boxShadow: rightCollapsed ? 'none' : 'var(--sidebar-shadow)',
                borderRadius: 16,
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
                transition: 'width 0.25s ease',
                opacity: rightCollapsed ? 0 : 1,
              }}>
                {!rightCollapsed && (
                  <div
                    onMouseDown={startResizeRight}
                    style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', background: 'transparent' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.08)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  />
                )}
                <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingLeft: 4 }}>
                  <PlacesSidebar
                    tripId={tripId}
                    places={places}
                    categories={categories}
                    assignments={assignments}
                    selectedDayId={selectedDayId}
                    selectedPlaceId={selectedPlaceId}
                    onPlaceClick={handlePlaceClick}
                    onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true) }}
                    onAssignToDay={handleAssignToDay}
                    onEditPlace={(place) => { setEditingPlace(place); setEditingAssignmentId(null); setShowPlaceForm(true) }}
                    onDeletePlace={(placeId) => handleDeletePlace(placeId)}
                    onCategoryFilterChange={setMapCategoryFilter}
                  />
                </div>
              </div>
            </div>

            {/* Mobile sidebar buttons — portal to body to escape Leaflet touch handling */}
            {activeTab === 'plan' && !mobileSidebarOpen && !showPlaceForm && !showMembersModal && !showReservationModal && ReactDOM.createPortal(
              <div className="flex md:hidden" style={{ position: 'fixed', top: 'calc(var(--nav-h) + 44px + 12px)', left: 12, right: 12, justifyContent: 'space-between', zIndex: 100, pointerEvents: 'none' }}>
                <button onClick={() => setMobileSidebarOpen('left')}
                  style={{ pointerEvents: 'auto', background: 'var(--bg-card)', color: 'var(--text-primary)', backdropFilter: 'blur(12px)', border: '1px solid var(--border-primary)', borderRadius: 24, padding: '11px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', minHeight: 44, fontFamily: 'inherit', touchAction: 'manipulation' }}>
                  {t('trip.mobilePlan')}
                </button>
                <button onClick={() => setMobileSidebarOpen('right')}
                  style={{ pointerEvents: 'auto', background: 'var(--bg-card)', color: 'var(--text-primary)', backdropFilter: 'blur(12px)', border: '1px solid var(--border-primary)', borderRadius: 24, padding: '11px 24px', fontSize: 15, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', minHeight: 44, fontFamily: 'inherit', touchAction: 'manipulation' }}>
                  {t('trip.mobilePlaces')}
                </button>
              </div>,
              document.body
            )}

            {showDayDetail && !selectedPlace && (() => {
              const currentDay = days.find(d => d.id === showDayDetail.id) || showDayDetail
              const dayAssignments = assignments[String(currentDay.id)] || []
              const geoPlace = dayAssignments.find(a => a.place?.lat && a.place?.lng)?.place || places.find(p => p.lat && p.lng)
              return (
                <DayDetailPanel
                  day={currentDay}
                  days={days}
                  places={places}
                  categories={categories}
                  tripId={tripId}
                  assignments={assignments}
                  reservations={reservations}
                  lat={geoPlace?.lat}
                  lng={geoPlace?.lng}
                  onClose={() => setShowDayDetail(null)}
                  onAccommodationChange={loadAccommodations}
                  leftWidth={isMobile ? 0 : (leftCollapsed ? 0 : leftWidth)}
                  rightWidth={isMobile ? 0 : (rightCollapsed ? 0 : rightWidth)}
                />
              )
            })()}

            {selectedPlace && (
              <PlaceInspector
                place={selectedPlace}
                categories={categories}
                days={days}
                selectedDayId={selectedDayId}
                selectedAssignmentId={selectedAssignmentId}
                assignments={assignments}
                reservations={reservations}
                onClose={() => setSelectedPlaceId(null)}
                onEdit={() => {
                  // When editing from assignment context, use assignment-level times
                  if (selectedAssignmentId) {
                    const assignmentObj = Object.values(assignments).flat().find(a => a.id === selectedAssignmentId)
                    const placeWithAssignmentTimes = assignmentObj?.place ? { ...selectedPlace, place_time: assignmentObj.place.place_time, end_time: assignmentObj.place.end_time } : selectedPlace
                    setEditingPlace(placeWithAssignmentTimes)
                  } else {
                    setEditingPlace(selectedPlace)
                  }
                  setEditingAssignmentId(selectedAssignmentId || null)
                  setShowPlaceForm(true)
                }}
                onDelete={() => handleDeletePlace(selectedPlace.id)}
                onAssignToDay={handleAssignToDay}
                onRemoveAssignment={handleRemoveAssignment}
                files={files}
                onFileUpload={(fd) => tripStore.addFile(tripId, fd)}
                tripMembers={tripMembers}
                onSetParticipants={async (assignmentId, dayId, userIds) => {
                  try {
                    const data = await assignmentsApi.setParticipants(tripId, assignmentId, userIds)
                    useTripStore.setState(state => ({
                      assignments: {
                        ...state.assignments,
                        [String(dayId)]: (state.assignments[String(dayId)] || []).map(a =>
                          a.id === assignmentId ? { ...a, participants: data.participants } : a
                        ),
                      }
                    }))
                  } catch {}
                }}
                onUpdatePlace={async (placeId, data) => { try { await tripStore.updatePlace(tripId, placeId, data) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : 'Unknown error') } }}
                leftWidth={leftCollapsed ? 0 : leftWidth}
                rightWidth={rightCollapsed ? 0 : rightWidth}
              />
            )}

            {mobileSidebarOpen && ReactDOM.createPortal(
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 9999 }} onClick={() => setMobileSidebarOpen(null)}>
                <div style={{ position: 'absolute', top: 'var(--nav-h)', left: 0, right: 0, bottom: 0, background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-secondary)' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{mobileSidebarOpen === 'left' ? t('trip.mobilePlan') : t('trip.mobilePlaces')}</span>
                    <button onClick={() => setMobileSidebarOpen(null)} style={{ background: 'var(--bg-tertiary)', border: 'none', borderRadius: '50%', width: 28, height: 28, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-primary)' }}>
                      <X size={14} />
                    </button>
                  </div>
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {mobileSidebarOpen === 'left'
                      ? <DayPlanSidebar tripId={tripId} trip={trip} days={days} places={places} categories={categories} assignments={assignments} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} selectedAssignmentId={selectedAssignmentId} onSelectDay={(id) => { handleSelectDay(id); setMobileSidebarOpen(null) }} onPlaceClick={handlePlaceClick} onReorder={handleReorder} onUpdateDayTitle={handleUpdateDayTitle} onAssignToDay={handleAssignToDay} onRouteCalculated={(r) => { if (r) { setRoute(r.coordinates); setRouteInfo({ distance: r.distanceText, duration: r.durationText }) } }} reservations={reservations} onAddReservation={(dayId) => { setEditingReservation(null); tripStore.setSelectedDay(dayId); setShowReservationModal(true); setMobileSidebarOpen(null) }} onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); setSelectedAssignmentId(null); setMobileSidebarOpen(null) }} accommodations={tripAccommodations} onNavigateToFiles={() => { setMobileSidebarOpen(null); handleTabChange('dateien') }} />
                      : <PlacesSidebar tripId={tripId} places={places} categories={categories} assignments={assignments} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} onPlaceClick={handlePlaceClick} onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onAssignToDay={handleAssignToDay} days={days} isMobile onCategoryFilterChange={setMapCategoryFilter} />
                    }
                  </div>
                </div>
              </div>,
              document.body
            )}
          </div>
        )}

        {activeTab === 'buchungen' && (
          <div style={{ height: '100%', maxWidth: 1200, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <ReservationsPanel
              tripId={tripId}
              reservations={reservations}
              days={days}
              assignments={assignments}
              files={files}
              onAdd={() => { setEditingReservation(null); setShowReservationModal(true) }}
              onEdit={(r) => { setEditingReservation(r); setShowReservationModal(true) }}
              onDelete={handleDeleteReservation}
              onNavigateToFiles={() => handleTabChange('dateien')}
            />
          </div>
        )}

        {activeTab === 'packliste' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', maxWidth: 1200, margin: '0 auto', width: '100%', padding: '8px 0' }}>
            <PackingListPanel tripId={tripId} items={packingItems} />
          </div>
        )}

        {activeTab === 'finanzplan' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', maxWidth: 1800, margin: '0 auto', width: '100%', padding: '8px 0' }}>
            <BudgetPanel tripId={tripId} tripMembers={tripMembers} />
          </div>
        )}

        {activeTab === 'dateien' && (
          <div style={{ height: '100%', overflow: 'hidden', overscrollBehavior: 'contain' }}>
            <FileManager
              files={files || []}
              onUpload={(fd) => tripStore.addFile(tripId, fd)}
              onDelete={(id) => tripStore.deleteFile(tripId, id)}
              onUpdate={(id, data) => tripStore.loadFiles(tripId)}
              places={places}
              days={days}
              assignments={assignments}
              reservations={reservations}
              tripId={tripId}
              allowedFileTypes={allowedFileTypes}
            />
          </div>
        )}

        {activeTab === 'memories' && (
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            <MemoriesPanel tripId={Number(tripId)} startDate={trip?.start_date || null} endDate={trip?.end_date || null} />
          </div>
        )}

        {activeTab === 'collab' && (
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            <CollabPanel tripId={tripId} tripMembers={tripMembers} />
          </div>
        )}
      </div>

      <PlaceFormModal isOpen={showPlaceForm} onClose={() => { setShowPlaceForm(false); setEditingPlace(null); setEditingAssignmentId(null); setPrefillCoords(null) }} onSave={handleSavePlace} place={editingPlace} prefillCoords={prefillCoords} assignmentId={editingAssignmentId} dayAssignments={editingAssignmentId ? Object.values(assignments).flat() : []} tripId={tripId} categories={categories} onCategoryCreated={cat => tripStore.addCategory?.(cat)} />
      <TripFormModal isOpen={showTripForm} onClose={() => setShowTripForm(false)} onSave={async (data) => { await tripStore.updateTrip(tripId, data); toast.success(t('trip.toast.tripUpdated')) }} trip={trip} />
      <TripMembersModal isOpen={showMembersModal} onClose={() => setShowMembersModal(false)} tripId={tripId} tripTitle={trip?.title} />
      <ReservationModal isOpen={showReservationModal} onClose={() => { setShowReservationModal(false); setEditingReservation(null) }} onSave={handleSaveReservation} reservation={editingReservation} days={days} places={places} assignments={assignments} selectedDayId={selectedDayId} files={files} onFileUpload={(fd) => tripStore.addFile(tripId, fd)} onFileDelete={(id) => tripStore.deleteFile(tripId, id)} accommodations={tripAccommodations} />
      <ConfirmDialog
        isOpen={!!deletePlaceId}
        onClose={() => setDeletePlaceId(null)}
        onConfirm={confirmDeletePlace}
        title={t('common.delete')}
        message={t('trip.confirm.deletePlace')}
      />
    </div>
  )
}
