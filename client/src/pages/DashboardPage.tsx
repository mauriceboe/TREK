import React, { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { tripsApi } from '../api/client'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { useTranslation } from '../i18n'
import { getApiErrorMessage } from '../types'
import Navbar from '../components/Layout/Navbar'
import DemoBanner from '../components/Layout/DemoBanner'
import CurrencyWidget from '../components/Dashboard/CurrencyWidget'
import TimezoneWidget from '../components/Dashboard/TimezoneWidget'
import TripFormModal from '../components/Trips/TripFormModal'
import ConfirmDialog from '../components/shared/ConfirmDialog'
import { useToast } from '../components/shared/Toast'
import {
  Plus, Calendar, Trash2, Edit2, Map, ChevronDown, ChevronUp,
  Archive, ArchiveRestore, Clock, MapPin, Settings, X, ArrowRightLeft,
  LayoutGrid, List,
} from 'lucide-react'
import { useCanDo } from '../store/permissionsStore'

interface DashboardTrip {
  id: number
  title: string
  description?: string | null
  start_date?: string | null
  end_date?: string | null
  cover_image?: string | null
  is_archived?: boolean
  is_owner?: boolean
  owner_username?: string
  day_count?: number
  place_count?: number
  [key: string]: string | number | boolean | null | undefined
}

const font: React.CSSProperties = { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }

const MS_PER_DAY = 86400000

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr + 'T00:00:00'); d.setHours(0, 0, 0, 0)
  return Math.round((d - today) / MS_PER_DAY)
}

function getTripStatus(trip: DashboardTrip): string | null {
  const today = new Date().toISOString().split('T')[0]
  if (trip.start_date && trip.end_date && trip.start_date <= today && trip.end_date >= today) return 'ongoing'
  const until = daysUntil(trip.start_date)
  if (until === null) return null
  if (until === 0) return 'today'
  if (until === 1) return 'tomorrow'
  if (until > 1) return 'future'
  return 'past'
}

function formatDate(dateStr: string | null | undefined, locale: string = 'en-US'): string | null {
  if (!dateStr) return null
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateShort(dateStr: string | null | undefined, locale: string = 'en-US'): string | null {
  if (!dateStr) return null
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

function sortTrips(trips: DashboardTrip[]): DashboardTrip[] {
  const today = new Date().toISOString().split('T')[0]
  function rank(t) {
    if (t.start_date && t.end_date && t.start_date <= today && t.end_date >= today) return 0 // ongoing
    if (t.start_date && t.start_date >= today) return 1 // upcoming
    return 2 // past
  }
  return [...trips].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    const ad = a.start_date || '', bd = b.start_date || ''
    if (ra <= 1) return ad.localeCompare(bd)
    return bd.localeCompare(ad)
  })
}

// Gradient backgrounds when no cover image
const GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
  'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
  'linear-gradient(135deg, #96fbc4 0%, #f9f586 100%)',
]
function tripGradient(id: number): string { return GRADIENTS[id % GRADIENTS.length] }

// ── Liquid Glass hover effect ────────────────────────────────────────────────
interface LiquidGlassProps {
  children: React.ReactNode
  dark: boolean
  style?: React.CSSProperties
  className?: string
  onClick?: () => void
}

function LiquidGlass({ children, dark, style, className = '', onClick }: LiquidGlassProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const glareRef = useRef<HTMLDivElement>(null)
  const borderRef = useRef<HTMLDivElement>(null)

  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!ref.current || !glareRef.current || !borderRef.current) return
    const rect = ref.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    glareRef.current.style.background = `radial-gradient(circle 250px at ${x}px ${y}px, ${dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'} 0%, transparent 70%)`
    glareRef.current.style.opacity = '1'
    borderRef.current.style.opacity = '1'
    borderRef.current.style.maskImage = `radial-gradient(circle 120px at ${x}px ${y}px, black 0%, transparent 100%)`
    borderRef.current.style.WebkitMaskImage = `radial-gradient(circle 120px at ${x}px ${y}px, black 0%, transparent 100%)`
  }
  const onLeave = () => {
    if (glareRef.current) glareRef.current.style.opacity = '0'
    if (borderRef.current) borderRef.current.style.opacity = '0'
  }

  return (
    <div ref={ref} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} className={className}
      style={{ position: 'relative', overflow: 'hidden', ...style }}>
      <div ref={glareRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0, transition: 'opacity 0.3s', borderRadius: 'inherit', zIndex: 1 }} />
      <div ref={borderRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0, transition: 'opacity 0.3s', borderRadius: 'inherit', zIndex: 1,
        border: dark ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid rgba(0,0,0,0.12)',
      }} />
      {children}
    </div>
  )
}

