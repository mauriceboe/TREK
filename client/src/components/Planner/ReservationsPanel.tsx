import { useState, useMemo, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import {
  Plane, Hotel, Utensils, Train, Car, Ship, Ticket, FileText, MapPin,
  Calendar, Hash, CheckCircle2, Circle, Pencil, Trash2, Plus, ChevronDown, ChevronRight, Users,
  ExternalLink, BookMarked, Lightbulb, Link2, Clock, ArrowRight, AlertCircle,
} from 'lucide-react'
import { openFile } from '../../utils/fileDownload'
import type { Reservation, Day, TripFile, AssignmentsMap } from '../../types'

interface AssignmentLookupEntry {
  dayNumber: number
  dayTitle: string | null
  dayDate: string
  placeName: string
  startTime: string | null
  endTime: string | null
}

const TYPE_OPTIONS = [
  { value: 'flight',      labelKey: 'reservations.type.flight',      Icon: Plane, color: '#3b82f6' },
  { value: 'hotel',       labelKey: 'reservations.type.hotel',       Icon: Hotel, color: '#8b5cf6' },
  { value: 'restaurant',  labelKey: 'reservations.type.restaurant',  Icon: Utensils, color: '#ef4444' },
  { value: 'train',       labelKey: 'reservations.type.train',       Icon: Train, color: '#06b6d4' },
  { value: 'car',         labelKey: 'reservations.type.car',         Icon: Car, color: '#6b7280' },
  { value: 'cruise',      labelKey: 'reservations.type.cruise',      Icon: Ship, color: '#0ea5e9' },
  { value: 'event',       labelKey: 'reservations.type.event',       Icon: Ticket, color: '#f59e0b' },
  { value: 'tour',        labelKey: 'reservations.type.tour',        Icon: Users, color: '#10b981' },
  { value: 'other',       labelKey: 'reservations.type.other',       Icon: FileText, color: '#6b7280' },
]

function getType(type) {
  return TYPE_OPTIONS.find(t => t.value === type) || TYPE_OPTIONS[TYPE_OPTIONS.length - 1]
}

function buildAssignmentLookup(days, assignments) {
  const map = {}
  for (const day of (days || [])) {
    const da = (assignments?.[String(day.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    for (const a of da) {
      if (!a.place) continue
      map[a.id] = { dayNumber: day.day_number, dayTitle: day.title, dayDate: day.date, placeName: a.place.name, startTime: a.place.place_time, endTime: a.place.end_time }
    }
  }
  return map
}

/* ── Shared field label style ── */
const fieldLabelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em',
  color: 'var(--text-faint)', marginBottom: 5,
}
const fieldValueStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
  padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 10,
}

interface ReservationCardProps {
  r: Reservation
  tripId: number
  onEdit: (reservation: Reservation) => void
  onDelete: (id: number) => void
  files?: TripFile[]
  onNavigateToFiles: () => void
  assignmentLookup: Record<number, AssignmentLookupEntry>
  canEdit: boolean
  days?: Day[]
}

function ReservationCard({ r, tripId, onEdit, onDelete, files = [], onNavigateToFiles, assignmentLookup, canEdit, days = [] }: ReservationCardProps) {
  const { toggleReservationStatus } = useTripStore()
  const toast = useToast()
  const { t, locale } = useTranslation()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const blurCodes = useSettingsStore(s => s.settings.blur_booking_codes)
  const [codeRevealed, setCodeRevealed] = useState(false)
  const typeInfo = getType(r.type)
  const TypeIcon = typeInfo.Icon
  const confirmed = r.status === 'confirmed'
  const attachedFiles = files.filter(f => f.reservation_id === r.id || (f.linked_reservation_ids || []).includes(r.id))
  const linked = r.assignment_id ? assignmentLookup[r.assignment_id] : null
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleToggle = async () => {
    try { await toggleReservationStatus(tripId, r.id) }
    catch { toast.error(t('reservations.toast.updateError')) }
  }
  const handleDelete = async () => {
    setShowDeleteConfirm(false)
    try { await onDelete(r.id) } catch { toast.error(t('reservations.toast.deleteError')) }
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const fmtDate = (str) => {
    const dateOnly = str.includes('T') ? str.split('T')[0] : str
    return new Date(dateOnly + 'T00:00:00Z').toLocaleDateString(locale, { ...(isMobile ? {} : { weekday: 'short' }), day: 'numeric', month: 'short', timeZone: 'UTC' })
  }
  const fmtTime = (str) => {
    const d = new Date(str)
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })
  }

  const hasDate = !!r.reservation_time
  const hasTime = r.reservation_time?.includes('T')
  const hasCode = !!r.confirmation_number
  const dateCols = [hasDate, hasTime, hasCode].filter(Boolean).length

  const TRANSPORT_TYPES_SET = new Set(['flight', 'train', 'bus', 'car', 'cruise'])
  const isTransportType = TRANSPORT_TYPES_SET.has(r.type)
  const isHotel = r.type === 'hotel'
  const startDay = r.day_id ? days.find(d => d.id === r.day_id)
    : (isHotel && r.accommodation_start_day_id) ? days.find(d => d.id === r.accommodation_start_day_id)
    : undefined
  const endDay = r.end_day_id ? days.find(d => d.id === r.end_day_id)
    : (isHotel && r.accommodation_end_day_id) ? days.find(d => d.id === r.accommodation_end_day_id)
    : undefined
  const DayLabel = ({ day }: { day: typeof startDay }) => {
    if (!day) return null
    const name = day.title || t('dayplan.dayN', { n: day.day_number })
    const badge = day.date
      ? new Date(day.date + 'T00:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
      : null
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span>{name}</span>
        {badge && (
          <span style={{
            fontSize: 10, fontWeight: 600, color: 'var(--text-faint)',
            background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: 999,
          }}>{badge}</span>
        )}
      </span>
    )
  }

  return (
    <div style={{
      borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      border: `1px solid ${confirmed ? 'rgba(22,163,74,0.25)' : 'rgba(217,119,6,0.25)'}`,
      background: 'var(--bg-card)',
      transition: 'box-shadow 0.15s ease',
    }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
    >
      {/* Header — wraps to a second row on narrow screens so the status/category chips
          never collide with the title. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        flexWrap: 'wrap',
        padding: '12px 14px',
        background: confirmed ? 'rgba(22,163,74,0.06)' : 'rgba(217,119,6,0.06)',
      }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 600, color: confirmed ? '#16a34a' : '#d97706',
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: confirmed ? '#16a34a' : '#d97706' }} />
            {confirmed ? t('reservations.confirmed') : t('reservations.pending')}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 12, color: 'var(--text-muted)',
            padding: '3px 8px', borderRadius: 6,
            background: 'var(--bg-secondary)',
          }}>
            <TypeIcon size={12} style={{ color: typeInfo.color }} />
            {t(typeInfo.labelKey)}
          </span>
          {r.needs_review ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, fontWeight: 600, color: '#b45309',
              padding: '3px 8px', borderRadius: 6,
              background: 'rgba(245,158,11,0.12)',
            }} title={t('reservations.needsReviewHint')}>
              <AlertCircle size={11} />
              {t('reservations.needsReview')}
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginRight: 6,
            maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{r.title}</span>
          {canEdit && (
            <button onClick={() => onEdit(r)} title={t('common.edit')} style={{
              appearance: 'none', border: 'none', background: 'transparent',
              width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center',
              cursor: 'pointer', color: 'var(--text-faint)', flexShrink: 0,
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; e.currentTarget.style.color = 'var(--text-primary)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)' }}>
              <Pencil size={13} />
            </button>
          )}
          {canEdit && (
            <button onClick={() => setShowDeleteConfirm(true)} title={t('common.delete')} style={{
              appearance: 'none', border: 'none', background: 'transparent',
              width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center',
              cursor: 'pointer', color: 'var(--text-faint)', flexShrink: 0,
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; e.currentTarget.style.color = '#ef4444' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)' }}>
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        {/* Day label for transport/hotel reservations linked to days */}
        {(isTransportType || isHotel) && startDay && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.date')}</div>
            <div style={{ ...fieldValueStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
              <DayLabel day={startDay} />
              {endDay && endDay.id !== startDay.id && (
                <><span style={{ color: 'var(--text-faint)' }}>–</span><DayLabel day={endDay} /></>
              )}
            </div>
          </div>
        )}
        {/* Date / Time row */}
        {hasDate && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: hasTime ? '1fr 1fr' : '1fr' }}>
            <div>
              <div style={fieldLabelStyle}>{t('reservations.date')}</div>
              <div style={{ ...fieldValueStyle, textAlign: 'center' }}>
                {fmtDate(r.reservation_time)}
                {(() => {
                  const endDatePart = r.reservation_end_time
                    ? r.reservation_end_time.includes('T')
                        ? r.reservation_end_time.split('T')[0]
                        : /^\d{4}-\d{2}-\d{2}$/.test(r.reservation_end_time)
                            ? r.reservation_end_time
                            : null
                    : null
                  return endDatePart && endDatePart !== r.reservation_time.split('T')[0]
                })() && (
                  <> – {fmtDate(r.reservation_end_time)}</>
                )}
              </div>
            </div>
            {hasTime && (
              <div>
                <div style={fieldLabelStyle}>{t('reservations.time')}</div>
                <div style={{ ...fieldValueStyle, textAlign: 'center' }}>
                  {fmtTime(r.reservation_time)}{r.reservation_end_time ? ` – ${r.reservation_end_time.includes('T') ? fmtTime(r.reservation_end_time) : fmtTime(r.reservation_time.split('T')[0] + 'T' + r.reservation_end_time)}` : ''}
                </div>
              </div>
            )}
          </div>
        )}
        {/* Booking code */}
        {hasCode && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.confirmationCode')}</div>
            <div
              onMouseEnter={() => blurCodes && setCodeRevealed(true)}
              onMouseLeave={() => blurCodes && setCodeRevealed(false)}
              onClick={() => blurCodes && setCodeRevealed(v => !v)}
              style={{
                ...fieldValueStyle, textAlign: 'center',
                fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace', fontSize: 12.5,
                filter: blurCodes && !codeRevealed ? 'blur(5px)' : 'none',
                cursor: blurCodes ? 'pointer' : 'default',
                transition: 'filter 0.2s',
              }}
            >
              {r.confirmation_number}
            </div>
          </div>
        )}

        {(() => {
          const eps = r.endpoints || []
          const from = eps.find(e => e.role === 'from')
          const to = eps.find(e => e.role === 'to')
          if (!from || !to) return null
          return (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '8px 12px', borderRadius: 10,
              background: 'var(--bg-tertiary)',
              fontSize: 12.5, color: 'var(--text-primary)',
            }}>
              <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{from.name}</span>
              <TypeIcon size={14} style={{ color: typeInfo.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{to.name}</span>
            </div>
          )
        })()}

        {/* Type-specific metadata */}
        {(() => {
          const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {})
          if (!meta || Object.keys(meta).length === 0) return null
          const hasEndpoints = (r.endpoints || []).some(e => e.role === 'from') && (r.endpoints || []).some(e => e.role === 'to')
          const cells: { label: string; value: string }[] = []
          if (meta.airline) cells.push({ label: t('reservations.meta.airline'), value: meta.airline })
          if (meta.flight_number) cells.push({ label: t('reservations.meta.flightNumber'), value: meta.flight_number })
          if (!hasEndpoints && meta.departure_airport) cells.push({ label: t('reservations.meta.from'), value: meta.departure_airport })
          if (!hasEndpoints && meta.arrival_airport) cells.push({ label: t('reservations.meta.to'), value: meta.arrival_airport })
          if (meta.train_number) cells.push({ label: t('reservations.meta.trainNumber'), value: meta.train_number })
          if (meta.platform) cells.push({ label: t('reservations.meta.platform'), value: meta.platform })
          if (meta.seat) cells.push({ label: t('reservations.meta.seat'), value: meta.seat })
          if (meta.check_in_time) cells.push({ label: t('reservations.meta.checkIn'), value: fmtTime('2000-01-01T' + meta.check_in_time) + (meta.check_in_end_time ? ` – ${fmtTime('2000-01-01T' + meta.check_in_end_time)}` : '') })
          if (meta.check_out_time) cells.push({ label: t('reservations.meta.checkOut'), value: fmtTime('2000-01-01T' + meta.check_out_time) })
          if (cells.length === 0) return null
          return (
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: cells.length > 1 ? `repeat(${Math.min(cells.length, 3)}, 1fr)` : '1fr' }}>
              {cells.map((c, i) => (
                <div key={i}>
                  <div style={fieldLabelStyle}>{c.label}</div>
                  <div style={{ ...fieldValueStyle, textAlign: 'center' }}>{c.value}</div>
                </div>
              ))}
            </div>
          )
        })()}

        {/* Location / Accommodation / Assignment */}
        {r.location && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.locationAddress')}</div>
            <div style={{ ...fieldValueStyle, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <MapPin size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.location}</span>
            </div>
          </div>
        )}
        {r.accommodation_name && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.meta.linkAccommodation')}</div>
            <div style={{ ...fieldValueStyle, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <Hotel size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.accommodation_name}</span>
            </div>
          </div>
        )}
        {linked && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.linkAssignment')}</div>
            <div style={{ ...fieldValueStyle, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <Link2 size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {linked.dayTitle || t('dayplan.dayN', { n: linked.dayNumber })} — {linked.placeName}
                {linked.startTime ? ` · ${linked.startTime}${linked.endTime ? ' – ' + linked.endTime : ''}` : ''}
              </span>
            </div>
          </div>
        )}

        {/* Notes */}
        {r.notes && (
          <div>
            <div style={fieldLabelStyle}>{t('reservations.notes')}</div>
            <div style={{ ...fieldValueStyle, fontWeight: 400, lineHeight: 1.5 }}>{r.notes}</div>
          </div>
        )}

        {/* Files */}
        {attachedFiles.length > 0 && (
          <div>
            <div style={fieldLabelStyle}>{t('files.title')}</div>
            <div style={{ ...fieldValueStyle, display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px' }}>
              {attachedFiles.map(f => (
                <a key={f.id} href="#" onClick={(e) => { e.preventDefault(); openFile(f.url).catch(() => {}) }} style={{ display: 'flex', alignItems: 'center', gap: 5, textDecoration: 'none', cursor: 'pointer' }}>
                  <FileText size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(3px)',
        }} onClick={() => setShowDeleteConfirm(false)}>
          <div style={{
            width: 340, background: 'var(--bg-card)', borderRadius: 16,
            boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
            display: 'flex', flexDirection: 'column', gap: 12,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%', background: 'rgba(239,68,68,0.12)',
              }}>
                <Trash2 size={18} strokeWidth={1.8} color="#ef4444" />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('reservations.confirm.deleteTitle')}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {t('reservations.confirm.deleteBody', { name: r.title })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setShowDeleteConfirm(false)} style={{
                fontSize: 12, background: 'none', border: '1px solid var(--border-primary)',
                borderRadius: 8, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit',
              }}>{t('common.cancel')}</button>
              <button onClick={handleDelete} style={{
                fontSize: 12, background: '#ef4444', color: 'white',
                border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
              }}>{t('common.confirm')}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  count: number
  children: React.ReactNode
  defaultOpen?: boolean
  accent: 'green' | string
  storageKey?: string
}

function Section({ title, count, children, defaultOpen = true, accent, storageKey }: SectionProps) {
  const [open, setOpen] = useState(() => {
    if (!storageKey || typeof window === 'undefined') return defaultOpen
    const stored = window.localStorage.getItem(storageKey)
    if (stored === null) return defaultOpen
    return stored === '1'
  })
  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return
    window.localStorage.setItem(storageKey, open ? '1' : '0')
  }, [open, storageKey])
  return (
    <div style={{ marginBottom: 28 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: 12, fontFamily: 'inherit',
        userSelect: 'none',
      }}>
        {open ? <ChevronDown size={14} style={{ color: 'var(--text-faint)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-faint)' }} />}
        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 99,
          background: 'var(--bg-tertiary)', color: 'var(--text-faint)',
          minWidth: 20, textAlign: 'center',
        }}>{count}</span>
      </button>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(max(33.33% - 14px, 340px), 1fr))', gap: 14, alignItems: 'stretch' }}>
          {children}
        </div>
      )}
    </div>
  )
}

