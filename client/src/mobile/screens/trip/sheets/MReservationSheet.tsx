import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ExternalLink, FileText, Hotel, Link2, ParkingSquare, Plus, Ticket, Users, Utensils } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import { useAddonStore } from '../../../../store/addonStore'
import { useTranslation } from '../../../../i18n'
import { resolveDayId } from '../../../../utils/formatters'
import { parseReservationMetadata } from '../../../../utils/flightLegs'
import { typeToCostCategory } from '@trek/shared'
import CustomSelect from '../../../../components/shared/CustomSelect'
import CustomTimePicker from '../../../../components/shared/CustomTimePicker'
import { CustomDatePicker } from '../../../../components/shared/CustomDateTimePicker'
import { Eyebrow, FIELD_AREA_CLS, FIELD_CLS, FormSheetFooter, FormSheetHeader } from './PlSheetChrome'
import PlFileAttach from './PlFileAttach'
import { buildAssignmentOptions } from '../../../../components/Planner/assignmentOptions'
import { openFile } from '../../../../utils/fileDownload'
import GuestBadge from '../../../../components/shared/GuestBadge'
import { SPLIT_COLORS } from '../../../../components/Budget/BudgetPanel.constants'
import { useTripStore } from '../../../../store/tripStore'
import type { TripMember } from '../../../../types'
import type { BookingExpenseRequest } from '../../../../components/Planner/BookingCostsSection.types'
import type { TripPlanner } from '../MTripShell'

export interface MReservationSheetProps {
  planner: TripPlanner
  onOpenExpense: (req: BookingExpenseRequest) => void
}

const TYPE_OPTIONS = [
  { value: 'hotel', labelKey: 'reservations.type.hotel', Icon: Hotel },
  { value: 'restaurant', labelKey: 'reservations.type.restaurant', Icon: Utensils },
  { value: 'event', labelKey: 'reservations.type.event', Icon: Ticket },
  { value: 'tour', labelKey: 'reservations.type.tour', Icon: Users },
  { value: 'parking', labelKey: 'reservations.type.parking', Icon: ParkingSquare },
  { value: 'other', labelKey: 'reservations.type.other', Icon: FileText },
]

// Traveler picker row — same surface as the cost-split rows (bg on --m-ic).
const TRAVELER_ROW_CLS = 'flex w-full items-center gap-[9px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px] text-left'

const EMPTY = {
  title: '', type: 'other', status: 'pending',
  reservation_time: '', reservation_end_time: '', end_date: '', location: '', confirmation_number: '',
  notes: '', url: '', place_id: '' as string | number, accommodation_id: '' as string | number,
  meta_check_in_time: '', meta_check_out_time: '',
  hotel_place_id: '' as string | number, hotel_start_day: '' as string | number, hotel_end_day: '' as string | number,
  hotel_address: '',
}

/**
 * Add/edit booking sheet — the mobile counterpart of the desktop ReservationModal,
 * driven by the planner's own editor flags (showReservationModal / editingReservation /
 * reservationPrefill / bookingForAssignmentId) so every entry point (bookings tab, day
 * sheet, timeline, import review) opens it unchanged. Saving reuses
 * planner.handleSaveReservation, which owns the accommodation split, file upload and undo.
 */
