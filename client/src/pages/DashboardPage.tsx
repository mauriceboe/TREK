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
  Archive, ArchiveRestore, Clock, MapPin, Settings, X, ArrowRightLeft, Users,
  LayoutGrid, List, Copy, Bell,
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
  shared_count?: number
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
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function formatDateShort(dateStr: string | null | undefined, locale: string = 'en-US'): string | null {
  if (!dateStr) return null
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
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
  onCopy?: (trip: DashboardTrip) => void
  onDelete?: (trip: DashboardTrip) => void
  onArchive?: (id: number) => void
  onClick: (trip: DashboardTrip) => void
  t: (key: string, params?: Record<string, string | number | null>) => string
  locale: string
  dark?: boolean
}

function SpotlightCard({ trip, onEdit, onCopy, onDelete, onArchive, onClick, t, locale }: TripCardProps): React.ReactElement {
  const status = getTripStatus(trip)
  const isLive = status === 'ongoing'
  const today = new Date().toISOString().split('T')[0]
  const startDate = trip.start_date || today
  const endDate = trip.end_date || today
  const totalDays = Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1)
  const currentDay = Math.min(totalDays, Math.ceil((new Date(today).getTime() - new Date(startDate).getTime()) / 86400000) + 1)
  const daysLeft = Math.max(0, totalDays - currentDay)
  const progress = Math.round((currentDay / totalDays) * 100)

  const badgeText = isLive ? t('dashboard.mobile.liveNow')
    : status === 'today' ? t('dashboard.mobile.startsToday')
    : status === 'tomorrow' ? t('dashboard.mobile.tomorrow')
    : status === 'future' ? t('dashboard.status.daysLeft', { count: daysUntil(trip.start_date) })
    : status === 'past' ? t('dashboard.mobile.completed')
    : null

  return (
    <div
      onClick={() => onClick(trip)}
      className="group relative rounded-3xl overflow-hidden cursor-pointer mb-8"
      style={{ minHeight: 340, boxShadow: '0 8px 40px rgba(0,0,0,0.13)' }}
    >
      {/* Background */}
      <div className="absolute inset-0" style={{
        background: trip.cover_image ? undefined : tripGradient(trip.id),
      }}>
        {trip.cover_image && (
          <>
            <img src={trip.cover_image} className="w-full h-full object-cover" alt="" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.6) 100%)' }} />
          </>
        )}
      </div>
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 0%, transparent 40%, rgba(0,0,0,0.5) 100%)' }} />

      {/* Content */}
      <div className="relative p-6 flex flex-col text-white z-[2]" style={{ minHeight: 340 }}>
        {/* Top: badge + actions */}
        <div className="flex items-center justify-between mb-5">
          {badgeText ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-black/40 backdrop-blur-sm border border-white/15 rounded-full text-[10px] font-bold uppercase tracking-[0.1em]">
              {isLive ? (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] animate-pulse" />
              ) : (
                <Clock size={10} />
              )}
              {badgeText}
            </span>
          ) : <span />}
          <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {onEdit && <button title={t('common.edit')} onClick={() => onEdit(trip)} className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-colors"><Edit2 size={14} /></button>}
            {onCopy && <button title={t('dashboard.copyTrip')} onClick={() => onCopy(trip)} className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-colors"><Copy size={14} /></button>}
            {onArchive && <button title={t('dashboard.archive')} onClick={() => onArchive(trip.id)} className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20 transition-colors"><Archive size={14} /></button>}
            {onDelete && <button title={t('common.delete')} onClick={() => onDelete(trip)} className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-red-300 hover:bg-red-500/20 transition-colors"><Trash2 size={14} /></button>}
          </div>
        </div>

        {/* Title area — pushed to bottom */}
        <div className="flex-1 flex flex-col justify-end mb-4">
          {!trip.is_owner && (
            <span className="inline-flex items-center gap-1 self-start px-2 py-0.5 bg-white/15 backdrop-blur-sm border border-white/15 rounded-full text-[9px] font-semibold uppercase tracking-[0.06em] mb-2">
              <Users size={9} /> {t('dashboard.sharedBy', { name: trip.owner_username })}
            </span>
          )}
          <h2 className="text-[32px] font-extrabold tracking-[-0.03em] leading-[0.95] mb-1.5">{trip.title}</h2>
          <p className="text-[12px] opacity-80 font-medium">
            {formatDateShort(trip.start_date, locale)} — {formatDateShort(trip.end_date, locale)}
            {isLive && <> · {t('journey.pdf.day')} {currentDay} / {totalDays}</>}
          </p>
        </div>

        {/* Progress bar — only for live trips */}
        {isLive && (
          <div className="mb-4">
            <div className="flex justify-between text-[11px] font-semibold mb-1.5">
              <span className="opacity-85">{t('dashboard.mobile.tripProgress')}</span>
              <span className="opacity-70">{t('dashboard.mobile.daysLeft', { count: daysLeft })}</span>
            </div>
            <div className="h-1.5 bg-white/15 rounded-full overflow-hidden">
              <div className="h-full bg-white rounded-full relative" style={{ width: `${progress}%` }}>
                <span className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-[0_0_12px_rgba(255,255,255,0.9)]" />
              </div>
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-4 gap-2.5 p-3.5 bg-black/25 backdrop-blur-sm border border-white/10 rounded-2xl">
          {trip.start_date && !isLive && (
            <div className="text-center">
              <p className="text-[18px] font-extrabold tracking-[-0.02em] leading-none">{formatDateShort(trip.start_date, locale)}</p>
              <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">{t('dashboard.mobile.starts')}</p>
            </div>
          )}
          {isLive && (
            <div className="text-center">
              <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{totalDays}</p>
              <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">{t('dashboard.mobile.duration')}</p>
            </div>
          )}
          <div className="text-center">
            <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{trip.place_count || 0}</p>
            <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">{t('dashboard.mobile.places')}</p>
          </div>
          <div className="text-center">
            <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{trip.shared_count || 0}</p>
            <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">{t('dashboard.mobile.buddies')}</p>
          </div>
          {!isLive && (
            <div className="text-center">
              <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{trip.day_count || totalDays}</p>
              <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">{t('dashboard.mobile.days')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Mobile Trip Card (upcoming style) ────────────────────────────────────────
function MobileTripCard({ trip, onEdit, onCopy, onDelete, onArchive, onClick, t, locale }: Omit<TripCardProps, 'dark'>): React.ReactElement {
  const status = getTripStatus(trip)
  const until = daysUntil(trip.start_date)
  const duration = trip.start_date && trip.end_date
    ? Math.ceil((new Date(trip.end_date).getTime() - new Date(trip.start_date).getTime()) / 86400000) + 1
    : trip.day_count || null

  const badgeText = status === 'ongoing' ? t('dashboard.mobile.ongoing')
    : status === 'today' ? t('dashboard.mobile.startsToday')
    : status === 'tomorrow' ? t('dashboard.mobile.tomorrow')
    : until && until > 0 ? (until < 30 ? t('dashboard.mobile.inDays', { count: until }) : until < 365 ? t('dashboard.mobile.inMonths', { count: Math.round(until / 30) }) : `In ${Math.round(until / 365)}y`)
    : status === 'past' ? t('dashboard.mobile.completed')
    : null

  return (
    <div
      onClick={() => onClick?.(trip)}
      className="rounded-2xl border border-zinc-200 dark:border-zinc-700 overflow-hidden cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md"
      style={{ background: 'var(--bg-card)' }}
    >
      {/* Cover */}
      <div className="relative h-[120px] overflow-hidden" style={{ background: trip.cover_image ? undefined : tripGradient(trip.id) }}>
        {trip.cover_image && (
          <img src={trip.cover_image} className="absolute inset-0 w-full h-full object-cover" alt="" />
        )}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.5) 100%)' }} />

        {/* Action buttons top-right */}
        <div className="absolute top-3 right-3 z-[2] flex gap-1">
          {onEdit && <button title={t('common.edit')} onClick={e => { e.stopPropagation(); onEdit(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white"><Edit2 size={12} /></button>}
          {onCopy && <button title={t('dashboard.copyTrip')} onClick={e => { e.stopPropagation(); onCopy(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white"><Copy size={12} /></button>}
          {onArchive && <button title={t('dashboard.archive')} onClick={e => { e.stopPropagation(); onArchive(trip.id) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white"><Archive size={12} /></button>}
          {onDelete && <button title={t('common.delete')} onClick={e => { e.stopPropagation(); onDelete(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-red-300"><Trash2 size={12} /></button>}
        </div>

        {/* Countdown badge */}
        {badgeText && (
          <div className="absolute top-3.5 left-3.5 z-[2]">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-black/40 backdrop-blur-sm border border-white/15 rounded-full text-white text-[10px] font-bold uppercase tracking-[0.08em]">
              {status === 'ongoing' ? (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] animate-pulse" />
              ) : (
                <Clock size={10} />
              )}
              {badgeText}
            </span>
          </div>
        )}

        {/* Title on cover */}
        <div className="absolute bottom-3.5 left-3.5 right-3.5 z-[2] text-white">
          <h3 className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{trip.title}</h3>
          {trip.description && (
            <p className="text-[11px] opacity-75 font-medium mt-1 truncate">{trip.description}</p>
          )}
        </div>
      </div>

      {/* Bottom stats */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex gap-[18px]">
          {trip.start_date && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{formatDateShort(trip.start_date, locale)}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.starts')}</span>
            </div>
          )}
          {duration && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{duration} {duration === 1 ? t('dashboard.mobile.day') : t('dashboard.mobile.days')}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.duration')}</span>
            </div>
          )}
          <div className="flex flex-col gap-px">
            <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{trip.place_count || 0}</span>
            <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.places')}</span>
          </div>
          {(trip.shared_count || 0) > 0 && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{trip.shared_count}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.buddies')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Regular Trip Card (matches mobile card design) ──────────────────────────
function TripCard({ trip, onEdit, onCopy, onDelete, onArchive, onClick, t, locale }: Omit<TripCardProps, 'dark'>): React.ReactElement {
  const status = getTripStatus(trip)
  const until = daysUntil(trip.start_date)
  const duration = trip.start_date && trip.end_date
    ? Math.ceil((new Date(trip.end_date).getTime() - new Date(trip.start_date).getTime()) / 86400000) + 1
    : trip.day_count || null

  const badgeText = status === 'ongoing' ? t('dashboard.mobile.ongoing')
    : status === 'today' ? t('dashboard.mobile.startsToday')
    : status === 'tomorrow' ? t('dashboard.mobile.tomorrow')
    : until && until > 0 ? (until < 30 ? t('dashboard.mobile.inDays', { count: until }) : until < 365 ? t('dashboard.mobile.inMonths', { count: Math.round(until / 30) }) : `In ${Math.round(until / 365)}y`)
    : status === 'past' ? t('dashboard.mobile.completed')
    : null

  return (
    <div
      onClick={() => onClick(trip)}
      className="group rounded-2xl border border-zinc-200 dark:border-zinc-700 overflow-hidden cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg hover:border-zinc-300 dark:hover:border-zinc-600"
      style={{ background: 'var(--bg-card)' }}
    >
      {/* Cover */}
      <div className="relative h-[140px] overflow-hidden" style={{ background: trip.cover_image ? undefined : tripGradient(trip.id) }}>
        {trip.cover_image && (
          <img src={trip.cover_image} className="absolute inset-0 w-full h-full object-cover" alt="" />
        )}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.55) 100%)' }} />

        {/* Action buttons top-right — visible on hover */}
        <div className="absolute top-3 right-3 z-[2] flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEdit && <button title={t('common.edit')} onClick={e => { e.stopPropagation(); onEdit(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-black/50 transition-colors"><Edit2 size={12} /></button>}
          {onCopy && <button title={t('dashboard.copyTrip')} onClick={e => { e.stopPropagation(); onCopy(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-black/50 transition-colors"><Copy size={12} /></button>}
          {onArchive && <button title={t('dashboard.archive')} onClick={e => { e.stopPropagation(); onArchive(trip.id) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:bg-black/50 transition-colors"><Archive size={12} /></button>}
          {onDelete && <button title={t('common.delete')} onClick={e => { e.stopPropagation(); onDelete(trip) }} className="w-[30px] h-[30px] rounded-[8px] bg-black/30 backdrop-blur-sm border border-white/20 flex items-center justify-center text-red-300 hover:bg-red-500/30 transition-colors"><Trash2 size={12} /></button>}
        </div>

        {/* Status badge top-left */}
        {badgeText && (
          <div className="absolute top-3.5 left-3.5 z-[2]">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-black/40 backdrop-blur-sm border border-white/15 rounded-full text-white text-[10px] font-bold uppercase tracking-[0.08em]">
              {status === 'ongoing' ? (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] animate-pulse" />
              ) : (
                <Clock size={10} />
              )}
              {badgeText}
            </span>
          </div>
        )}

        {/* Shared badge */}
        {!trip.is_owner && (
          <div className="absolute top-3.5 right-3.5 z-[1] group-hover:opacity-0 transition-opacity">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-black/40 backdrop-blur-sm border border-white/15 rounded-full text-white text-[9px] font-semibold uppercase tracking-[0.06em]">
              <Users size={9} /> {t('dashboard.shared')}
            </span>
          </div>
        )}

        {/* Title on cover */}
        <div className="absolute bottom-3.5 left-3.5 right-3.5 z-[2] text-white">
          <h3 className="text-[20px] font-extrabold tracking-[-0.02em] leading-tight">{trip.title}</h3>
          {trip.description && (
            <p className="text-[11px] opacity-75 font-medium mt-1 truncate">{trip.description}</p>
          )}
        </div>
      </div>

      {/* Bottom stats */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex gap-[18px]">
          {trip.start_date && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{formatDateShort(trip.start_date, locale)}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.starts')}</span>
            </div>
          )}
          {duration && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{duration} {duration === 1 ? t('dashboard.mobile.day') : t('dashboard.mobile.days')}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.duration')}</span>
            </div>
          )}
          <div className="flex flex-col gap-px">
            <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{trip.place_count || 0}</span>
            <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.places')}</span>
          </div>
          {(trip.shared_count || 0) > 0 && (
            <div className="flex flex-col gap-px">
              <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{trip.shared_count}</span>
              <span className="text-[9px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--text-faint)' }}>{t('dashboard.mobile.buddies')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── List View Item ──────────────────────────────────────────────────────────
function TripListItem({ trip, onEdit, onCopy, onDelete, onArchive, onClick, t, locale }: Omit<TripCardProps, 'dark'>): React.ReactElement {
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
        <div className="hidden md:flex" style={{ alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
          <Users size={11} /> {trip.shared_count || 0}
        </div>
      </div>

      {/* Actions */}
      {(onEdit || onCopy || onArchive || onDelete) && (
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {onEdit && <CardAction onClick={() => onEdit(trip)} icon={<Edit2 size={12} />} label="" />}
        {onCopy && <CardAction onClick={() => onCopy(trip)} icon={<Copy size={12} />} label="" />}
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
  onCopy?: (trip: DashboardTrip) => void
  onUnarchive?: (id: number) => void
  onDelete?: (trip: DashboardTrip) => void
  onClick: (trip: DashboardTrip) => void
  t: (key: string, params?: Record<string, string | number | null>) => string
  locale: string
}

function ArchivedRow({ trip, onEdit, onCopy, onUnarchive, onDelete, onClick, t, locale }: ArchivedRowProps): React.ReactElement {
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
      {(onEdit || onCopy || onUnarchive || onDelete) && (
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        {onCopy && <button onClick={() => onCopy(trip)} title={t('dashboard.copyTrip')} style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-faint)'; e.currentTarget.style.color = 'var(--text-primary)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
          <Copy size={12} />
        </button>}
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
  const [showWidgetSettings, setShowWidgetSettings] = useState<boolean | 'mobile' | 'mobile-currency' | 'mobile-timezone'>(false)
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
  const { demoMode, user } = useAuthStore()
  const { settings, updateSetting } = useSettingsStore()
  const can = useCanDo()
  const dm = settings.dark_mode
  const dark = dm === true || dm === 'dark' || (dm === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const showCurrency = settings.dashboard_currency !== 'off'
  const showTimezone = settings.dashboard_timezone !== 'off'
  const showSidebar = showCurrency || showTimezone

  useEffect(() => {
    if (showWidgetSettings === 'mobile' || showWidgetSettings === 'mobile-currency' || showWidgetSettings === 'mobile-timezone') {
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

  const handleCopy = async (trip: DashboardTrip) => {
    try {
      const data = await tripsApi.copy(trip.id, { title: `${trip.title} (${t('dashboard.copySuffix')})` })
      setTrips(prev => sortTrips([data.trip, ...prev]))
      toast.success(t('dashboard.toast.copied'))
    } catch {
      toast.error(t('dashboard.toast.copyError'))
    }
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
        <div style={{ maxWidth: 1300, margin: '0 auto', paddingTop: 32, paddingLeft: 20, paddingRight: 20, paddingBottom: 'calc(100px + env(safe-area-inset-bottom, 0px))' }}>

          {/* Mobile greeting header */}
          <div className="md:hidden flex items-center justify-between mb-5">
            <div>
              <p className="text-[12px] text-zinc-500 font-medium">{new Date().getHours() < 12 ? t('dashboard.greeting.morning') : new Date().getHours() < 18 ? t('dashboard.greeting.afternoon') : t('dashboard.greeting.evening')}</p>
              <p className="text-[22px] font-extrabold tracking-[-0.025em] leading-tight" style={{ color: 'var(--text-primary)' }}>{user?.username || t('nav.profile')}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate('/notifications')}
                className="w-10 h-10 rounded-xl flex items-center justify-center relative"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }}
              >
                <Bell size={18} />
              </button>
              <button
                onClick={() => navigate('/settings')}
                className="w-10 h-10 rounded-full flex items-center justify-center text-[15px] font-bold text-white overflow-hidden"
                style={{ background: user?.avatar_url ? undefined : 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}
              >
                {user?.avatar_url
                  ? <img src={user.avatar_url} className="w-full h-full object-cover" alt="" />
                  : (user?.username || '?')[0].toUpperCase()
                }
              </button>
            </div>
          </div>

          {/* Mobile: Live Trip Hero */}
          {(() => {
            const liveTrip = trips.find(t => getTripStatus(t) === 'ongoing')
            if (!liveTrip) return null
            const today = new Date().toISOString().split('T')[0]
            const startDate = liveTrip.start_date || today
            const endDate = liveTrip.end_date || today
            const totalDays = Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1)
            const currentDay = Math.min(totalDays, Math.ceil((new Date(today).getTime() - new Date(startDate).getTime()) / 86400000) + 1)
            const daysLeft = Math.max(0, totalDays - currentDay)
            const progress = Math.round((currentDay / totalDays) * 100)

            return (
              <div className="md:hidden mb-5">
                <div
                  onClick={() => navigate(`/trips/${liveTrip.id}`)}
                  className="relative rounded-3xl overflow-hidden cursor-pointer"
                  style={{ minHeight: 340 }}
                >
                  {/* Background */}
                  <div className="absolute inset-0" style={{
                    background: liveTrip.cover_image ? undefined : `radial-gradient(circle at 15% 20%, rgba(16,185,129,0.7), transparent 45%), radial-gradient(circle at 85% 80%, rgba(6,182,212,0.6), transparent 50%), radial-gradient(circle at 50% 50%, rgba(14,165,233,0.4), transparent 55%), linear-gradient(135deg, #064E3B 0%, #065F46 35%, #0E7490 75%, #164E63 100%)`
                  }}>
                    {liveTrip.cover_image && (
                      <>
                        <img src={liveTrip.cover_image} className="w-full h-full object-cover" alt="" />
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.6) 100%)' }} />
                      </>
                    )}
                  </div>
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 0%, transparent 40%, rgba(0,0,0,0.5) 100%)' }} />

                  {/* Content */}
                  <div className="relative p-5 flex flex-col text-white z-[2]" style={{ minHeight: 340 }}>
                    {/* Top badges */}
                    <div className="flex items-center justify-between mb-5">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-black/40 backdrop-blur-sm border border-white/15 rounded-full text-[10px] font-bold uppercase tracking-[0.1em]">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)] animate-pulse" />
                        {t("dashboard.mobile.liveNow")}
                      </span>
                      <div className="flex gap-1.5">
                        <button
                          onClick={e => { e.stopPropagation(); setEditingTrip(liveTrip); setShowForm(true) }}
                          className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleCopy(liveTrip) }}
                          className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleArchive(liveTrip.id) }}
                          className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-white hover:bg-white/20"
                        >
                          <Archive size={14} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleDelete(liveTrip) }}
                          className="w-[34px] h-[34px] rounded-[10px] bg-white/12 backdrop-blur-sm border border-white/15 flex items-center justify-center text-red-300 hover:bg-red-500/20"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Title area */}
                    <div className="flex-1 flex flex-col justify-end mb-4">
                      <h2 className="text-[32px] font-extrabold tracking-[-0.03em] leading-[0.95] mb-1.5">{liveTrip.title}</h2>
                      <p className="text-[12px] opacity-80 font-medium">
                        {formatDateShort(liveTrip.start_date)} — {formatDateShort(liveTrip.end_date)} · {t('journey.pdf.day')} {currentDay} / {totalDays}
                      </p>
                    </div>

                    {/* Progress */}
                    <div className="mb-4">
                      <div className="flex justify-between text-[11px] font-semibold mb-1.5">
                        <span className="opacity-85">{t('dashboard.mobile.tripProgress')}</span>
                        <span className="opacity-70">{daysLeft} days left</span>
                      </div>
                      <div className="h-1.5 bg-white/15 rounded-full overflow-hidden">
                        <div className="h-full bg-white rounded-full relative" style={{ width: `${progress}%` }}>
                          <span className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-[0_0_12px_rgba(255,255,255,0.9)]" />
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-2 gap-2.5 p-3.5 bg-black/25 backdrop-blur-sm border border-white/10 rounded-2xl">
                      <div className="text-center">
                        <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{liveTrip.place_count || 0}</p>
                        <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">Places</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[22px] font-extrabold tracking-[-0.02em] leading-none">{liveTrip.shared_count || 0}</p>
                        <p className="text-[9px] uppercase tracking-[0.1em] opacity-70 font-semibold mt-1">Buddies</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Mobile: Quick Actions */}
          <div className="md:hidden grid grid-cols-3 gap-2 mb-6">
            {can('trip_create') && (
              <button
                onClick={() => { setEditingTrip(null); setShowForm(true) }}
                className="flex flex-col items-center gap-2 py-3.5 rounded-2xl border border-zinc-200 dark:border-zinc-700"
                style={{ background: 'var(--bg-card)' }}
              >
                <div className="w-9 h-9 rounded-[11px] flex items-center justify-center" style={{ background: '#FEF3C7', color: '#B45309' }}>
                  <Plus size={16} />
                </div>
                <span className="text-[10px] font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dashboard.mobile.newTrip')}</span>
              </button>
            )}
            {showCurrency && (
              <button
                onClick={() => setShowWidgetSettings('mobile-currency')}
                className="flex flex-col items-center gap-2 py-3.5 rounded-2xl border border-zinc-200 dark:border-zinc-700"
                style={{ background: 'var(--bg-card)' }}
              >
                <div className="w-9 h-9 rounded-[11px] flex items-center justify-center" style={{ background: '#DBEAFE', color: '#1E40AF' }}>
                  <ArrowRightLeft size={16} />
                </div>
                <span className="text-[10px] font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dashboard.mobile.currency')}</span>
              </button>
            )}
            {showTimezone && (
              <button
                onClick={() => setShowWidgetSettings('mobile-timezone')}
                className="flex flex-col items-center gap-2 py-3.5 rounded-2xl border border-zinc-200 dark:border-zinc-700"
                style={{ background: 'var(--bg-card)' }}
              >
                <div className="w-9 h-9 rounded-[11px] flex items-center justify-center" style={{ background: '#DCFCE7', color: '#15803D' }}>
                  <Clock size={16} />
                </div>
                <span className="text-[10px] font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dashboard.mobile.timezone')}</span>
              </button>
            )}
          </div>

          {/* Desktop header */}
          <div className="hidden md:flex" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
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

          {/* Mobile widgets button — replaced by Quick Actions */}

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

          {/* Spotlight (grid mode, desktop only — mobile has Live Hero) */}
          {!isLoading && spotlight && viewMode === 'grid' && (
            <div className="hidden md:block"><SpotlightCard
              trip={spotlight}
              t={t} locale={locale} dark={dark}
              onEdit={(can('trip_edit', spotlight) || can('trip_cover_upload', spotlight)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
              onCopy={can('trip_create') ? handleCopy : undefined}
              onDelete={can('trip_delete', spotlight) ? handleDelete : undefined}
              onArchive={can('trip_archive', spotlight) ? handleArchive : undefined}
              onClick={tr => navigate(`/trips/${tr.id}`)}
            /></div>
          )}

          {/* Trips — mobile cards */}
          {!isLoading && rest.length > 0 && (
            <div className="md:hidden flex flex-col gap-3 mb-10">
              <div className="flex items-baseline justify-between px-1 pb-1">
                <span className="text-[11px] font-bold tracking-[0.12em] uppercase" style={{ color: 'var(--text-faint)' }}>
                  {rest.some(t => getTripStatus(t) === 'future' || getTripStatus(t) === 'tomorrow') ? t('dashboard.mobile.upcomingTrips') : t('dashboard.mobile.yourTrips')}
                </span>
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{rest.length} {t('dashboard.mobile.trips')}</span>
              </div>
              {rest.map(trip => (
                <MobileTripCard
                  key={trip.id}
                  trip={trip}
                  t={t} locale={locale}
                  onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                  onCopy={can('trip_create') ? handleCopy : undefined}
                  onDelete={can('trip_delete', trip) ? handleDelete : undefined}
                  onArchive={can('trip_archive', trip) ? handleArchive : undefined}
                  onClick={tr => navigate(`/trips/${tr.id}`)}
                />
              ))}
            </div>
          )}

          {/* Trips — desktop grid or list */}
          {!isLoading && (viewMode === 'grid' ? rest : rest).length > 0 && (
            viewMode === 'grid' ? (
              <div className="trip-grid hidden md:grid" style={{ gap: 16, marginBottom: 40 }}>
                {rest.map(trip => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    t={t} locale={locale}
                    onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                    onCopy={can('trip_create') ? handleCopy : undefined}
                    onDelete={can('trip_delete', trip) ? handleDelete : undefined}
                    onArchive={can('trip_archive', trip) ? handleArchive : undefined}
                    onClick={tr => navigate(`/trips/${tr.id}`)}
                  />
                ))}
              </div>
            ) : (
              <div className="hidden md:flex" style={{ flexDirection: 'column', gap: 8, marginBottom: 40 }}>
                {rest.map(trip => (
                  <TripListItem
                    key={trip.id}
                    trip={trip}
                    t={t} locale={locale}
                    onEdit={(can('trip_edit', trip) || can('trip_cover_upload', trip)) ? tr => { setEditingTrip(tr); setShowForm(true) } : undefined}
                    onCopy={can('trip_create') ? handleCopy : undefined}
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
                      onCopy={can('trip_create') ? handleCopy : undefined}
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
      {(showWidgetSettings === 'mobile' || showWidgetSettings === 'mobile-currency' || showWidgetSettings === 'mobile-timezone') && (
        <div className="lg:hidden fixed inset-0 z-50" style={{ background: 'rgba(0,0,0,0.3)', touchAction: 'none' }} onClick={() => setShowWidgetSettings(false)}>
          <div className="absolute left-0 right-0 flex flex-col overflow-hidden"
            style={{ bottom: 'calc(84px + env(safe-area-inset-bottom, 0px))', maxHeight: '70vh', background: 'var(--bg-card)', borderRadius: '20px 20px 0 0', overscrollBehavior: 'contain', animation: 'slideUp 0.25s ease-out' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-10 h-1 rounded-full" style={{ background: 'var(--border-primary)' }} />
            </div>
            <div className="flex items-center justify-between px-5 pb-3">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {showWidgetSettings === 'mobile-currency' ? t('dashboard.mobile.currencyConverter') : showWidgetSettings === 'mobile-timezone' ? t('dashboard.mobile.timezone') : t('common.settings')}
              </span>
              <button onClick={() => setShowWidgetSettings(false)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                <X size={14} style={{ color: 'var(--text-primary)' }} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-4" style={{ borderTop: '1px solid var(--border-secondary)' }}>
              {(showWidgetSettings === 'mobile' || showWidgetSettings === 'mobile-currency') && showCurrency && <CurrencyWidget />}
              {(showWidgetSettings === 'mobile' || showWidgetSettings === 'mobile-timezone') && showTimezone && <TimezoneWidget />}
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