interface ReservationsPanelProps {
  tripId: number
  reservations: Reservation[]
  days: Day[]
  assignments: AssignmentsMap
  files?: TripFile[]
  onAdd: () => void
  onEdit: (reservation: Reservation) => void
  onDelete: (id: number) => void
  onNavigateToFiles: () => void
  titleKey?: string
  addManualKey?: string
}

export default function ReservationsPanel({ tripId, reservations, days, assignments, files = [], onAdd, onEdit, onDelete, onNavigateToFiles, titleKey = 'reservations.title', addManualKey = 'reservations.addManual' }: ReservationsPanelProps) {
  const { t, locale } = useTranslation()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('reservation_edit', trip)
  const [showHint, setShowHint] = useState(() => !localStorage.getItem('hideReservationHint'))

  const storageKey = `trek-reservation-filters-${tripId}`
  const [typeFilters, setTypeFilters] = useState<Set<string>>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch { return new Set() }
  })

  const toggleTypeFilter = (type: string) => {
    setTypeFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type); else next.add(type)
      sessionStorage.setItem(storageKey, JSON.stringify([...next]))
      return next
    })
  }

  const assignmentLookup = useMemo(() => buildAssignmentLookup(days, assignments), [days, assignments])

  const filtered = useMemo(() =>
    typeFilters.size === 0 ? reservations : reservations.filter(r => typeFilters.has(r.type)),
  [reservations, typeFilters])

  const allPending = filtered.filter(r => r.status !== 'confirmed')
  const allConfirmed = filtered.filter(r => r.status === 'confirmed')
  const total = filtered.length

  const usedTypes = useMemo(() => new Set(reservations.map(r => r.type)), [reservations])
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const r of reservations) counts[r.type] = (counts[r.type] || 0) + 1
    return counts
  }, [reservations])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Unified toolbar */}
      <div style={{ padding: '24px 28px 0' }} className="max-md:!px-4 max-md:!pt-4">
        <div style={{
          background: 'var(--bg-tertiary)', borderRadius: 18,
          padding: '14px 16px 14px 22px',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', flexShrink: 0 }}>
            {t(titleKey)}
          </h2>

          {reservations.length > 0 && (
            <>
              <div className="hidden md:block" style={{ width: 1, height: 22, background: 'var(--border-faint)', flexShrink: 0 }} />
              <div className="hidden md:inline-flex" style={{ gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                <button
                  onClick={() => { setTypeFilters(new Set()); sessionStorage.removeItem(storageKey) }}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 99, fontSize: 13, whiteSpace: 'nowrap',
                    background: typeFilters.size === 0 ? 'var(--bg-card)' : 'transparent',
                    color: typeFilters.size === 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: typeFilters.size === 0 ? 500 : 400,
                    boxShadow: typeFilters.size === 0 ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {t('common.all')}
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    background: typeFilters.size === 0 ? 'var(--bg-tertiary)' : 'rgba(0,0,0,0.06)',
                    color: 'var(--text-faint)',
                    padding: '1px 6px', borderRadius: 99, minWidth: 16, textAlign: 'center',
                  }}>{reservations.length}</span>
                </button>
                {TYPE_OPTIONS.filter(opt => usedTypes.has(opt.value)).map(opt => {
                  const active = typeFilters.has(opt.value)
                  const Icon = opt.Icon
                  return (
                    <button
                      key={opt.value}
                      onClick={() => toggleTypeFilter(opt.value)}
                      style={{
                        appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 12px', borderRadius: 99, fontSize: 13, whiteSpace: 'nowrap',
                        background: active ? 'var(--bg-card)' : 'transparent',
                        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                        fontWeight: active ? 500 : 400,
                        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <Icon size={13} style={{ color: active ? opt.color : 'var(--text-faint)' }} />
                      {t(opt.labelKey)}
                      <span style={{
                        fontSize: 10, fontWeight: 600,
                        background: active ? 'var(--bg-tertiary)' : 'rgba(0,0,0,0.06)',
                        color: 'var(--text-faint)',
                        padding: '1px 6px', borderRadius: 99, minWidth: 16, textAlign: 'center',
                      }}>{typeCounts[opt.value] || 0}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {canEdit && (
            <button onClick={onAdd} style={{
              appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
              background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
              marginLeft: 'auto',
              transition: 'opacity 0.15s ease',
            }}
              onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span className="hidden sm:inline">{t(addManualKey)}</span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 80px' }} className="max-md:!px-4 max-md:!pt-4">
        {total === 0 && reservations.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <BookMarked size={36} style={{ color: 'var(--text-faint)', display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('reservations.empty')}</p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>{t('reservations.emptyHint')}</p>
          </div>
        ) : total === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <p style={{ fontSize: 13, color: 'var(--text-faint)' }}>{t('places.noneFound')}</p>
          </div>
        ) : (
          <>
            {allPending.length > 0 && (
              <Section title={t('reservations.pending')} count={allPending.length} accent="gray" storageKey={`trek:bookings-pending-open:${tripId}`}>
                {allPending.map(r => <ReservationCard key={r.id} r={r} tripId={tripId} onEdit={onEdit} onDelete={onDelete} files={files} onNavigateToFiles={onNavigateToFiles} assignmentLookup={assignmentLookup} canEdit={canEdit} days={days} />)}
              </Section>
            )}
            {allConfirmed.length > 0 && (
              <Section title={t('reservations.confirmed')} count={allConfirmed.length} accent="green" storageKey={`trek:bookings-confirmed-open:${tripId}`}>
                {allConfirmed.map(r => <ReservationCard key={r.id} r={r} tripId={tripId} onEdit={onEdit} onDelete={onDelete} files={files} onNavigateToFiles={onNavigateToFiles} assignmentLookup={assignmentLookup} canEdit={canEdit} days={days} />)}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