// ── Spotlight Card (next upcoming trip) ─────────────────────────────────────
interface TripCardProps {
  trip: DashboardTrip
  onEdit?: (trip: DashboardTrip) => void
  onDelete?: (trip: DashboardTrip) => void
  onArchive?: (id: number) => void
  onClick: (trip: DashboardTrip) => void
  t: (key: string, params?: Record<string, string | number | null>) => string
  locale: string
  dark?: boolean
}

function SpotlightCard({ trip, onEdit, onDelete, onArchive, onClick, t, locale, dark }: TripCardProps): React.ReactElement {
  const status = getTripStatus(trip)

  const coverBg = trip.cover_image
    ? `url(${trip.cover_image}) center/cover no-repeat`
    : tripGradient(trip.id)

  return (
    <LiquidGlass dark={dark} style={{ marginBottom: 32, borderRadius: 20, boxShadow: '0 8px 40px rgba(0,0,0,0.13)', cursor: 'pointer' }}
      onClick={() => onClick(trip)}>
      {/* Cover / Background */}
      <div style={{ height: 300, background: coverBg, position: 'relative' }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.25) 50%, rgba(0,0,0,0.1) 100%)',
        }} />

        {/* Badges top-left */}
        <div style={{ position: 'absolute', top: 16, left: 16, display: 'flex', gap: 8 }}>
          {status && (
            <span style={{
              background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)',
              color: 'white', fontSize: 12, fontWeight: 700,
              padding: '5px 12px', borderRadius: 99, border: '1px solid rgba(255,255,255,0.25)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {status === 'ongoing' && (
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', animation: 'blink 1s ease-in-out infinite', display: 'inline-block', flexShrink: 0 }} />
              )}
              {status === 'ongoing' ? t('dashboard.status.ongoing')
                : status === 'today' ? t('dashboard.status.today')
                : status === 'tomorrow' ? t('dashboard.status.tomorrow')
                : status === 'future' ? t('dashboard.status.daysLeft', { count: daysUntil(trip.start_date) })
                : t('dashboard.status.past')}
            </span>
          )}
        </div>

        {/* Top-right actions */}
        {(onEdit || onArchive || onDelete) && (
        <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 6 }}
          onClick={e => e.stopPropagation()}>
          {onEdit && <IconBtn onClick={() => onEdit(trip)} title={t('common.edit')}><Edit2 size={14} /></IconBtn>}
          {onArchive && <IconBtn onClick={() => onArchive(trip.id)} title={t('dashboard.archive')}><Archive size={14} /></IconBtn>}
          {onDelete && <IconBtn onClick={() => onDelete(trip)} title={t('common.delete')} danger><Trash2 size={14} /></IconBtn>}
        </div>
        )}

        {/* Bottom content */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            {trip.is_owner ? t('dashboard.nextTrip') : t('dashboard.sharedBy', { name: trip.owner_username })}
          </div>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: 'white', lineHeight: 1.2, textShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
            {trip.title}
          </h2>
          {trip.description && (
            <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {trip.description}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
            {trip.start_date && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                <Calendar size={13} />
                {formatDateShort(trip.start_date, locale)}
                {trip.end_date && <> — {formatDateShort(trip.end_date, locale)}</>}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
              <Clock size={13} /> {trip.day_count || 0} {t('dashboard.days')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
              <MapPin size={13} /> {trip.place_count || 0} {t('dashboard.places')}
            </div>
          </div>
        </div>
      </div>
    </LiquidGlass>
  )
}

// ── Regular Trip Card ────────────────────────────────────────────────────────
function TripCard({ trip, onEdit, onDelete, onArchive, onClick, t, locale }: Omit<TripCardProps, 'dark'>): React.ReactElement {
  const status = getTripStatus(trip)
  const [hovered, setHovered] = useState(false)

  const coverBg = trip.cover_image
    ? `url(${trip.cover_image}) center/cover no-repeat`
    : tripGradient(trip.id)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onClick(trip)}
      style={{
        background: hovered ? 'var(--bg-tertiary)' : 'var(--bg-card)', borderRadius: 16, overflow: 'hidden', cursor: 'pointer',
        border: `1px solid ${hovered ? 'var(--text-faint)' : 'var(--border-primary)'}`, transition: 'all 0.18s',
        boxShadow: hovered ? '0 8px 28px rgba(0,0,0,0.15)' : '0 1px 4px rgba(0,0,0,0.04)',
        transform: hovered ? 'translateY(-2px)' : 'none',
      }}
    >
      {/* Image area */}
      <div style={{ height: 120, background: coverBg, position: 'relative', overflow: 'hidden' }}>
        {trip.cover_image && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.35) 0%, transparent 60%)' }} />}

        {/* Status badge */}
        {status && (
          <div style={{ position: 'absolute', top: 8, left: 8 }}>
            <span style={{
              fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
              background: 'rgba(0,0,0,0.4)', color: 'white', backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              {status === 'ongoing' && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', animation: 'blink 1s ease-in-out infinite', display: 'inline-block', flexShrink: 0 }} />
              )}
              {status === 'ongoing' ? t('dashboard.status.ongoing')
                : status === 'today' ? t('dashboard.status.today')
                : status === 'tomorrow' ? t('dashboard.status.tomorrow')
                : status === 'future' ? t('dashboard.status.daysLeft', { count: daysUntil(trip.start_date) })
                : t('dashboard.status.past')}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', marginBottom: 3 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {trip.title}
          </span>
          {!trip.is_owner && (
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 99, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t('dashboard.shared')}
            </span>
          )}
        </div>
        {trip.description && (
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {trip.description}
          </p>
        )}

        {(trip.start_date || trip.end_date) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            <Calendar size={11} style={{ flexShrink: 0 }} />
            {trip.start_date && trip.end_date
              ? `${formatDateShort(trip.start_date, locale)} — ${formatDateShort(trip.end_date, locale)}`
              : formatDate(trip.start_date || trip.end_date, locale)}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <Stat label={t('dashboard.days')} value={trip.day_count || 0} />
          <Stat label={t('dashboard.places')} value={trip.place_count || 0} />
        </div>

        {(onEdit || onArchive || onDelete) && (
        <div style={{ display: 'flex', gap: 6, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}
          onClick={e => e.stopPropagation()}>
          {onEdit && <CardAction onClick={() => onEdit(trip)} icon={<Edit2 size={12} />} label={t('common.edit')} />}
          {onArchive && <CardAction onClick={() => onArchive(trip.id)} icon={<Archive size={12} />} label={t('dashboard.archive')} />}
          {onDelete && <CardAction onClick={() => onDelete(trip)} icon={<Trash2 size={12} />} label={t('common.delete')} danger />}
        </div>
        )}
      </div>
    </div>
  )
}

// ── List View Item ──────────────────────────────────────────────────────────
function TripListItem({ trip, onEdit, onDelete, onArchive, onClick, t, locale }: Omit<TripCardProps, 'dark'>): React.ReactElement {
  const status = getTripStatus(trip)
  const [hovered, setHovered] = useState(false)

  const coverBg = trip.cover_image
    ? `url(${trip.cover_image}) center/cover no-repeat`
    : tripGradient(trip.id)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onClick(trip)}
      style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px',
        background: hovered ? 'var(--bg-tertiary)' : 'var(--bg-card)', borderRadius: 14,
        border: `1px solid ${hovered ? 'var(--text-faint)' : 'var(--border-primary)'}`,
        cursor: 'pointer', transition: 'all 0.15s',
        boxShadow: hovered ? '0 4px 16px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.03)',
      }}
    >
      {/* Cover thumbnail */}
      <div style={{
        width: 52, height: 52, borderRadius: 12, flexShrink: 0,
        background: coverBg, position: 'relative', overflow: 'hidden',
      }}>
        {status === 'ongoing' && (
          <span style={{
            position: 'absolute', top: 4, left: 4,
            width: 7, height: 7, borderRadius: '50%', background: '#ef4444',
            animation: 'blink 1s ease-in-out infinite',
          }} />
        )}
      </div>

      {/* Title & description */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {trip.title}
          </span>
          {!trip.is_owner && (
            <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 99, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t('dashboard.shared')}
            </span>
          )}
          {status && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 99,
              background: status === 'ongoing' ? 'rgba(239,68,68,0.1)' : 'var(--bg-tertiary)',
              color: status === 'ongoing' ? '#ef4444' : 'var(--text-muted)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              {status === 'ongoing' ? t('dashboard.status.ongoing')
                : status === 'today' ? t('dashboard.status.today')
                : status === 'tomorrow' ? t('dashboard.status.tomorrow')
                : status === 'future' ? t('dashboard.status.daysLeft', { count: daysUntil(trip.start_date) })
                : t('dashboard.status.past')}
            </span>
          )}
        </div>
        {trip.description && (
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {trip.description}
          </p>
        )}
      </div>

      {/* Date & stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        {trip.start_date && (
          <div className="hidden sm:flex" style={{ alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            <Calendar size={11} />
            {formatDateShort(trip.start_date, locale)}
            {trip.end_date && <> — {formatDateShort(trip.end_date, locale)}</>}
          </div>
        )}
        <div className="hidden md:flex" style={{ alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
          <Clock size={11} /> {trip.day_count || 0}
        </div>
        <div className="hidden md:flex" style={{ alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
          <MapPin size={11} /> {trip.place_count || 0}
        </div>
      </div>

      {/* Actions */}
      {(onEdit || onArchive || onDelete) && (
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {onEdit && <CardAction onClick={() => onEdit(trip)} icon={<Edit2 size={12} />} label="" />}
        {onArchive && <CardAction onClick={() => onArchive(trip.id)} icon={<Archive size={12} />} label="" />}
        {onDelete && <CardAction onClick={() => onDelete(trip)} icon={<Trash2 size={12} />} label="" danger />}
      </div>
      )}
    </div>
  )
}

