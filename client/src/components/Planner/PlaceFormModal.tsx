import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import NoteFormatToolbar from '../shared/NoteFormatToolbar'
import { mapsApi } from '../../api/client'
import { recordPlacePick } from '../../api/placeShadow'
import { useAuthStore } from '../../store/authStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useAddonStore } from '../../store/addonStore'
import CollectionPicker from '../Collections/CollectionPicker'
import PlaceDetailsColumn, { type PlaceDetailsSelection } from './PlaceDetailsColumn'
import { useToast } from '../shared/Toast'
import { Search, Paperclip, X, AlertTriangle, Loader2, Plus } from 'lucide-react'
import { useTranslation } from '../../i18n'
import CustomTimePicker from '../shared/CustomTimePicker'
import { DEFAULT_FORM, isGoogleMapsUrl, mergeResult, type PlaceFormData, type ResultField } from './PlaceFormModal.helpers'
import { getApiErrorMessage } from '../../utils/apiError'
import { BookingCostsSection } from './BookingCostsSection'
import type { BookingExpenseRequest } from './BookingCostsSection.types'
import type { Place, Category, Assignment, BudgetItem } from '../../types'
import { NumericInput } from '../shared/NumericInput'
import { PlacesSession } from '../../utils/placesSession'

// The submit payload mirrors the form, but lat/lng are parsed to numbers and
// category_id is normalised, plus any files chosen before the place existed.
export interface PlaceSubmitData extends Omit<PlaceFormData, 'lat' | 'lng' | 'category_id'> {
  lat: number | null
  lng: number | null
  category_id: string | null
  _pendingFiles?: File[]
}

interface PlaceFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: PlaceSubmitData, files?: File[]) => Promise<{ id: number } | void> | void
  place: Place | null
  prefillCoords?: { lat: number; lng: number; name?: string; address?: string; website?: string; phone?: string; osm_id?: string } | null
  tripId: number
  categories: Category[]
  onCategoryCreated: (category: { name: string; color?: string; icon?: string }) => Promise<Category> | undefined
  assignmentId: number | null
  dayAssignments?: Assignment[]
  /** Mobile keeps the untouched single-column form; desktop adds the saved-place
   *  picker column when the Collections addon is enabled. Sourced from the trip
   *  planner's matchMedia('(max-width:767px)'). */
  isMobile?: boolean
  /** Opens the Costs editor for this place's linked expense (#1298) — the same
   *  seam the booking and transport modals use. */
  onOpenExpense?: (req: BookingExpenseRequest) => void
}


/** Place create/edit form state: maps search + Google-URL resolve + autocomplete,
 * category creation, file attachments and submit. Keeps PlaceFormModal a thin
 * render over the form fields. */

// #1152: a manually-added place is treated as a likely duplicate of an existing
// trip place if it shares the Google Place ID, the (case-insensitive) name, or
// near-identical coordinates (~11 m). Mirrors the server-side import dedup.
const DUP_COORD_TOLERANCE = 0.0001
function findDuplicatePlace(
  form: PlaceFormData,
  places: { name?: string | null; lat?: number | null; lng?: number | null; google_place_id?: string | null }[],
): { name?: string | null } | null {
  const name = (form.name || '').trim().toLowerCase()
  const gid = (form.google_place_id || '').trim()
  const lat = form.lat ? Number.parseFloat(form.lat) : null
  const lng = form.lng ? Number.parseFloat(form.lng) : null
  for (const p of places || []) {
    if (gid && p.google_place_id && p.google_place_id === gid) return p
    if (name && p.name && p.name.trim().toLowerCase() === name) return p
    if (
      lat != null && lng != null && p.lat != null && p.lng != null &&
      Math.abs(Number(p.lat) - lat) <= DUP_COORD_TOLERANCE &&
      Math.abs(Number(p.lng) - lng) <= DUP_COORD_TOLERANCE
    ) return p
  }
  return null
}

