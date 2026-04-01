import { useState, useEffect, useRef } from 'react'
import Modal from '../shared/Modal'
import { Calendar, Camera, X, Clipboard, UserPlus, Bell } from 'lucide-react'
import { tripsApi, authApi } from '../../api/client'
import CustomSelect from '../shared/CustomSelect'
import { useAuthStore } from '../../store/authStore'
import { useCanDo } from '../../store/permissionsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import type { Trip } from '../../types'

interface TripFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: Record<string, string | number | null>) => Promise<void> | void
  trip: Trip | null
  onCoverUpdate: (tripId: number, coverUrl: string) => void
}

export default function TripFormModal({ isOpen, onClose, onSave, trip, onCoverUpdate }: TripFormModalProps) {
  const isEditing = !!trip
  const fileRef = useRef(null)
  const toast = useToast()
  const { t } = useTranslation()
  const currentUser = useAuthStore(s => s.user)
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
    reminder_days: 0 as number,
  })
  const [customReminder, setCustomReminder] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [coverPreview, setCoverPreview] = useState(null)
  const [pendingCoverFile, setPendingCoverFile] = useState(null)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([])
  const [selectedMembers, setSelectedMembers] = useState<number[]>([])
  const [memberSelectValue, setMemberSelectValue] = useState('')

  useEffect(() => {
    if (trip) {
      const rd = trip.reminder_days ?? 3
      setFormData({
        title: trip.title || '',
        description: trip.description || '',
        start_date: trip.start_date || '',
        end_date: trip.end_date || '',
        reminder_days: rd,
      })
      setCustomReminder(![0, 1, 3, 9].includes(rd))
      setCoverPreview(trip.cover_image || null)
    } else {
      setFormData({ title: '', description: '', start_date: '', end_date: '', reminder_days: tripRemindersEnabled ? 3 : 0 })
      setCustomReminder(false)
      setCoverPreview(null)
    }
    setPendingCoverFile(null)
    setSelectedMembers([])
    setError('')
    if (isOpen) {
      authApi.getAppConfig().then((c: { trip_reminders_enabled?: boolean }) => {
        if (c?.trip_reminders_enabled !== undefined) setTripRemindersEnabled(c.trip_reminders_enabled)
      }).catch(() => {})
    }
    if (!trip) {
      authApi.listUsers().then(d => setAllUsers(d.users || [])).catch(() => {})
    }
  }, [trip, isOpen])

  useEffect(() => {
    if (!trip && isOpen) {
      setFormData(prev => ({ ...prev, reminder_days: tripRemindersEnabled ? 3 : 0 }))
    }
  }, [tripRemindersEnabled])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!formData.title.trim()) { setError(t('dashboard.titleRequired')); return }
    if (formData.start_date && formData.end_date && new Date(formData.end_date) < new Date(formData.start_date)) {
      setError(t('dashboard.endDateError')); return
    }
    setIsLoading(true)
    try {
      const result = await onSave({
        title: formData.title.trim(),
        description: formData.description.trim() || null,
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
        reminder_days: formData.reminder_days,
      })
      // Add selected members for newly created trips
      if (selectedMembers.length > 0 && result?.trip?.id) {
        for (const userId of selectedMembers) {
          const user = allUsers.find(u => u.id === userId)
          if (user) {
            try { await tripsApi.addMember(result.trip.id, user.username) } catch {}
          }
        }
      }
      // Upload pending cover for newly created trips
      if (pendingCoverFile && result?.trip?.id) {
        try {
          const fd = new FormData()
          fd.append('cover', pendingCoverFile)
          const data = await tripsApi.uploadCover(result.trip.id, fd)
          onCoverUpdate?.(result.trip.id, data.cover_image)
        } catch {
          // Cover upload failed but trip was created
        }
      }
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCoverSelect = (file) => {
    if (!file) return
    if (isEditing && trip?.id) {
      // Existing trip: upload immediately
      uploadCoverNow(file)
    } else {
      // New trip: stage for upload after creation
      setPendingCoverFile(file)
      setCoverPreview(URL.createObjectURL(file))
    }
  }

  const handleCoverChange = (e) => {
    handleCoverSelect((e.target as HTMLInputElement).files?.[0])
    e.target.value = ''
  }

  const uploadCoverNow = async (file) => {
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

  const handleRemoveCover = async () => {
    if (pendingCoverFile) {
      setPendingCoverFile(null)
      setCoverPreview(null)
      return
    }
    if (!trip?.id) return
    try {
      await tripsApi.update(trip.id, { cover_image: null })
      setCoverPreview(null)
      onCoverUpdate?.(trip.id, null)
    } catch {
      toast.error(t('dashboard.coverRemoveError'))
    }
  }

  // Paste support for cover image
  const handlePaste = (e) => {
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
        const oldStart = new Date(prev.start_date + 'T00:00:00')
        const oldEnd = new Date(prev.end_date + 'T00:00:00')
        const duration = Math.round((oldEnd - oldStart) / 86400000)
        const newEnd = new Date(value + 'T00:00:00')
        newEnd.setDate(newEnd.getDate() + duration)
        next.end_date = newEnd.toISOString().split('T')[0]
      }
    }
    return next
  })

  const inputCls = "w-full px-3 py-2.5 border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300 focus:border-transparent text-sm"

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? t('dashboard.editTrip') : t('dashboard.createTrip')}
      size="md"
      footer={
        <div className="flex gap-3 justify-end">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={handleSubmit} disabled={isLoading}
            className="px-4 py-2 text-sm bg-slate-900 hover:bg-slate-700 disabled:bg-slate-400 text-white rounded-lg transition-colors flex items-center gap-2">
            {isLoading
              ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{t('common.saving')}</>
              : isEditing ? t('common.update') : t('dashboard.createTrip')}
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" onPaste={handlePaste}>
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>
        )}

        {/* Cover image — gated by trip_cover_upload permission */}
        {canUploadCover && <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('dashboard.coverImage')}</label>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleCoverChange} />
          {coverPreview ? (
            <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', height: 130 }}>
              <img src={coverPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 6 }}>
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingCover}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.55)', border: 'none', color: 'white', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
                  <Camera size={12} /> {uploadingCover ? t('common.uploading') : t('common.change')}
                </button>
                <button type="button" onClick={handleRemoveCover}
                  style={{ display: 'flex', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: 'rgba(0,0,0,0.55)', border: 'none', color: 'white', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
                  <X size={12} />
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploadingCover}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.background = 'rgba(99,102,241,0.04)' }}
              onDragLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = 'none' }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = 'none'; const file = e.dataTransfer.files?.[0]; if (file?.type.startsWith('image/')) handleCoverSelect(file) }}
              style={{ width: '100%', padding: '18px', border: '2px dashed #e5e7eb', borderRadius: 10, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, color: '#9ca3af', fontFamily: 'inherit', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#6b7280' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.color = '#9ca3af' }}>
              <Camera size={15} /> {uploadingCover ? t('common.uploading') : t('dashboard.addCoverImage')}
            </button>
          )}
        </div>}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            {t('dashboard.tripTitle')} <span className="text-red-500">*</span>
          </label>
          <input type="text" value={formData.title} onChange={e => canEditTrip && update('title', e.target.value)}
            required readOnly={!canEditTrip} placeholder={t('dashboard.tripTitlePlaceholder')} className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('dashboard.tripDescription')}</label>
          <textarea value={formData.description} onChange={e => canEditTrip && update('description', e.target.value)}
            readOnly={!canEditTrip} placeholder={t('dashboard.tripDescriptionPlaceholder')} rows={3}
            className={`${inputCls} resize-none`} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              <Calendar className="inline w-4 h-4 mr-1" />{t('dashboard.startDate')}
            </label>
            <CustomDatePicker value={formData.start_date} onChange={v => update('start_date', v)} placeholder={t('dashboard.startDate')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              <Calendar className="inline w-4 h-4 mr-1" />{t('dashboard.endDate')}
            </label>
            <CustomDatePicker value={formData.end_date} onChange={v => update('end_date', v)} placeholder={t('dashboard.endDate')} />
          </div>
        </div>

        {/* Reminder — only visible to owner (or when creating) */}
        {(!isEditing || trip?.user_id === currentUser?.id || currentUser?.role === 'admin') && (
        <div className={!tripRemindersEnabled ? 'opacity-50' : ''}>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            <Bell className="inline w-4 h-4 mr-1" />{t('trips.reminder')}
          </label>
          {!tripRemindersEnabled ? (
            <p className="text-xs text-slate-400 bg-slate-50 rounded-lg p-3">
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
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      !customReminder && formData.reminder_days === opt.value
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                    }`}>
                    {opt.label}
                  </button>
                ))}
                <button type="button"
                  onClick={() => { setCustomReminder(true); if ([0, 1, 3, 9].includes(formData.reminder_days)) update('reminder_days', 7) }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                    customReminder
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  }`}>
                  {t('trips.reminderCustom')}
                </button>
              </div>
              {customReminder && (
                <div className="flex items-center gap-2 mt-2">
                  <input type="number" min={1} max={30}
                    value={formData.reminder_days}
                    onChange={e => update('reminder_days', Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                    className="w-20 px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300" />
                  <span className="text-xs text-slate-500">{t('trips.reminderDaysBefore')}</span>
                </div>
              )}
            </>
          )}
        </div>
        )}

        {/* Members — only for new trips */}
        {!isEditing && allUsers.filter(u => u.id !== currentUser?.id).length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              <UserPlus className="inline w-4 h-4 mr-1" />{t('dashboard.addMembers')}
            </label>
            {selectedMembers.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {selectedMembers.map(uid => {
                  const user = allUsers.find(u => u.id === uid)
                  if (!user) return null
                  return (
                    <span key={uid} onClick={() => setSelectedMembers(prev => prev.filter(id => id !== uid))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 99,
                        background: 'var(--bg-secondary)', fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', cursor: 'pointer',
                        border: '1px solid var(--border-primary)',
                      }}>
                      {user.username}
                      <X size={11} style={{ color: 'var(--text-faint)' }} />
                    </span>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <CustomSelect
                value={memberSelectValue}
                onChange={value => {
                  if (value) { setSelectedMembers(prev => prev.includes(Number(value)) ? prev : [...prev, Number(value)]); setMemberSelectValue('') }
                }}
                placeholder={t('dashboard.addMember')}
                options={allUsers.filter(u => u.id !== currentUser?.id && !selectedMembers.includes(u.id)).map(u => ({ value: u.id, label: u.username }))}
                searchable
                size="sm"
              />
            </div>
          </div>
        )}

      </form>
    </Modal>
  )
}