// ── Archived Trip Row ────────────────────────────────────────────────────────
interface ArchivedRowProps {
  trip: DashboardTrip
  onEdit?: (trip: DashboardTrip) => void
  onUnarchive?: (id: number) => void
  onDelete?: (trip: DashboardTrip) => void
  onClick: (trip: DashboardTrip) => void
  t: (key: string, params?: Record<string, string | number | null>) => string
  locale: string
}

function ArchivedRow({ trip, onEdit, onUnarchive, onDelete, onClick, t, locale }: ArchivedRowProps): React.ReactElement {
  return (
    <div onClick={() => onClick(trip)} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
      borderRadius: 12, border: '1px solid var(--border-faint)', background: 'var(--bg-card)', cursor: 'pointer',
      transition: 'border-color 0.12s',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-primary)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-faint)'}>
      {/* Mini cover */}
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: trip.cover_image ? `url(${trip.cover_image}) center/cover no-repeat` : tripGradient(trip.id),
        opacity: 0.7,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trip.title}</span>
          {!trip.is_owner && <span style={{ fontSize: 10, color: 'var(--text-faint)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 99, flexShrink: 0 }}>{t('dashboard.shared')}</span>}
        </div>
        {trip.start_date && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
            {formatDateShort(trip.start_date, locale)}{trip.end_date ? ` — ${formatDateShort(trip.end_date, locale)}` : ''}
          </div>
        )}
      </div>
      {(onEdit || onUnarchive || onDelete) && (
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {onUnarchive && <button onClick={() => onUnarchive(trip.id)} title={t('dashboard.restore')} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-faint)'; e.currentTarget.style.color = 'var(--text-primary)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
          <ArchiveRestore size={12} /> {t('dashboard.restore')}
        </button>}
        {onDelete && <button onClick={() => onDelete(trip)} title={t('common.delete')} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-faint)' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#fecaca'; e.currentTarget.style.color = '#ef4444' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-faint)' }}>
          <Trash2 size={12} />
        </button>}
      </div>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function Stat({ value, label }: { value: number | string; label: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{value}</span>
      <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}</span>
    </div>
  )
}