function usePlaceFormModal(props: PlaceFormModalProps) {
  const {
  isOpen, onClose, onSave, place, prefillCoords, tripId, categories,
  onCategoryCreated, assignmentId, dayAssignments = [], isMobile = false,
  onOpenExpense,
  } = props
  const [form, setForm] = useState(DEFAULT_FORM)
  const [mapsSearch, setMapsSearch] = useState('')
  const [mapsResults, setMapsResults] = useState([])
  /**
   * What produced the list currently on screen, kept for the shadow log: the
   * query as typed and the provider the envelope named. A ref rather than
   * state because nothing renders from it and a pick must read the value that
   * belonged to the list, not a value a re-render replaced.
   */
  const searchMetaRef = useRef<{ query: string; source: string } | null>(null)
  const acMetaRef = useRef<{ query: string; source: string } | null>(null)
  const [isSearchingMaps, setIsSearchingMaps] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)
  // What the detail column is describing. Null until the user picks a result.
  const [detailsSelection, setDetailsSelection] = useState<PlaceDetailsSelection | null>(null)
  // Which fields the last picked search result wrote. Anything in here belongs
  // to that place and goes when another is picked; anything outside it is the
  // user's and survives. See mergeResult.
  const autoFilledRef = useRef<Set<ResultField>>(new Set())
  const [pendingFiles, setPendingFiles] = useState([])
  const fileRef = useRef(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [acSuggestions, setAcSuggestions] = useState<{ placeId: string; mainText: string; secondaryText: string }[]>([])
  const [acHighlight, setAcHighlight] = useState(-1)
  const acDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const acAbortRef = useRef<AbortController | null>(null)
  // Ties one search's keystrokes and its details lookup into a single Google
  // billing session (see utils/placesSession).
  const placesSessionRef = useRef(new PlacesSession())
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const { hasMapsKey, placesEnrichEnabled } = useAuthStore()
  const can = useCanDo()
  const timeFormat = useSettingsStore((s) => s.settings.time_format) || '24h'
  const tripObj = useTripStore((s) => s.trip)
  const canUploadFiles = can('file_upload', tripObj)
  const collectionsEnabled = useAddonStore((s) => s.isEnabled('collections'))
  const isBudgetEnabled = useAddonStore((s) => s.isEnabled('budget'))
  const deleteBudgetItem = useTripStore((s) => s.deleteBudgetItem)
  // Set right before submit when the user clicked create/edit expense — the
  // place has to exist before an expense can point at it (see ReservationModal).
  const expenseIntentRef = useRef<{ editItem?: BudgetItem; create?: boolean } | null>(null)

  useEffect(() => {
    if (place) {
      // Times are stored per day-assignment, not on the pool place. When an
      // assignment is in context (itinerary edit, or a single-assignment pool
      // edit) read the times off its embedded place; fall back to the place prop.
      const assignment = assignmentId ? dayAssignments.find(a => a.id === assignmentId) : null
      const timeSource = assignment?.place ?? place
      setForm({
        name: place.name || '',
        description: place.description || '',
        address: place.address || '',
        lat: place.lat != null ? String(place.lat) : '',
        lng: place.lng != null ? String(place.lng) : '',
        category_id: place.category_id != null ? String(place.category_id) : '',
        place_time: timeSource.place_time || '',
        end_time: timeSource.end_time || '',
        notes: place.notes || '',
        transport_mode: place.transport_mode || 'walking',
        website: place.website || '',
        // The day-specific note rides only with an assignment in context (#2163);
        // otherwise the key stays absent so submit never sends a notes write.
        ...(assignment ? { assignment_notes: assignment.notes || '' } : {}),
      })
    } else if (prefillCoords) {
      setForm({
        ...DEFAULT_FORM,
        lat: String(prefillCoords.lat),
        lng: String(prefillCoords.lng),
        name: prefillCoords.name || '',
        address: prefillCoords.address || '',
        website: prefillCoords.website || '',
        phone: prefillCoords.phone || '',
        osm_id: prefillCoords.osm_id,
      })
    } else {
      setForm(DEFAULT_FORM)
    }
    // A fresh dialog owns nothing yet. The exception is a POI tapped on the map
    // or a right-click place: those arrive prefilled from a place, so the same
    // fields belong to it and a later search pick may clear them. An existing
    // place being edited is the opposite — everything on that form came out of
    // the database and none of it is a search result's to drop.
    autoFilledRef.current = new Set(
      !place && prefillCoords
        ? (['name', 'address', 'lat', 'lng', 'website', 'phone', 'osm_id'] as ResultField[]).filter(
            (field) => !!prefillCoords[field as keyof typeof prefillCoords],
          )
        : [],
    )
    setPendingFiles([])
    setDuplicateWarning(null)
    // The column follows whatever the dialog was opened with, not only a search
    // pick: a POI tapped on the map and a right-click place arrive as
    // prefillCoords, and editing an existing place arrives as `place`. Without
    // this the column kept showing the previous place's pictures and facts,
    // because only handleSelectMapsResult ever set it.
    if (place && place.lat != null && place.lng != null) {
      setDetailsSelection({
        placeId: place.google_place_id || place.osm_id || undefined,
        lat: Number(place.lat),
        lng: Number(place.lng),
        name: place.name || '',
      })
    } else if (prefillCoords) {
      setDetailsSelection({
        placeId: prefillCoords.osm_id || undefined,
        lat: prefillCoords.lat,
        lng: prefillCoords.lng,
        name: prefillCoords.name || '',
      })
    } else {
      setDetailsSelection(null)
    }
    // dayAssignments is a fresh array each render; read it at open-time only and
    // re-run on identity changes (place/assignmentId/open), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, prefillCoords, isOpen, assignmentId])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        const modal = searchInputRef.current?.closest('[role="dialog"]') ?? document.body
        if (!modal.contains(document.activeElement) || document.activeElement === document.body) {
          searchInputRef.current?.focus()
        }
      }, 50)
    }
  }, [isOpen])

  // Derive location bias bounding box from the trip's existing places
  const places = useTripStore((s) => s.places)
  const locationBias = useMemo(() => {
    const withCoords = (places || []).filter((p) => p.lat != null && p.lng != null)
    if (withCoords.length === 0) return undefined

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
    for (const p of withCoords) {
      const lat = Number(p.lat), lng = Number(p.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
    if (!Number.isFinite(minLat)) return undefined

    // Skip bias if the bounding box is too large (~500 km diagonal)
    const dlat = maxLat - minLat
    const dlng = maxLng - minLng
    const avgLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180)
    const diagKm = Math.sqrt((dlat * 111) ** 2 + (dlng * 111 * Math.cos(avgLatRad)) ** 2)
    if (diagKm > 500) return undefined

    return { low: { lat: minLat, lng: minLng }, high: { lat: maxLat, lng: maxLng } }
  }, [places])

  // Autocomplete fetch — aborts any in-flight request before starting a new one
  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 2 || isGoogleMapsUrl(query)) {
      setAcSuggestions([])
      setAcHighlight(-1)
      return
    }
    acAbortRef.current?.abort()
    const controller = new AbortController()
    acAbortRef.current = controller
    try {
      const result = await mapsApi.autocomplete(query, language, locationBias, controller.signal, placesSessionRef.current.current())
      acMetaRef.current = { query, source: result.source || 'unknown' }
      setAcSuggestions(result.suggestions || [])
      setAcHighlight(-1)
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (err instanceof Error && err.name === 'CanceledError') return // axios abort
      console.error('Autocomplete failed:', err)
      setAcSuggestions([])
    }
  }, [language, locationBias])

  // Debounce effect — only watches mapsSearch
  useEffect(() => {
    if (acDebounceRef.current) clearTimeout(acDebounceRef.current)

    const trimmed = mapsSearch.trim()
    if (trimmed.length < 2 || isGoogleMapsUrl(trimmed)) {
      setAcSuggestions([])
      setAcHighlight(-1)
      placesSessionRef.current.end()
      return
    }

    acDebounceRef.current = setTimeout(() => fetchSuggestions(trimmed), 300)

    return () => {
      if (acDebounceRef.current) clearTimeout(acDebounceRef.current)
    }
  }, [mapsSearch, fetchSuggestions])

  const handleChange = (field: string, value: string) => {
    // Typed by hand, so the next pick must not clear it.
    autoFilledRef.current.delete(field as ResultField)
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const handleMapsSearch = async () => {
    if (!mapsSearch.trim()) return
    setIsSearchingMaps(true)
    try {
      // Detect Google Maps URLs and resolve them directly
      const trimmed = mapsSearch.trim()
      if (isGoogleMapsUrl(trimmed)) {
        const resolved = await mapsApi.resolveUrl(trimmed)
        if (resolved.lat && resolved.lng) {
          setForm(prev => ({
            ...prev,
            name: resolved.name || prev.name,
            address: resolved.address || prev.address,
            lat: String(resolved.lat),
            lng: String(resolved.lng),
            google_ftid: resolved.google_ftid || prev.google_ftid,
          }))
          setMapsResults([])
          setMapsSearch('')
          toast.success(t('places.urlResolved'))
          return
        }
      }
      const result = await mapsApi.search(mapsSearch, language)
      searchMetaRef.current = { query: mapsSearch.trim(), source: result.source || 'unknown' }
      setMapsResults(result.places || [])
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('places.mapsSearchError')))
    } finally {
      setIsSearchingMaps(false)
    }
  }

  /**
   * `pick` is present only when the click came from a ranked list. The
   * collection picker and the autocomplete detour reach this function with a
   * place that was never ranked against a query, and a made-up rank would be
   * worse than no row at all.
   */
  const handleSelectMapsResult = (result, pick?: { mode: 'search' | 'autocomplete'; rank: number; count: number }) => {
    setForm(prev => mergeResult(prev, result, autoFilledRef.current))
    // The one point every pick flows through, so the detail column hangs here.
    // A new pick drops whatever hero image belonged to the previous place.
    const lat = Number(result.lat)
    const lng = Number(result.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setDetailsSelection({
        placeId: result.google_place_id || result.osm_id || undefined,
        lat,
        lng,
        name: result.name || '',
        // Hand the record along: the server needs the same OSM tags, and
        // looking them up again costs an Overpass round trip it can skip.
        details: result,
      })
      setForm(prev => ({ ...prev, image_url: undefined }))
      if (pick) {
        const meta = pick.mode === 'search' ? searchMetaRef.current : acMetaRef.current
        if (meta) {
          recordPlacePick({
            query: meta.query,
            lang: language,
            // The bias the search actually ran under is a box around the trip's
            // existing places; the corpus stores its centre, which is what an
            // evaluation needs to bias its own index the same way.
            biasLat: locationBias ? (locationBias.low.lat + locationBias.high.lat) / 2 : undefined,
            biasLng: locationBias ? (locationBias.low.lng + locationBias.high.lng) / 2 : undefined,
            source: `${pick.mode}:${meta.source}`,
            liveRank: pick.rank,
            liveCount: pick.count,
            pickedName: result.name || '',
            pickedLat: lat,
            pickedLng: lng,
            pickedPlaceId: result.google_place_id || result.osm_id || null,
          })
        }
      }
    }
    setMapsResults([])
    setMapsSearch('')
  }

  const handleSelectSuggestion = async (suggestion: { placeId: string; mainText: string; secondaryText: string }) => {
    // Read before the list is cleared: this is the rank the user saw.
    const acRank = acSuggestions.findIndex(s => s.placeId === suggestion.placeId)
    const acCount = acSuggestions.length
    setAcSuggestions([])
    setAcHighlight(-1)
    const previousSearch = mapsSearch
    setMapsSearch('')
    setForm(prev => ({ ...prev, name: suggestion.mainText }))
    setIsSearchingMaps(true)
    try {
      // The details lookup is a fragile second hop — it can fail when the
      // details kill-switch is off, when the OSM Overpass mirror is overloaded,
      // or on any upstream error. Treat a missing/coordinate-less place as a
      // miss and fall back to the reliable text-search path the search button
      // uses (its results already carry coordinates), so dropdown items stay
      // clickable instead of dead-ending on "Place search failed". (#1192)
      let place: Record<string, unknown> | null = null
      try {
        // Spends the session the suggestions opened, so Google bills the search
        // once rather than per keystroke.
        const result = await mapsApi.details(suggestion.placeId, language, placesSessionRef.current.peek())
        if (result.place && result.place.lat != null && result.place.lng != null) {
          place = result.place
        }
      } catch (err) {
        console.error('Failed to fetch place details:', err)
      }
      if (!place) {
        const query = [suggestion.mainText, suggestion.secondaryText].filter(Boolean).join(', ')
        const search = await mapsApi.search(query, language)
        place = search.places?.[0] ?? null
      }
      if (place) {
        handleSelectMapsResult(place, acRank >= 0 ? { mode: 'autocomplete', rank: acRank, count: acCount } : undefined)
      } else {
        setMapsSearch(previousSearch)
        toast.error(t('places.mapsSearchError'))
      }
    } catch (err) {
      console.error('Place suggestion lookup failed:', err)
      setMapsSearch(previousSearch)
      toast.error(getApiErrorMessage(err, t('places.mapsSearchError')))
    } finally {
      setIsSearchingMaps(false)
      placesSessionRef.current.end()
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (acSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcHighlight(prev => (prev + 1) % acSuggestions.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcHighlight(prev => (prev <= 0 ? acSuggestions.length - 1 : prev - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (acHighlight >= 0) {
          handleSelectSuggestion(acSuggestions[acHighlight])
        } else {
          setAcSuggestions([])
          handleMapsSearch()
        }
      } else if (e.key === 'Escape') {
        setAcSuggestions([])
        setAcHighlight(-1)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleMapsSearch()
    }
  }

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return
    try {
      const cat = await onCategoryCreated?.({ name: newCategoryName, color: '#6366f1', icon: 'MapPin' })
      if (cat) setForm(prev => ({ ...prev, category_id: String(cat.id) }))
      setNewCategoryName('')
      setShowNewCategory(false)
    } catch (err: unknown) {
      toast.error(t('places.categoryCreateError'))
    }
  }

  const handleFileAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    setPendingFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const handleRemoveFile = (idx: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
  }

  // Paste support for files/images
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!canUploadFiles) return
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') || item.type === 'application/pdf') {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) setPendingFiles(prev => [...prev, file])
        return
      }
    }
  }

  const hasTimeError = place && form.place_time && form.end_time && form.place_time.length >= 5 && form.end_time.length >= 5 && form.end_time <= form.place_time

  const handleSubmit = async (e?: { preventDefault?: () => void }) => {
    e?.preventDefault?.()
    if (!form.name.trim()) {
      // Nothing was saved, so an expense intent from a previous click is stale —
      // otherwise the next plain Save would open a Costs editor out of nowhere.
      expenseIntentRef.current = null
      toast.error(t('places.nameRequired'))
      return
    }
    // #1152: only for new places, and only on the first attempt — a second click
    // (with the warning already showing) is the explicit "add anyway" confirmation.
    if (!place && !duplicateWarning) {
      const dup = findDuplicatePlace(form, places)
      if (dup) {
        const dupName = dup.name || form.name
        setDuplicateWarning(dupName)
        toast.warning(t('places.duplicateExists', { name: dupName }))
        return
      }
    }
    setIsSaving(true)
    try {
      const payload = {
        ...form,
        lat: form.lat ? Number.parseFloat(form.lat) : null,
        lng: form.lng ? Number.parseFloat(form.lng) : null,
        category_id: form.category_id || null,
        _pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
      }
      // #2163: the per-assignment note only travels when an assignment is in
      // context AND the value actually changed — an untouched note must not
      // produce a PUT (a legacy note longer than the textarea would otherwise
      // be re-sent on every unrelated save).
      const ctxAssignment = assignmentId ? dayAssignments.find(a => a.id === assignmentId) : null
      if (!ctxAssignment || (form.assignment_notes ?? '') === (ctxAssignment.notes ?? '')) {
        delete payload.assignment_notes
      }
      const saved = await onSave(payload)
      // Open the Costs editor for the saved place when the user asked to
      // create/edit its linked expense — gated on an id, so a create that the
      // server refused never opens an editor pointing at nothing (#1298).
      const intent = expenseIntentRef.current
      expenseIntentRef.current = null
      const savedId = (saved && 'id' in saved ? saved.id : null) ?? place?.id ?? null
      if (intent && onOpenExpense && savedId) {
        if (intent.editItem) onOpenExpense({ editItem: intent.editItem })
        else onOpenExpense({ prefill: { placeId: savedId, name: form.name.trim(), category: 'activities' } })
      }
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleCreateExpense = () => { expenseIntentRef.current = { create: true }; void handleSubmit() }
  const handleEditExpense = (item: BudgetItem) => { expenseIntentRef.current = { editItem: item }; void handleSubmit() }
  const handleRemoveExpense = async (item: BudgetItem) => {
    try { await deleteBudgetItem(Number(tripId), item.id) } catch { toast.error(t('common.unknownError')) }
  }

  return {
    isOpen,
    onClose,
    onSave,
    place,
    prefillCoords,
    tripId,
    categories,
    onCategoryCreated,
    assignmentId,
    dayAssignments,
    isMobile,
    collectionsEnabled,
    form,
    setForm,
    mapsSearch,
    setMapsSearch,
    mapsResults,
    setMapsResults,
    isSearchingMaps,
    setIsSearchingMaps,
    newCategoryName,
    setNewCategoryName,
    showNewCategory,
    setShowNewCategory,
    isSaving,
    setIsSaving,
    pendingFiles,
    setPendingFiles,
    fileRef,
    acSuggestions,
    setAcSuggestions,
    acHighlight,
    setAcHighlight,
    acDebounceRef,
    acAbortRef,
    toast,
    t,
    language,
    locale,
    timeFormat,
    hasMapsKey,
    placesEnrichEnabled,
    can,
    tripObj,
    canUploadFiles,
    places,
    locationBias,
    searchInputRef,
    fetchSuggestions,
    handleChange,
    handleMapsSearch,
    handleSelectMapsResult,
    handleSelectSuggestion,
    handleSearchKeyDown,
    handleCreateCategory,
    handleFileAdd,
    handleRemoveFile,
    handlePaste,
    hasTimeError,
    handleSubmit,
    duplicateWarning,
    detailsSelection,
    isBudgetEnabled,
    handleCreateExpense,
    handleEditExpense,
    handleRemoveExpense,
  }
}

export default function PlaceFormModal(props: PlaceFormModalProps) {
  const S = usePlaceFormModal(props)
  const {
    isOpen,
    onClose,
    onSave,
    place,
    prefillCoords,
    tripId,
    categories,
    onCategoryCreated,
    assignmentId,
    dayAssignments,
    isMobile,
    collectionsEnabled,
    form,
    setForm,
    mapsSearch,
    setMapsSearch,
    mapsResults,
    setMapsResults,
    isSearchingMaps,
    setIsSearchingMaps,
    newCategoryName,
    setNewCategoryName,
    showNewCategory,
    setShowNewCategory,
    isSaving,
    setIsSaving,
    pendingFiles,
    setPendingFiles,
    fileRef,
    acSuggestions,
    setAcSuggestions,
    acHighlight,
    setAcHighlight,
    acDebounceRef,
    acAbortRef,
    toast,
    t,
    language,
    hasMapsKey,
    placesEnrichEnabled,
    can,
    tripObj,
    canUploadFiles,
    places,
    locationBias,
    searchInputRef,
    fetchSuggestions,
    handleChange,
    handleMapsSearch,
    handleSelectMapsResult,
    handleSelectSuggestion,
    handleSearchKeyDown,
    handleCreateCategory,
    handleFileAdd,
    handleRemoveFile,
    handlePaste,
    hasTimeError,
    handleSubmit,
    duplicateWarning,
    detailsSelection,
    isBudgetEnabled,
    handleCreateExpense,
    handleEditExpense,
    handleRemoveExpense,
  } = S
  // Desktop + Collections addon → the saved-place picker on the right. Mobile
  // always keeps the original single-column form untouched.
  const twoColumn = !isMobile && collectionsEnabled
  // The detail column sits on the left on desktop whenever enrichment is on. It
  // stays mounted with the selection null rather than appearing on the first
  // pick — otherwise the dialog would jump sideways mid-typing.
  const showDetails = !isMobile && placesEnrichEnabled
  const modalSize = isMobile ? 'lg' : showDetails && twoColumn ? '5xl' : showDetails || twoColumn ? '4xl' : 'lg'
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null)
  const notesRef = useRef<HTMLTextAreaElement | null>(null)
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={place ? t('places.editPlace') : t('places.addPlace')}
      size={modalSize}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-content-secondary hover:text-content border border-edge rounded-lg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving || hasTimeError}
            className="px-6 py-2 bg-accent text-accent-text text-sm rounded-lg hover:bg-accent-hover disabled:opacity-60 font-medium"
          >
            {isSaving ? t('common.saving') : place ? t('common.update') : duplicateWarning ? t('places.addAnyway') : t('common.add')}
          </button>
        </div>
      }
    >
      <div className={twoColumn || showDetails ? 'flex gap-5 items-stretch' : ''}>
      {showDetails && (
        <PlaceDetailsColumn
          selection={detailsSelection}
          selectedImageUrl={form.image_url}
          onPickImage={(url) => setForm(prev => ({ ...prev, image_url: url ?? undefined }))}
          onAdoptDescription={(text) => setForm(prev => ({ ...prev, description: text }))}
          hasDescription={!!form.description.trim()}
          language={language}
          timeFormat={S.timeFormat}
          locale={S.locale}
          hasMapsKey={S.hasMapsKey}
          t={t}
        />
      )}
      <form onSubmit={handleSubmit} className={twoColumn || showDetails ? 'flex-1 min-w-0 space-y-3' : 'space-y-3'} onPaste={handlePaste}>
        {/* Place Search */}
        <div className="bg-surface-secondary rounded-xl p-3 border border-edge">
          {!hasMapsKey && (
            <p className="mb-2 text-xs text-content-faint">
              {t('places.osmActive')}
            </p>
          )}
          <div className="relative">
            <div className="flex gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={mapsSearch}
                onChange={e => setMapsSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                onBlur={() => setTimeout(() => setAcSuggestions([]), 150)}
                onFocus={() => {
                  if (mapsSearch.trim().length >= 2 && acSuggestions.length === 0 && mapsResults.length === 0) {
                    fetchSuggestions(mapsSearch.trim())
                  }
                }}
                placeholder={t('places.mapsSearchPlaceholder')}
                className="flex-1 border border-edge rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 bg-surface-input"
              />
              <button
                type="button"
                onClick={() => { setAcSuggestions([]); handleMapsSearch() }}
                disabled={isSearchingMaps}
                className="bg-accent text-accent-text px-3 py-1.5 rounded-lg text-sm hover:bg-accent-hover disabled:opacity-60"
              >
                {isSearchingMaps ? '...' : <Search className="w-4 h-4" />}
              </button>
            </div>

            {/* Autocomplete dropdown */}
            {acSuggestions.length > 0 && (
              <div className="absolute left-0 right-0 z-20 mt-1 bg-surface-card rounded-lg border border-edge shadow-dropdown overflow-hidden">
                {acSuggestions.map((s, idx) => (
                  <button
                    key={s.placeId}
                    type="button"
                    onMouseDown={() => handleSelectSuggestion(s)}
                    onMouseEnter={() => setAcHighlight(idx)}
                    className={`w-full text-left px-3 py-2 border-b border-edge-faint last:border-0 ${
                      idx === acHighlight ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'
                    }`}
                  >
                    <div className="font-medium text-sm">{s.mainText}</div>
                    {s.secondaryText && (
                      <div className="text-xs text-content-muted truncate">{s.secondaryText}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search results (populated after full search) */}
          {mapsResults.length > 0 && (
            <div className="bg-surface-card rounded-lg border border-edge overflow-hidden max-h-40 overflow-y-auto mt-2">
              {mapsResults.map((result, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSelectMapsResult(result, { mode: 'search', rank: idx, count: mapsResults.length })}
                  className="w-full text-left px-3 py-2 hover:bg-surface-hover border-b border-edge-faint last:border-0"
                >
                  <div className="font-medium text-sm">{result.name}</div>
                  <div className="text-xs text-content-muted truncate">{result.address}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.formName')} *</label>
          <div className="relative">
            <input
              type="text"
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              required
              placeholder={t('places.formNamePlaceholder')}
              className="form-input"
            />
            {isSearchingMaps && (
              <div className="absolute right-2.5 top-0 bottom-0 flex items-center" role="status" aria-label={t('places.loadingDetails')}>
                <Loader2 className="w-4 h-4 animate-spin text-content-faint" aria-hidden="true" />
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <label className="block text-sm font-medium text-content-secondary">{t('places.formDescription')}</label>
            <NoteFormatToolbar textareaRef={descriptionRef} onChange={v => handleChange('description', v)} compact />
          </div>
          <textarea
            ref={descriptionRef}
            value={form.description}
            onChange={e => handleChange('description', e.target.value)}
            rows={3}
            placeholder={t('places.formDescriptionPlaceholder')}
            className="form-input" style={{ resize: 'vertical' }}
          />
        </div>

        {/* Notes — Markdown, same as the description, and rendered as such in the
            inspector. The bar is how anyone finds that out. */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <label className="block text-sm font-medium text-content-secondary">{t('places.formNotes')}</label>
            <NoteFormatToolbar textareaRef={notesRef} onChange={v => handleChange('notes', v)} compact />
          </div>
          <textarea
            ref={notesRef}
            value={form.notes}
            onChange={e => handleChange('notes', e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('places.formNotesPlaceholder')}
            className="form-input" style={{ resize: 'vertical' }}
          />
        </div>

        {/* Address + Coordinates */}
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.formAddress')}</label>
          <input
            type="text"
            value={form.address}
            onChange={e => handleChange('address', e.target.value)}
            placeholder={t('places.formAddressPlaceholder')}
            className="form-input"
          />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <NumericInput
              mode="signed"
              value={form.lat}
              onValueChange={v => handleChange('lat', v)}
              onPaste={e => {
                const text = e.clipboardData.getData('text').trim()
                const match = text.match(/^(-?\d+(?:\.\d*)?)(?:\s*[,;]\s*|\s+)(-?\d+(?:\.\d*)?)$/)
                if (match) {
                  e.preventDefault()
                  handleChange('lat', match[1])
                  handleChange('lng', match[2])
                }
              }}
              placeholder={t('places.formLat')}
              className="form-input"
            />
            <NumericInput
              mode="signed"
              value={form.lng}
              onValueChange={v => handleChange('lng', v)}
              placeholder={t('places.formLng')}
              className="form-input"
            />
          </div>
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.formCategory')}</label>
          {!showNewCategory ? (
            <div className="flex gap-2">
              <CustomSelect
                value={form.category_id}
                onChange={value => handleChange('category_id', String(value))}
                placeholder={t('places.noCategory')}
                options={[
                  { value: '', label: t('places.noCategory') },
                  ...(categories || []).map(c => ({
                    // form.category_id is a string; CustomSelect matches options by
                    // strict equality, so the option value must be a string too —
                    // otherwise the chosen category never renders in the trigger.
                    value: String(c.id),
                    label: c.name,
                  })),
                ]}
                style={{ flex: 1 }}
                size="sm"
              />
              <button
                type="button"
                onClick={() => setShowNewCategory(true)}
                aria-label={t('places.newCategory')}
                title={t('places.newCategory')}
                className="text-content-muted px-2 hover:text-content-secondary"
              >
                <Plus size={16} />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                placeholder={t('places.categoryNamePlaceholder')}
                className="form-input" style={{ flex: 1 }}
              />
              <button type="button" onClick={handleCreateCategory} className="bg-accent text-accent-text px-3 rounded-lg hover:bg-accent-hover text-sm">
                OK
              </button>
              <button type="button" onClick={() => setShowNewCategory(false)} className="text-content-muted px-2 text-sm">
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>

        {/* Time is per day-assignment: only shown when a single assignment is in
            context (itinerary edit, or a single-assignment pool edit). Hidden when
            creating, and for unassigned / multi-day pool edits where a single time
            is ambiguous and wouldn't persist. */}
        {!!(place && assignmentId) && (
          <TimeSection
            form={form}
            handleChange={handleChange}
            assignmentId={assignmentId}
            dayAssignments={dayAssignments}
            hasTimeError={hasTimeError}
            t={t}
          />
        )}

        {/* Day-specific note — like the times, it lives on the assignment, not
            the pool place (#2163): only editable with one in context. */}
        {!!(place && assignmentId) && (
          <div>
            <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.assignmentNotes')}</label>
            <textarea
              value={form.assignment_notes ?? ''}
              onChange={e => handleChange('assignment_notes', e.target.value)}
              rows={2}
              placeholder={t('places.assignmentNotesPlaceholder')}
              className="form-input" style={{ resize: 'vertical' }}
            />
          </div>
        )}

        {/* Website */}
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.formWebsite')}</label>
          <input
            type="url"
            value={form.website}
            onChange={e => handleChange('website', e.target.value)}
            placeholder="https://..."
            className="form-input"
          />
        </div>

        {/* File Attachments */}
        {canUploadFiles && (
          <div className="border border-edge rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-content-secondary">{t('files.title')}</label>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 text-xs text-content-muted hover:text-content transition-colors">
                <Paperclip size={12} /> {t('files.attach')}
              </button>
            </div>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileAdd} />
            {pendingFiles.length > 0 && (
              <div className="space-y-1" data-testid="pending-files">
                {pendingFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-secondary text-xs">
                    <Paperclip size={10} className="text-content-faint shrink-0" />
                    <span className="truncate flex-1 text-content-secondary">{file.name}</span>
                    <button type="button" onClick={() => handleRemoveFile(idx)} className="text-content-faint hover:text-red-500 shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Costs — create / view the expense linked to this place (#1298).
            Same block, same flow as a booking: save first, then the editor. */}
        {isBudgetEnabled && (
          <BookingCostsSection
            placeId={place?.id ?? null}
            reservationId={null}
            hintKey="places.createExpenseHint"
            onCreate={handleCreateExpense}
            onEdit={handleEditExpense}
            onRemove={handleRemoveExpense}
          />
        )}

      </form>
      {twoColumn && (
        <CollectionPicker bias={locationBias} onSelect={handleSelectMapsResult} t={t} />
      )}
      </div>
    </Modal>
  )
}

interface TimeSectionProps {
  form: PlaceFormData
  handleChange: (field: string, value: string) => void
  assignmentId: number | null
  dayAssignments: Assignment[]
  hasTimeError: boolean
  t: (key: string, params?: Record<string, string | number>) => string
}

function TimeSection({ form, handleChange, assignmentId, dayAssignments, hasTimeError, t }: TimeSectionProps) {

  const collisions = useMemo(() => {
    if (!assignmentId || !form.place_time || form.place_time.length < 5) return []
    // Find the day_id for the current assignment
    const current = dayAssignments.find(a => a.id === assignmentId)
    if (!current) return []
    const myStart = form.place_time
    const myEnd = form.end_time && form.end_time.length >= 5 ? form.end_time : null
    return dayAssignments.filter(a => {
      if (a.id === assignmentId) return false
      if (a.day_id !== current.day_id) return false
      const aStart = a.place?.place_time
      const aEnd = a.place?.end_time
      if (!aStart) return false
      // Check overlap: two intervals overlap if start < otherEnd AND otherStart < end
      const s1 = myStart, e1 = myEnd || myStart
      const s2 = aStart, e2 = aEnd || aStart
      return s1 < (e2 || '23:59') && s2 < (e1 || '23:59') && s1 !== e2 && s2 !== e1
    })
  }, [assignmentId, dayAssignments, form.place_time, form.end_time])

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.startTime')}</label>
          <CustomTimePicker
            value={form.place_time}
            onChange={v => handleChange('place_time', v)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-content-secondary mb-1">{t('places.endTime')}</label>
          <CustomTimePicker
            value={form.end_time}
            onChange={v => handleChange('end_time', v)}
          />
        </div>
      </div>
      {hasTimeError && (
        <div className="flex items-center gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-caption bg-warning-soft text-warning">
          <AlertTriangle size={13} className="shrink-0" />
          {t('places.endTimeBeforeStart')}
        </div>
      )}
      {collisions.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-caption bg-warning-soft text-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            {t('places.timeCollision')}{' '}
            {collisions.map(a => a.place?.name).filter(Boolean).join(', ')}
          </span>
        </div>
      )}
    </div>
  )
}
