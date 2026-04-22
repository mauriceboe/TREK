import { useState, useEffect, useMemo } from 'react'
import { Plane, Train, Car, Ship } from 'lucide-react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import CustomTimePicker from '../shared/CustomTimePicker'
import AirportSelect, { type Airport } from './AirportSelect'
import LocationSelect, { type LocationPoint } from './LocationSelect'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { useTripStore } from '../../store/tripStore'
import { useAddonStore } from '../../store/addonStore'
import { formatDate } from '../../utils/formatters'
import type { Day, Reservation, ReservationEndpoint } from '../../types'

const TRANSPORT_TYPES = ['flight', 'train', 'car', 'cruise'] as const
type TransportType = typeof TRANSPORT_TYPES[number]

interface EndpointPick {
  airport?: Airport
  location?: LocationPoint
}

function endpointFromAirport(a: Airport, role: 'from' | 'to', sequence: number, date: string | null, time: string | null): Omit<ReservationEndpoint, 'id' | 'reservation_id'> {
  return {
    role, sequence,
    name: a.city ? `${a.city} (${a.iata})` : a.name,
    code: a.iata,
    lat: a.lat, lng: a.lng,
    timezone: a.tz,
    local_date: date,
    local_time: time,
  }
}

function endpointFromLocation(l: LocationPoint, role: 'from' | 'to', sequence: number, date: string | null, time: string | null): Omit<ReservationEndpoint, 'id' | 'reservation_id'> {
  return {
    role, sequence,
    name: l.name,
    code: null,
    lat: l.lat, lng: l.lng,
    timezone: null,
    local_date: date,
    local_time: time,
  }
}

function airportFromEndpoint(e: ReservationEndpoint | undefined): Airport | null {
  if (!e || !e.code) return null
  return {
    iata: e.code, icao: null,
    name: e.name, city: e.name.replace(/\s*\([A-Z]{3}\)\s*$/, ''),
    country: '',
    lat: e.lat, lng: e.lng,
    tz: e.timezone || '',
  }
}

function locationFromEndpoint(e: ReservationEndpoint | undefined): LocationPoint | null {
  if (!e) return null
  return { name: e.name, lat: e.lat, lng: e.lng, address: null }
}

const TYPE_OPTIONS = [
  { value: 'flight', labelKey: 'reservations.type.flight', Icon: Plane },
  { value: 'train',  labelKey: 'reservations.type.train',  Icon: Train },
  { value: 'car',    labelKey: 'reservations.type.car',    Icon: Car },
  { value: 'cruise', labelKey: 'reservations.type.cruise', Icon: Ship },
]

const defaultForm = {
  title: '',
  type: 'flight' as TransportType,
  status: 'pending' as 'pending' | 'confirmed',
  start_day_id: '' as string | number,
  end_day_id: '' as string | number,
  departure_time: '',
  arrival_time: '',
  confirmation_number: '',
  notes: '',
  price: '',
  budget_category: '',
  meta_airline: '',
  meta_flight_number: '',
  meta_train_number: '',
  meta_platform: '',
  meta_seat: '',
}

interface TransportModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: Record<string, any>) => Promise<void>
  reservation: Reservation | null
  days: Day[]
  selectedDayId: number | null
}