function CardAction({ onClick, icon, label, danger }: { onClick: () => void; icon: React.ReactNode; label: string; danger?: boolean }): React.ReactElement {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 8,
      border: 'none', background: 'none', cursor: 'pointer', fontSize: 11,
      color: danger ? '#9ca3af' : '#9ca3af', fontFamily: 'inherit',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? '#fef2f2' : '#f3f4f6'; e.currentTarget.style.color = danger ? '#ef4444' : '#374151' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#9ca3af' }}>
      {icon}{label}
    </button>
  )
}

function IconBtn({ onClick, title, danger, loading, children }: { onClick: () => void; title: string; danger?: boolean; loading?: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <button onClick={onClick} title={title} disabled={loading} style={{
      width: 32, height: 32, borderRadius: 99, border: '1px solid rgba(255,255,255,0.25)',
      background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', color: danger ? '#fca5a5' : 'white', transition: 'background 0.12s',
    }}
      onMouseEnter={e => e.currentTarget.style.background = danger ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.25)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.3)'}>
      {children}
    </button>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────────────
function SkeletonCard(): React.ReactElement {
  return (
    <div style={{ background: 'white', borderRadius: 16, overflow: 'hidden', border: '1px solid #f3f4f6' }}>
      <div style={{ height: 120, background: '#f3f4f6', animation: 'pulse 1.5s ease-in-out infinite' }} />
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{ height: 14, background: '#f3f4f6', borderRadius: 6, marginBottom: 8, width: '70%' }} />
        <div style={{ height: 11, background: '#f3f4f6', borderRadius: 6, width: '50%' }} />
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function DashboardPage(): React.ReactElement {
  const [trips, setTrips] = useState<DashboardTrip[]>([])
  const [archivedTrips, setArchivedTrips] = useState<DashboardTrip[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [showForm, setShowForm] = useState<boolean>(false)
  const [editingTrip, setEditingTrip] = useState<DashboardTrip | null>(null)
  const [showArchived, setShowArchived] = useState<boolean>(false)
  const [showWidgetSettings, setShowWidgetSettings] = useState<boolean | 'mobile'>(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => (localStorage.getItem('trek_dashboard_view') as 'grid' | 'list') || 'grid')
  const [deleteTrip, setDeleteTrip] = useState<DashboardTrip | null>(null)

  const toggleViewMode = () => {
    setViewMode(prev => {
      const next = prev === 'grid' ? 'list' : 'grid'
      localStorage.setItem('trek_dashboard_view', next)
      return next
    })
  }

  const navigate = useNavigate()
  const toast = useToast()
  const { t, locale } = useTranslation()
  const { demoMode } = useAuthStore()
  const { settings, updateSetting } = useSettingsStore()
  const can = useCanDo()
  const dm = settings.dark_mode
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const showCurrency = settings.dashboard_currency !== 'off'
  const showTimezone = settings.dashboard_timezone !== 'off'
  const showSidebar = showCurrency || showTimezone

  useEffect(() => {
    if (showWidgetSettings === 'mobile') {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [showWidgetSettings])

  useEffect(() => { loadTrips() }, [])

  const loadTrips = async () => {
    setIsLoading(true)
    try {
      const [active, archived] = await Promise.all([
        tripsApi.list(),
        tripsApi.list({ archived: 1 }),
      ])
      setTrips(sortTrips(active.trips))
      setArchivedTrips(sortTrips(archived.trips))
    } catch {
      toast.error(t('dashboard.toast.loadError'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreate = async (tripData) => {
    try {
      const data = await tripsApi.create(tripData)
      setTrips(prev => sortTrips([data.trip, ...prev]))
      toast.success(t('dashboard.toast.created'))
      return data
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, t('dashboard.toast.createError')))
    }
  }

  const handleUpdate = async (tripData) => {
    try {
      const data = await tripsApi.update(editingTrip.id, tripData)
      setTrips(prev => sortTrips(prev.map(t => t.id === editingTrip.id ? data.trip : t)))
      toast.success(t('dashboard.toast.updated'))
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, t('dashboard.toast.updateError')))
    }
  }

  const handleDelete = (trip) => setDeleteTrip(trip)
  const confirmDelete = async () => {
    if (!deleteTrip) return
    try {
      await tripsApi.delete(deleteTrip.id)
      setTrips(prev => prev.filter(t => t.id !== deleteTrip.id))
      setArchivedTrips(prev => prev.filter(t => t.id !== deleteTrip.id))
      toast.success(t('dashboard.toast.deleted'))
    } catch {
      toast.error(t('dashboard.toast.deleteError'))
    }
    setDeleteTrip(null)
  }

  const handleArchive = async (id) => {
    try {
      const data = await tripsApi.archive(id)
      setTrips(prev => prev.filter(t => t.id !== id))
      setArchivedTrips(prev => sortTrips([data.trip, ...prev]))
      toast.success(t('dashboard.toast.archived'))
    } catch {
      toast.error(t('dashboard.toast.archiveError'))
    }
  }

  const handleUnarchive = async (id) => {
    try {
      const data = await tripsApi.unarchive(id)
      setArchivedTrips(prev => prev.filter(t => t.id !== id))
      setTrips(prev => sortTrips([data.trip, ...prev]))
      toast.success(t('dashboard.toast.restored'))
    } catch {
      toast.error(t('dashboard.toast.restoreError'))
    }
  }

  const handleCoverUpdate = (tripId: number, coverImage: string | null): void => {
    const update = (t: DashboardTrip) => t.id === tripId ? { ...t, cover_image: coverImage } : t
    setTrips(prev => prev.map(update))
    setArchivedTrips(prev => prev.map(update))
  }

  const today = new Date().toISOString().split('T')[0]
  const spotlight = trips.find(t => t.start_date && t.end_date && t.start_date <= today && t.end_date >= today)
    || trips.find(t => t.start_date && t.start_date >= today)
    || trips[0]
    || null
  const rest = spotlight ? trips.filter(t => t.id !== spotlight.id) : trips

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', ...font }}>
      <Navbar />
      {demoMode && <DemoBanner />}
      <div style={{ flex: 1, overflow: 'auto', overscrollBehavior: 'contain', marginTop: 'var(--nav-h)' }}>
        <div style={{ maxWidth: 1300, margin: '0 auto', padding: '32px 20px 60px' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>{t('dashboard.title')}</h1>
              <p style={{ margin: '3px 0 0', fontSize: 13, color: '#9ca3af' }}>
                {isLoading ? t('common.loading')
                  : trips.length > 0 ? `${t(trips.length !== 1 ? 'dashboard.subtitle.activeMany' : 'dashboard.subtitle.activeOne', { count: trips.length })}${archivedTrips.length > 0 ? t('dashboard.subtitle.archivedSuffix', { count: archivedTrips.length }) : ''}`
                  : t('dashboard.subtitle.empty')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              {/* View mode toggle */}
              <button
                onClick={toggleViewMode}
                title={viewMode === 'grid' ? t('dashboard.listView') : t('dashboard.gridView')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 14px', height: 37,
                  background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12,
                  cursor: 'pointer', color: 'var(--text-faint)', fontFamily: 'inherit',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--text-faint)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)'; e.currentTarget.style.borderColor = 'var(--border-primary)' }}
              >
                {viewMode === 'grid' ? <List size={15} /> : <LayoutGrid size={15} />}
              </button>
              {/* Widget settings */}
              <button
                onClick={() => setShowWidgetSettings(s => s ? false : true)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 14px', height: 37,
                  background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 12,
                  cursor: 'pointer', color: 'var(--text-faint)', fontFamily: 'inherit',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--text-faint)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)'; e.currentTarget.style.borderColor = 'var(--border-primary)' }}
              >
                <Settings size={15} />
              </button>
              {can('trip_create') && <button
                onClick={() => { setEditingTrip(null); setShowForm(true) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px',
                  background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 12,
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
              onMouseLeave={e => e.currentTarget.style.opacity = '1'}
            >
              <Plus size={15} /> {t('dashboard.newTrip')}
              </button>}
            </div>
          </div>

          {/* Widget settings dropdown */}
          {showWidgetSettings && (
            <div className="rounded-xl border p-3 mb-4 flex items-center gap-4" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)' }}>
              <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Widgets:</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <button onClick={() => updateSetting('dashboard_currency', showCurrency ? 'off' : 'on')}
                  className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  style={{ background: showCurrency ? 'var(--text-primary)' : 'var(--border-primary)' }}>
                  <span className="absolute left-0.5 h-4 w-4 rounded-full transition-transform duration-200"
                    style={{ background: 'var(--bg-card)', transform: showCurrency ? 'translateX(16px)' : 'translateX(0)' }} />
                </button>
                <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{t('dashboard.currency')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <button onClick={() => updateSetting('dashboard_timezone', showTimezone ? 'off' : 'on')}
                  className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  style={{ background: showTimezone ? 'var(--text-primary)' : 'var(--border-primary)' }}>
                  <span className="absolute left-0.5 h-4 w-4 rounded-full transition-transform duration-200"
                    style={{ background: 'var(--bg-card)', transform: showTimezone ? 'translateX(16px)' : 'translateX(0)' }} />
                </button>
                <span className="text-xs" style={{ color: 'var(--text-primary)' }}>{t('dashboard.timezone')}</span>
              </label>
            </div>
          )}

          {/* Mobile widgets button */}
          {showSidebar && (
            <button
              onClick={() => setShowWidgetSettings('mobile')}
              className="lg:hidden flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-semibold mb-4"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
            >
              <ArrowRightLeft size={13} style={{ color: 'var(--text-faint)' }} />
              {showCurrency && showTimezone ? `${t('dashboard.currency')} & ${t('dashboard.timezone')}` : showCurrency ? t('dashboard.currency') : t('dashboard.timezone')}
            </button>
          )}

          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
          {/* Main content */}
          <div style={{ flex: 1, minWidth: 0 }}>

          {/* Loading skeletons */}
          {isLoading && (
            <>
              <div style={{ height: 260, background: '#e5e7eb', borderRadius: 20, marginBottom: 32, animation: 'pulse 1.5s ease-in-out infinite' }} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
              </div>
            </>
          )}

          {/* Empty state */}
          {!isLoading && trips.length === 0 && (
            <div style={{ textAlign: 'center', padding: '80px 20px' }}>
              <div style={{ width: 80, height: 80, background: '#f3f4f6', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <Map size={36} style={{ color: '#d1d5db' }} />
              </div>
              <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{t('dashboard.emptyTitle')}</h3>
              <p style={{ margin: '0 0 24px', fontSize: 14, color: '#9ca3af', maxWidth: 340, marginLeft: 'auto', marginRight: 'auto' }}>
                {t('dashboard.emptyText')}
              </p>
              {can('trip_create') && <button
                onClick={() => { setEditingTrip(null); setShowForm(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 22px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <Plus size={16} /> {t('dashboard.emptyButton')}
              </button>}
            </div>
          )}

          {/* Spotlight (grid mode only) */}
          {!isLoading && spotlight && viewMode === 'grid' && (
            <SpotlightCard
              trip={spotlight}
              t={t} locale={locale} dark={dark}
              onEdit={(can('trip_edit', spotlight) || can('trip_cover_upload', spotlight)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
              onDelete={can('trip_delete', spotlight) ? handleDelete : undefined}
              onArchive={can('trip_archive', spotlight) ? handleArchive : undefined}
              onClick={tr => navigate(`/trips/${tr.id}`)}
            />
          )}

          {/* Trips — grid or list */}
          {!isLoading && (viewMode === 'grid' ? rest : trips).length > 0 && (
            viewMode === 'grid' ? (
              <div className="trip-grid" style={{ display: 'grid', gap: 16, marginBottom: 40 }}>
                {rest.map(trip => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    t={t} locale={locale}
                    onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                    onDelete={can('trip_delete', trip) ? handleDelete : undefined}
                    onArchive={can('trip_archive', trip) ? handleArchive : undefined}
                    onClick={tr => navigate(`/trips/${tr.id}`)}
                  />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 40 }}>
                {trips.map(trip => (
                  <TripListItem
                    key={trip.id}
                    trip={trip}
                    t={t} locale={locale}
                    onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                    onDelete={can('trip_delete', trip) ? handleDelete : undefined}
                    onArchive={can('trip_archive', trip) ? handleArchive : undefined}
                    onClick={tr => navigate(`/trips/${tr.id}`)}
                  />
                ))}
              </div>
            )
          )}

          {/* Archived section */}
          {!isLoading && archivedTrips.length > 0 && (
            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 24 }}>
              <button
                onClick={() => setShowArchived(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: showArchived ? 16 : 0, fontFamily: 'inherit' }}
              >
                <Archive size={15} style={{ color: '#9ca3af' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>
                  {t('dashboard.archived')} ({archivedTrips.length})
                </span>
                {showArchived ? <ChevronUp size={14} style={{ color: '#9ca3af' }} /> : <ChevronDown size={14} style={{ color: '#9ca3af' }} />}
              </button>
              {showArchived && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {archivedTrips.map(trip => (
                    <ArchivedRow
                      key={trip.id}
                      trip={trip}
                      t={t} locale={locale}
                      onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                      onUnarchive={can('trip_archive', trip) ? handleUnarchive : undefined}
                      onDelete={can('trip_delete', trip) ? handleDelete : undefined}
                      onClick={tr => navigate(`/trips/${tr.id}`)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          </div>

          {/* Widgets sidebar */}
          {showSidebar && (
            <div className="hidden lg:flex flex-col gap-4" style={{ position: 'sticky', top: 80, flexShrink: 0, width: 280 }}>
              {showCurrency && <LiquidGlass dark={dark} style={{ borderRadius: 16 }}><CurrencyWidget /></LiquidGlass>}
              {showTimezone && <LiquidGlass dark={dark} style={{ borderRadius: 16 }}><TimezoneWidget /></LiquidGlass>}
            </div>
          )}
          </div>
        </div>
      </div>

      {/* Mobile widgets bottom sheet */}
      {showWidgetSettings === 'mobile' && (
        <div className="lg:hidden fixed inset-0 z-50" style={{ background: 'rgba(0,0,0,0.3)', touchAction: 'none' }} onClick={() => setShowWidgetSettings(false)}>
          <div className="absolute bottom-0 left-0 right-0 flex flex-col overflow-hidden"
            style={{ maxHeight: '80vh', background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', overscrollBehavior: 'contain' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Widgets</span>
              <button onClick={() => setShowWidgetSettings(false)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                <X size={14} style={{ color: 'var(--text-primary)' }} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {showCurrency && <CurrencyWidget />}
              {showTimezone && <TimezoneWidget />}
            </div>
          </div>
        </div>
      )}

      <TripFormModal
        isOpen={showForm}
        onClose={() => { setShowForm(false); setEditingTrip(null) }}
        onSave={editingTrip ? handleUpdate : handleCreate}
        trip={editingTrip}
        onCoverUpdate={handleCoverUpdate}
      />

      <ConfirmDialog
        isOpen={!!deleteTrip}
        onClose={() => setDeleteTrip(null)}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        message={t('dashboard.confirm.delete', { title: deleteTrip?.title || '' })}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1 }
          50% { opacity: 0.5 }
        }
        @keyframes blink {
          0%, 100% { opacity: 1 }
          50% { opacity: 0 }
        }
        .trip-grid { grid-template-columns: repeat(3, 1fr); }
        @media(max-width: 1024px) { .trip-grid { grid-template-columns: repeat(2, 1fr); } }
        @media(max-width: 640px) { .trip-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  )
}
