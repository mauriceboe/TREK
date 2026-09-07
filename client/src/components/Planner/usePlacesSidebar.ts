import type React from 'react'
import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { Pencil, Trash2, ExternalLink, Navigation, CalendarDays, Bookmark } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { useContextMenu } from '../shared/ContextMenu'
import { placesApi } from '../../api/client'
import { collectionsApi } from '../../api/collections'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useAuthStore } from '../../store/authStore'
import { useAddonStore } from '../../store/addonStore'
import { useSaveToCollectionStore } from '../../store/saveToCollectionStore'
import { placeToSaveTarget } from '../Collections/saveTarget'
import type { Place, Category, Day, AssignmentsMap } from '../../types'
import { getGoogleMapsUrlForPlace } from './placeGoogleMaps'
import { safeHttpUrl } from '../../utils/safeUrl'
import { plannedPlaceIds, type PlannedAccommodation } from '../../utils/plannedPlaces'

/** Stable identity — a fresh [] default would invalidate the planned memo on every render. */
const NO_ACCOMMODATIONS: PlannedAccommodation[] = []

export interface PlacesSidebarProps {
  tripId: number
  places: Place[]
  /** The trip's stays — hook-local state in useTripPlanner, so it arrives as a prop. */
  accommodations?: PlannedAccommodation[]
  categories: Category[]
  assignments: AssignmentsMap
  selectedDayId: number | null
  selectedPlaceId: number | null
  onPlaceClick: (placeId: number | null) => void
  onAddPlace: () => void
  onAssignToDay: (placeId: number, dayId: number) => void
  onEditPlace: (place: Place) => void
  onDeletePlace: (placeId: number) => void
  onBulkDeletePlaces?: (ids: number[]) => void
  onBulkDeleteConfirm?: (ids: number[]) => void
  onBulkChangeCategory?: (ids: number[], categoryId: number | null) => void
  days: Day[]
  isMobile: boolean
  pushUndo?: (label: string, undoFn: () => Promise<void> | void) => void
  initialScrollTop?: number
  onScrollTopChange?: (top: number) => void
}

/**
 * Sidebar state: file/list import, search + filter + category multi-select,
 * multi-select/bulk-delete and the mobile day-picker sheet. Kept in one hook so
 * PlacesSidebar stays a thin layout shell over the sub-sections below.
 */
