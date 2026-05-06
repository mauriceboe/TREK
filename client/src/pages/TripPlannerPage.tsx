import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import ReactDOM from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useTripStore } from '../store/tripStore'
import { useCanDo } from '../store/permissionsStore'
import { useSettingsStore } from '../store/settingsStore'
import { MapViewAuto as MapView } from '../components/Map/MapViewAuto'
import { getCached, fetchPhoto } from '../services/photoService'
import DayPlanSidebar from '../components/Planner/DayPlanSidebar'
import PlacesSidebar from '../components/Planner/PlacesSidebar'
import PlaceInspector from '../components/Planner/PlaceInspector'
import DayDetailPanel from '../components/Planner/DayDetailPanel'
import PlaceFormModal from '../components/Planner/PlaceFormModal'
import TripFormModal from '../components/Trips/TripFormModal'
import SlidingTabs from '../components/shared/SlidingTabs'
import TripMembersModal from '../components/Trips/TripMembersModal'
import { ReservationModal } from '../components/Planner/ReservationModal'
import { TransportModal } from '../components/Planner/TransportModal'
// MemoriesPanel moved to Journey addon
import ReservationsPanel from '../components/Planner/ReservationsPanel'
import PackingListPanel from '../components/Packing/PackingListPanel'
import ApplyTemplateButton from '../components/Packing/ApplyTemplateButton'
import TodoListPanel from '../components/Todo/TodoListPanel'
import FileManager from '../components/Files/FileManager'
import BudgetPanel from '../components/Budget/BudgetPanel'
import CollabPanel from '../components/Collab/CollabPanel'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { Map, X, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Ticket, PackageCheck, Wallet, FolderOpen, Users, Train } from 'lucide-react'
import { useTranslation } from '../i18n'
import { addonsApi, accommodationsApi, authApi, tripsApi, assignmentsApi, mapsApi } from '../api/client'
import { accommodationRepo } from '../repo/accommodationRepo'
import { offlineDb } from '../db/offlineDb'
import { useAuthStore } from '../store/authStore'
import ConfirmDialog from '../components/shared/ConfirmDialog'
import { useResizablePanels } from '../hooks/useResizablePanels'
import { useTripWebSocket } from '../hooks/useTripWebSocket'
import { useRouteCalculation } from '../hooks/useRouteCalculation'
import { usePlaceSelection } from '../hooks/usePlaceSelection'
import { usePlannerHistory } from '../hooks/usePlannerHistory'
import type { Accommodation, TripMember, Day, Place, Reservation, PackingItem, TodoItem } from '../types'
import { ListTodo, Upload, Plus, Trash2, FolderPlus } from 'lucide-react'

function ListsContainer({ tripId, packingItems, todoItems }: { tripId: number; packingItems: PackingItem[]; todoItems: TodoItem[] }) {
  const [subTab, setSubTab] = useState<'packing' | 'todo'>(() => {
    return (sessionStorage.getItem(`trip-lists-subtab-${tripId}`) as 'packing' | 'todo') || 'packing'
  })
  const setSubTabPersist = (tab: 'packing' | 'todo') => { setSubTab(tab); sessionStorage.setItem(`trip-lists-subtab-${tripId}`, tab) }
  const [importPackingSignal, setImportPackingSignal] = useState(0)
  const [clearCheckedSignal, setClearCheckedSignal] = useState(0)
  const [saveTemplateSignal, setSaveTemplateSignal] = useState(0)
  const [addTodoSignal, setAddTodoSignal] = useState(0)
  const { t } = useTranslation()

  const tabs = [
    { id: 'packing' as const, label: t('todo.subtab.packing'), icon: PackageCheck, count: packingItems.length },
    { id: 'todo' as const, label: t('todo.subtab.todo'), icon: ListTodo, count: todoItems.length },
  ]

  return (
    <div>
      <div style={{ padding: '24px 28px 0' }} className="max-md:!px-4 max-md:!pt-4">
        <div style={{
          background: 'var(--bg-tertiary)', borderRadius: 18,
          padding: '14px 16px 14px 22px',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', flexShrink: 0 }}>
            {t('trip.tabs.lists')}
          </h2>
          <div className="hidden md:block" style={{ width: 1, height: 22, background: 'var(--border-faint)', flexShrink: 0 }} />
          <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {tabs.map(tab => {
              const active = subTab === tab.id
              const Icon = tab.icon
              return (
                <button key={tab.id} onClick={() => setSubTabPersist(tab.id)}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 99, fontSize: 13, whiteSpace: 'nowrap',
                    background: active ? 'var(--bg-card)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: active ? 500 : 400,
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    transition: 'background 180ms cubic-bezier(0.23,1,0.32,1), color 180ms cubic-bezier(0.23,1,0.32,1), box-shadow 180ms cubic-bezier(0.23,1,0.32,1)',
                  }}
                >
                  <Icon size={13} style={{ color: active ? 'var(--text-primary)' : 'var(--text-faint)' }} />
                  <span className="hidden sm:inline">{tab.label}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    background: active ? 'var(--bg-tertiary)' : 'rgba(0,0,0,0.06)',
                    color: 'var(--text-faint)',
                    padding: '1px 6px', borderRadius: 99, minWidth: 16, textAlign: 'center',
                  }}>{tab.count}</span>
                </button>
              )
            })}
          </div>

          {subTab === 'packing' && (() => {
            const packingAbgehakt = packingItems.filter(i => i.checked).length
            const sharedBtnClass = 'inline-flex items-center gap-1.5 px-2.5 sm:px-[14px] py-[7px] sm:py-[9px] hover:opacity-[0.88]'
            const sharedBtnStyle: React.CSSProperties = {
              appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              borderRadius: 10, fontSize: 13, fontWeight: 500,
            }
            return (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {packingAbgehakt > 0 && (
                  <button onClick={() => setClearCheckedSignal(s => s + 1)}
                    className={`hidden sm:inline-flex items-center gap-1.5 px-[14px] py-[9px] hover:opacity-[0.88]`}
                    style={{ ...sharedBtnStyle, background: 'rgba(239,68,68,0.14)', color: '#ef4444' }}
                  >
                    <Trash2 size={14} strokeWidth={2.5} />
                    <span>{t('packing.clearChecked', { count: packingAbgehakt })}</span>
                  </button>
                )}
                <ApplyTemplateButton
                  tripId={tripId}
                  className={sharedBtnClass}
                  style={{ ...sharedBtnStyle, background: 'var(--accent)', color: 'var(--accent-text)' }}
                />
                {packingItems.length > 0 && (
                  <button onClick={() => setSaveTemplateSignal(s => s + 1)}
                    className={sharedBtnClass}
                    style={{ ...sharedBtnStyle, background: 'var(--accent)', color: 'var(--accent-text)' }}
                  >
                    <FolderPlus size={14} strokeWidth={2.5} />
                    <span className="hidden sm:inline">{t('packing.saveAsTemplate')}</span>
                  </button>
                )}
                <button onClick={() => setImportPackingSignal(s => s + 1)}
                  className={sharedBtnClass}
                  style={{ ...sharedBtnStyle, background: 'var(--accent)', color: 'var(--accent-text)' }}
                >
                  <Upload size={14} strokeWidth={2.5} />
                  <span className="hidden sm:inline">{t('packing.import')}</span>
                </button>
              </div>
            )
          })()}
          {subTab === 'todo' && (
            <button onClick={() => setAddTodoSignal(s => s + 1)}
              className="hover:opacity-[0.88]"
              style={{
                appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
                marginLeft: 'auto',
              }}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span className="hidden sm:inline">{t('todo.addItem')}</span>
            </button>
          )}
        </div>
      </div>
      <div style={{ padding: '16px 28px 0' }} className="max-md:!px-4">
        {subTab === 'packing' && <PackingListPanel tripId={tripId} items={packingItems} openImportSignal={importPackingSignal} clearCheckedSignal={clearCheckedSignal} saveTemplateSignal={saveTemplateSignal} inlineHeader={false} />}
        {subTab === 'todo' && <TodoListPanel tripId={tripId} items={todoItems} addItemSignal={addTodoSignal} />}
      </div>
    </div>
  )
}

