import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import { mapsApi } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { useToast } from '../shared/Toast'
import { Search, Paperclip, X, AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import CustomTimePicker from '../shared/CustomTimePicker'
import type { Place, Category, Assignment } from '../../types'

interface PlaceFormData {
  name: string
  description: string
  address: string
  lat: string
  lng: string
  category_id: string
  place_time: string
  end_time: string
  notes: string
  transport_mode: string
  website: string
}

function isGoogleMapsUrl(input: string): boolean {
  try {
    const { hostname, pathname } = new URL(input.trim())
    const h = hostname.toLowerCase()
    // maps.app.goo.gl, goo.gl/maps
    if (h === 'maps.app.goo.gl') return true
    if (h === 'goo.gl' && pathname.startsWith('/maps')) return true
    // maps.google.* (e.g. maps.google.com, maps.google.co.uk)
    // Must be maps.google.<tld> or maps.google.<sld>.<tld> — reject maps.google.evil.com
    if (/^maps\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)) return true
    // google.*/maps (e.g. google.com/maps, www.google.co.uk/maps)
    const bare = h.startsWith('www.') ? h.slice(4) : h
    if (/^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(bare) && pathname.startsWith('/maps')) return true
    return false
  } catch {
    return false
  }
}

const DEFAULT_FORM: PlaceFormData = {
  name: '',
  description: '',
  address: '',
  lat: '',
  lng: '',
  category_id: '',
  place_time: '',
  end_time: '',
  notes: '',
  transport_mode: 'walking',
  website: '',
}

interface PlaceFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: PlaceFormData, files?: File[]) => Promise<void> | void
  place: Place | null
  prefillCoords?: { lat: number; lng: number; name?: string; address?: string } | null
  tripId: number
  categories: Category[]
  onCategoryCreated: (category: Category) => void
  assignmentId: number | null
  dayAssignments?: Assignment[]
}

