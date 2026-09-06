import { useState, useEffect, useRef } from 'react'
import Modal from '../shared/Modal'
import { Calendar, Camera, Search, X, UserPlus, Bell } from 'lucide-react'
import { tripsApi, authApi } from '../../api/client'
import CustomSelect from '../shared/CustomSelect'
import { useAuthStore } from '../../store/authStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useCanDo } from '../../store/permissionsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import { normalizeImageFile } from '../../utils/convertHeic'
import { getApiErrorMessage, type Trip } from '../../types'
import type { TripCreateRequest } from '@trek/shared'
import { NumericInput } from '../shared/NumericInput'
import { currenciesWith, SYMBOLS } from '../Budget/BudgetPanel.constants'

type DateShiftMode = 'keep_bookings' | 'shift_all'

interface TripFormModalProps {
  isOpen: boolean
  onClose: () => void
  // Create returns the new trip (so we can attach members / upload the cover);
  // update resolves without a payload.
  onSave: (data: TripCreateRequest & { date_shift_mode?: DateShiftMode }) => Promise<{ trip?: Trip } | void> | void
  trip: Trip | null
  onCoverUpdate?: (tripId: number, coverUrl: string | null) => void
}

interface CoverSearchPhoto {
  id: string
  url: string
  thumb: string
  description?: string | null
  photographer?: string | null
  link?: string | null
}