export default function TripPlannerPage(): React.ReactElement | null {
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const { t, language } = useTranslation()
  const { settings } = useSettingsStore()
  const placesPhotosEnabled = useAuthStore(s => s.placesPhotosEnabled)
  const trip = useTripStore(s => s.trip)
  const days = useTripStore(s => s.days)
  const places = useTripStore(s => s.places)
  const assignments = useTripStore(s => s.assignments)
  const packingItems = useTripStore(s => s.packingItems)
  const todoItems = useTripStore(s => s.todoItems)
  const categories = useTripStore(s => s.categories)
  const reservations = useTripStore(s => s.reservations)
  const budgetItems = useTripStore(s => s.budgetItems)
  const files = useTripStore(s => s.files)
  const selectedDayId = useTripStore(s => s.selectedDayId)
  const isLoading = useTripStore(s => s.isLoading)
  // Actions — stable references, don't cause re-renders
  const tripActions = useRef(useTripStore.getState()).current
  const can = useCanDo()
  const canUploadFiles = can('file_upload', trip)
  const { pushUndo, undo, canUndo, lastActionLabel } = usePlannerHistory()

  const handleUndo = useCallback(async () => {
    const label = lastActionLabel
    await undo()
    toast.info(t('undo.done', { action: label ?? '' }))
  }, [undo, lastActionLabel, toast])

  const [enabledAddons, setEnabledAddons] = useState<Record<string, boolean>>({ packing: true, budget: true, documents: true, collab: false })
  const [collabFeatures, setCollabFeatures] = useState<{ chat: boolean; notes: boolean; polls: boolean; whatsnext: boolean }>({ chat: true, notes: true, polls: true, whatsnext: true })
  const [tripAccommodations, setTripAccommodations] = useState<Accommodation[]>([])
  const [allowedFileTypes, setAllowedFileTypes] = useState<string | null>(null)
  const [tripMembers, setTripMembers] = useState<TripMember[]>([])

  const loadAccommodations = useCallback(() => {
    if (tripId) {
      accommodationRepo.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
      tripActions.loadReservations(tripId)
    }
  }, [tripId])

  useEffect(() => {
    addonsApi.enabled().then(data => {
      const map = {}
      data.addons.forEach(a => { map[a.id] = true })
      setEnabledAddons({ packing: !!map.packing, budget: !!map.budget, documents: !!map.documents, collab: !!map.collab })
      if (data.collabFeatures) setCollabFeatures(data.collabFeatures)
    }).catch(() => {})
    authApi.getAppConfig().then(config => {
      if (config.allowed_file_types) setAllowedFileTypes(config.allowed_file_types)
    }).catch(() => {})
  }, [])

  const TRANSPORT_TYPES = new Set(['flight', 'train', 'car', 'cruise', 'bus'])

  const TRIP_TABS = [
    { id: 'plan', label: t('trip.tabs.plan'), icon: Map },
    { id: 'transports', label: t('trip.tabs.transports'), icon: Train },
    { id: 'buchungen', label: t('trip.tabs.reservations'), shortLabel: t('trip.tabs.reservationsShort'), icon: Ticket },
    ...(enabledAddons.packing ? [{ id: 'listen', label: t('trip.tabs.lists'), shortLabel: t('trip.tabs.listsShort'), icon: PackageCheck }] : []),
    ...(enabledAddons.budget ? [{ id: 'finanzplan', label: t('trip.tabs.budget'), icon: Wallet }] : []),
    ...(enabledAddons.documents ? [{ id: 'dateien', label: t('trip.tabs.files'), icon: FolderOpen }] : []),
    ...(enabledAddons.collab ? [{ id: 'collab', label: t('admin.addons.catalog.collab.name'), icon: Users }] : []),
  ]

  const [activeTab, setActiveTab] = useState<string>(() => {
    const saved = sessionStorage.getItem(`trip-tab-${tripId}`)
    return saved || 'plan'
  })

  useEffect(() => {
    const validTabIds = TRIP_TABS.map(t => t.id)
    if (!validTabIds.includes(activeTab)) {
      setActiveTab('plan')
      sessionStorage.setItem(`trip-tab-${tripId}`, 'plan')
    }
  }, [enabledAddons])

  const handleTabChange = (tabId: string): void => {
    setActiveTab(tabId)
    sessionStorage.setItem(`trip-tab-${tripId}`, tabId)
    if (tabId === 'finanzplan') tripActions.loadBudgetItems?.(tripId)
    if (tabId === 'dateien' && (!files || files.length === 0)) tripActions.loadFiles?.(tripId)
  }
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed, startResizeLeft, startResizeRight } = useResizablePanels()
  const { selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment } = usePlaceSelection()
  const [showDayDetail, setShowDayDetail] = useState<Day | null>(null)
  const [dayDetailCollapsed, setDayDetailCollapsed] = useState(false)
  const [showPlaceForm, setShowPlaceForm] = useState<boolean>(false)
  const [editingPlace, setEditingPlace] = useState<Place | null>(null)
  const [prefillCoords, setPrefillCoords] = useState<{ lat: number; lng: number; name?: string; address?: string } | null>(null)
  const [editingAssignmentId, setEditingAssignmentId] = useState<number | null>(null)
  const [showTripForm, setShowTripForm] = useState<boolean>(false)
  const [showMembersModal, setShowMembersModal] = useState<boolean>(false)
  const [showReservationModal, setShowReservationModal] = useState<boolean>(false)
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null)
  const [bookingForAssignmentId, setBookingForAssignmentId] = useState<number | null>(null)
  const [showTransportModal, setShowTransportModal] = useState<boolean>(false)
  const [editingTransport, setEditingTransport] = useState<Reservation | null>(null)
  const [transportModalDayId, setTransportModalDayId] = useState<number | null>(null)
  const [fitKey, setFitKey] = useState<number>(0)
  const initialFitTripId = useRef<number | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<'left' | 'right' | null>(null)
  const mobilePlanScrollTopRef = useRef<number>(0)
  const mobilePlacesScrollTopRef = useRef<number>(0)
  const [deletePlaceId, setDeletePlaceId] = useState<number | null>(null)
  const [deletePlaceIds, setDeletePlaceIds] = useState<number[] | null>(null)

  useEffect(() => {
    if (!trip) return
    if (initialFitTripId.current === trip.id) return
    const hasGeoPlaces = places.some(p => p.lat != null && p.lng != null)
    if (!hasGeoPlaces) return
    initialFitTripId.current = trip.id
    setFitKey(k => k + 1)
  }, [trip, places])

  const connectionsStorageKey = tripId ? `trek:visible-connections:${tripId}` : null
  const [visibleConnections, setVisibleConnections] = useState<number[]>(() => {
    if (typeof window === 'undefined' || !connectionsStorageKey) return []
    try {
      const stored = window.localStorage.getItem(connectionsStorageKey)
      return stored ? JSON.parse(stored) as number[] : []
    } catch { return [] }
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !connectionsStorageKey) return
    window.localStorage.setItem(connectionsStorageKey, JSON.stringify(visibleConnections))
  }, [connectionsStorageKey, visibleConnections])
  const toggleConnection = useCallback((id: number) => {
    setVisibleConnections(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }, [])
  const [mapTransportDetail, setMapTransportDetail] = useState<Reservation | null>(null)

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Start photo fetches during splash screen so images are ready when map mounts
  useEffect(() => {
    if (isLoading || !places || places.length === 0 || !placesPhotosEnabled) return
    for (const p of places) {
      if (p.image_url) continue
      const cacheKey = p.google_place_id || p.osm_id || `${p.lat},${p.lng}`
      if (!cacheKey || getCached(cacheKey)) continue
      const photoId = p.google_place_id || p.osm_id
      if (photoId || (p.lat && p.lng)) {
        fetchPhoto(cacheKey, photoId || `coords:${p.lat}:${p.lng}`, p.lat, p.lng, p.name)
      }
    }
  }, [isLoading, places])

  // Load trip + files (needed for place inspector file section)
  useEffect(() => {
    if (tripId) {
      tripActions.loadTrip(tripId).catch(() => { toast.error(t('trip.toast.loadError')); navigate('/dashboard') })
      tripActions.loadFiles(tripId)
      loadAccommodations()
      if (!navigator.onLine) {
        offlineDb.tripMembers.where('tripId').equals(Number(tripId)).toArray()
          .then(rows => setTripMembers(rows))
          .catch(() => {})
      } else {
        tripsApi.getMembers(tripId).then(d => {
          const all = [d.owner, ...(d.members || [])].filter(Boolean)
          setTripMembers(all)
        }).catch(() => {})
      }
    }
  }, [tripId])

  useEffect(() => {
    if (tripId) {
      tripActions.loadReservations(tripId)
      tripActions.loadBudgetItems?.(tripId)
    }
  }, [tripId])

  useTripWebSocket(tripId)

  const [mapCategoryFilter, setMapCategoryFilter] = useState<Set<string>>(new Set())
  const [mapPlacesFilter, setMapPlacesFilter] = useState<string>('all')

  const [expandedDayIds, setExpandedDayIds] = useState<Set<number> | null>(null)

  const mapPlaces = useMemo(() => {
    // Build set of place IDs assigned to collapsed days
    const hiddenPlaceIds = new Set<number>()
    if (expandedDayIds) {
      for (const [dayId, dayAssignments] of Object.entries(assignments)) {
        if (!expandedDayIds.has(Number(dayId))) {
          for (const a of dayAssignments) {
            if (a.place?.id) hiddenPlaceIds.add(a.place.id)
          }
        }
      }
      // Don't hide places that are also assigned to an expanded day
      for (const [dayId, dayAssignments] of Object.entries(assignments)) {
        if (expandedDayIds.has(Number(dayId))) {
          for (const a of dayAssignments) {
            hiddenPlaceIds.delete(a.place?.id)
          }
        }
      }
    }

    // Build set of planned place IDs for unplanned filter
    const plannedIds = mapPlacesFilter === 'unplanned'
      ? new Set(Object.values(assignments).flatMap(da => da.map(a => a.place?.id).filter(Boolean)))
      : null

    return places.filter(p => {
      if (!p.lat || !p.lng) return false
      if (mapPlacesFilter === 'tracks' && !p.route_geometry) return false
      if (mapCategoryFilter.size > 0) {
        if (p.category_id == null) {
          if (!mapCategoryFilter.has('uncategorized')) return false
        } else if (!mapCategoryFilter.has(String(p.category_id))) return false
      }
      if (hiddenPlaceIds.has(p.id)) return false
      if (plannedIds && plannedIds.has(p.id)) return false
      return true
    })
  }, [places, mapCategoryFilter, mapPlacesFilter, assignments, expandedDayIds])

  const { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay } = useRouteCalculation({ assignments } as any, selectedDayId)

  const handleSelectDay = useCallback((dayId, skipFit) => {
    const changed = dayId !== selectedDayId
    tripActions.setSelectedDay(dayId)
    if (changed && !skipFit) setFitKey(k => k + 1)
    setMobileSidebarOpen(null)
    updateRouteForDay(dayId)
  }, [updateRouteForDay, selectedDayId])

  const handlePlaceClick = useCallback((placeId, assignmentId) => {
    if (assignmentId) {
      selectAssignment(assignmentId, placeId)
    } else {
      setSelectedPlaceId(placeId)
    }
    if (placeId) { setShowDayDetail(null); setLeftCollapsed(false); setRightCollapsed(false) }
  }, [selectAssignment, setSelectedPlaceId])

  const handleMarkerClick = useCallback((placeId) => {
    if (placeId === undefined) {
      setSelectedPlaceId(null)
      return
    }
    // Find every assignment for this place (same place can sit on several
    // days / be planned twice in one day). Cycle through them on repeated
    // marker clicks so the sidebar highlight jumps to the next occurrence
    // instead of leaving the user confused.
    const allAssignments = Object.values(useTripStore.getState().assignments || {}).flat()
    const matching = allAssignments.filter(a => a?.place?.id === placeId)

    if (matching.length === 0) {
      setSelectedPlaceId(prev => prev === placeId ? null : placeId)
    } else if (matching.length === 1) {
      const only = matching[0]
      if (selectedAssignmentId === only.id) {
        setSelectedPlaceId(null)
      } else {
        selectAssignment(only.id, placeId)
      }
    } else {
      const currentIdx = matching.findIndex(a => a.id === selectedAssignmentId)
      const nextIdx = currentIdx === -1 ? 0 : currentIdx + 1
      if (nextIdx >= matching.length) {
        // cycled past the last occurrence — clear selection so the next
        // click starts fresh at occurrence 0.
        setSelectedPlaceId(null)
      } else {
        selectAssignment(matching[nextIdx].id, placeId)
      }
    }
    setLeftCollapsed(false); setRightCollapsed(false)
  }, [selectAssignment, selectedAssignmentId, setSelectedPlaceId])

  const handleMapClick = useCallback(() => {
    setSelectedPlaceId(null)
  }, [])

  const handleMapContextMenu = useCallback(async (e) => {
    if (!can('place_edit', trip)) return
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
      await tripActions.updatePlace(tripId, editingPlace.id, placeData)
      // If editing from assignment context, save time per-assignment
      if (editingAssignmentId) {
        await assignmentsApi.updateTime(tripId, editingAssignmentId, { place_time: place_time || null, end_time: end_time || null })
        await tripActions.refreshDays(tripId)
      }
      // Upload pending files with place_id
      if (pendingFiles?.length > 0) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('place_id', editingPlace.id)
          try { await tripActions.addFile(tripId, fd) } catch {}
        }
      }
      toast.success(t('trip.toast.placeUpdated'))
    } else {
      const place = await tripActions.addPlace(tripId, data)
      if (pendingFiles?.length > 0 && place?.id) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('place_id', place.id)
          try { await tripActions.addFile(tripId, fd) } catch {}
        }
      }
      toast.success(t('trip.toast.placeAdded'))
      if (place?.id) {
        const capturedId = place.id
        pushUndo(t('undo.addPlace'), async () => {
          await tripActions.deletePlace(tripId, capturedId)
        })
      }
    }
  }, [editingPlace, editingAssignmentId, tripId, toast, pushUndo])

  const handleDeletePlace = useCallback((placeId) => {
    setDeletePlaceId(placeId)
  }, [])

  const confirmDeletePlace = useCallback(async () => {
    if (!deletePlaceId) return
    const state = useTripStore.getState()
    const capturedPlace = state.places.find(p => p.id === deletePlaceId)
    const capturedAssignments = Object.entries(state.assignments).flatMap(([dayId, as]) =>
      as.filter(a => a.place?.id === deletePlaceId).map(a => ({ dayId: Number(dayId), orderIndex: a.order_index }))
    )
    try {
      await tripActions.deletePlace(tripId, deletePlaceId)
      if (selectedPlaceId === deletePlaceId) setSelectedPlaceId(null)
      updateRouteForDay(selectedDayId)
      toast.success(t('trip.toast.placeDeleted'))
      if (capturedPlace) {
        pushUndo(t('undo.deletePlace'), async () => {
          const newPlace = await tripActions.addPlace(tripId, {
            name: capturedPlace.name,
            description: capturedPlace.description,
            lat: capturedPlace.lat,
            lng: capturedPlace.lng,
            address: capturedPlace.address,
            category_id: capturedPlace.category_id,
            icon: capturedPlace.icon,
            price: capturedPlace.price,
          })
          for (const { dayId, orderIndex } of capturedAssignments) {
            await tripActions.assignPlaceToDay(tripId, dayId, newPlace.id, orderIndex)
          }
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [deletePlaceId, tripId, toast, selectedPlaceId, selectedDayId, updateRouteForDay, pushUndo])

  const confirmDeletePlaces = useCallback(async (ids?: number[]) => {
    const targetIds = ids ?? deletePlaceIds
    if (!targetIds?.length) return
    const state = useTripStore.getState()
    const capturedPlaces = state.places.filter(p => targetIds.includes(p.id))
    const capturedAssignments = Object.entries(state.assignments).flatMap(([dayId, as]) =>
      as.filter(a => a.place?.id != null && targetIds.includes(a.place.id)).map(a => ({ dayId: Number(dayId), placeId: a.place!.id, orderIndex: a.order_index }))
    )
    try {
      await tripActions.deletePlacesMany(tripId, targetIds)
      if (selectedPlaceId != null && targetIds.includes(selectedPlaceId)) setSelectedPlaceId(null)
      if (!ids) setDeletePlaceIds(null)
      updateRouteForDay(selectedDayId)
      toast.success(t('trip.toast.placesDeleted', { count: capturedPlaces.length }))
      if (capturedPlaces.length > 0) {
        pushUndo(t('undo.deletePlaces'), async () => {
          for (const place of capturedPlaces) {
            const newPlace = await tripActions.addPlace(tripId, {
              name: place.name, description: place.description,
              lat: place.lat, lng: place.lng, address: place.address,
              category_id: place.category_id, icon: place.icon, price: place.price,
            })
            for (const a of capturedAssignments.filter(x => x.placeId === place.id)) {
              await tripActions.assignPlaceToDay(tripId, a.dayId, newPlace.id, a.orderIndex)
            }
          }
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [deletePlaceIds, tripId, toast, selectedPlaceId, selectedDayId, updateRouteForDay, pushUndo])

  const handleAssignToDay = useCallback(async (placeId, dayId, position) => {
    const target = dayId || selectedDayId
    if (!target) { toast.error(t('trip.toast.selectDay')); return }
    try {
      const assignment = await tripActions.assignPlaceToDay(tripId, target, placeId, position)
      toast.success(t('trip.toast.assignedToDay'))
      updateRouteForDay(target)
      if (assignment?.id) {
        const capturedAssignmentId = assignment.id
        const capturedTarget = target
        pushUndo(t('undo.assignPlace'), async () => {
          await tripActions.removeAssignment(tripId, capturedTarget, capturedAssignmentId)
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [selectedDayId, tripId, toast, updateRouteForDay, pushUndo])

  const handleRemoveAssignment = useCallback(async (dayId, assignmentId) => {
    const state = useTripStore.getState()
    const capturedAssignment = (state.assignments[String(dayId)] || []).find(a => a.id === assignmentId)
    const capturedPlaceId = capturedAssignment?.place?.id
    const capturedOrderIndex = capturedAssignment?.order_index ?? 0
    try {
      await tripActions.removeAssignment(tripId, dayId, assignmentId)
      updateRouteForDay(dayId)
      if (capturedPlaceId != null) {
        const capturedDayId = dayId
        const capturedPos = capturedOrderIndex
        pushUndo(t('undo.removeAssignment'), async () => {
          await tripActions.assignPlaceToDay(tripId, capturedDayId, capturedPlaceId, capturedPos)
        })
      }
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [tripId, toast, updateRouteForDay, pushUndo])

  const handleReorder = useCallback((dayId, orderedIds) => {
    const prevIds = (useTripStore.getState().assignments[String(dayId)] || [])
      .slice().sort((a, b) => a.order_index - b.order_index).map(a => a.id)
    try {
      tripActions.reorderAssignments(tripId, dayId, orderedIds)
        .then(() => {
          const capturedDayId = dayId
          const capturedPrevIds = prevIds
          pushUndo(t('undo.reorder'), async () => {
            await tripActions.reorderAssignments(tripId, capturedDayId, capturedPrevIds)
          })
        })
        .catch(err => toast.error(err instanceof Error ? err.message : t('trip.toast.reorderError')))
      updateRouteForDay(dayId)
    }
    catch { toast.error(t('trip.toast.reorderError')) }
  }, [tripId, toast, pushUndo, updateRouteForDay])

  const handleUpdateDayTitle = useCallback(async (dayId, title) => {
    try { await tripActions.updateDayTitle(tripId, dayId, title) }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [tripId, toast])

  const handleSaveReservation = async (data) => {
    try {
      if (editingReservation) {
        const r = await tripActions.updateReservation(tripId, editingReservation.id, { ...data, day_id: selectedDayId || null })
        toast.success(t('trip.toast.reservationUpdated'))
        setShowReservationModal(false)
        setEditingReservation(null)
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      } else {
        const r = await tripActions.addReservation(tripId, { ...data, day_id: selectedDayId || null })
        toast.success(t('trip.toast.reservationAdded'))
        setShowReservationModal(false)
        // Refresh accommodations if hotel was created
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }

  const handleSaveTransport = async (data) => {
    try {
      if (editingTransport) {
        const r = await tripActions.updateReservation(tripId, editingTransport.id, data)
        toast.success(t('trip.toast.reservationUpdated'))
        setShowTransportModal(false)
        setEditingTransport(null)
        setTransportModalDayId(null)
        return r
      } else {
        const r = await tripActions.addReservation(tripId, data)
        toast.success(t('trip.toast.reservationAdded'))
        setShowTransportModal(false)
        setEditingTransport(null)
        setTransportModalDayId(null)
        return r
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }

  const handleDeleteReservation = async (id) => {
    try {
      await tripActions.deleteReservation(tripId, id)
      toast.success(t('trip.toast.deleted'))
      // Refresh accommodations in case a hotel booking was deleted
      accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
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

  // Splash screen — show for initial load + a brief moment for photos to start loading
  const [splashDone, setSplashDone] = useState(false)
  useEffect(() => {
    if (!isLoading && trip) {
      const timer = setTimeout(() => setSplashDone(true), 1500)
      return () => clearTimeout(timer)
    }
  }, [isLoading, trip])

  if (isLoading || !splashDone) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)', ...fontStyle,
      }}>
        <style>{`
          @keyframes dotPulse {
            0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1); }
          }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
        <div style={{ marginBottom: 28 }}>
          <img
            src={document.documentElement.classList.contains('dark') ? '/icons/trek-loading-light.gif' : '/icons/trek-loading-dark.gif'}
            alt="Loading"
            width={64}
            height={64}
          />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.3px', marginBottom: 6, animation: 'fadeInUp 0.5s ease-out' }}>
          {trip?.title || 'TREK'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 500, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 32, animation: 'fadeInUp 0.5s ease-out 0.1s both' }}>
          {t('trip.loadingPhotos')}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)',
              animation: `dotPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
            }} />
          ))}
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
      }}>
        <SlidingTabs
          tabs={TRIP_TABS.map(tab => ({
            id: tab.id,
            label: <span className="hidden sm:inline">{tab.shortLabel || tab.label}</span>,
            title: tab.label,
            icon: tab.icon,
          }))}
          activeTab={activeTab}
          onChange={handleTabChange}
        />
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
              hasDayDetail={!!showDayDetail && !selectedPlace}
              reservations={reservations}
              showReservationStats={settings.route_calculation !== false}
              visibleConnectionIds={visibleConnections}
              onReservationClick={(rid) => {
                const r = reservations.find(x => x.id === rid)
                if (r) setMapTransportDetail(r)
              }}
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
                  onRouteCalculated={(r) => { if (r) { setRoute([r.coordinates]); setRouteInfo({ distance: r.distanceText, duration: r.durationText, walkingText: r.walkingText, drivingText: r.drivingText }) } else { setRoute(null); setRouteInfo(null) } }}
                  reservations={reservations}
                  visibleConnectionIds={visibleConnections}
                  onToggleConnection={toggleConnection}
                  externalTransportDetail={mapTransportDetail}
                  onExternalTransportDetailHandled={() => setMapTransportDetail(null)}
                  onAddReservation={(dayId) => { setEditingReservation(null); tripActions.setSelectedDay(dayId); setShowReservationModal(true) }}
                  onAddTransport={can('day_edit', trip) ? (dayId) => { setTransportModalDayId(dayId); setEditingTransport(null); setShowTransportModal(true) } : undefined}
                  onEditTransport={can('day_edit', trip) ? (reservation) => { setEditingTransport(reservation); setTransportModalDayId(reservation.day_id ?? null); setShowTransportModal(true) } : undefined}
                  onEditReservation={can('reservation_edit', trip) ? (r) => { setEditingReservation(r); setShowReservationModal(true) } : undefined}
                  onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); selectAssignment(null) }}
                  onRemoveAssignment={handleRemoveAssignment}
                  onEditPlace={(place, assignmentId) => { setEditingPlace(place); setEditingAssignmentId(assignmentId || null); setShowPlaceForm(true) }}
                  onDeletePlace={(placeId) => handleDeletePlace(placeId)}
                  accommodations={tripAccommodations}
                  onNavigateToFiles={() => handleTabChange('dateien')}
                  onExpandedDaysChange={setExpandedDayIds}
                  pushUndo={pushUndo}
                  canUndo={canUndo}
                  lastActionLabel={lastActionLabel}
                  onUndo={handleUndo}
                  onRouteRefresh={() => { if (selectedDayId) updateRouteForDay(selectedDayId) }}
                  onAddBookingToAssignment={can('day_edit', trip) ? (dayId, assignmentId) => { tripActions.setSelectedDay(dayId); setBookingForAssignmentId(assignmentId); setEditingReservation(null); setShowReservationModal(true) } : undefined}
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
                    onBulkDeletePlaces={(ids) => setDeletePlaceIds(ids)}
                    onCategoryFilterChange={setMapCategoryFilter}
                    onPlacesFilterChange={setMapPlacesFilter}
                    pushUndo={pushUndo}
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
                  onClose={() => { setShowDayDetail(null); handleSelectDay(null) }}
                  onAccommodationChange={loadAccommodations}
                  leftWidth={isMobile ? 0 : (leftCollapsed ? 0 : leftWidth)}
                  rightWidth={isMobile ? 0 : (rightCollapsed ? 0 : rightWidth)}
                  collapsed={dayDetailCollapsed}
                  onToggleCollapse={() => setDayDetailCollapsed(c => !c)}
                />
              )
            })()}

            {selectedPlace && !isMobile && (
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
                onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined}
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
                onUpdatePlace={async (placeId, data) => { try { await tripActions.updatePlace(tripId, placeId, data) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                leftWidth={(isMobile || window.innerWidth < 900) ? 0 : (leftCollapsed ? 0 : leftWidth)}
                rightWidth={(isMobile || window.innerWidth < 900) ? 0 : (rightCollapsed ? 0 : rightWidth)}
              />
            )}

            {selectedPlace && isMobile && ReactDOM.createPortal(
              <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.3)', paddingBottom: 'var(--bottom-nav-h)' }} onClick={() => setSelectedPlaceId(null)}>
                <div style={{ width: '100%', maxHeight: '85vh' }} onClick={e => e.stopPropagation()}>
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
                      if (selectedAssignmentId) {
                        const assignmentObj = Object.values(assignments).flat().find(a => a.id === selectedAssignmentId)
                        const placeWithAssignmentTimes = assignmentObj?.place ? { ...selectedPlace, place_time: assignmentObj.place.place_time, end_time: assignmentObj.place.end_time } : selectedPlace
                        setEditingPlace(placeWithAssignmentTimes)
                      } else {
                        setEditingPlace(selectedPlace)
                      }
                      setEditingAssignmentId(selectedAssignmentId || null)
                      setShowPlaceForm(true)
                      setSelectedPlaceId(null)
                    }}
                    onDelete={() => { handleDeletePlace(selectedPlace.id); setSelectedPlaceId(null) }}
                    onAssignToDay={handleAssignToDay}
                    onRemoveAssignment={handleRemoveAssignment}
                    files={files}
                    onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined}
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
                    onUpdatePlace={async (placeId, data) => { try { await tripActions.updatePlace(tripId, placeId, data) } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) } }}
                    leftWidth={0}
                    rightWidth={0}
                  />
                </div>
              </div>,
              document.body
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
                      ? <DayPlanSidebar tripId={tripId} trip={trip} days={days} places={places} categories={categories} assignments={assignments} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} selectedAssignmentId={selectedAssignmentId} onSelectDay={(id) => { handleSelectDay(id); setMobileSidebarOpen(null) }} onPlaceClick={(placeId, assignmentId) => { handlePlaceClick(placeId, assignmentId) }} onReorder={handleReorder} onUpdateDayTitle={handleUpdateDayTitle} onAssignToDay={handleAssignToDay} onRouteCalculated={(r) => { if (r) { setRoute(r.coordinates); setRouteInfo({ distance: r.distanceText, duration: r.durationText }) } }} reservations={reservations} visibleConnectionIds={visibleConnections} onToggleConnection={toggleConnection} onAddReservation={(dayId) => { setEditingReservation(null); tripActions.setSelectedDay(dayId); setShowReservationModal(true); setMobileSidebarOpen(null) }} onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onDayDetail={(day) => { setShowDayDetail(day); setSelectedPlaceId(null); selectAssignment(null); setMobileSidebarOpen(null) }} accommodations={tripAccommodations} onNavigateToFiles={() => { setMobileSidebarOpen(null); handleTabChange('dateien') }} onExpandedDaysChange={setExpandedDayIds} pushUndo={pushUndo} canUndo={canUndo} lastActionLabel={lastActionLabel} onUndo={handleUndo} onEditTransport={can('day_edit', trip) ? (reservation) => { setEditingTransport(reservation); setTransportModalDayId(reservation.day_id ?? null); setShowTransportModal(true); setMobileSidebarOpen(null) } : undefined} onEditReservation={can('reservation_edit', trip) ? (r) => { setEditingReservation(r); setShowReservationModal(true); setMobileSidebarOpen(null) } : undefined} initialScrollTop={mobilePlanScrollTopRef.current} onScrollTopChange={(top) => { mobilePlanScrollTopRef.current = top }} />
                      : <PlacesSidebar tripId={tripId} places={places} categories={categories} assignments={assignments} selectedDayId={selectedDayId} selectedPlaceId={selectedPlaceId} onPlaceClick={(placeId) => { handlePlaceClick(placeId); setMobileSidebarOpen(null) }} onAddPlace={() => { setEditingPlace(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onAssignToDay={handleAssignToDay} onEditPlace={(place) => { setEditingPlace(place); setEditingAssignmentId(null); setShowPlaceForm(true); setMobileSidebarOpen(null) }} onDeletePlace={(placeId) => handleDeletePlace(placeId)} onBulkDeletePlaces={(ids) => setDeletePlaceIds(ids)} onBulkDeleteConfirm={(ids) => confirmDeletePlaces(ids)} days={days} isMobile onCategoryFilterChange={setMapCategoryFilter} onPlacesFilterChange={setMapPlacesFilter} pushUndo={pushUndo} initialScrollTop={mobilePlacesScrollTopRef.current} onScrollTopChange={(top) => { mobilePlacesScrollTopRef.current = top }} />
                    }
                  </div>
                </div>
              </div>,
              document.body
            )}
          </div>
        )}

        {activeTab === 'transports' && (
          <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <ReservationsPanel
              tripId={tripId}
              reservations={reservations.filter(r => TRANSPORT_TYPES.has(r.type))}
              days={days}
              assignments={assignments}
              files={files}
              onAdd={() => { setEditingTransport(null); setShowTransportModal(true) }}
              onEdit={(r) => { setEditingTransport(r); setShowTransportModal(true) }}
              onDelete={handleDeleteReservation}
              onNavigateToFiles={() => handleTabChange('dateien')}
              titleKey="transport.title"
              addManualKey="transport.addManual"
            />
          </div>
        )}

        {activeTab === 'buchungen' && (
          <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <ReservationsPanel
              tripId={tripId}
              reservations={reservations.filter(r => !TRANSPORT_TYPES.has(r.type))}
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

        {activeTab === 'listen' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', width: '100%', paddingBottom: 'var(--bottom-nav-h)' }}>
            <ListsContainer tripId={tripId} packingItems={packingItems} todoItems={todoItems} />
          </div>
        )}

        {activeTab === 'finanzplan' && (
          <div style={{ height: '100%', overflowY: 'auto', overscrollBehavior: 'contain', width: '100%', paddingBottom: 'var(--bottom-nav-h)' }}>
            <BudgetPanel tripId={tripId} tripMembers={tripMembers} />
          </div>
        )}

        {activeTab === 'dateien' && (
          <div style={{ height: '100%', overflow: 'hidden', overscrollBehavior: 'contain', paddingBottom: 'var(--bottom-nav-h)' }}>
            <FileManager
              files={files || []}
              onUpload={(fd) => tripActions.addFile(tripId, fd)}
              onDelete={(id) => tripActions.deleteFile(tripId, id)}
              onUpdate={(id, data) => tripActions.loadFiles(tripId)}
              places={places}
              days={days}
              assignments={assignments}
              reservations={reservations}
              tripId={tripId}
              allowedFileTypes={allowedFileTypes}
            />
          </div>
        )}

        {activeTab === 'collab' && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 'var(--bottom-nav-h)', overflow: 'hidden' }}>
            <CollabPanel tripId={tripId} tripMembers={tripMembers} collabFeatures={collabFeatures} />
          </div>
        )}
      </div>

      <PlaceFormModal isOpen={showPlaceForm} onClose={() => { setShowPlaceForm(false); setEditingPlace(null); setEditingAssignmentId(null); setPrefillCoords(null) }} onSave={handleSavePlace} place={editingPlace} prefillCoords={prefillCoords} assignmentId={editingAssignmentId} dayAssignments={editingAssignmentId ? Object.values(assignments).flat() : []} tripId={tripId} categories={categories} onCategoryCreated={cat => tripActions.addCategory?.(cat)} />
      <TripFormModal isOpen={showTripForm} onClose={() => setShowTripForm(false)} onSave={async (data) => { await tripActions.updateTrip(tripId, data); toast.success(t('trip.toast.tripUpdated')) }} trip={trip} />
      <TripMembersModal isOpen={showMembersModal} onClose={() => setShowMembersModal(false)} tripId={tripId} tripTitle={trip?.title} />
      <ReservationModal isOpen={showReservationModal} onClose={() => { setShowReservationModal(false); setEditingReservation(null); setBookingForAssignmentId(null) }} onSave={handleSaveReservation} reservation={editingReservation} days={days} places={places} assignments={assignments} selectedDayId={selectedDayId} files={files} onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined} onFileDelete={(id) => tripActions.deleteFile(tripId, id)} accommodations={tripAccommodations} defaultAssignmentId={bookingForAssignmentId} />
      {showTransportModal && <TransportModal isOpen={showTransportModal} onClose={() => { setShowTransportModal(false); setEditingTransport(null); setTransportModalDayId(null) }} onSave={handleSaveTransport} reservation={editingTransport} days={days} selectedDayId={transportModalDayId} files={files} onFileUpload={canUploadFiles ? (fd) => tripActions.addFile(tripId, fd) : undefined} onFileDelete={(id) => tripActions.deleteFile(tripId, id)} />}
      <ConfirmDialog
        isOpen={!!deletePlaceId}
        onClose={() => setDeletePlaceId(null)}
        onConfirm={confirmDeletePlace}
        title={t('common.delete')}
        message={t('trip.confirm.deletePlace')}
      />
      <ConfirmDialog
        isOpen={!!deletePlaceIds?.length}
        onClose={() => setDeletePlaceIds(null)}
        onConfirm={confirmDeletePlaces}
        title={t('common.delete')}
        message={t('trip.confirm.deletePlaces', { count: deletePlaceIds?.length ?? 0 })}
      />
    </div>
  )
}
