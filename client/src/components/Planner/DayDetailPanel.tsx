import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { X, Sun, Cloud, CloudRain, CloudSnow, CloudDrizzle, CloudLightning, Wind, Droplets, Sunrise, Sunset, Hotel, Calendar, MapPin, LogIn, LogOut, Hash, Pencil, Plane, Utensils, Train, Car, Ship, Ticket, FileText, Users } from 'lucide-react'

const RES_TYPE_ICONS = { flight: Plane, hotel: Hotel, restaurant: Utensils, train: Train, car: Car, cruise: Ship, event: Ticket, tour: Users, other: FileText }
const RES_TYPE_COLORS = { flight: '#3b82f6', hotel: '#8b5cf6', restaurant: '#ef4444', train: '#06b6d4', car: '#6b7280', cruise: '#0ea5e9', event: '#f59e0b', tour: '#10b981', other: '#6b7280' }
import { weatherApi, accommodationsApi } from '../../api/client'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import CustomSelect from '../shared/CustomSelect'
import CustomTimePicker from '../shared/CustomTimePicker'
import { useSettingsStore } from '../../store/settingsStore'
import { getLocaleForLanguage, useTranslation } from '../../i18n'
import type { Day, Place, Category, Reservation, AssignmentsMap } from '../../types'

const WEATHER_ICON_MAP = {
  Clear: Sun, Clouds: Cloud, Rain: CloudRain, Drizzle: CloudDrizzle,
  Thunderstorm: CloudLightning, Snow: CloudSnow, Mist: Wind, Fog: Wind, Haze: Wind,
}

interface WIconProps {
  main: string
  size?: number
}

function WIcon({ main, size = 14 }: WIconProps) {
  const Icon = WEATHER_ICON_MAP[main] || Cloud
  return <Icon size={size} strokeWidth={1.8} />
}

function cTemp(c, f) { return Math.round(f ? c * 9 / 5 + 32 : c) }

