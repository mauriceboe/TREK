import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import apiClient from '../../api/client'
import { useTripStore } from '../../store/tripStore'
import { useAddonStore } from '../../store/addonStore'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import { Hotel, Utensils, Ticket, FileText, Users, Paperclip, X, ExternalLink, Link2 } from 'lucide-react'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import CustomTimePicker from '../shared/CustomTimePicker'
import { openFile } from '../../utils/fileDownload'
import type { Day, Place, Reservation, TripFile, AssignmentsMap, Accommodation } from '../../types'

const TYPE_OPTIONS = [
  { value: 'hotel',      labelKey: 'reservations.type.hotel',      Icon: Hotel },
  { value: 'restaurant', labelKey: 'reservations.type.restaurant', Icon: Utensils },
  { value: 'event',      labelKey: 'reservations.type.event',      Icon: Ticket },
  { value: 'tour',       labelKey: 'reservations.type.tour',       Icon: Users },
  { value: 'other',      labelKey: 'reservations.type.other',      Icon: FileText },
]

function buildAssignmentOptions(days, assignments, t, locale) {
  const options = []
  for (const day of (days || [])) {
    const da = (assignments?.[String(day.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    if (da.length === 0) continue
    const dayLabel = day.title || t('dayplan.dayN', { n: day.day_number })
    const dateStr = day.date ? ` · ${formatDate(day.date, locale)}` : ''
    const groupLabel = `${dayLabel}${dateStr}`
    options.push({ value: `_header_${day.id}`, label: groupLabel, disabled: true, isHeader: true })
    for (let i = 0; i < da.length; i++) {
      const place = da[i].place
      if (!place) continue
      const timeStr = place.place_time ? ` · ${place.place_time}${place.end_time ? ' – ' + place.end_time : ''}` : ''
      options.push({
        value: da[i].id,
        label: `  ${i + 1}. ${place.name}${timeStr}`,
        searchLabel: place.name,
        groupLabel,
        dayDate: day.date || null,
      })
    }
  }
  return options
}

interface ReservationModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: Record<string, string | number | null>) => Promise<void> | void
  reservation: Reservation | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  selectedDayId: number | null
  files?: TripFile[]
  onFileUpload?: (fd: FormData) => Promise<void>
  onFileDelete: (fileId: number) => Promise<void>
  accommodations?: Accommodation[]
  defaultAssignmentId?: number | null
}

export function ReservationModal({ isOpen, onClose, onSave, reservation, days, places, assignments, selectedDayId, files = [], onFileUpload, onFileDelete, accommodations = [], defaultAssignmentId = null }: ReservationModalProps) {
  const { id: tripId } = useParams<{ id: string }>()
  const loadFiles = useTripStore(s => s.loadFiles)
  const toast = useToast()
  const { t, locale } = useTranslation()
  const fileInputRef = useRef(null)

  const isBudgetEnabled = useAddonStore(s => s.isEnabled('budget'))
  const budgetItems = useTripStore(s => s.budgetItems)
  const budgetCategories = useMemo(() => {
    const cats = new Set<string>()
    budgetItems.forEach(i => { if (i.category) cats.add(i.category) })
    return Array.from(cats).sort()
  }, [budgetItems])

  const [form, setForm] = useState({
    title: '', type: 'other', status: 'pending',
    reservation_time: '', reservation_end_time: '', end_date: '', location: '', confirmation_number: '',
    notes: '', assignment_id: '' as string | number, accommodation_id: '' as string | number,
    price: '', budget_category: '',
    meta_check_in_time: '', meta_check_in_end_time: '', meta_check_out_time: '',
    hotel_place_id: '' as string | number, hotel_start_day: '' as string | number, hotel_end_day: '' as string | number,
  })
  const [isSaving, setIsSaving] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [linkedFileIds, setLinkedFileIds] = useState<number[]>([])

  const assignmentOptions = useMemo(
    () => buildAssignmentOptions(days, assignments, t, locale),
    [days, assignments, t, locale]
  )

  useEffect(() => {
    if (reservation) {
      const meta = typeof reservation.metadata === 'string' ? JSON.parse(reservation.metadata || '{}') : (reservation.metadata || {})
      const rawEnd = reservation.reservation_end_time || ''
      let endDate = ''
      let endTime = rawEnd
      if (rawEnd.includes('T')) {
        endDate = rawEnd.split('T')[0]
        endTime = rawEnd.split('T')[1]?.slice(0, 5) || ''
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
        endDate = rawEnd
        endTime = ''
      }
      setForm({
        title: reservation.title || '',
        type: reservation.type || 'other',
        status: reservation.status || 'pending',
        reservation_time: reservation.reservation_time ? reservation.reservation_time.slice(0, 16) : '',
        reservation_end_time: endTime,
        end_date: endDate,
        location: reservation.location || '',
        confirmation_number: reservation.confirmation_number || '',
        notes: reservation.notes || '',
        assignment_id: reservation.assignment_id || '',
        accommodation_id: reservation.accommodation_id || '',
        meta_check_in_time: meta.check_in_time || '',
        meta_check_in_end_time: meta.check_in_end_time || '',
        meta_check_out_time: meta.check_out_time || '',
        hotel_place_id: (() => { const acc = accommodations.find(a => a.id == reservation.accommodation_id); return acc?.place_id || '' })(),
        hotel_start_day: (() => { const acc = accommodations.find(a => a.id == reservation.accommodation_id); return acc?.start_day_id || '' })(),
        hotel_end_day: (() => { const acc = accommodations.find(a => a.id == reservation.accommodation_id); return acc?.end_day_id || '' })(),
        price: meta.price || '',
        budget_category: (meta.budget_category && budgetItems.some(i => i.category === meta.budget_category)) ? meta.budget_category : '',
      })
    } else {
      setForm({
        title: '', type: 'other', status: 'pending',
        reservation_time: '', reservation_end_time: '', end_date: '', location: '', confirmation_number: '',
        notes: '', assignment_id: defaultAssignmentId ?? '', accommodation_id: '',
        price: '', budget_category: '',
        meta_check_in_time: '', meta_check_in_end_time: '', meta_check_out_time: '',
        hotel_place_id: '', hotel_start_day: '', hotel_end_day: '',
      })
      setPendingFiles([])
    }
  }, [reservation, isOpen, selectedDayId, defaultAssignmentId])

  // Re-hydrate hotel day range when the accommodations prop arrives after the modal opens
  // (race: tripAccommodations fetch may complete after isOpen fires, leaving hotel fields empty)
  useEffect(() => {
    if (!isOpen || !reservation || reservation.type !== 'hotel' || !reservation.accommodation_id) return
    const acc = accommodations.find(a => a.id == reservation.accommodation_id)
    if (!acc) return
    setForm(prev => {
      if (prev.hotel_place_id !== '' || prev.hotel_start_day !== '' || prev.hotel_end_day !== '') return prev
      return { ...prev, hotel_place_id: acc.place_id, hotel_start_day: acc.start_day_id, hotel_end_day: acc.end_day_id }
    })
  }, [accommodations, isOpen, reservation])

  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  const isEndBeforeStart = (() => {
    if (!form.end_date || !form.reservation_time) return false
    const startDate = form.reservation_time.split('T')[0]
    const startTime = form.reservation_time.split('T')[1] || '00:00'
    const endTime = form.reservation_end_time || '00:00'
    const startFull = `${startDate}T${startTime}`
    const endFull = `${form.end_date}T${endTime}`
    return endFull <= startFull
  })()

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    if (isEndBeforeStart) { toast.error(t('reservations.validation.endBeforeStart')); return }
    setIsSaving(true)
    try {
      const metadata: Record<string, string> = {}
      if (form.type === 'hotel') {
        if (form.meta_check_in_time) metadata.check_in_time = form.meta_check_in_time
        if (form.meta_check_in_end_time) metadata.check_in_end_time = form.meta_check_in_end_time
        if (form.meta_check_out_time) metadata.check_out_time = form.meta_check_out_time
      }
      let combinedEndTime = form.reservation_end_time
      if (form.end_date) {
        combinedEndTime = form.reservation_end_time ? `${form.end_date}T${form.reservation_end_time}` : form.end_date
      } else if (form.reservation_end_time && form.reservation_time) {
        combinedEndTime = `${form.reservation_time.split('T')[0]}T${form.reservation_end_time}`
      }
      if (isBudgetEnabled) {
        if (form.price) metadata.price = form.price
        if (form.budget_category) metadata.budget_category = form.budget_category
      }

      const saveData: Record<string, any> = {
        title: form.title, type: form.type, status: form.status,
        reservation_time: form.type === 'hotel' ? null : (form.reservation_time || null),
        reservation_end_time: form.type === 'hotel' ? null : (combinedEndTime || null),
        location: form.location, confirmation_number: form.confirmation_number,
        notes: form.notes,
        assignment_id: form.assignment_id || null,
        accommodation_id: form.type === 'hotel' ? (form.accommodation_id || null) : null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        endpoints: [],
        needs_review: false,
      }
      if (isBudgetEnabled) {
        saveData.create_budget_entry = form.price && parseFloat(form.price) > 0
          ? { total_price: parseFloat(form.price), category: form.budget_category || t(`reservations.type.${form.type}`) || 'Other' }
          : { total_price: 0 }
      }
      if (form.type === 'hotel' && form.hotel_start_day && form.hotel_end_day) {
        saveData.create_accommodation = {
          place_id: form.hotel_place_id || null,
          start_day_id: form.hotel_start_day,
          end_day_id: form.hotel_end_day,
          check_in: form.meta_check_in_time || null,
          check_in_end: form.meta_check_in_end_time || null,
          check_out: form.meta_check_out_time || null,
          confirmation: form.confirmation_number || null,
        }
      }
      const saved = await onSave(saveData)
      if (!reservation?.id && saved?.id && pendingFiles.length > 0) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('reservation_id', saved.id)
          fd.append('description', form.title)
          await onFileUpload(fd)
        }
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleFileChange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    if (reservation?.id) {
      setUploadingFile(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('reservation_id', reservation.id)
        fd.append('description', reservation.title)
        await onFileUpload(fd)
        toast.success(t('reservations.toast.fileUploaded'))
      } catch {
        toast.error(t('reservations.toast.uploadError'))
      } finally {
        setUploadingFile(false)
        e.target.value = ''
      }
    } else {
      setPendingFiles(prev => [...prev, file])
      e.target.value = ''
    }
  }

  const attachedFiles = reservation?.id
    ? files.filter(f =>
        f.reservation_id === reservation.id ||
        linkedFileIds.includes(f.id) ||
        (f.linked_reservation_ids && f.linked_reservation_ids.includes(reservation.id))
      )
    : []

  const inputStyle = {
    width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
    padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)', background: 'var(--bg-input)',
  }
  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.03em' }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={reservation ? t('reservations.editTitle') : t('reservations.newTitle')}
      size="2xl"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={handleSubmit} disabled={isSaving || !form.title.trim() || isEndBeforeStart} style={{ padding: '8px 20px', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: isSaving || !form.title.trim() || isEndBeforeStart ? 0.5 : 1 }}>
            {isSaving ? t('common.saving') : reservation ? t('common.update') : t('common.add')}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Type selector */}
        <div>
          <label style={labelStyle}>{t('reservations.bookingType')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {TYPE_OPTIONS.map(({ value, labelKey, Icon }) => (
              <button key={value} type="button" onClick={() => set('type', value)} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', borderRadius: 99, border: '1px solid',
                fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s',
                background: form.type === value ? 'var(--text-primary)' : 'var(--bg-card)',
                borderColor: form.type === value ? 'var(--text-primary)' : 'var(--border-primary)',
                color: form.type === value ? 'var(--bg-primary)' : 'var(--text-muted)',
              }}>
                <Icon size={11} /> {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label style={labelStyle}>{t('reservations.titleLabel')} *</label>
          <input type="text" value={form.title} onChange={e => set('title', e.target.value)} required
            placeholder={t('reservations.titlePlaceholder')} style={inputStyle} />
        </div>

        {/* Assignment Picker (hidden for hotels) */}
        {form.type !== 'hotel' && assignmentOptions.length > 0 && (
          <div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>
                <Link2 size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />
                {t('reservations.linkAssignment')}
              </label>
              <CustomSelect
                value={form.assignment_id}
                onChange={value => {
                  set('assignment_id', value)
                  const opt = assignmentOptions.find(o => o.value === value)
                  if (opt?.dayDate) {
                    setForm(prev => {
                      if (prev.reservation_time) return prev
                      return { ...prev, reservation_time: opt.dayDate }
                    })
                  }
                }}
                placeholder={t('reservations.pickAssignment')}
                options={[
                  { value: '', label: t('reservations.noAssignment') },
                  ...assignmentOptions,
                ]}
                searchable
                size="sm"
              />
            </div>
          </div>
        )}

        {/* Start Date/Time + End Date/Time + Status (hidden for hotels) */}
        {form.type !== 'hotel' && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.date')}</label>
                <CustomDatePicker
                  value={(() => { const [d] = (form.reservation_time || '').split('T'); return d || '' })()}
                  onChange={d => {
                    const [, tm] = (form.reservation_time || '').split('T')
                    set('reservation_time', d ? (tm ? `${d}T${tm}` : d) : '')
                  }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.startTime')}</label>
                <CustomTimePicker
                  value={(() => { const [, tm] = (form.reservation_time || '').split('T'); return tm || '' })()}
                  onChange={tm => {
                    const [d] = (form.reservation_time || '').split('T')
                    const selectedDay = days.find(dy => dy.id === selectedDayId)
                    const date = d || selectedDay?.date || new Date().toISOString().split('T')[0]
                    set('reservation_time', tm ? `${date}T${tm}` : date)
                  }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.endDate')}</label>
                <CustomDatePicker
                  value={form.end_date}
                  onChange={d => set('end_date', d || '')}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.endTime')}</label>
                <CustomTimePicker value={form.reservation_end_time} onChange={v => set('reservation_end_time', v)} />
              </div>
            </div>
            {isEndBeforeStart && (
              <div style={{ fontSize: 11, color: '#ef4444', marginTop: -6 }}>{t('reservations.validation.endBeforeStart')}</div>
            )}
          </>
        )}

        {/* Location */}
        {form.type !== 'hotel' && (
          <div>
            <label style={labelStyle}>{t('reservations.locationAddress')}</label>
            <input type="text" value={form.location} onChange={e => set('location', e.target.value)}
              placeholder={t('reservations.locationPlaceholder')} style={inputStyle} />
          </div>
        )}

        {/* Booking Code + Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>{t('reservations.confirmationCode')}</label>
            <input type="text" value={form.confirmation_number} onChange={e => set('confirmation_number', e.target.value)}
              placeholder={t('reservations.confirmationPlaceholder')} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>{t('reservations.status')}</label>
            <CustomSelect
              value={form.status}
              onChange={value => set('status', value)}
              options={[
                { value: 'pending', label: t('reservations.pending') },
                { value: 'confirmed', label: t('reservations.confirmed') },
              ]}
              size="sm"
            />
          </div>
        </div>

        {/* Hotel fields */}
        {form.type === 'hotel' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label style={labelStyle}>{t('reservations.meta.hotelPlace')}</label>
                <CustomSelect
                  value={form.hotel_place_id}
                  onChange={value => {
                    const p = places.find(pl => pl.id === value)
                    setForm(prev => {
                      const next = { ...prev, hotel_place_id: value }
                      if (!value) {
                        next.location = ''
                      } else if (p) {
                        if (!prev.title) next.title = p.name
                        if (!prev.location && p.address) next.location = p.address
                      }
                      return next
                    })
                  }}
                  placeholder={t('reservations.meta.pickHotel')}
                  options={[
                    { value: '', label: '—' },
                    ...places.map(p => ({ value: p.id, label: p.name })),
                  ]}
                  searchable
                  size="sm"
                />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.meta.fromDay')}</label>
                <CustomSelect
                  value={form.hotel_start_day}
                  onChange={value => set('hotel_start_day', value)}
                  placeholder={t('reservations.meta.selectDay')}
                  options={days.map(d => {
                    const dateBadge = d.date ? (formatDate(d.date, locale) ?? undefined) : undefined
                    const dayBadge = d.title ? t('dayplan.dayN', { n: d.day_number }) : undefined
                    return {
                      value: d.id,
                      label: d.title || t('dayplan.dayN', { n: d.day_number }),
                      badge: dateBadge ?? dayBadge,
                    }
                  })}
                  size="sm"
                />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.meta.toDay')}</label>
                <CustomSelect
                  value={form.hotel_end_day}
                  onChange={value => set('hotel_end_day', value)}
                  placeholder={t('reservations.meta.selectDay')}
                  options={days.map(d => {
                    const dateBadge = d.date ? (formatDate(d.date, locale) ?? undefined) : undefined
                    const dayBadge = d.title ? t('dayplan.dayN', { n: d.day_number }) : undefined
                    return {
                      value: d.id,
                      label: d.title || t('dayplan.dayN', { n: d.day_number }),
                      badge: dateBadge ?? dayBadge,
                    }
                  })}
                  size="sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label style={labelStyle}>{t('reservations.meta.checkIn')}</label>
                <CustomTimePicker value={form.meta_check_in_time} onChange={v => set('meta_check_in_time', v)} />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.meta.checkInUntil')}</label>
                <CustomTimePicker value={form.meta_check_in_end_time} onChange={v => set('meta_check_in_end_time', v)} />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.meta.checkOut')}</label>
                <CustomTimePicker value={form.meta_check_out_time} onChange={v => set('meta_check_out_time', v)} />
              </div>
            </div>
          </>
        )}

        {/* Notes */}
        <div>
          <label style={labelStyle}>{t('reservations.notes')}</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
            placeholder={t('reservations.notesPlaceholder')}
            style={{ ...inputStyle, resize: 'none', lineHeight: 1.5 }} />
        </div>

        {/* Files */}
        <div>
          <label style={labelStyle}>{t('files.title')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {attachedFiles.map(f => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                <a href="#" onClick={(e) => { e.preventDefault(); openFile(f.url).catch(() => {}) }} style={{ color: 'var(--text-faint)', display: 'flex', flexShrink: 0, cursor: 'pointer' }}><ExternalLink size={11} /></a>
                <button type="button" onClick={async () => {
                  if (f.reservation_id === reservation?.id) {
                    try { await apiClient.put(`/trips/${tripId}/files/${f.id}`, { reservation_id: null }) } catch {}
                  }
                  try {
                    const linksRes = await apiClient.get(`/trips/${tripId}/files/${f.id}/links`)
                    const link = (linksRes.data.links || []).find((l: any) => l.reservation_id === reservation?.id)
                    if (link) await apiClient.delete(`/trips/${tripId}/files/${f.id}/link/${link.id}`)
                  } catch {}
                  setLinkedFileIds(prev => prev.filter(id => id !== f.id))
                  if (tripId) loadFiles(tripId)
                }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 0, flexShrink: 0 }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            {pendingFiles.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 0, flexShrink: 0 }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,image/*" style={{ display: 'none' }} onChange={handleFileChange} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {onFileUpload && <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile} style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
                fontSize: 11, color: 'var(--text-faint)', cursor: uploadingFile ? 'default' : 'pointer', fontFamily: 'inherit',
              }}>
                <Paperclip size={11} />
                {uploadingFile ? t('reservations.uploading') : t('reservations.attachFile')}
              </button>}
              {reservation?.id && files.filter(f => !f.deleted_at && !attachedFiles.some(af => af.id === f.id)).length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button type="button" onClick={() => setShowFilePicker(v => !v)} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                    border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
                    fontSize: 11, color: 'var(--text-faint)', cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    <Link2 size={11} /> {t('reservations.linkExisting')}
                  </button>
                  {showFilePicker && (
                    <div style={{
                      position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50,
                      background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 220, maxHeight: 200, overflowY: 'auto',
                    }}>
                      {files.filter(f => !f.deleted_at && !attachedFiles.some(af => af.id === f.id)).map(f => (
                        <button key={f.id} type="button" onClick={async () => {
                          try {
                            await apiClient.post(`/trips/${tripId}/files/${f.id}/link`, { reservation_id: reservation.id })
                            setLinkedFileIds(prev => [...prev, f.id])
                            setShowFilePicker(false)
                            if (tripId) loadFiles(tripId)
                          } catch {}
                        }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
                            background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                            color: 'var(--text-secondary)', borderRadius: 7, textAlign: 'left',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                          <FileText size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Price + Budget Category */}
        {isBudgetEnabled && (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.price')}</label>
                <input type="text" inputMode="decimal" value={form.price}
                  onChange={e => { const v = e.target.value; if (v === '' || /^\d*[.,]?\d{0,2}$/.test(v)) set('price', v.replace(',', '.')) }}
                  onPaste={e => { e.preventDefault(); let txt = e.clipboardData.getData('text').trim().replace(/[^\d.,-]/g, ''); const lc = txt.lastIndexOf(','), ld = txt.lastIndexOf('.'), dp = Math.max(lc, ld); if (dp > -1) { txt = txt.substring(0, dp).replace(/[.,]/g, '') + '.' + txt.substring(dp + 1) } else { txt = txt.replace(/[.,]/g, '') } set('price', txt) }}
                  placeholder="0.00"
                  style={inputStyle} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={labelStyle}>{t('reservations.budgetCategory')}</label>
                <CustomSelect
                  value={form.budget_category}
                  onChange={v => set('budget_category', v)}
                  options={[
                    { value: '', label: t('reservations.budgetCategoryAuto') },
                    ...budgetCategories.map(c => ({ value: c, label: c })),
                  ]}
                  placeholder={t('reservations.budgetCategoryAuto')}
                  size="sm"
                />
              </div>
            </div>
            {form.price && parseFloat(form.price) > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: -4 }}>
                {t('reservations.budgetHint')}
              </div>
            )}
          </>
        )}

      </form>
    </Modal>
  )
}

function formatDate(dateStr, locale) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString(locale || undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