export function TransportModal({ isOpen, onClose, onSave, reservation, days, selectedDayId }: TransportModalProps) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const isBudgetEnabled = useAddonStore(s => s.isEnabled('budget'))
  const budgetItems = useTripStore(s => s.budgetItems)
  const budgetCategories = useMemo(() => {
    const cats = new Set<string>()
    budgetItems.forEach(i => { if (i.category) cats.add(i.category) })
    return Array.from(cats).sort()
  }, [budgetItems])
  const [form, setForm] = useState({ ...defaultForm })
  const [isSaving, setIsSaving] = useState(false)
  const [fromPick, setFromPick] = useState<EndpointPick>({})
  const [toPick, setToPick] = useState<EndpointPick>({})

  useEffect(() => {
    if (!isOpen) return
    if (reservation) {
      const meta = typeof reservation.metadata === 'string'
        ? JSON.parse(reservation.metadata || '{}')
        : (reservation.metadata || {})
      const eps = reservation.endpoints || []
      const from = eps.find(e => e.role === 'from')
      const to = eps.find(e => e.role === 'to')
      const type = (TRANSPORT_TYPES as readonly string[]).includes(reservation.type)
        ? reservation.type as TransportType
        : 'flight'
      setForm({
        title: reservation.title || '',
        type,
        status: reservation.status || 'pending',
        start_day_id: reservation.day_id ?? '',
        end_day_id: reservation.end_day_id ?? '',
        departure_time: reservation.reservation_time?.split('T')[1]?.slice(0, 5) ?? '',
        arrival_time: reservation.reservation_end_time?.split('T')[1]?.slice(0, 5) ?? '',
        confirmation_number: reservation.confirmation_number || '',
        notes: reservation.notes || '',
        meta_airline: meta.airline || '',
        meta_flight_number: meta.flight_number || '',
        meta_train_number: meta.train_number || '',
        meta_platform: meta.platform || '',
        meta_seat: meta.seat || '',
        price: meta.price || '',
        budget_category: (meta.budget_category && budgetItems.some(i => i.category === meta.budget_category)) ? meta.budget_category : '',
      })
      if (type === 'flight') {
        setFromPick({ airport: airportFromEndpoint(from) || undefined })
        setToPick({ airport: airportFromEndpoint(to) || undefined })
      } else {
        setFromPick({ location: locationFromEndpoint(from) || undefined })
        setToPick({ location: locationFromEndpoint(to) || undefined })
      }
    } else {
      setForm({ ...defaultForm, start_day_id: selectedDayId ?? '', end_day_id: selectedDayId ?? '' })
      setFromPick({})
      setToPick({})
    }
  }, [isOpen, reservation, selectedDayId, budgetItems])

  const set = (field: string, value: any) => setForm(prev => ({ ...prev, [field]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setIsSaving(true)
    try {
      const startDay = days.find(d => d.id === Number(form.start_day_id))
      const endDay = days.find(d => d.id === Number(form.end_day_id))

      const buildTime = (day: Day | undefined, time: string): string | null => {
        if (!time) return null
        return day?.date ? `${day.date}T${time}` : `T${time}`
      }

      const metadata: Record<string, string> = {}
      if (form.type === 'flight') {
        if (form.meta_airline) metadata.airline = form.meta_airline
        if (form.meta_flight_number) metadata.flight_number = form.meta_flight_number
        if (fromPick.airport) {
          metadata.departure_airport = fromPick.airport.iata
          metadata.departure_timezone = fromPick.airport.tz
        }
        if (toPick.airport) {
          metadata.arrival_airport = toPick.airport.iata
          metadata.arrival_timezone = toPick.airport.tz
        }
      } else if (form.type === 'train') {
        if (form.meta_train_number) metadata.train_number = form.meta_train_number
        if (form.meta_platform) metadata.platform = form.meta_platform
        if (form.meta_seat) metadata.seat = form.meta_seat
      }
      if (isBudgetEnabled) {
        if (form.price) metadata.price = form.price
        if (form.budget_category) metadata.budget_category = form.budget_category
      }

      const startDate = startDay?.date ?? null
      const endDate = (endDay ?? startDay)?.date ?? null
      const endpoints: ReturnType<typeof endpointFromAirport>[] = []
      if (form.type === 'flight') {
        if (fromPick.airport) endpoints.push(endpointFromAirport(fromPick.airport, 'from', 0, startDate, form.departure_time || null))
        if (toPick.airport) endpoints.push(endpointFromAirport(toPick.airport, 'to', 1, endDate, form.arrival_time || null))
      } else {
        if (fromPick.location) endpoints.push(endpointFromLocation(fromPick.location, 'from', 0, startDate, form.departure_time || null))
        if (toPick.location) endpoints.push(endpointFromLocation(toPick.location, 'to', 1, endDate, form.arrival_time || null))
      }

      const payload = {
        title: form.title,
        type: form.type,
        status: form.status,
        day_id: form.start_day_id ? Number(form.start_day_id) : null,
        end_day_id: form.end_day_id ? Number(form.end_day_id) : null,
        reservation_time: buildTime(startDay, form.departure_time),
        reservation_end_time: buildTime(endDay ?? startDay, form.arrival_time),
        location: null,
        confirmation_number: form.confirmation_number || null,
        notes: form.notes || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        endpoints,
        needs_review: false,
      }
      if (isBudgetEnabled) {
        (payload as any).create_budget_entry = form.price && parseFloat(form.price) > 0
          ? { total_price: parseFloat(form.price), category: form.budget_category || t(`reservations.type.${form.type}`) || 'Other' }
          : { total_price: 0 }
      }
      await onSave(payload)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    } finally {
      setIsSaving(false)
    }
  }

  const inputStyle = {
    width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
    padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box' as const, color: 'var(--text-primary)', background: 'var(--bg-input)',
  }
  const labelStyle = {
    display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-faint)',
    marginBottom: 5, textTransform: 'uppercase' as const, letterSpacing: '0.03em',
  }

  const dayOptions = [
    { value: '', label: '—' },
    ...days.map(d => {
      const dateBadge = d.date ? (formatDate(d.date, locale) ?? undefined) : undefined
      const dayBadge = d.title ? t('dayplan.dayN', { n: d.day_number }) : undefined
      return {
        value: d.id,
        label: d.title || t('dayplan.dayN', { n: d.day_number }),
        badge: dateBadge ?? dayBadge,
      }
    }),
  ]

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={reservation ? t('transport.modalTitle.edit') : t('transport.modalTitle.create')}
      size="2xl"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={handleSubmit} disabled={isSaving || !form.title.trim()} style={{ padding: '8px 20px', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: isSaving || !form.title.trim() ? 0.5 : 1 }}>
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

        {/* From / To endpoints */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>{t('reservations.meta.from')}</label>
            {form.type === 'flight' ? (
              <AirportSelect value={fromPick.airport || null} onChange={a => setFromPick({ airport: a || undefined })} />
            ) : (
              <LocationSelect value={fromPick.location || null} onChange={l => setFromPick({ location: l || undefined })} />
            )}
          </div>
          <div>
            <label style={labelStyle}>{t('reservations.meta.to')}</label>
            {form.type === 'flight' ? (
              <AirportSelect value={toPick.airport || null} onChange={a => setToPick({ airport: a || undefined })} />
            ) : (
              <LocationSelect value={toPick.location || null} onChange={l => setToPick({ location: l || undefined })} />
            )}
          </div>
        </div>

        {/* Departure row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>
              {form.type === 'flight' ? t('reservations.departureDate') : form.type === 'car' ? t('reservations.pickupDate') : t('reservations.date')}
            </label>
            <CustomSelect
              value={form.start_day_id}
              onChange={value => set('start_day_id', value)}
              placeholder={t('dayplan.dayN', { n: '?' })}
              options={dayOptions}
              size="sm"
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>
              {form.type === 'flight' ? t('reservations.departureTime') : form.type === 'car' ? t('reservations.pickupTime') : t('reservations.startTime')}
            </label>
            <CustomTimePicker value={form.departure_time} onChange={v => set('departure_time', v)} />
          </div>
          {form.type === 'flight' && fromPick.airport && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>{t('reservations.meta.departureTimezone')}</label>
              <div style={{ ...inputStyle, padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12, background: 'var(--bg-tertiary)' }}>
                {fromPick.airport.tz}
              </div>
            </div>
          )}
        </div>

        {/* Arrival row */}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>
              {form.type === 'flight' ? t('reservations.arrivalDate') : form.type === 'car' ? t('reservations.returnDate') : t('reservations.endDate')}
            </label>
            <CustomSelect
              value={form.end_day_id}
              onChange={value => set('end_day_id', value)}
              placeholder={t('dayplan.dayN', { n: '?' })}
              options={dayOptions}
              size="sm"
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>
              {form.type === 'flight' ? t('reservations.arrivalTime') : form.type === 'car' ? t('reservations.returnTime') : t('reservations.endTime')}
            </label>
            <CustomTimePicker value={form.arrival_time} onChange={v => set('arrival_time', v)} />
          </div>
          {form.type === 'flight' && toPick.airport && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <label style={labelStyle}>{t('reservations.meta.arrivalTimezone')}</label>
              <div style={{ ...inputStyle, padding: '8px 12px', color: 'var(--text-muted)', fontSize: 12, background: 'var(--bg-tertiary)' }}>
                {toPick.airport.tz}
              </div>
            </div>
          )}
        </div>

        {/* Flight-specific fields */}
        {form.type === 'flight' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>{t('reservations.meta.airline')}</label>
              <input type="text" value={form.meta_airline} onChange={e => set('meta_airline', e.target.value)}
                placeholder="Lufthansa" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('reservations.meta.flightNumber')}</label>
              <input type="text" value={form.meta_flight_number} onChange={e => set('meta_flight_number', e.target.value)}
                placeholder="LH 123" style={inputStyle} />
            </div>
          </div>
        )}

        {/* Train-specific fields */}
        {form.type === 'train' && (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label style={labelStyle}>{t('reservations.meta.trainNumber')}</label>
              <input type="text" value={form.meta_train_number} onChange={e => set('meta_train_number', e.target.value)}
                placeholder="ICE 123" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('reservations.meta.platform')}</label>
              <input type="text" value={form.meta_platform} onChange={e => set('meta_platform', e.target.value)}
                placeholder="12" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>{t('reservations.meta.seat')}</label>
              <input type="text" value={form.meta_seat} onChange={e => set('meta_seat', e.target.value)}
                placeholder="42A" style={inputStyle} />
            </div>
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

        {/* Notes */}
        <div>
          <label style={labelStyle}>{t('reservations.notes')}</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
            placeholder={t('reservations.notesPlaceholder')}
            style={{ ...inputStyle, resize: 'none', lineHeight: 1.5 }} />
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