function formatTime12(val, is12h) {
  if (!val) return val
  const [h, m] = val.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return val
  if (!is12h) return val
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

interface DayDetailPanelProps {
  day: Day
  days: Day[]
  places: Place[]
  categories?: Category[]
  tripId: number
  assignments: AssignmentsMap
  reservations?: Reservation[]
  lat: number | null
  lng: number | null
  onClose: () => void
  onAccommodationChange: () => void
  leftWidth?: number
  rightWidth?: number
}

export default function DayDetailPanel({ day, days, places, categories = [], tripId, assignments, reservations = [], lat, lng, onClose, onAccommodationChange, leftWidth = 0, rightWidth = 0 }: DayDetailPanelProps) {
  const { t, language, locale } = useTranslation()
  const can = useCanDo()
  const tripObj = useTripStore((s) => s.trip)
  const canEditDays = can('day_edit', tripObj)
  const isFahrenheit = useSettingsStore(s => s.settings.temperature_unit) === 'fahrenheit'
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'
  const blurCodes = useSettingsStore(s => s.settings.blur_booking_codes)
  const fmtTime = (v) => formatTime12(v, is12h)
  const unit = isFahrenheit ? '°F' : '°C'
  const [weather, setWeather] = useState(null)
  const [loading, setLoading] = useState(false)
  const [accommodation, setAccommodation] = useState(null)
  const [dayAccommodations, setDayAccommodations] = useState<any[]>([])
  const [accommodations, setAccommodations] = useState([])
  const [showHotelPicker, setShowHotelPicker] = useState(false)
  const [hotelDayRange, setHotelDayRange] = useState({ start: day?.id, end: day?.id })
  const [hotelCategoryFilter, setHotelCategoryFilter] = useState('')
  const [hotelForm, setHotelForm] = useState({ check_in: '', check_out: '', confirmation: '', place_id: null })

  useEffect(() => {
    if (!day?.date || !lat || !lng) { setWeather(null); return }
    setLoading(true)
    weatherApi.getDetailed(lat, lng, day.date, language)
      .then(data => setWeather(data.error ? null : data))
      .catch(() => setWeather(null))
      .finally(() => setLoading(false))
  }, [day?.date, lat, lng, language])

  useEffect(() => {
    if (!tripId) return
    accommodationsApi.list(tripId)
      .then(data => {
        setAccommodations(data.accommodations || [])
        const allForDay = (data.accommodations || []).filter(a =>
          days.some(d => d.id >= a.start_day_id && d.id <= a.end_day_id && d.id === day?.id)
        )
        setDayAccommodations(allForDay)
        setAccommodation(allForDay[0] || null)
      })
      .catch(() => {})
  }, [tripId, day?.id])

  useEffect(() => { if (day) setHotelDayRange({ start: day.id, end: day.id }) }, [day?.id])

  const handleSelectPlace = (placeId) => {
    setHotelForm(f => ({ ...f, place_id: placeId }))
  }

  const handleSaveAccommodation = async () => {
    if (!hotelForm.place_id) return
    try {
      const data = await accommodationsApi.create(tripId, {
        place_id: hotelForm.place_id,
        start_day_id: hotelDayRange.start,
        end_day_id: hotelDayRange.end,
        check_in: hotelForm.check_in || null,
        check_out: hotelForm.check_out || null,
        confirmation: hotelForm.confirmation || null,
      })
      const newAcc = data.accommodation
      const updated = [...accommodations, newAcc]
      setAccommodations(updated)
      setAccommodation(newAcc)
      setDayAccommodations(updated.filter(a =>
        days.some(d => d.id >= a.start_day_id && d.id <= a.end_day_id && d.id === day?.id)
      ))
      setShowHotelPicker(false)
      setHotelForm({ check_in: '', check_out: '', confirmation: '', place_id: null })
      onAccommodationChange?.()
    } catch {}
  }

  const updateAccommodationField = async (field, value) => {
    if (!accommodation) return
    try {
      const data = await accommodationsApi.update(tripId, accommodation.id, { [field]: value || null })
      setAccommodation(data.accommodation)
      onAccommodationChange?.()
    } catch {}
  }

  const handleRemoveAccommodation = async () => {
    if (!accommodation) return
    try {
      await accommodationsApi.delete(tripId, accommodation.id)
      const updated = accommodations.filter(a => a.id !== accommodation.id)
      setAccommodations(updated)
      setDayAccommodations(updated.filter(a =>
        days.some(d => d.id >= a.start_day_id && d.id <= a.end_day_id && d.id === day?.id)
      ))
      setAccommodation(null)
      onAccommodationChange?.()
    } catch {}
  }

  if (!day) return null

  const formattedDate = day.date ? new Date(day.date + 'T00:00:00').toLocaleDateString(
    getLocaleForLanguage(language),
    { weekday: 'long', day: 'numeric', month: 'long' }
  ) : null

  const placesWithCoords = places.filter(p => p.lat && p.lng)
  const font = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }

  return (
    <div style={{ position: 'fixed', bottom: 20, left: `calc(${leftWidth}px + (100vw - ${leftWidth}px - ${rightWidth}px) / 2)`, transform: 'translateX(-50%)', width: `min(800px, calc(100vw - ${leftWidth}px - ${rightWidth}px - 32px))`, zIndex: 50, ...font }}>
      <div style={{
        background: 'var(--bg-elevated)',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        borderRadius: 20,
        boxShadow: '0 8px 40px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)',
        overflow: 'hidden', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 16px 14px 20px', borderBottom: '1px solid var(--border-faint)' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Calendar size={20} style={{ color: 'var(--text-primary)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {day.title || t('planner.dayN', { n: (days.indexOf(day) + 1) || '?' })}
            </div>
            {formattedDate && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>{formattedDate}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 10, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <X size={14} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ overflowY: 'auto', padding: '14px 20px 18px' }}>

          {/* ── Weather ── */}
          {day.date && lat && lng && (
            loading ? (
              <div style={{ textAlign: 'center', padding: 16, color: 'var(--text-faint)', fontSize: 12 }}>
                <div style={{ width: 18, height: 18, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 6px' }} />
              </div>
            ) : weather ? (
              <div>
                {/* Summary row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <WIcon main={weather.main} size={20} />
                  </div>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>
                      {weather.type === 'climate' ? 'Ø ' : ''}{cTemp(weather.temp, isFahrenheit)}{unit}
                    </span>
                    {weather.temp_max != null && (
                      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                        {cTemp(weather.temp_min, isFahrenheit)}° / {cTemp(weather.temp_max, isFahrenheit)}°
                      </span>
                    )}
                    {weather.description && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{weather.description}</span>
                    )}
                  </div>
                </div>

                {/* Chips row */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: weather.hourly ? 10 : 0 }}>
                  {weather.precipitation_probability_max != null && (
                    <Chip icon={Droplets} value={`${weather.precipitation_probability_max}%`} />
                  )}
                  {weather.precipitation_sum > 0 && (
                    <Chip icon={CloudRain} value={`${weather.precipitation_sum.toFixed(1)} mm`} />
                  )}
                  {weather.wind_max != null && (
                    <Chip icon={Wind} value={isFahrenheit ? `${Math.round(weather.wind_max * 0.621371)} mph` : `${Math.round(weather.wind_max)} km/h`} />
                  )}
                  {weather.sunrise && <Chip icon={Sunrise} value={weather.sunrise} />}
                  {weather.sunset && <Chip icon={Sunset} value={weather.sunset} />}
                </div>

                {/* Hourly scroll */}
                {weather.hourly?.length > 0 && (
                  <div style={{ overflowX: 'auto', margin: '0 -6px', padding: '0 6px 4px' }}>
                    <div style={{ display: 'inline-flex', gap: 2 }}>
                      {weather.hourly.filter((_, i) => i % 2 === 0).map(h => (
                        <div key={h.hour} style={{
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                          width: 44, padding: '5px 2px', borderRadius: 8,
                          background: h.precipitation_probability > 50 ? 'rgba(59,130,246,0.07)' : 'transparent',
                        }}>
                          <span style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500 }}>{String(h.hour).padStart(2, '0')}</span>
                          <WIcon main={h.main} size={12} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)' }}>{cTemp(h.temp, isFahrenheit)}°</span>
                          {h.precipitation_probability > 0 && (
                            <span style={{ fontSize: 8, color: '#3b82f6', fontWeight: 500 }}>{h.precipitation_probability}%</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {weather.type === 'climate' && (
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6, fontStyle: 'italic' }}>{t('day.climateHint')}</div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: 8 }}>{t('day.noWeather')}</div>
            )
          )}

          {/* ── Reservations for this day's assignments ── */}
          {(() => {
            const dayAssignments = assignments[String(day.id)] || []
            const dayReservations = reservations.filter(r => dayAssignments.some(a => a.id === r.assignment_id))
            if (dayReservations.length === 0) return null
            return (
              <div style={{ marginBottom: 0 }}>
                {day.date && lat && lng && <div style={{ height: 1, background: 'var(--border-faint)', margin: '12px 0' }} />}
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{t('day.reservations')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayReservations.map(r => {
                    const linkedAssignment = dayAssignments.find(a => a.id === r.assignment_id)
                    const confirmed = r.status === 'confirmed'
                    return (
                      <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 8, background: confirmed ? 'rgba(22,163,74,0.06)' : 'rgba(217,119,6,0.06)', border: `1px solid ${confirmed ? 'rgba(22,163,74,0.15)' : 'rgba(217,119,6,0.15)'}` }}>
                        {(() => { const TIcon = RES_TYPE_ICONS[r.type] || FileText; return <TIcon size={12} style={{ color: RES_TYPE_COLORS[r.type] || 'var(--text-faint)', flexShrink: 0 }} /> })()}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                          {linkedAssignment?.place && <span style={{ fontSize: 9, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>· {linkedAssignment.place.name}</span>}
                        </div>
                        {r.reservation_time?.includes('T') && (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                            {new Date(r.reservation_time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: is12h })}
                            {r.reservation_end_time && ` – ${fmtTime(r.reservation_end_time)}`}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Divider before accommodation */}
          <div style={{ height: 1, background: 'var(--border-faint)', margin: '12px 0' }} />

          {/* ── Accommodation ── */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{t('day.accommodation')}</div>

            {dayAccommodations.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {dayAccommodations.map(acc => {
                  const isCheckInDay = acc.start_day_id === day.id
                  const isCheckOutDay = acc.end_day_id === day.id
                  const isMiddleDay = !isCheckInDay && !isCheckOutDay
                  const dayLabel = isCheckInDay && isCheckOutDay ? t('day.checkIn') + ' & ' + t('day.checkOut')
                    : isCheckInDay ? t('day.checkIn')
                    : isCheckOutDay ? t('day.checkOut')
                    : null
                  const linked = reservations.find(r => r.accommodation_id === acc.id)
                  const confirmed = linked?.status === 'confirmed'

                  return (
                    <div key={acc.id} style={{ borderRadius: 12, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                      {/* Day label */}
                      {dayLabel && (
                        <div style={{ padding: '4px 12px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                          {isCheckInDay && <LogIn size={9} style={{ color: '#22c55e' }} />}
                          {isCheckOutDay && !isCheckInDay && <LogOut size={9} style={{ color: '#ef4444' }} />}
                          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: isCheckOutDay && !isCheckInDay ? '#ef4444' : '#22c55e' }}>{dayLabel}</span>
                        </div>
                      )}
                      {/* Hotel header */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {acc.place_image ? (
                            <img src={acc.place_image} style={{ width: '100%', height: '100%', borderRadius: 10, objectFit: 'cover' }} />
                          ) : (
                            <Hotel size={16} style={{ color: 'var(--text-muted)' }} />
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.place_name}</div>
                          {acc.place_address && <div style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.place_address}</div>}
                        </div>
                        {canEditDays && <button onClick={() => { setAccommodation(acc); setHotelForm({ check_in: acc.check_in || '', check_out: acc.check_out || '', confirmation: acc.confirmation || '', place_id: acc.place_id }); setHotelDayRange({ start: acc.start_day_id, end: acc.end_day_id }); setShowHotelPicker('edit') }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, flexShrink: 0 }}>
                          <Pencil size={12} style={{ color: 'var(--text-faint)' }} />
                        </button>}
                        {canEditDays && <button onClick={() => { setAccommodation(acc); handleRemoveAccommodation() }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 3, flexShrink: 0 }}>
                          <X size={12} style={{ color: 'var(--text-faint)' }} />
                        </button>}
                      </div>
                      {/* Details grid */}
                      <div style={{ display: 'flex', gap: 0, margin: '0 12px 8px', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-faint)' }}>
                        {acc.check_in && (
                          <div style={{ flex: 1, padding: '8px 10px', borderRight: '1px solid var(--border-faint)', textAlign: 'center' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>{fmtTime(acc.check_in)}</div>
                            <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                              <LogIn size={8} /> {t('day.checkIn')}
                            </div>
                          </div>
                        )}
                        {acc.check_out && (
                          <div style={{ flex: 1, padding: '8px 10px', borderRight: acc.confirmation ? '1px solid var(--border-faint)' : 'none', textAlign: 'center' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>{fmtTime(acc.check_out)}</div>
                            <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                              <LogOut size={8} /> {t('day.checkOut')}
                            </div>
                          </div>
                        )}
                        {acc.confirmation && (
                          <div style={{ flex: 1, padding: '8px 10px', textAlign: 'center' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>{acc.confirmation}</div>
                            <div style={{ fontSize: 9, color: 'var(--text-faint)', fontWeight: 500, marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                              <Hash size={8} /> {t('day.confirmation')}
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Linked booking */}
                      {linked && (
                        <div style={{ margin: '0 12px 8px', padding: '6px 10px', borderRadius: 8, background: confirmed ? 'rgba(22,163,74,0.06)' : 'rgba(217,119,6,0.06)', border: `1px solid ${confirmed ? 'rgba(22,163,74,0.15)' : 'rgba(217,119,6,0.15)'}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: confirmed ? '#16a34a' : '#d97706', flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{linked.title}</div>
                            <div style={{ fontSize: 9, color: 'var(--text-faint)', display: 'flex', gap: 6, marginTop: 1 }}>
                              <span>{confirmed ? t('reservations.confirmed') : t('reservations.pending')}</span>
                              {linked.confirmation_number && <span
                                onMouseEnter={e => { if (blurCodes) e.currentTarget.style.filter = 'none' }}
                                onMouseLeave={e => { if (blurCodes) e.currentTarget.style.filter = 'blur(4px)' }}
                                onClick={e => { if (blurCodes) { const el = e.currentTarget; el.style.filter = el.style.filter === 'none' ? 'blur(4px)' : 'none' } }}
                                style={{ filter: blurCodes ? 'blur(4px)' : 'none', transition: 'filter 0.2s', cursor: blurCodes ? 'pointer' : 'default' }}
                              >#{linked.confirmation_number}</span>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                {/* Add another hotel */}
                {canEditDays && <button onClick={() => setShowHotelPicker(true)} style={{
                  width: '100%', padding: 8, border: '1.5px dashed var(--border-primary)', borderRadius: 10,
                  background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  fontSize: 10, color: 'var(--text-faint)', fontFamily: 'inherit',
                }}>
                  <Hotel size={10} /> {t('day.addAccommodation')}
                </button>}
              </div>
            ) : (
              canEditDays ? <button onClick={() => setShowHotelPicker(true)} style={{
                width: '100%', padding: 10, border: '1.5px dashed var(--border-primary)', borderRadius: 10,
                background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                fontSize: 11, color: 'var(--text-faint)', fontFamily: 'inherit',
              }}>
                <Hotel size={12} /> {t('day.addAccommodation')}
              </button> : null
            )}

            {/* Hotel Picker Popup — portal to body to escape transform stacking context */}
            {showHotelPicker && ReactDOM.createPortal(
              <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                onClick={() => setShowHotelPicker(false)}>
                <div onClick={e => e.stopPropagation()} style={{
                  width: '100%', maxWidth: 900, borderRadius: 16, overflow: 'hidden',
                  background: 'var(--bg-card)', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
                  ...font,
                }}>
                  {/* Popup Header */}
                  <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid var(--border-faint)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Hotel size={16} style={{ color: 'var(--text-primary)' }} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{showHotelPicker === 'edit' ? t('day.editAccommodation') : t('day.addAccommodation')}</span>
                    <button onClick={() => setShowHotelPicker(false)} style={{ background: 'var(--bg-secondary)', border: 'none', borderRadius: 8, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <X size={12} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </div>

                  {/* Day Range */}
                  <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-faint)', background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('day.hotelDayRange')}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <CustomSelect
                          value={hotelDayRange.start}
                          onChange={v => setHotelDayRange(prev => ({ start: v, end: Math.max(v, prev.end) }))}
                          options={days.map((d, i) => ({
                            value: d.id,
                            label: `${d.title || t('planner.dayN', { n: i + 1 })}${d.date ? ` — ${new Date(d.date + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })}` : ''}`,
                          }))}
                          size="sm"
                        />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>→</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <CustomSelect
                          value={hotelDayRange.end}
                          onChange={v => setHotelDayRange(prev => ({ start: Math.min(prev.start, v), end: v }))}
                          options={days.map((d, i) => ({
                            value: d.id,
                            label: `${d.title || t('planner.dayN', { n: i + 1 })}${d.date ? ` — ${new Date(d.date + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })}` : ''}`,
                          }))}
                          size="sm"
                        />
                      </div>
                      <button onClick={() => setHotelDayRange({ start: days[0]?.id, end: days[days.length - 1]?.id })} style={{
                        padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                        background: hotelDayRange.start === days[0]?.id && hotelDayRange.end === days[days.length - 1]?.id ? 'var(--text-primary)' : 'var(--bg-card)',
                        color: hotelDayRange.start === days[0]?.id && hotelDayRange.end === days[days.length - 1]?.id ? 'var(--bg-card)' : 'var(--text-muted)',
                      }}>
                        {t('day.allDays')}
                      </button>
                    </div>
                  </div>

                  {/* Check-in / Check-out / Confirmation */}
                  <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border-faint)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 100 }}>
                      <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 3 }}>{t('day.checkIn')}</label>
                      <CustomTimePicker value={hotelForm.check_in} onChange={v => setHotelForm(f => ({ ...f, check_in: v }))} placeholder="14:00" />
                    </div>
                    <div style={{ flex: 1, minWidth: 100 }}>
                      <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 3 }}>{t('day.checkOut')}</label>
                      <CustomTimePicker value={hotelForm.check_out} onChange={v => setHotelForm(f => ({ ...f, check_out: v }))} placeholder="11:00" />
                    </div>
                    <div style={{ flex: 2, minWidth: 120 }}>
                      <label style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 3 }}>{t('day.confirmation')}</label>
                      <input type="text" value={hotelForm.confirmation} onChange={e => setHotelForm(f => ({ ...f, confirmation: e.target.value }))}
                        placeholder="ABC-12345" style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', height: 38 }} />
                    </div>
                  </div>

                  {/* Category Filter */}
                  {categories.length > 0 && (
                    <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--border-faint)', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => setHotelCategoryFilter('')} style={{
                        padding: '3px 10px', borderRadius: 6, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                        background: !hotelCategoryFilter ? 'var(--text-primary)' : 'var(--bg-secondary)',
                        color: !hotelCategoryFilter ? 'var(--bg-card)' : 'var(--text-muted)',
                      }}>{t('day.allDays')}</button>

                      {categories.map(c => (
                        <button key={c.id} onClick={() => setHotelCategoryFilter(c.id)} style={{
                          padding: '3px 10px', borderRadius: 6, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                          background: hotelCategoryFilter === c.id ? c.color || 'var(--text-primary)' : 'var(--bg-secondary)',
                          color: hotelCategoryFilter === c.id ? '#fff' : 'var(--text-muted)',
                        }}>{c.name}</button>
                      ))}
                    </div>
                  )}

                  {/* Place List */}
                  <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                    {(() => {
                      const filtered = hotelCategoryFilter ? places.filter(p => p.category_id === hotelCategoryFilter) : places
                      return filtered.length === 0 ? (
                        <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}>{t('day.noPlacesForHotel')}</div>
                      ) : filtered.map(p => (
                      <button key={p.id} onClick={() => handleSelectPlace(p.id)} style={{
                        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 18px',
                        border: 'none', borderBottom: '1px solid var(--border-faint)',
                        background: hotelForm.place_id === p.id ? 'var(--bg-hover)' : 'none',
                        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                        transition: 'background 0.1s',
                        outline: hotelForm.place_id === p.id ? '2px solid var(--accent)' : 'none',
                        outlineOffset: -2, borderRadius: hotelForm.place_id === p.id ? 8 : 0,
                      }}
                        onMouseEnter={e => { if (hotelForm.place_id !== p.id) e.currentTarget.style.background = 'var(--bg-hover)' }}
                        onMouseLeave={e => { if (hotelForm.place_id !== p.id) e.currentTarget.style.background = 'none' }}
                      >
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {p.image_url ? (
                            <img src={p.image_url} style={{ width: '100%', height: '100%', borderRadius: 8, objectFit: 'cover' }} />
                          ) : (
                            <MapPin size={13} style={{ color: 'var(--text-faint)' }} />
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                          {p.address && <div style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address}</div>}
                        </div>
                      </button>
                    ))
                    })()}
                  </div>

                {/* Save / Cancel */}
                <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-faint)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={() => setShowHotelPicker(false)} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={async () => {
                    if (showHotelPicker === 'edit' && accommodation) {
                      // Update existing
                      await accommodationsApi.update(tripId, accommodation.id, {
                        place_id: hotelForm.place_id,
                        start_day_id: hotelDayRange.start,
                        end_day_id: hotelDayRange.end,
                        check_in: hotelForm.check_in || null,
                        check_out: hotelForm.check_out || null,
                        confirmation: hotelForm.confirmation || null,
                      })
                      setShowHotelPicker(false)
                      setHotelForm({ check_in: '', check_out: '', confirmation: '', place_id: null })
                      // Reload
                      accommodationsApi.list(tripId).then(d => {
                        const all = d.accommodations || []
                        setAccommodations(all)
                        setDayAccommodations(all.filter(a =>
                          days.some(dd => dd.id >= a.start_day_id && dd.id <= a.end_day_id && dd.id === day?.id)
                        ))
                        const acc = all.find(a => days.some(dd => dd.id >= a.start_day_id && dd.id <= a.end_day_id && dd.id === day?.id))
                        setAccommodation(acc || null)
                      })
                      onAccommodationChange?.()
                    } else {
                      await handleSaveAccommodation()
                    }
                  }} disabled={!hotelForm.place_id} style={{
                    padding: '7px 20px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    background: hotelForm.place_id ? 'var(--text-primary)' : 'var(--bg-tertiary)',
                    color: hotelForm.place_id ? 'var(--bg-card)' : 'var(--text-faint)',
                  }}>
                    {t('common.save')}
                  </button>
                </div>

                </div>
              </div>,
              document.body
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

interface ChipProps {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  value: string
}

function Chip({ icon: Icon, value }: ChipProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
      <Icon size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  )
}

interface InfoChipProps {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  label: string
  value: string
  placeholder: string
  onEdit: (value: string) => void
  type: 'text' | 'time'
}

function InfoChip({ icon: Icon, label, value, placeholder, onEdit, type }: InfoChipProps) {
  const [editing, setEditing] = React.useState(false)
  const [val, setVal] = React.useState(value || '')
  const inputRef = React.useRef(null)

  React.useEffect(() => { setVal(value || '') }, [value])
  React.useEffect(() => { if (editing && inputRef.current) inputRef.current.focus() }, [editing])

  const save = () => {
    setEditing(false)
    if (val !== (value || '')) onEdit(val)
  }

  return (
    <div
      onClick={() => setEditing(true)}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 8,
        background: 'var(--bg-card)', border: '1px solid var(--border-faint)',
        cursor: 'pointer', minWidth: 0, flex: type === 'text' ? 1 : undefined,
      }}
    >
      <Icon size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 8, color: 'var(--text-faint)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', lineHeight: 1 }}>{label}</div>
        {editing ? (
          <input
            ref={inputRef}
            type={type}
            value={val}
            onChange={e => setVal(e.target.value)}
            onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setVal(value || ''); setEditing(false) } }}
            onClick={e => e.stopPropagation()}
            style={{
              border: 'none', outline: 'none', background: 'none', padding: 0, margin: 0,
              fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'inherit',
              width: type === 'time' ? 50 : '100%', lineHeight: 1.3,
            }}
          />
        ) : (
          <div style={{ fontSize: 11, fontWeight: 600, color: value ? 'var(--text-primary)' : 'var(--text-faint)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value || placeholder}
          </div>
        )}
      </div>
    </div>
  )
}