export default function TripFormModal({ isOpen, onClose, onSave, trip, onCoverUpdate }: TripFormModalProps) {
  const isEditing = !!trip
  const fileRef = useRef<HTMLInputElement>(null)
  const coverSearchSeq = useRef(0)
  // The staged cover lives on as an object URL until it is replaced or the modal goes.
  const previewUrlRef = useRef<string | null>(null)
  const toast = useToast()
  const { t } = useTranslation()
  const currentUser = useAuthStore(s => s.user)
  const defaultCurrency = useSettingsStore(s => s.settings.default_currency) || 'EUR'
  const tripRemindersEnabled = useAuthStore(s => s.tripRemindersEnabled)
  const setTripRemindersEnabled = useAuthStore(s => s.setTripRemindersEnabled)
  const can = useCanDo()
  const canUploadCover = !isEditing || can('trip_cover_upload', trip)
  const canEditTrip = !isEditing || can('trip_edit', trip)

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    start_date: '',
    end_date: '',
    currency: 'EUR',
    reminder_days: 0 as number,
    day_count: 7 as number | '',
  })
  const [customReminder, setCustomReminder] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null)
  const [pendingUnsplashUrl, setPendingUnsplashUrl] = useState<string | null>(null)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [coverSearchQuery, setCoverSearchQuery] = useState('')
  const [coverSearchResults, setCoverSearchResults] = useState<CoverSearchPhoto[]>([])
  const [coverSearchError, setCoverSearchError] = useState('')
  const [searchingCover, setSearchingCover] = useState(false)
  // Drives the drop zone's hover look. Used to be four handlers writing
  // element.style directly, which is how the indigo dragover colour survived
  // the move to a configurable accent.
  const [coverDragActive, setCoverDragActive] = useState(false)
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([])
  const [selectedMembers, setSelectedMembers] = useState<number[]>([])
  const [existingMembers, setExistingMembers] = useState<{ id: number; username: string }[]>([])
  const [memberSelectValue, setMemberSelectValue] = useState('')
  // Set when a start-date change on a dated trip needs the user to pick how the
  // itinerary follows the new dates (#1288); holds the payload awaiting that choice.
  const [pendingDateShift, setPendingDateShift] = useState<(TripCreateRequest & { date_shift_mode?: DateShiftMode }) | null>(null)
  const [dateShiftMode, setDateShiftMode] = useState<DateShiftMode>('keep_bookings')

  useEffect(() => {
    if (trip) {
      const rd = trip.reminder_days ?? 3
      setFormData({
        title: trip.title || '',
        description: trip.description || '',
        start_date: trip.start_date || '',
        end_date: trip.end_date || '',
        currency: trip.currency || 'EUR',
        reminder_days: rd,
        day_count: trip.day_count || 7,
      })
      setCustomReminder(![0, 1, 3, 9].includes(rd))
      setCoverPreview(trip.cover_image || null)
      setCoverSearchQuery('')
    } else {
      setFormData({ title: '', description: '', start_date: '', end_date: '', currency: defaultCurrency, reminder_days: tripRemindersEnabled ? 3 : 0, day_count: 7 })
      setCustomReminder(false)
      setCoverPreview(null)
      setCoverSearchQuery('')
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPendingCoverFile(null)
    setPendingUnsplashUrl(null)
    setCoverSearchResults([])
    setCoverSearchError('')
    setSelectedMembers([])
    setPendingDateShift(null)
    setDateShiftMode('keep_bookings')
    setError('')
    setExistingMembers([])
    // The planner keeps this modal mounted while it is closed, so nothing may be
    // fetched until it is actually open.
    if (isOpen) {
      authApi.getAppConfig().then((c: { trip_reminders_enabled?: boolean }) => {
        if (c?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(c.trip_reminders_enabled)
      }).catch(() => {})
      authApi.listUsers().then(d => setAllUsers(d.users || [])).catch(() => {})
      if (trip) {
        tripsApi.getMembers(trip.id).then(d => setExistingMembers(d.members || [])).catch(() => {})
      }
    }
  }, [trip, isOpen])

  useEffect(() => {
    if (!trip && isOpen) {
      setFormData(prev => ({ ...prev, reminder_days: tripRemindersEnabled ? 3 : 0 }))
    }
  }, [tripRemindersEnabled])

  // A staged cover that never got uploaded would otherwise pin the full image for
  // as long as the tab lives.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!formData.title.trim()) { setError(t('dashboard.titleRequired')); return }
    if (formData.start_date && formData.end_date && new Date(formData.end_date) < new Date(formData.start_date)) {
      setError(t('dashboard.endDateError')); return
    }
    if (!formData.start_date && !formData.end_date) {
      const dc = Number(formData.day_count)
      if (formData.day_count === '' || !Number.isInteger(dc) || dc < 1 || dc > 365) {
        setError(t('dashboard.dayCountRequired')); return
      }
    }
    const payload: TripCreateRequest & { date_shift_mode?: DateShiftMode } = {
      title: formData.title.trim(),
      description: formData.description.trim() || null,
      start_date: formData.start_date || null,
      end_date: formData.end_date || null,
      currency: formData.currency,
      reminder_days: formData.reminder_days,
      ...(!formData.start_date && !formData.end_date ? { day_count: Number(formData.day_count) } : {}),
    }
    // Moving the start of a dated trip shifts the whole day grid, so let the user
    // choose how bookings follow before anything is saved (#1288). End-date-only
    // changes don't shift days and dateless transitions have nothing to shift.
    if (isEditing && trip?.start_date && trip?.end_date
      && payload.start_date && payload.end_date && payload.start_date !== trip.start_date) {
      setDateShiftMode('keep_bookings')
      setPendingDateShift(payload)
      return
    }
    await performSave(payload)
  }

  const performSave = async (payload: TripCreateRequest & { date_shift_mode?: DateShiftMode }) => {
    setIsLoading(true)
    try {
      const result = await onSave(payload)
      const createdTrip = result ? result.trip : undefined
      // Add selected members for newly created trips
      if (selectedMembers.length > 0 && createdTrip?.id) {
        let memberAddFailed = false
        for (const userId of selectedMembers) {
          const user = allUsers.find(u => u.id === userId)
          if (user) {
            try { await tripsApi.addMember(createdTrip.id, user.username) } catch { memberAddFailed = true }
          }
        }
        if (memberAddFailed) toast.error(t('trips.memberAddError'))
      }
      // Upload pending cover for newly created trips
      if (pendingCoverFile && createdTrip?.id) {
        try {
          const fd = new FormData()
          fd.append('cover', pendingCoverFile)
          const data = await tripsApi.uploadCover(createdTrip.id, fd)
          onCoverUpdate?.(createdTrip.id, data.cover_image)
        } catch {
          // Cover upload failed but trip was created — surface it without blocking the create
          toast.error(t('dashboard.coverUploadError'))
        }
      } else if (pendingUnsplashUrl && createdTrip?.id) {
        try {
          await tripsApi.update(createdTrip.id, { cover_image: pendingUnsplashUrl })
          onCoverUpdate?.(createdTrip.id, pendingUnsplashUrl)
        } catch {
          toast.error(t('dashboard.coverSaveError'))
        }
      }
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCoverSelect = async (file: File | null | undefined) => {
    if (!file) return
    // HEIC/HEIF from iOS can't be rendered or stored as-is — convert to JPEG first
    const normalized = await normalizeImageFile(file)
    setPendingUnsplashUrl(null)
    if (isEditing && trip?.id) {
      // Existing trip: upload immediately
      uploadCoverNow(normalized)
    } else {
      // New trip: stage for upload after creation
      setPendingCoverFile(normalized)
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = URL.createObjectURL(normalized)
      setCoverPreview(previewUrlRef.current)
    }
  }

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleCoverSelect(e.target.files?.[0])
    e.target.value = ''
  }

  const uploadCoverNow = async (file: File) => {
    setUploadingCover(true)
    try {
      const fd = new FormData()
      fd.append('cover', file)
      const data = await tripsApi.uploadCover(trip.id, fd)
      setCoverPreview(data.cover_image)
      onCoverUpdate?.(trip.id, data.cover_image)
      toast.success(t('dashboard.coverSaved'))
    } catch {
      toast.error(t('dashboard.coverUploadError'))
    } finally {
      setUploadingCover(false)
    }
  }

  const handleCoverSearch = async () => {
    const query = coverSearchQuery.trim() || formData.title.trim()
    if (!query) {
      setCoverSearchError(t('dashboard.unsplashQueryRequired'))
      return
    }
    // Guard against out-of-order responses: only the latest search applies its
    // results, so a slow earlier query can't overwrite a newer one. #1277 review
    const seq = ++coverSearchSeq.current
    setSearchingCover(true)
    setCoverSearchError('')
    try {
      const data = await tripsApi.searchCoverImages(query)
      if (seq !== coverSearchSeq.current) return
      const photos = data.photos || []
      setCoverSearchResults(photos)
      if (photos.length === 0) setCoverSearchError(t('dashboard.unsplashNoResults'))
    } catch (err: unknown) {
      if (seq !== coverSearchSeq.current) return
      setCoverSearchError(getApiErrorMessage(err, t('dashboard.coverSearchError')))
    } finally {
      if (seq === coverSearchSeq.current) setSearchingCover(false)
    }
  }

  const handleUnsplashSelect = async (photo: CoverSearchPhoto) => {
    if (!photo.url) return
    setPendingCoverFile(null)
    if (isEditing && trip?.id) {
      setUploadingCover(true)
      try {
        await tripsApi.update(trip.id, { cover_image: photo.url })
        setCoverPreview(photo.url)
        onCoverUpdate?.(trip.id, photo.url)
        toast.success(t('dashboard.coverSaved'))
      } catch (err: unknown) {
        toast.error(getApiErrorMessage(err, t('dashboard.coverSaveError')))
      } finally {
        setUploadingCover(false)
      }
    } else {
      setPendingUnsplashUrl(photo.url)
      setCoverPreview(photo.url)
    }
  }

  const handleRemoveCover = async () => {
    if (pendingCoverFile || pendingUnsplashUrl) {
      setPendingCoverFile(null)
      setPendingUnsplashUrl(null)
      setCoverPreview(null)
      return
    }
    // Nothing pending left, so the preview is a saved trip's stored cover.
    try {
      await tripsApi.update(trip.id, { cover_image: null })
      setCoverPreview(null)
      onCoverUpdate?.(trip.id, null)
    } catch {
      toast.error(t('dashboard.coverRemoveError'))
    }
  }

  // Paste support for cover image
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!canUploadCover) return
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) handleCoverSelect(file)
        return
      }
    }
  }

  const update = (field, value) => setFormData(prev => {
    const next = { ...prev, [field]: value }
    if (field === 'start_date' && value) {
      if (!prev.end_date || prev.end_date < value) {
        next.end_date = value
      } else if (prev.start_date) {
        const oldStart = new Date(prev.start_date + 'T00:00:00Z')
        const oldEnd = new Date(prev.end_date + 'T00:00:00Z')
        const duration = Math.round((oldEnd.getTime() - oldStart.getTime()) / 86400000)
        const newEnd = new Date(value + 'T00:00:00Z')
        newEnd.setDate(newEnd.getDate() + duration)
        next.end_date = newEnd.toISOString().split('T')[0]
      }
    }
    return next
  })

  /* The dashboard's shapes, in the app's own tokens.
     `.trek-dash` deliberately scopes its palette to that page, so none of its
     variables are reachable from here — what carries over is the geometry:
     generous radii, grouped panels instead of a single stack of labelled
     fields, and overline captions rather than sentence-case labels. */
  const inputCls = "w-full px-3.5 py-2.5 border border-edge rounded-xl bg-surface-input text-content placeholder:text-content-faint focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent text-body transition-shadow"
  const labelCls = "flex items-center gap-1 text-caption font-semibold uppercase tracking-[0.14em] text-content-faint mb-2"
  const ghostBtnCls = "px-4 py-2.5 text-body font-medium text-content-secondary hover:text-content border border-edge rounded-xl hover:bg-surface-hover transition-colors"
  const primaryBtnCls = "px-5 py-2.5 text-body font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-text rounded-xl shadow-card transition-colors flex items-center gap-2"
  /* Two columns once there is room for them: the form had grown to eight stacked
     blocks and the create button sat a full screen below the title. Left is what
     the trip looks like, right is when and with whom. One column below md. */
  const columnCls = "flex flex-col gap-4"
  const panelCls = "rounded-2xl border border-edge bg-surface-secondary p-4 space-y-3.5"

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={pendingDateShift ? t('dashboard.dateShiftTitle') : isEditing ? t('dashboard.editTrip') : t('dashboard.createTrip')}
      /* The date-shift step is two radio buttons and a sentence — it would look
         lost across the width the form itself needs. */
      size={pendingDateShift ? 'md' : '2xl'}
      footer={
        <div className="flex gap-3 justify-end">
          {pendingDateShift ? (
            <>
              <button type="button" onClick={() => setPendingDateShift(null)} disabled={isLoading} className={ghostBtnCls}>
                {t('common.back')}
              </button>
              <button type="button" onClick={() => performSave({ ...pendingDateShift, date_shift_mode: dateShiftMode })} disabled={isLoading}
                className={primaryBtnCls}>
                {isLoading
                  ? <><div className="w-4 h-4 border-2 border-accent-text/30 border-t-accent-text rounded-full animate-spin" />{t('common.saving')}</>
                  : t('common.update')}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className={ghostBtnCls}>
                {t('common.cancel')}
              </button>
              <button type="button" onClick={handleSubmit} disabled={isLoading} className={primaryBtnCls}>
                {isLoading
                  ? <><div className="w-4 h-4 border-2 border-accent-text/30 border-t-accent-text rounded-full animate-spin" />{t('common.saving')}</>
                  : isEditing ? t('common.update') : t('dashboard.createTrip')}
              </button>
            </>
          )}
        </div>
      }
    >
      {pendingDateShift && (
        <div className="space-y-3">
          {error && (
            <div className="p-3 bg-danger-soft border border-danger/30 rounded-xl text-body text-danger">{error}</div>
          )}
          <p className="text-body text-content-secondary">{t('dashboard.dateShiftIntro')}</p>
          {([
            { mode: 'keep_bookings' as DateShiftMode, label: t('dashboard.dateShiftKeepBookings'), desc: t('dashboard.dateShiftKeepBookingsDesc') },
            { mode: 'shift_all' as DateShiftMode, label: t('dashboard.dateShiftAll'), desc: t('dashboard.dateShiftAllDesc') },
          ]).map(({ mode, label, desc }) => (
            <label key={mode}
              className={`flex items-start gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${dateShiftMode === mode ? 'border-accent bg-surface-selected' : 'border-edge hover:bg-surface-hover'}`}>
              <input type="radio" name="date_shift_mode" value={mode} checked={dateShiftMode === mode}
                onChange={() => setDateShiftMode(mode)} className="mt-1 accent-[var(--accent)]" />
              <span className="block text-body font-medium text-content">
                {label}
                <span className="block text-body font-normal text-content-muted mt-0.5">{desc}</span>
              </span>
            </label>
          ))}
          <p className="text-caption text-content-faint">{t('dashboard.dateShiftHint')}</p>
        </div>
      )}
      <form onSubmit={handleSubmit} className={pendingDateShift ? 'hidden' : 'space-y-4'} onPaste={handlePaste}>
        {error && (
          <div className="p-3 bg-danger-soft border border-danger/30 rounded-xl text-body text-danger">{error}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 items-start">

        {/* Left column — what the trip is: its picture, its name, what it is about. */}
        <div className={columnCls}>

        {/* Cover image — gated by trip_cover_upload permission */}
        {canUploadCover && <div className={panelCls}>
          <label className={labelCls}>{t('dashboard.coverImage')}</label>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleCoverChange} />
          {coverPreview ? (
            <div className="relative h-[130px] rounded-xl overflow-hidden">
              <img src={coverPreview} alt="" className="w-full h-full object-cover" />
              <div className="absolute bottom-2 right-2 flex gap-1.5">
                {/* Chrome sitting on top of a photo, so it is deliberately dark in
                    both themes rather than following the surface tokens. */}
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingCover}
                  className="flex items-center gap-1 px-2.5 py-[5px] rounded-lg bg-black/55 backdrop-blur-sm text-white text-caption font-semibold">
                  <Camera size={12} /> {uploadingCover ? t('common.uploading') : t('common.change')}
                </button>
                <button type="button" onClick={handleRemoveCover} aria-label={t('common.remove')}
                  className="flex items-center px-2 py-[5px] rounded-lg bg-black/55 backdrop-blur-sm text-white">
                  <X size={12} />
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingCover}
              onDragOver={e => { e.preventDefault(); setCoverDragActive(true) }}
              onDragLeave={() => setCoverDragActive(false)}
              onDrop={e => { e.preventDefault(); setCoverDragActive(false); const file = e.dataTransfer.files?.[0]; if (file?.type.startsWith('image/')) handleCoverSelect(file) }}
              className={`w-full h-[130px] px-4 border-2 border-dashed rounded-xl flex items-center justify-center gap-1.5 text-body transition-colors ${
                coverDragActive
                  ? 'border-accent bg-accent-subtle text-content'
                  : 'border-edge text-content-faint hover:border-edge-secondary hover:text-content-muted'
              }`}>
              <Camera size={15} /> {uploadingCover ? t('common.uploading') : t('dashboard.addCoverImage')}
            </button>
          )}
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={coverSearchQuery}
              onChange={e => setCoverSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCoverSearch() } }}
              placeholder={t('dashboard.unsplashSearchPlaceholder')}
              className={inputCls}
            />
            <button type="button" onClick={handleCoverSearch} disabled={searchingCover || (!coverSearchQuery.trim() && !formData.title.trim())}
              className="px-3 py-2 text-body text-content-secondary border border-edge rounded-xl hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap">
              {searchingCover ? <div className="w-4 h-4 border-2 border-edge border-t-content-muted rounded-full animate-spin" /> : <Search size={14} />}
              {t('dashboard.searchUnsplash')}
            </button>
          </div>
          {coverSearchError && <p className="text-caption text-danger mt-1.5">{coverSearchError}</p>}
          {coverSearchResults.length > 0 && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              {coverSearchResults.map(photo => (
                <button
                  type="button"
                  key={photo.id}
                  onClick={() => handleUnsplashSelect(photo)}
                  aria-label={t('dashboard.useUnsplashPhoto', { photographer: photo.photographer || 'Unsplash' })}
                  className={`relative h-20 overflow-hidden rounded-xl border transition-colors ${coverPreview === photo.url ? 'border-accent ring-2 ring-accent/20' : 'border-edge hover:border-content-faint'}`}
                >
                  <img src={photo.thumb} alt={photo.description || ''} loading="lazy" className="w-full h-full object-cover" />
                  {photo.photographer && (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-1 text-caption text-white">
                      {photo.photographer}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>}

        <div className={`${panelCls} flex-1`}>
          <div>
            <label className={labelCls}>
              {t('dashboard.tripTitle')} <span className="text-danger">*</span>
            </label>
            <input type="text" value={formData.title} onChange={e => canEditTrip && update('title', e.target.value)}
              required readOnly={!canEditTrip} placeholder={t('dashboard.tripTitlePlaceholder')} className={inputCls} />
          </div>

          <div>
            <label className={labelCls}>{t('dashboard.tripDescription')}</label>
            <textarea value={formData.description} onChange={e => canEditTrip && update('description', e.target.value)}
              readOnly={!canEditTrip} placeholder={t('dashboard.tripDescriptionPlaceholder')} rows={3}
              className={`${inputCls} resize-none`} />
          </div>
        </div>

        </div>{/* /left column */}

        {/* Right column — when it happens, in what currency, with whom. */}
        <div className={columnCls}>

        <div className={panelCls}>

        {/* min-w-0 on both cells: a grid item defaults to min-width:auto, so a
            long date ("12. Sept. 2026" and the keyboard button beside it) pushed
            the cell past its track and the two columns overlapped (#2267). */}
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label className={labelCls}>
              <Calendar className="w-3.5 h-3.5" />{t('dashboard.startDate')}
            </label>
            <CustomDatePicker value={formData.start_date} onChange={v => update('start_date', v)} placeholder={t('dashboard.startDate')} />
          </div>
          <div className="min-w-0">
            <label className={labelCls}>
              <Calendar className="w-3.5 h-3.5" />{t('dashboard.endDate')}
            </label>
            <CustomDatePicker value={formData.end_date} onChange={v => update('end_date', v)} placeholder={t('dashboard.endDate')} />
          </div>
        </div>

        {!formData.start_date && !formData.end_date && (
          <div>
            <label className={labelCls}>
              {t('dashboard.dayCount')}
            </label>
            <NumericInput min={1} max={365} value={formData.day_count}
              onValueChange={raw => {
                if (raw === '') { update('day_count', ''); return }
                const n = Math.floor(Number(raw))
                if (Number.isFinite(n)) update('day_count', Math.min(365, Math.max(1, n)))
              }}
              className={inputCls} />
            <p className="text-caption text-content-faint mt-1.5">{t('dashboard.dayCountHint')}</p>
          </div>
        )}

        <div>
          <label className={labelCls}>{t('dashboard.currency')}</label>
          <CustomSelect
            value={formData.currency}
            onChange={v => canEditTrip && update('currency', v)}
            disabled={!canEditTrip}
            options={currenciesWith(formData.currency).map(c => ({ value: c, label: `${c} (${SYMBOLS[c] || c})` }))}
            searchable
          />
        </div>

        {/* Reminder — only visible to owner (or when creating) */}
        {(!isEditing || trip?.user_id === currentUser?.id || currentUser?.role === 'admin') && (
        <div className={!tripRemindersEnabled ? 'opacity-50' : ''}>
          <label className={labelCls}>
            <Bell className="w-3.5 h-3.5" />{t('trips.reminder')}
          </label>
          {!tripRemindersEnabled ? (
            <p className="text-caption text-content-faint bg-surface rounded-xl p-3">
              {t('trips.reminderDisabledHint')}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 0, label: t('trips.reminderNone') },
                  { value: 1, label: `1 ${t('trips.reminderDay')}` },
                  { value: 3, label: `3 ${t('trips.reminderDays')}` },
                  { value: 9, label: `9 ${t('trips.reminderDays')}` },
                ].map(opt => (
                  <button key={opt.value} type="button"
                    onClick={() => { update('reminder_days', opt.value); setCustomReminder(false) }}
                    className={`px-3 py-1.5 text-caption font-medium rounded-full border transition-colors ${
                      !customReminder && formData.reminder_days === opt.value
                        ? 'bg-accent text-accent-text border-accent'
                        : 'bg-surface text-content-secondary border-edge hover:border-content-faint'
                    }`}>
                    {opt.label}
                  </button>
                ))}
                <button type="button"
                  onClick={() => { setCustomReminder(true); if ([0, 1, 3, 9].includes(formData.reminder_days)) update('reminder_days', 7) }}
                  className={`px-3 py-1.5 text-caption font-medium rounded-full border transition-colors ${
                    customReminder
                      ? 'bg-accent text-accent-text border-accent'
                      : 'bg-surface text-content-secondary border-edge hover:border-content-faint'
                  }`}>
                  {t('trips.reminderCustom')}
                </button>
              </div>
              {customReminder && (
                <div className="flex items-center gap-2 mt-2">
                  <NumericInput min={1} max={30}
                    value={formData.reminder_days}
                    onValueChange={raw => update('reminder_days', Math.max(1, Math.min(30, Number(raw) || 1)))}
                    className="w-20 px-3 py-1.5 border border-edge rounded-xl bg-surface-input text-body text-content focus:outline-none focus:ring-2 focus:ring-accent/40" />
                  <span className="text-caption text-content-muted">{t('trips.reminderDaysBefore')}</span>
                </div>
              )}
            </>
          )}
        </div>
        )}

        {/* Members */}
        {allUsers.filter(u => u.id !== currentUser?.id).length > 0 && (
          <div>
            <label className={labelCls}>
              <UserPlus className="w-3.5 h-3.5" />{t('dashboard.addMembers')}
            </label>
            {/* Existing members (editing mode) */}
            {isEditing && existingMembers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {existingMembers.map(m => (
                  <button type="button" key={m.id} disabled={m.id === currentUser?.id}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-body font-medium bg-surface text-content border border-edge"
                    onClick={async () => {
                      if (m.id === currentUser?.id) return
                      try {
                        await tripsApi.removeMember(trip!.id, m.id)
                        setExistingMembers(prev => prev.filter(x => x.id !== m.id))
                        toast.success(t('trips.memberRemoved', { username: m.username }))
                      } catch { toast.error(t('trips.memberRemoveError')) }
                    }}
                    style={{ cursor: m.id === currentUser?.id ? 'default' : 'pointer' }}>
                    {m.username}
                    {m.id !== currentUser?.id && <X size={11} className="text-content-faint" />}
                  </button>
                ))}
              </div>
            )}
            {/* Newly selected members (both modes) */}
            {selectedMembers.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedMembers.map(uid => {
                  const user = allUsers.find(u => u.id === uid)!
                  return (
                    <button type="button" key={uid} onClick={() => setSelectedMembers(prev => prev.filter(id => id !== uid))}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-body font-medium bg-surface text-content border border-edge cursor-pointer">
                      {user.username}
                      <X size={11} className="text-content-faint" />
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <CustomSelect
                value={memberSelectValue}
                onChange={async value => {
                  if (isEditing && trip?.id) {
                    const user = allUsers.find(u => u.id === Number(value))
                    if (user) {
                      try {
                        await tripsApi.addMember(trip.id, user.username)
                        setExistingMembers(prev => [...prev, { id: user.id, username: user.username }])
                        toast.success(t('trips.memberAdded', { username: user.username }))
                      } catch { toast.error(t('trips.memberAddError')) }
                    }
                  } else {
                    setSelectedMembers(prev => prev.includes(Number(value)) ? prev : [...prev, Number(value)])
                  }
                  setMemberSelectValue('')
                }}
                placeholder={t('dashboard.addMember')}
                options={allUsers.filter(u => u.id !== currentUser?.id && !selectedMembers.includes(u.id) && !existingMembers.some(m => m.id === u.id)).map(u => ({ value: u.id, label: u.username }))}
                searchable
                size="sm"
              />
            </div>
          </div>
        )}

        </div>{/* /right panel */}

        </div>{/* /right column */}

        </div>{/* /two-column grid */}
      </form>
    </Modal>
  )
}
