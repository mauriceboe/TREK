import { useState, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import {
  Plane, Hotel, Utensils, Train, Car, Ship, Ticket, FileText, MapPin,
  Calendar, Hash, CheckCircle2, Circle, Pencil, Trash2, Plus, ChevronDown, ChevronRight, Users,
  ExternalLink, BookMarked, Lightbulb, Link2, Clock,
} from 'lucide-react'
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

interface ReservationCardProps {
  r: Reservation
  tripId: number
  onEdit: (reservation: Reservation) => void
  onDelete: (id: number) => void
  files?: TripFile[]
  onNavigateToFiles: () => void
  assignmentLookup: Record<number, AssignmentLookupEntry>
  canEdit: boolean
}

function ReservationCard({ r, tripId, onEdit, onDelete, files = [], onNavigateToFiles, assignmentLookup, canEdit }: ReservationCardProps) {
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

  const fmtDate = (str) => {
    const d = new Date(str)
    return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
  }
  const fmtTime = (str) => {
    const d = new Date(str)
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' })
  }

  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${confirmed ? 'rgba(22,163,74,0.2)' : 'rgba(217,119,6,0.2)'}` }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: confirmed ? 'rgba(22,163,74,0.06)' : 'rgba(217,119,6,0.06)' }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: confirmed ? '#16a34a' : '#d97706' }} />
        {canEdit ? (
          <button onClick={handleToggle} style={{ fontSize: 10, fontWeight: 700, color: confirmed ? '#16a34a' : '#d97706', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
            {confirmed ? t('reservations.confirmed') : t('reservations.pending')}
          </button>
        ) : (
          <span style={{ fontSize: 10, fontWeight: 700, color: confirmed ? '#16a34a' : '#d97706', padding: 0 }}>
            {confirmed ? t('reservations.confirmed') : t('reservations.pending')}
          </span>
        )}
        <div style={{ width: 1, height: 10, background: 'var(--border-faint)' }} />
        <TypeIcon size={11} style={{ color: typeInfo.color, flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{t(typeInfo.labelKey)}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
        {canEdit && (
          <button onClick={() => onEdit(r)} title={t('common.edit')} style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
            <Pencil size={11} />
          </button>
        )}
        {canEdit && (
          <button onClick={() => setShowDeleteConfirm(true)} title={t('common.delete')} style={{ padding: 3, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Details */}
      {(r.reservation_time || r.confirmation_number || r.location || linked || r.metadata) && (
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Row 1: Date, Time, Code */}
          {(r.reservation_time || r.confirmation_number) && (
            <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-secondary)', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
              {r.reservation_time && (
                <div style={{ flex: 1, padding: '5px 10px', textAlign: 'center', borderRight: '1px solid var(--border-faint)' }}>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{t('reservations.date')}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginTop: 1 }}>{fmtDate(r.reservation_time)}</div>
                </div>
              )}
              {r.reservation_time?.includes('T') && (
                <div style={{ flex: 1, padding: '5px 10px', textAlign: 'center', borderRight: '1px solid var(--border-faint)' }}>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{t('reservations.time')}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginTop: 1 }}>
                    {fmtTime(r.reservation_time)}{r.reservation_end_time ? ` – ${r.reservation_end_time.includes('T') ? fmtTime(r.reservation_end_time) : fmtTime(r.reservation_time.split('T')[0] + 'T' + r.reservation_end_time)}` : ''}
                  </div>
                </div>
              )}
              {r.confirmation_number && (
                <div style={{ flex: 1, padding: '5px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{t('reservations.confirmationCode')}</div>
                  <div
                    onMouseEnter={() => blurCodes && setCodeRevealed(true)}
                    onMouseLeave={() => blurCodes && setCodeRevealed(false)}
                    onClick={() => blurCodes && setCodeRevealed(v => !v)}
                    style={{
                      fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginTop: 1,
                      filter: blurCodes && !codeRevealed ? 'blur(5px)' : 'none',
                      cursor: blurCodes ? 'pointer' : 'default',
                      transition: 'filter 0.2s',
                    }}
                  >
                    {r.confirmation_number}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Row 1b: Type-specific metadata */}
          {(() => {
            const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {})
            if (!meta || Object.keys(meta).length === 0) return null
            const cells: { label: string; value: string }[] = []
            if (meta.airline) cells.push({ label: t('reservations.meta.airline'), value: meta.airline })
            if (meta.flight_number) cells.push({ label: t('reservations.meta.flightNumber'), value: meta.flight_number })
            if (meta.departure_airport) cells.push({ label: t('reservations.meta.from'), value: meta.departure_airport })
            if (meta.arrival_airport) cells.push({ label: t('reservations.meta.to'), value: meta.arrival_airport })
            if (meta.train_number) cells.push({ label: t('reservations.meta.trainNumber'), value: meta.train_number })
            if (meta.platform) cells.push({ label: t('reservations.meta.platform'), value: meta.platform })
            if (meta.seat) cells.push({ label: t('reservations.meta.seat'), value: meta.seat })
            if (meta.check_in_time) cells.push({ label: t('reservations.meta.checkIn'), value: meta.check_in_time })
            if (meta.check_out_time) cells.push({ label: t('reservations.meta.checkOut'), value: meta.check_out_time })
            if (cells.length === 0) return null
            return (
              <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-secondary)', boxShadow: '0 1px 6px rgba(0,0,0,0.08)' }}>
                {cells.map((c, i) => (
                  <div key={i} style={{ flex: 1, padding: '5px 10px', textAlign: 'center', borderRight: i < cells.length - 1 ? '1px solid var(--border-faint)' : 'none' }}>
                    <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{c.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', marginTop: 1 }}>{c.value}</div>
                  </div>
                ))}
              </div>
            )
          })()}
          {/* Row 2: Location + Assignment */}
          {(r.location || linked || r.accommodation_name) && (
            <div className={`grid grid-cols-1 ${r.location && linked ? 'sm:grid-cols-2' : ''} gap-2`} style={{ paddingTop: 6, borderTop: '1px solid var(--border-faint)' }}>
              {r.location && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.locationAddress')}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 7, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
                    <MapPin size={10} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.location}</span>
                  </div>
                </div>
              )}
              {r.accommodation_name && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.meta.linkAccommodation')}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 7, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
                    <Hotel size={10} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.accommodation_name}</span>
                  </div>
                </div>
              )}
              {linked && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.linkAssignment')}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 7, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)' }}>
                    <Link2 size={10} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {linked.dayTitle || t('dayplan.dayN', { n: linked.dayNumber })} — {linked.placeName}
                      {linked.startTime ? ` · ${linked.startTime}${linked.endTime ? ' – ' + linked.endTime : ''}` : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {r.notes && (
        <div style={{ padding: '0 12px 8px' }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.notes')}</div>
          <div style={{ padding: '5px 8px', borderRadius: 7, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {r.notes}
          </div>
        </div>
      )}

      {/* Files */}
      {attachedFiles.length > 0 && (
        <div style={{ padding: '0 12px 8px' }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('files.title')}</div>
          <div style={{ padding: '4px 8px', borderRadius: 7, background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {attachedFiles.map(f => (
              <a key={f.id} href={f.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'none', cursor: 'pointer' }}>
                <FileText size={9} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
              </a>
            ))}
          </div>
        </div>
      )}
      {/* Delete confirmation popup */}
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
}

function Section({ title, count, children, defaultOpen = true, accent }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ marginBottom: 16 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: 8, fontFamily: 'inherit',
      }}>
        {open ? <ChevronDown size={14} style={{ color: 'var(--text-faint)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-faint)' }} />}
        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{title}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 99,
          background: accent === 'green' ? 'rgba(22,163,74,0.1)' : 'var(--bg-tertiary)',
          color: accent === 'green' ? '#16a34a' : 'var(--text-faint)',
        }}>{count}</span>
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>}
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
}

export default function ReservationsPanel({ tripId, reservations, days, assignments, files = [], onAdd, onEdit, onDelete, onNavigateToFiles }: ReservationsPanelProps) {
  const { t, locale } = useTranslation()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('reservation_edit', trip)
  const [showHint, setShowHint] = useState(() => !localStorage.getItem('hideReservationHint'))

  const assignmentLookup = useMemo(() => buildAssignmentLookup(days, assignments), [days, assignments])

  const allPending = reservations.filter(r => r.status !== 'confirmed')
  const allConfirmed = reservations.filter(r => r.status === 'confirmed')
  const total = reservations.length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-faint)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{t('reservations.title')}</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
            {total === 0 ? t('reservations.empty') : t('reservations.summary', { confirmed: allConfirmed.length, pending: allPending.length })}
          </p>
        </div>
        {canEdit && (
          <button onClick={onAdd} style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 99,
            border: 'none', background: 'var(--accent)', color: 'var(--accent-text)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            <Plus size={13} /> <span className="hidden sm:inline">{t('reservations.addManual')}</span>
          </button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {total === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <BookMarked size={36} style={{ color: 'var(--text-faint)', display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('reservations.empty')}</p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>{t('reservations.emptyHint')}</p>
          </div>
        ) : (
          <>
            {allPending.length > 0 && (
              <Section title={t('reservations.pending')} count={allPending.length} accent="gray">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {allPending.map(r => <ReservationCard key={r.id} r={r} tripId={tripId} onEdit={onEdit} onDelete={onDelete} files={files} onNavigateToFiles={onNavigateToFiles} assignmentLookup={assignmentLookup} canEdit={canEdit} />)}
                </div>
              </Section>
            )}
            {allConfirmed.length > 0 && (
              <Section title={t('reservations.confirmed')} count={allConfirmed.length} accent="green">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {allConfirmed.map(r => <ReservationCard key={r.id} r={r} tripId={tripId} onEdit={onEdit} onDelete={onDelete} files={files} onNavigateToFiles={onNavigateToFiles} assignmentLookup={assignmentLookup} canEdit={canEdit} />)}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