export default function MReservationSheet({ planner, onOpenExpense }: MReservationSheetProps) {
  const {
    t, toast, tripId, days, places, tripAccommodations, tripMembers, selectedDayId,
    showReservationModal, setShowReservationModal,
    editingReservation, setEditingReservation, reservationPrefill,
    bookingForAssignmentId, setBookingForAssignmentId,
    assignments, files,
    importReviewActive, advanceImportReview,
    handleSaveReservation, canUploadFiles, tripActions,
  } = planner
  const { locale } = useTranslation()
  const setReservationTravelers = useTripStore(s => s.setReservationTravelers)

  const isBudgetEnabled = useAddonStore(s => s.isEnabled('budget'))

  const [form, setForm] = useState(EMPTY)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const assignmentOptions = useMemo(
    () => buildAssignmentOptions(days, assignments, t, locale),
    [days, assignments, t, locale],
  )

  // Travelers assigned to this booking (#1517) — seeded from the editing
  // reservation on open, persisted separately after the save resolves.
  const [travelerIds, setTravelerIds] = useState<Set<number>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  // Ref (not state) so handleSubmit reads the intent set by the same click.
  const expenseIntentRef = useRef(false)
  // Open-time snapshot so the sheet content survives the exit animation.
  const [snap, setSnap] = useState<{ res: typeof editingReservation; assignmentId: number | null }>(
    { res: null, assignmentId: null },
  )
  // The stop this booking hangs on. Seeded from the booking being edited, not
  // only from the create-for-a-stop flag, because saving used to write the flag
  // straight back and an edit therefore erased the link (#2216).
  const [assignmentId, setAssignmentId] = useState<number | ''>('')

  useEffect(() => {
    if (!showReservationModal) return
    setSnap({ res: editingReservation, assignmentId: bookingForAssignmentId ?? null })
    setAssignmentId(bookingForAssignmentId ?? editingReservation?.assignment_id ?? '')
    expenseIntentRef.current = false
    setPendingFiles([])
    setTravelerIds(new Set((editingReservation?.travelers || []).map(tv => tv.user_id)))

    const res = editingReservation
    if (res) {
      const meta = parseReservationMetadata(res)
      const rawEnd = res.reservation_end_time || ''
      let endDate = '', endTime = rawEnd
      if (rawEnd.includes('T')) { endDate = rawEnd.split('T')[0]; endTime = rawEnd.split('T')[1]?.slice(0, 5) || '' }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) { endDate = rawEnd; endTime = '' }
      const acc = tripAccommodations.find(a => a.id == res.accommodation_id)
      setForm({
        ...EMPTY,
        title: res.title || '', type: res.type || 'other', status: res.status || 'pending',
        reservation_time: res.reservation_time ? res.reservation_time.slice(0, 16) : '',
        reservation_end_time: endTime, end_date: endDate,
        location: res.location || '', confirmation_number: res.confirmation_number || '',
        notes: res.notes || '', url: res.url || '',
        place_id: res.place_id || '', accommodation_id: res.accommodation_id || '',
        meta_check_in_time: meta.check_in_time || '', meta_check_out_time: meta.check_out_time || '',
        hotel_place_id: acc?.place_id || '', hotel_start_day: acc?.start_day_id || '', hotel_end_day: acc?.end_day_id || '',
        hotel_address: places.find(p => p.id == acc?.place_id)?.address || res.location || '',
      })
    } else if (reservationPrefill) {
      const pf = reservationPrefill
      const meta = (pf.metadata && typeof pf.metadata === 'object' ? pf.metadata : {}) as Record<string, string>
      const rawEnd = typeof pf.reservation_end_time === 'string' ? pf.reservation_end_time : ''
      let endDate = '', endTime = rawEnd
      if (rawEnd.includes('T')) { endDate = rawEnd.split('T')[0]; endTime = rawEnd.split('T')[1]?.slice(0, 5) || '' }
      else if (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) { endDate = rawEnd; endTime = '' }
      setForm({
        ...EMPTY,
        title: pf.title || '', type: pf.type || 'other', status: pf.status || 'pending',
        reservation_time: typeof pf.reservation_time === 'string' ? pf.reservation_time.slice(0, 16) : '',
        reservation_end_time: endTime, end_date: endDate,
        location: pf.location || '', confirmation_number: pf.confirmation_number || '',
        notes: pf.notes || '', url: (pf as { url?: string }).url || '',
        meta_check_in_time: meta.check_in_time || '', meta_check_out_time: meta.check_out_time || '',
        hotel_start_day: resolveDayId(days, pf._accommodation?.check_in),
        hotel_end_day: resolveDayId(days, pf._accommodation?.check_out),
        hotel_address: pf._venue?.address || '',
      })
      setPendingFiles(pf._sourceFiles ?? [])
    } else {
      // Opened from a day's toolbar: start on that day rather than on a blank
      // date the user has to look up again (#1998). A hotel spans to the next
      // day, which is what checking in on this day actually means.
      const ctxDay = planner.reservationModalDayId != null
        ? days.find(d => d.id === planner.reservationModalDayId)
        : undefined
      const ctxDate = ctxDay?.date ? ctxDay.date.slice(0, 10) : ''
      const nextDay = ctxDay ? days[days.indexOf(ctxDay) + 1] : undefined
      setForm(ctxDate
        ? {
            ...EMPTY,
            reservation_time: ctxDate,
            hotel_start_day: ctxDay!.id,
            hotel_end_day: nextDay?.id ?? ctxDay!.id,
          }
        : EMPTY)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReservationModal])

  const res = snap.res
  // Files already on this booking. The sheet used to list only the ones picked
  // in this session, so an upload from the desktop was invisible here (#2217).
  const attachedFiles = res?.id
    ? (files || []).filter(f =>
        !f.deleted_at && (
          String(f.reservation_id) === String(res.id) ||
          (f.linked_reservation_ids || []).includes(res.id)
        ),
      )
    : []
  const isHotel = form.type === 'hotel'
  const set = (field: keyof typeof EMPTY, value: string | number) => setForm(prev => ({ ...prev, [field]: value }))

  const toggleTraveler = (id: number) => setTravelerIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const TravelerAvatar = ({ m, idx, dim }: { m: TripMember; idx: number; dim: boolean }) =>
    m.avatar_url
      ? <img src={m.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, opacity: dim ? 0.45 : 1 }} />
      : (
        <span
          style={{
            width: 22, height: 22, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient,
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: 8.8, fontWeight: 700, flexShrink: 0, opacity: dim ? 0.45 : 1,
          }}
        >
          {(m.username || '?').charAt(0).toUpperCase()}
        </span>
      )

  const isEndBeforeStart = (() => {
    if (isHotel || !form.end_date || !form.reservation_time) return false
    const sDate = form.reservation_time.split('T')[0]
    const sTime = form.reservation_time.split('T')[1] || ''
    const eTime = form.reservation_end_time || ''
    // Without a time on either side the booking is all-day, so an end on the
    // start day is fine — only compare the dates there.
    if (!sTime || !eTime) return form.end_date < sDate
    return `${form.end_date}T${eTime}` <= `${sDate}T${sTime}`
  })()

  const startDate = (form.reservation_time || '').split('T')[0] || ''
  const startTime = (form.reservation_time || '').split('T')[1] || ''

  const fmtDate = (d?: string | null) =>
    d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : undefined

  const placeOptions = [{ value: '', label: '—' }, ...places.map(p => ({ value: p.id, label: p.name }))]
  const dayOptions = days.map(d => ({
    value: d.id,
    label: d.title || t('dayplan.dayN', { n: d.day_number }),
    badge: fmtDate(d.date),
  }))

  // Restrict non-hotel booking dates to the trip's span (#1662); hotels already
  // constrain to trip days via their day dropdowns.
  const tripDates = days.map(d => d.date).filter((d): d is string => !!d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const tripMinDate = tripDates[0]
  const tripMaxDate = tripDates[tripDates.length - 1]

  const handleClose = () => {
    if (importReviewActive) { advanceImportReview(); return }
    planner.setReservationModalDayId(null)
    setShowReservationModal(false)
    setEditingReservation(null)
    setBookingForAssignmentId(null)
  }

  const handleSubmit = async () => {
    // Only the costs button reaches this without the footer's date check.
    if (isEndBeforeStart) { toast.error(t('reservations.validation.endBeforeStart')); return }
    const withExpense = expenseIntentRef.current
    expenseIntentRef.current = false
    setIsSaving(true)
    try {
      const metadata: Record<string, string> = {}
      if (isHotel) {
        if (form.meta_check_in_time) metadata.check_in_time = form.meta_check_in_time
        if (form.meta_check_out_time) metadata.check_out_time = form.meta_check_out_time
      }
      let combinedEndTime: string = form.reservation_end_time
      if (form.end_date) {
        combinedEndTime = form.reservation_end_time ? `${form.end_date}T${form.reservation_end_time}` : form.end_date
      } else if (form.reservation_end_time && form.reservation_time) {
        combinedEndTime = `${startDate}T${form.reservation_end_time}`
      }
      const saveData: Record<string, unknown> & { title: string } = {
        title: form.title, type: form.type, status: form.status,
        reservation_time: isHotel ? null : (form.reservation_time || null),
        reservation_end_time: isHotel ? null : (combinedEndTime || null),
        location: isHotel ? form.hotel_address : form.location,
        confirmation_number: form.confirmation_number,
        notes: form.notes, url: form.url,
        assignment_id: (isHotel && !form.accommodation_id) ? null : (assignmentId || null),
        accommodation_id: isHotel ? (form.accommodation_id || null) : null,
        place_id: isHotel ? null : (form.place_id || null),
        // An empty object, not null: null clears the column outright, and that
        // took the mirrored booking price with it on every edit of a type that
        // fills no metadata of its own — restaurant, event, tour, parking, other,
        // a hotel without check-in times (#2233). An object still clears what the
        // form dropped, and lets the server carry the price across.
        metadata,
        // Omitted on an edit for the same reason as the desktop dialog: the
        // server swaps the whole endpoint set when the key is present, and this
        // sheet never edits endpoints (#2216).
        ...(snap.res?.id ? {} : { endpoints: [] }),
        needs_review: false,
      }
      if (isHotel && (form.hotel_start_day || form.hotel_end_day)) {
        saveData.create_accommodation = {
          place_id: form.hotel_place_id || null,
          venue: (!form.hotel_place_id && (form.hotel_address || form.title))
            ? { name: form.title, address: form.hotel_address || null } : null,
          address: form.hotel_address || null,
          start_day_id: form.hotel_start_day || form.hotel_end_day,
          end_day_id: form.hotel_end_day || form.hotel_start_day,
          check_in: form.meta_check_in_time || null,
          check_out: form.meta_check_out_time || null,
          confirmation: form.confirmation_number || null,
        }
      }
      const saved = await handleSaveReservation(saveData as never)
      // Persist the traveler assignment once we have the reservation id (from the
      // save result on create, or the edited reservation) — only when it changed.
      const savedId = saved?.id ?? res?.id
      if (savedId) {
        const original = (res?.travelers || []).map(tv => tv.user_id)
        const next = [...travelerIds]
        const changed = original.length !== next.length || next.some(id => !original.includes(id))
        if (changed) await setReservationTravelers(tripId, savedId, next)
      }
      if (!res?.id && saved?.id && pendingFiles.length > 0 && canUploadFiles) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('reservation_id', String(saved.id))
          fd.append('description', form.title)
          await tripActions.addFile(tripId, fd)
        }
      }
      if (withExpense && saved?.id) {
        onOpenExpense({ prefill: { reservationId: saved.id, name: form.title, category: typeToCostCategory(form.type) } })
      }
      if (importReviewActive && saved) advanceImportReview()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <MSheet
      open={showReservationModal}
      onClose={handleClose}
      material="opaque"
      ariaLabel={res ? t('reservations.editTitle') : t('reservations.newTitle')}
    >
      <FormSheetHeader
        icon={Ticket}
        title={res ? t('reservations.editTitle') : t('reservations.newTitle')}
        onClose={handleClose}
        closeLabel={t('common.close')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-[2px]">
        {/* BOOKING TYPE */}
        <Eyebrow className="mb-[6px] mt-2 uppercase">{t('reservations.bookingType')}</Eyebrow>
        <div className="flex flex-wrap gap-[6px]">
          {TYPE_OPTIONS.map(({ value, labelKey, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => set('type', value)}
              aria-pressed={form.type === value}
              className={`flex items-center gap-[5px] rounded-full px-[11px] py-[6px] text-[0.71875rem] font-semibold ${
                form.type === value
                  ? 'bg-m-act text-m-actfg'
                  : 'border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] text-m-muted'
              }`}
            >
              <Icon size={12} strokeWidth={2} />
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* TITLE */}
        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.titleLabel')} *</Eyebrow>
        <input
          type="text"
          value={form.title}
          onChange={e => set('title', e.target.value)}
          placeholder={t('reservations.titlePlaceholder')}
          className={FIELD_CLS}
        />

        {!isHotel && (
          <>
            <div className="mt-3 flex gap-2">
              <div className="min-w-0 flex-[1.2]">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.date')}</Eyebrow>
                <CustomDatePicker
                  value={startDate}
                  onChange={d => set('reservation_time', d ? (startTime ? `${d}T${startTime}` : d) : '')}
                  min={tripMinDate}
                  max={tripMaxDate}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.startTime')}</Eyebrow>
                <CustomTimePicker
                  value={startTime}
                  onChange={tm => {
                    const d = startDate || days.find(dy => dy.id === selectedDayId)?.date || ''
                    set('reservation_time', tm ? `${d}T${tm}` : d)
                  }}
                />
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <div className="min-w-0 flex-[1.2]">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.endDate')}</Eyebrow>
                <CustomDatePicker value={form.end_date} onChange={d => set('end_date', d || '')} min={tripMinDate} max={tripMaxDate} />
              </div>
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.endTime')}</Eyebrow>
                <CustomTimePicker value={form.reservation_end_time} onChange={v => set('reservation_end_time', v)} />
              </div>
            </div>
            {isEndBeforeStart && (
              <div className="mt-[6px] text-[0.6875rem] text-[color:var(--m-st-danger)]">
                {t('reservations.validation.endBeforeStart')}
              </div>
            )}

            {/* PLACE / ACTIVITY */}
            <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.meta.linkPlace')}</Eyebrow>
            <CustomSelect
              value={form.place_id}
              onChange={value => {
                const p = places.find(pl => pl.id === value)
                setForm(prev => {
                  const next = { ...prev, place_id: value }
                  if (value && p) {
                    if (!prev.title) next.title = p.name
                    if (!prev.location && p.address) next.location = p.address
                  }
                  return next
                })
              }}
              options={placeOptions}
              placeholder={t('reservations.meta.pickPlace')}
              searchable
              size="sm"
            />

            {/* LOCATION / ADDRESS */}
            <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.locationAddress')}</Eyebrow>
            <input
              type="text"
              value={form.location}
              onChange={e => set('location', e.target.value)}
              placeholder={t('reservations.locationPlaceholder')}
              className={FIELD_CLS}
            />
          </>
        )}

        {isHotel && (
          <>
            <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.meta.hotelPlace')}</Eyebrow>
            <CustomSelect
              value={form.hotel_place_id}
              onChange={value => {
                const p = places.find(pl => pl.id === value)
                setForm(prev => {
                  const next = { ...prev, hotel_place_id: value }
                  if (value && p) {
                    if (!prev.title) next.title = p.name
                    next.hotel_address = p.address || prev.hotel_address
                  }
                  return next
                })
              }}
              options={placeOptions}
              placeholder={t('reservations.meta.pickHotel')}
              searchable
              size="sm"
            />

            <div className="mt-3 flex gap-2">
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.meta.fromDay')}</Eyebrow>
                <CustomSelect
                  value={form.hotel_start_day}
                  onChange={value => setForm(prev => ({
                    ...prev,
                    hotel_start_day: value,
                    hotel_end_day: days.findIndex(d => d.id === value) > days.findIndex(d => d.id === prev.hotel_end_day)
                      ? value : prev.hotel_end_day,
                  }))}
                  options={dayOptions}
                  placeholder={t('reservations.meta.selectDay')}
                  size="sm"
                />
              </div>
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.meta.toDay')}</Eyebrow>
                <CustomSelect
                  value={form.hotel_end_day}
                  onChange={value => setForm(prev => ({
                    ...prev,
                    hotel_start_day: days.findIndex(d => d.id === value) < days.findIndex(d => d.id === prev.hotel_start_day)
                      ? value : prev.hotel_start_day,
                    hotel_end_day: value,
                  }))}
                  options={dayOptions}
                  placeholder={t('reservations.meta.selectDay')}
                  size="sm"
                />
              </div>
            </div>

            <div className="mt-2 flex gap-2">
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.meta.checkIn')}</Eyebrow>
                <CustomTimePicker value={form.meta_check_in_time} onChange={v => set('meta_check_in_time', v)} placeholder="15:00" />
              </div>
              <div className="min-w-0 flex-1">
                <Eyebrow className="mb-[5px] uppercase">{t('reservations.meta.checkOut')}</Eyebrow>
                <CustomTimePicker value={form.meta_check_out_time} onChange={v => set('meta_check_out_time', v)} placeholder="11:00" />
              </div>
            </div>

            <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.locationAddress')}</Eyebrow>
            <input
              type="text"
              value={form.hotel_address}
              onChange={e => set('hotel_address', e.target.value)}
              placeholder={t('reservations.locationPlaceholder')}
              className={FIELD_CLS}
            />
          </>
        )}

        {/* BOOKING CODE + STATUS */}
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('reservations.confirmationCode')}</Eyebrow>
            <input
              type="text"
              value={form.confirmation_number}
              onChange={e => set('confirmation_number', e.target.value)}
              placeholder={t('reservations.confirmationPlaceholder')}
              className={FIELD_CLS}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('reservations.status')}</Eyebrow>
            <div className="flex rounded-full bg-[color:var(--m-ic)] p-[3px]">
              {(['pending', 'confirmed'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => set('status', s)}
                  className={`flex-1 rounded-full py-[7px] text-[0.71875rem] font-semibold ${
                    form.status === s ? 'bg-m-act text-m-actfg' : 'text-m-muted'
                  }`}
                >
                  {t(`reservations.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* LINK */}
        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.urlLabel')}</Eyebrow>
        <div className="relative">
          <Link2 size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-m-faint" />
          <input
            type="url"
            value={form.url}
            onChange={e => set('url', e.target.value)}
            placeholder={t('reservations.urlPlaceholder')}
            className={`${FIELD_CLS} pl-[34px]`}
          />
        </div>

        {/* NOTES */}
        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('reservations.notes')}</Eyebrow>
        <textarea
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          rows={2}
          placeholder={t('reservations.notesPlaceholder')}
          className={FIELD_AREA_CLS}
        />

        {/* TRAVELERS */}
        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('reservations.travelers.label')}</Eyebrow>
        {tripMembers.length === 0 ? (
          <div className="text-[0.71875rem] text-m-faint">{t('reservations.travelers.none')}</div>
        ) : (
          <div className="flex flex-col gap-[6px]">
            {tripMembers.map((m, idx) => {
              const on = travelerIds.has(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleTraveler(m.id)}
                  className={`${TRAVELER_ROW_CLS} ${on ? '' : 'opacity-60'}`}
                >
                  <TravelerAvatar m={m} idx={idx} dim={!on} />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-m-ink">{m.username}</span>
                  {m.is_guest && <GuestBadge size="xs" />}
                  {on && <Check size={15} strokeWidth={2.4} className="flex-none text-m-act" />}
                </button>
              )
            })}
          </div>
        )}

        {/* LINK TO A STOP IN THE PLAN (#2216) */}
        {!isHotel && assignmentOptions.length > 0 && (
          <>
            <Eyebrow className="mb-[6px] mt-3 uppercase">{t('reservations.linkAssignment')}</Eyebrow>
            <CustomSelect
              value={assignmentId}
              onChange={value => {
                setAssignmentId(value === '' ? '' : Number(value))
                const opt = assignmentOptions.find(o => o.value === value)
                // Same courtesy as the desktop dialog: an undated booking takes
                // the day of the stop it was just linked to.
                if (opt?.dayDate) setForm(prev => (prev.reservation_time ? prev : { ...prev, reservation_time: opt.dayDate! }))
              }}
              placeholder={t('reservations.pickAssignment')}
              options={[{ value: '', label: t('reservations.noAssignment') }, ...assignmentOptions]}
              searchable
              size="sm"
            />
          </>
        )}

        {/* FILES */}
        {attachedFiles.length > 0 && (
          <>
            <Eyebrow className="mb-[6px] mt-3 uppercase">{t('files.title')}</Eyebrow>
            <div className="flex flex-col gap-1">
              {attachedFiles.map(f => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => openFile(f.url, f.original_name)}
                  className="flex w-full items-center gap-2 rounded-[10px] bg-[color:var(--m-ic)] px-[10px] py-[7px] text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium">{f.original_name}</span>
                  <ExternalLink size={11} strokeWidth={2} className="flex-none text-m-faint" />
                </button>
              ))}
            </div>
          </>
        )}
        {canUploadFiles && (
          <PlFileAttach
            planner={planner}
            files={pendingFiles}
            onAdd={files => setPendingFiles(prev => [...prev, ...files])}
            onRemove={idx => setPendingFiles(prev => prev.filter((_, i) => i !== idx))}
            hideHint
          />
        )}

        {/* COSTS */}
        {isBudgetEnabled && (
          <>
            <Eyebrow className="mb-[6px] mt-3 uppercase">{t('reservations.costsLabel')}</Eyebrow>
            <button
              type="button"
              onClick={() => { expenseIntentRef.current = true; handleSubmit() }}
              disabled={!form.title.trim() || isSaving}
              className="flex w-full items-center justify-center gap-[6px] rounded-[13px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] py-[11px] text-[0.78125rem] font-semibold text-m-ink disabled:opacity-40"
            >
              <Plus size={13} strokeWidth={2.2} />
              {t('reservations.createExpense')}
            </button>
            <div className="mt-[5px] font-geist text-[0.625rem] text-m-faint">{t('reservations.createExpenseHint')}</div>
          </>
        )}
      </div>

      <FormSheetFooter
        onCancel={handleClose}
        cancelLabel={t('common.cancel')}
        onSubmit={handleSubmit}
        submitLabel={isSaving ? t('common.saving') : res ? t('common.update') : t('common.add')}
        submitDisabled={!form.title.trim() || isSaving || isEndBeforeStart}
      />
    </MSheet>
  )
}