export default function PlaceFormModal({
  isOpen, onClose, onSave, place, prefillCoords, tripId, categories,
  onCategoryCreated, assignmentId, dayAssignments = [],
}: PlaceFormModalProps) {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [mapsSearch, setMapsSearch] = useState('')
  const [mapsResults, setMapsResults] = useState([])
  const [isSearchingMaps, setIsSearchingMaps] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])
  const fileRef = useRef(null)
  const [acSuggestions, setAcSuggestions] = useState<{ placeId: string; mainText: string; secondaryText: string }[]>([])
  const [acHighlight, setAcHighlight] = useState(-1)
  const acDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const acAbortRef = useRef<AbortController | null>(null)
  const toast = useToast()
  const { t, language } = useTranslation()
  const { hasMapsKey } = useAuthStore()
  const can = useCanDo()
  const tripObj = useTripStore((s) => s.trip)
  const canUploadFiles = can('file_upload', tripObj)

  useEffect(() => {
    if (place) {
      setForm({
        name: place.name || '',
        description: place.description || '',
        address: place.address || '',
        lat: place.lat || '',
        lng: place.lng || '',
        category_id: place.category_id || '',
        place_time: place.place_time || '',
        end_time: place.end_time || '',
        notes: place.notes || '',
        transport_mode: place.transport_mode || 'walking',
        website: place.website || '',
      })
    } else if (prefillCoords) {
      setForm({
        ...DEFAULT_FORM,
        lat: String(prefillCoords.lat),
        lng: String(prefillCoords.lng),
        name: prefillCoords.name || '',
        address: prefillCoords.address || '',
      })
    } else {
      setForm(DEFAULT_FORM)
    }
    setPendingFiles([])
  }, [place, prefillCoords, isOpen])

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
      const result = await mapsApi.autocomplete(query, language, locationBias, controller.signal)
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
      return
    }

    acDebounceRef.current = setTimeout(() => fetchSuggestions(trimmed), 300)

    return () => {
      if (acDebounceRef.current) clearTimeout(acDebounceRef.current)
    }
  }, [mapsSearch, fetchSuggestions])

  const handleChange = (field, value) => {
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
          }))
          setMapsResults([])
          setMapsSearch('')
          toast.success(t('places.urlResolved'))
          return
        }
      }
      const result = await mapsApi.search(mapsSearch, language)
      setMapsResults(result.places || [])
    } catch (err: unknown) {
      toast.error(t('places.mapsSearchError'))
    } finally {
      setIsSearchingMaps(false)
    }
  }

  const handleSelectMapsResult = (result) => {
    setForm(prev => ({
      ...prev,
      name: result.name || prev.name,
      address: result.address || prev.address,
      lat: result.lat || prev.lat,
      lng: result.lng || prev.lng,
      google_place_id: result.google_place_id || prev.google_place_id,
      osm_id: result.osm_id || prev.osm_id,
      website: result.website || prev.website,
      phone: result.phone || prev.phone,
    }))
    setMapsResults([])
    setMapsSearch('')
  }

  const handleSelectSuggestion = async (suggestion: { placeId: string; mainText: string; secondaryText: string }) => {
    setAcSuggestions([])
    setAcHighlight(-1)
    const previousSearch = mapsSearch
    setMapsSearch('')
    setForm(prev => ({ ...prev, name: suggestion.mainText }))
    setIsSearchingMaps(true)
    try {
      const result = await mapsApi.details(suggestion.placeId, language)
      if (result.place) {
        handleSelectMapsResult(result.place)
      } else {
        setMapsSearch(previousSearch)
        toast.error(t('places.mapsSearchError'))
      }
    } catch (err) {
      console.error('Failed to fetch place details:', err)
      setMapsSearch(previousSearch)
      toast.error(t('places.mapsSearchError'))
    } finally {
      setIsSearchingMaps(false)
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
      if (cat) setForm(prev => ({ ...prev, category_id: cat.id }))
      setNewCategoryName('')
      setShowNewCategory(false)
    } catch (err: unknown) {
      toast.error(t('places.categoryCreateError'))
    }
  }

  const handleFileAdd = (e) => {
    const files = Array.from((e.target as HTMLInputElement).files || [])
    setPendingFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const handleRemoveFile = (idx) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
  }

  // Paste support for files/images
  const handlePaste = (e) => {
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

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      toast.error(t('places.nameRequired'))
      return
    }
    setIsSaving(true)
    try {
      await onSave({
        ...form,
        lat: form.lat ? parseFloat(form.lat) : null,
        lng: form.lng ? parseFloat(form.lng) : null,
        category_id: form.category_id || null,
        _pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
      })
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={place ? t('places.editPlace') : t('places.addPlace')}
      size="lg"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving || hasTimeError}
            className="px-6 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 disabled:opacity-60 font-medium"
          >
            {isSaving ? t('common.saving') : place ? t('common.update') : t('common.add')}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" onPaste={handlePaste}>
        {/* Place Search */}
        <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
          {!hasMapsKey && (
            <p className="mb-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              {t('places.osmActive')}
            </p>
          )}
          <div className="relative">
            <div className="flex gap-2">
              <input
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
                className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
              />
              <button
                type="button"
                onClick={() => { setAcSuggestions([]); handleMapsSearch() }}
                disabled={isSearchingMaps}
                className="bg-slate-900 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-60"
              >
                {isSearchingMaps ? '...' : <Search className="w-4 h-4" />}
              </button>
            </div>

            {/* Autocomplete dropdown */}
            {acSuggestions.length > 0 && (
              <div className="absolute left-0 right-0 z-20 mt-1 bg-white rounded-lg border border-slate-200 shadow-lg overflow-hidden">
                {acSuggestions.map((s, idx) => (
                  <button
                    key={s.placeId}
                    type="button"
                    onMouseDown={() => handleSelectSuggestion(s)}
                    onMouseEnter={() => setAcHighlight(idx)}
                    className={`w-full text-left px-3 py-2 border-b border-slate-100 last:border-0 ${
                      idx === acHighlight ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-medium text-sm">{s.mainText}</div>
                    {s.secondaryText && (
                      <div className="text-xs text-slate-500 truncate">{s.secondaryText}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search results (populated after full search) */}
          {mapsResults.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden max-h-40 overflow-y-auto mt-2">
              {mapsResults.map((result, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSelectMapsResult(result)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                >
                  <div className="font-medium text-sm">{result.name}</div>
                  <div className="text-xs text-slate-500 truncate">{result.address}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formName')} *</label>
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
                <Loader2 className="w-4 h-4 animate-spin text-slate-400" aria-hidden="true" />
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formDescription')}</label>
          <textarea
            value={form.description}
            onChange={e => handleChange('description', e.target.value)}
            rows={2}
            placeholder={t('places.formDescriptionPlaceholder')}
            className="form-input" style={{ resize: 'vertical' }}
          />
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formNotes')}</label>
          <textarea
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
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formAddress')}</label>
          <input
            type="text"
            value={form.address}
            onChange={e => handleChange('address', e.target.value)}
            placeholder={t('places.formAddressPlaceholder')}
            className="form-input"
          />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <input
              type="number"
              step="any"
              value={form.lat}
              onChange={e => handleChange('lat', e.target.value)}
              onPaste={e => {
                const text = e.clipboardData.getData('text').trim()
                const match = text.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/)
                if (match) {
                  e.preventDefault()
                  handleChange('lat', match[1])
                  handleChange('lng', match[2])
                }
              }}
              placeholder={t('places.formLat')}
              className="form-input"
            />
            <input
              type="number"
              step="any"
              value={form.lng}
              onChange={e => handleChange('lng', e.target.value)}
              placeholder={t('places.formLng')}
              className="form-input"
            />
          </div>
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formCategory')}</label>
          {!showNewCategory ? (
            <div className="flex gap-2">
              <CustomSelect
                value={form.category_id}
                onChange={value => handleChange('category_id', value)}
                placeholder={t('places.noCategory')}
                options={[
                  { value: '', label: t('places.noCategory') },
                  ...(categories || []).map(c => ({
                    value: c.id,
                    label: c.name,
                  })),
                ]}
                style={{ flex: 1 }}
                size="sm"
              />
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
              <button type="button" onClick={handleCreateCategory} className="bg-slate-900 text-white px-3 rounded-lg hover:bg-slate-700 text-sm">
                OK
              </button>
              <button type="button" onClick={() => setShowNewCategory(false)} className="text-gray-500 px-2 text-sm">
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>

        {/* Time — only shown when editing, not when creating */}
        {place && (
          <TimeSection
            form={form}
            handleChange={handleChange}
            assignmentId={assignmentId}
            dayAssignments={dayAssignments}
            hasTimeError={hasTimeError}
            t={t}
          />
        )}

        {/* Website */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formWebsite')}</label>
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
          <div className="border border-gray-200 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">{t('files.title')}</label>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors">
                <Paperclip size={12} /> {t('files.attach')}
              </button>
            </div>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileAdd} />
            {pendingFiles.length > 0 && (
              <div className="space-y-1">
                {pendingFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 text-xs">
                    <Paperclip size={10} className="text-slate-400 shrink-0" />
                    <span className="truncate flex-1 text-slate-600">{file.name}</span>
                    <button type="button" onClick={() => handleRemoveFile(idx)} className="text-slate-400 hover:text-red-500 shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pendingFiles.length === 0 && (
              <p className="text-xs text-slate-400">{t('files.pasteHint')}</p>
            )}
          </div>
        )}

      </form>
    </Modal>
  )
}

interface TimeSectionProps {
  form: PlaceFormData
  handleChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void
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
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.startTime')}</label>
          <CustomTimePicker
            value={form.place_time}
            onChange={v => handleChange('place_time', v)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.endTime')}</label>
          <CustomTimePicker
            value={form.end_time}
            onChange={v => handleChange('end_time', v)}
          />
        </div>
      </div>
      {hasTimeError && (
        <div className="flex items-center gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--text-warning, #92400e)' }}>
          <AlertTriangle size={13} className="shrink-0" />
          {t('places.endTimeBeforeStart')}
        </div>
      )}
      {collisions.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--text-warning, #92400e)' }}>
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