export function usePlacesSidebar(props: PlacesSidebarProps) {
  const {
    tripId, places, assignments, selectedDayId, accommodations = NO_ACCOMMODATIONS,
    pushUndo, initialScrollTop, onScrollTopChange,
  } = props
  const { t } = useTranslation()
  const toast = useToast()
  const ctxMenu = useContextMenu()
  const trip = useTripStore((s) => s.trip)
  // A booking plans the place it points at, so the pool has to see them (#2072).
  const reservations = useTripStore((s) => s.reservations)
  const loadTrip = useTripStore((s) => s.loadTrip)
  const can = useCanDo()
  const canEditPlaces = can('place_edit', trip)
  const collectionsEnabled = useAddonStore((s) => s.isEnabled('collections'))
  // Places-API enrichment (#886) needs a Google Maps key. Not the places
  // *provider* choice: enrichment's photos and summary come from Google (and,
  // keyless, from Wikimedia), which is independent of which provider answers
  // search — an Amap install with a Google key still enriches through Google.
  const canEnrichImport = useAuthStore((s) => s.hasMapsKey)

  const [fileImportOpen, setFileImportOpen] = useState(false)
  const [sidebarDropFile, setSidebarDropFile] = useState<File | null>(null)
  const [sidebarDragOver, setSidebarDragOver] = useState(false)
  const sidebarDragCounter = useRef(0)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const placeRowRefs = useRef(new Map<number, HTMLDivElement>())
  const lastAutoScrolledPlaceIdRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (scrollContainerRef.current && initialScrollTop) {
      scrollContainerRef.current.scrollTop = initialScrollTop
    }
  }, [])

  const handleSidebarDragEnter = (e: React.DragEvent) => {
    if (!canEditPlaces) return
    e.preventDefault()
    sidebarDragCounter.current++
    setSidebarDragOver(true)
  }

  const handleSidebarDragOver = (e: React.DragEvent) => {
    if (!canEditPlaces) return
    e.preventDefault()
  }

  const handleSidebarDragLeave = () => {
    sidebarDragCounter.current--
    if (sidebarDragCounter.current === 0) setSidebarDragOver(false)
  }

  const handleSidebarDrop = (e: React.DragEvent) => {
    e.preventDefault()
    sidebarDragCounter.current = 0
    setSidebarDragOver(false)
    if (!canEditPlaces) return
    const f = e.dataTransfer.files[0]
    if (!f) return
    setSidebarDropFile(f)
    setFileImportOpen(true)
  }

  const [listImportOpen, setListImportOpen] = useState(false)
  const [listImportUrl, setListImportUrl] = useState('')
  const [listImportLoading, setListImportLoading] = useState(false)
  const [listImportProvider, setListImportProvider] = useState<'google' | 'naver'>('google')
  const [listImportEnrich, setListImportEnrich] = useState(false)
  const availableListImportProviders: Array<'google' | 'naver'> = ['google', 'naver']
  const hasMultipleListImportProviders = availableListImportProviders.length > 1

  const handleListImport = async () => {
    if (!listImportUrl.trim()) return
    setListImportLoading(true)
    const provider = listImportProvider
    try {
      const enrich = listImportEnrich && canEnrichImport
      const result = provider === 'google'
        ? await placesApi.importGoogleList(tripId, listImportUrl.trim(), enrich)
        : await placesApi.importNaverList(tripId, listImportUrl.trim(), enrich)
      await loadTrip(tripId)
      if (result.count === 0 && result.skipped > 0) {
        toast.warning(t('places.importAllSkipped'))
      } else {
        toast.success(t(provider === 'google' ? 'places.googleListImported' : 'places.naverListImported', { count: result.count, list: result.listName }))
      }
      setListImportOpen(false)
      setListImportUrl('')
      if (result.places?.length > 0) {
        const importedIds: number[] = result.places.map((p: { id: number }) => p.id)
        pushUndo?.(t(provider === 'google' ? 'undo.importGoogleList' : 'undo.importNaverList'), async () => {
          try { await placesApi.bulkDelete(tripId, importedIds) } catch {}
          await loadTrip(tripId)
        })
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t(provider === 'google' ? 'places.googleListError' : 'places.naverListError'))
    } finally {
      setListImportLoading(false)
    }
  }

  const [search, setSearch] = useState('')
  // Filter state lives in the trip store so it survives the Plan tab
  // unmounting (tab switch, mobile sheet close) and stays in lockstep with the
  // map markers, which filter on the same values (#1541).
  const filter = useTripStore((s) => s.placesFilter)
  const setFilter = useTripStore((s) => s.setPlacesFilter)
  const categoryFilters = useTripStore((s) => s.placesCategoryFilter)
  const setCategoryFilters = useTripStore((s) => s.setPlacesCategoryFilter)
  const [selectMode, setSelectMode] = useState(false)
  // Star sort (#1435): list-only toggle, so it stays local (the map keeps its order).
  // Minimum average stars, matching the collections filter (#1435): 'all', or a
  // floor of 1..5 that unrated places fall through. It replaced a sort toggle,
  // which put the best first but still left everything else on the list — no
  // help at all when the point is to see only what the group actually rated.
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[] | null>(null)
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)
  const [saveToListOpen, setSaveToListOpen] = useState(false)

  const [markVisitedBusy, setMarkVisitedBusy] = useState(false)

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }

  /**
   * "I have been to these" for the selection, applied wherever the places are
   * saved in the library (#1469). The server does the matching, so a place saved
   * under a different name in a list is still found.
   */
  const markSelectionVisited = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || markVisitedBusy) return
    setMarkVisitedBusy(true)
    try {
      const { updated, places: matchedPlaces } = await collectionsApi.setStatusFromTrip(props.tripId, ids, 'visited')
      if (updated === 0) toast.info(t('collections.markVisitedNone'))
      else toast.success(t('collections.markedVisitedTrip', { count: matchedPlaces ?? 0 }))
      exitSelectMode()
    } catch {
      toast.error(t('common.error'))
    } finally {
      setMarkVisitedBusy(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, markVisitedBusy, props.tripId, t])

  // Auto-exit when all selected places have been removed from the store (e.g. after bulk delete)
  useEffect(() => {
    if (!selectMode || selectedIds.size === 0) return
    const placeIdSet = new Set(places.map(p => p.id))
    if ([...selectedIds].every(id => !placeIdSet.has(id))) {
      setSelectMode(false)
      setSelectedIds(new Set())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places])

  const toggleSelected = useCallback((id: number) => setSelectedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  }), [])

  const toggleCategoryFilter = (catId: string) => {
    const next = new Set(categoryFilters)
    if (next.has(catId)) next.delete(catId); else next.add(catId)
    setCategoryFilters(next)
  }
  const [dayPickerPlace, setDayPickerPlace] = useState<Place | null>(null)
  const [catDropOpen, setCatDropOpen] = useState(false)
  const [starDropOpen, setStarDropOpen] = useState(false)
  const [mobileShowDays, setMobileShowDays] = useState(false)

  // Alle geplanten Ort-IDs abrufen (einem Tag zugewiesen)
  const hasTracks = useMemo(() => places.some(p => p.route_geometry), [places])
  useEffect(() => { if (filter === 'tracks' && !hasTracks) setFilter('all') }, [hasTracks, filter])

  const plannedIds = useMemo(
    () => plannedPlaceIds({ assignments, accommodations, reservations }),
    [assignments, accommodations, reservations],
  )

  const filtered = useMemo(() => {
    const list = places.filter(p => {
      if (filter === 'unplanned' && plannedIds.has(p.id)) return false
      if (filter === 'planned' && !plannedIds.has(p.id)) return false
      if (filter === 'tracks' && !p.route_geometry) return false
      if (categoryFilters.size > 0) {
        if (p.category_id == null) {
          if (!categoryFilters.has('uncategorized')) return false
        } else if (!categoryFilters.has(String(p.category_id))) return false
      }
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
          !(p.address || '').toLowerCase().includes(search.toLowerCase())) return false
      if (ratingFilter !== 'all' && (p.rating_avg == null || p.rating_avg < ratingFilter)) return false
      return true
    })
    return list
  }, [places, filter, categoryFilters, search, plannedIds, ratingFilter])

  const registerPlaceRow = useCallback((placeId: number, element: HTMLDivElement | null) => {
    if (element) {
      placeRowRefs.current.set(placeId, element)
    } else {
      placeRowRefs.current.delete(placeId)
    }
  }, [])

  useEffect(() => {
    if (!props.selectedPlaceId) {
      lastAutoScrolledPlaceIdRef.current = null
      return
    }
    if (lastAutoScrolledPlaceIdRef.current === props.selectedPlaceId) return
    if (!filtered.some(place => place.id === props.selectedPlaceId)) return

    const selectedRow = placeRowRefs.current.get(props.selectedPlaceId)
    if (!selectedRow) return
    selectedRow.scrollIntoView({ behavior: 'smooth', block: 'center' })
    lastAutoScrolledPlaceIdRef.current = props.selectedPlaceId
  }, [filtered, props.selectedPlaceId])

  const isAssignedToSelectedDay = (placeId) =>
    selectedDayId && (assignments[String(selectedDayId)] || []).some(a => a.place?.id === placeId)

  const selectedDayIdRef = useRef<number | null>(selectedDayId)
  useEffect(() => { selectedDayIdRef.current = selectedDayId }, [selectedDayId])

  const inDaySet = useMemo(() => {
    if (!selectedDayId) return new Set<number>()
    return new Set<number>((assignments[String(selectedDayId)] || []).map((a: any) => a.place?.id).filter(Boolean))
  }, [assignments, selectedDayId])

  const openContextMenu = useCallback((e: React.MouseEvent, place: Place) => {
    const selDayId = selectedDayIdRef.current
    const googleMapsUrl = getGoogleMapsUrlForPlace(place)
    ctxMenu.open(e, [
      canEditPlaces && { label: t('common.edit'), icon: Pencil, onClick: () => props.onEditPlace(place) },
      selDayId && { label: t('planner.addToDay'), icon: CalendarDays, onClick: () => props.onAssignToDay(place.id, selDayId) },
      safeHttpUrl(place.website) && { label: t('inspector.website'), icon: ExternalLink, onClick: () => window.open(safeHttpUrl(place.website)!, '_blank', 'noopener,noreferrer') },
      googleMapsUrl && { label: t('inspector.google'), icon: Navigation, onClick: () => window.open(googleMapsUrl, '_blank') },
      collectionsEnabled && { label: t('inspector.saveToCollection'), icon: Bookmark, onClick: () => useSaveToCollectionStore.getState().open(placeToSaveTarget(place)) },
      { divider: true },
      canEditPlaces && { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => props.onDeletePlace(place.id) },
    ])
  }, [ctxMenu.open, canEditPlaces, collectionsEnabled, t, props.onEditPlace, props.onAssignToDay, props.onDeletePlace])

  return {
    ...props,
    t, toast, ctxMenu, trip, canEditPlaces,
    fileImportOpen, setFileImportOpen, sidebarDropFile, setSidebarDropFile,
    sidebarDragOver, handleSidebarDragEnter, handleSidebarDragOver, handleSidebarDragLeave, handleSidebarDrop,
    scrollContainerRef, onScrollTopChange,
    listImportOpen, setListImportOpen, listImportUrl, setListImportUrl,
    listImportLoading, listImportProvider, setListImportProvider,
    listImportEnrich, setListImportEnrich, canEnrichImport,
    availableListImportProviders, hasMultipleListImportProviders, handleListImport,
    search, setSearch, filter, setFilter, categoryFilters, setCategoryFilters,
    ratingFilter, setRatingFilter,
    starDropOpen, setStarDropOpen,
    selectMode, setSelectMode, selectedIds, setSelectedIds, pendingDeleteIds, setPendingDeleteIds,
    categoryPickerOpen, setCategoryPickerOpen,
    saveToListOpen, setSaveToListOpen, collectionsEnabled, tripId,
    markSelectionVisited, markVisitedBusy,
    exitSelectMode, toggleSelected, toggleCategoryFilter, dayPickerPlace, setDayPickerPlace,
    catDropOpen, setCatDropOpen, mobileShowDays, setMobileShowDays,
    hasTracks, plannedIds, filtered, registerPlaceRow, isAssignedToSelectedDay, inDaySet, openContextMenu,
  }
}

export type SidebarState = ReturnType<typeof usePlacesSidebar>
