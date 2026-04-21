import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { formatLocationName } from '../utils/formatters'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useJourneyStore } from '../store/journeyStore'
import { useAuthStore } from '../store/authStore'
import { useTranslation } from '../i18n'
import { journeyApi, authApi, addonsApi, mapsApi } from '../api/client'
import { addListener, removeListener } from '../api/websocket'
import Navbar from '../components/Layout/Navbar'
import JourneyMap from '../components/Journey/JourneyMapAuto'
import { DAY_COLORS } from '../components/Journey/dayColors'
import type { JourneyMapAutoHandle as JourneyMapHandle } from '../components/Journey/JourneyMapAuto'
import JournalBody from '../components/Journey/JournalBody'
import MarkdownToolbar from '../components/Journey/MarkdownToolbar'
import PhotoLightbox from '../components/Journey/PhotoLightbox'
import { useToast } from '../components/shared/Toast'
import ConfirmDialog from '../components/shared/ConfirmDialog'
import {
  ArrowLeft, RefreshCw, MoreHorizontal, Share2, Download, List, Grid, MapPin, Link, Copy,
  Clock, Package, Image, ChevronRight,
  UserPlus, Plus, Minus, Calendar, Camera, BookOpen, X, Check, ImagePlus, Trash2, Pencil,
  Laugh, Smile, Meh, Annoyed, Frown,
  Sun, CloudSun, Cloud, CloudRain, CloudLightning, Snowflake, ChevronUp, ChevronDown, Eye, EyeOff,
  Archive, ArchiveRestore,
} from 'lucide-react'
import MobileMapTimeline from '../components/Journey/MobileMapTimeline'
import MobileEntryView from '../components/Journey/MobileEntryView'
import { useIsMobile } from '../hooks/useIsMobile'
import type { JourneyEntry, JourneyPhoto, JourneyDetail } from '../store/journeyStore'
import { computeJourneyLifecycle } from '../utils/journeyLifecycle'

const GRADIENTS = [
  'linear-gradient(135deg, #0F172A 0%, #6366F1 45%, #EC4899 100%)',
  'linear-gradient(135deg, #1E293B 0%, #7C3AED 50%, #F59E0B 100%)',
  'linear-gradient(135deg, #134E5E 0%, #71B280 100%)',
  'linear-gradient(135deg, #2D1B69 0%, #11998E 100%)',
  'linear-gradient(135deg, #4B134F 0%, #C94B4B 100%)',
  'linear-gradient(135deg, #373B44 0%, #4286F4 100%)',
]

function pickGradient(id: number): string {
  return GRADIENTS[id % GRADIENTS.length]
}

const MOOD_CONFIG: Record<string, { bg: string; text: string; icon: typeof Laugh; label: string }> = {
  amazing: { bg: '#FDF2F8', text: '#BE185D', icon: Laugh, label: 'journey.mood.amazing' },
  good: { bg: '#FFFBEB', text: '#B45309', icon: Smile, label: 'journey.mood.good' },
  neutral: { bg: '#F4F4F5', text: '#3F3F46', icon: Meh, label: 'journey.mood.neutral' },
  rough: { bg: '#F5F3FF', text: '#6D28D9', icon: Frown, label: 'journey.mood.rough' },
}

const WEATHER_CONFIG: Record<string, { icon: typeof Sun; label: string }> = {
  sunny: { icon: Sun, label: 'journey.weather.sunny' },
  partly: { icon: CloudSun, label: 'journey.weather.partly' },
  cloudy: { icon: Cloud, label: 'journey.weather.cloudy' },
  rainy: { icon: CloudRain, label: 'journey.weather.rainy' },
  stormy: { icon: CloudLightning, label: 'journey.weather.stormy' },
  cold: { icon: Snowflake, label: 'journey.weather.cold' },
}

function groupByDate(entries: JourneyEntry[]): Map<string, JourneyEntry[]> {
  const groups = new Map<string, JourneyEntry[]>()
  for (const e of entries) {
    const d = e.entry_date
    if (!groups.has(d)) groups.set(d, [])
    groups.get(d)!.push(e)
  }
  return groups
}

function formatDate(d: string, locale?: string): { weekday: string; month: string; day: number } {
  const date = new Date(d + 'T00:00:00')
  // Pass the app's selected locale so weekday/month follow the UI language
  // instead of the browser's navigator.language.
  return {
    weekday: date.toLocaleDateString(locale, { weekday: 'long' }),
    month: date.toLocaleDateString(locale, { month: 'long' }),
    day: date.getDate(),
  }
}

function photoUrl(p: JourneyPhoto, size: 'thumbnail' | 'original' = 'thumbnail'): string {
  return `/api/photos/${p.photo_id}/${size}`
}

export default function JourneyDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { t, locale } = useTranslation()
  const { current, loading, notFound, loadJourney, updateEntry, deleteEntry, reorderEntries, uploadPhotos, deletePhoto } = useJourneyStore()
  const mapRef = useRef<JourneyMapHandle>(null)
  const fullMapRef = useRef<JourneyMapHandle>(null)
  const [activeLocationId, setActiveLocationId] = useState<string | null>(null)

  const isMobile = useIsMobile()
  // Role-based permissions (server-provided via my_role). Fall back to
  // "owner" when the field isn't present yet (legacy responses) so behavior
  // matches the pre-permissions era.
  const myRole = (current as any)?.my_role ?? 'owner'
  const canEditEntries = myRole === 'owner' || myRole === 'editor'
  const canEditJourney = myRole === 'owner'
  const [view, setView] = useState<'timeline' | 'gallery'>('timeline')
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const [viewingEntry, setViewingEntry] = useState<JourneyEntry | null>(null)
  const [editingEntry, setEditingEntry] = useState<JourneyEntry | null>(null)
  const [lightbox, setLightbox] = useState<{ photos: { id: number; src: string; caption?: string | null; provider?: string; asset_id?: string | null; owner_id?: number | null }[]; index: number } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<JourneyEntry | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [showAddTrip, setShowAddTrip] = useState(false)
  const [unlinkTrip, setUnlinkTrip] = useState<{ trip_id: number; title: string } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [hideSkeletons, setHideSkeletons] = useState(false)

  useEffect(() => {
    if (id) loadJourney(Number(id)).catch(() => {})
  }, [id])

  useEffect(() => {
    if (current?.hide_skeletons !== undefined) setHideSkeletons(current.hide_skeletons)
  }, [current?.hide_skeletons])

  useEffect(() => {
    if (notFound) {
      toast.error(t('journey.notFound'))
      navigate('/journey')
    }
  }, [notFound])

  // WebSocket real-time updates
  useEffect(() => {
    if (!id) return
    const journeyId = Number(id)
    const handler = (event: Record<string, unknown>) => {
      const type = event.type as string
      if (!type?.startsWith('journey:')) return
      if (event.journeyId !== journeyId) return
      // reload journey data on any change from other contributors
      loadJourney(journeyId)
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [id])

  // scroll sync with map — the sticky map on the right follows whichever
  // entry the user is currently reading in the feed on the left. We use
  // scroll position (not IntersectionObserver) because short text-only
  // entries pass through any IO band too quickly to reliably register.
  const rafRef = useRef<number | null>(null)
  const scrollCleanupRef = useRef<(() => void) | null>(null)
  // Suppress scroll-sync updates while a programmatic smooth-scroll is
  // running (triggered by a marker click). The scroll-progress reference
  // line doesn't align with `scrollIntoView({ block: 'center' })`, so the
  // sync would otherwise pick random entries as the scroll animates past
  // them and end up nowhere near the clicked marker.
  const suppressScrollSyncRef = useRef(false)
  const suppressTimerRef = useRef<number | null>(null)
  const setupScrollSync = useCallback(() => {
    scrollCleanupRef.current?.()
    const feed = feedRef.current
    if (!feed) return

    const commitWinner = () => {
      if (suppressScrollSyncRef.current) return
      const nodes = document.querySelectorAll('[data-entry-id]')
      if (nodes.length === 0) return
      const feedRect = feed.getBoundingClientRect()
      // Reference line tracks scroll progress — at the top of the feed
      // it sits at the top edge; at the bottom it sits at the bottom
      // edge. This keeps every entry passing through the line exactly
      // once even when they're too short to cross a static line before
      // the feed runs out of scroll.
      const maxScroll = feed.scrollHeight - feed.clientHeight
      const progress = maxScroll > 0 ? feed.scrollTop / maxScroll : 0
      const referenceY = feedRect.top + feedRect.height * progress
      let lastPast: { id: string; top: number } | null = null
      let firstAhead: { id: string; top: number } | null = null
      nodes.forEach(el => {
        const entryId = el.getAttribute('data-entry-id')
        if (!entryId) return
        const top = el.getBoundingClientRect().top
        if (top <= referenceY) {
          if (!lastPast || top > lastPast.top) lastPast = { id: entryId, top }
        } else {
          if (!firstAhead || top < firstAhead.top) firstAhead = { id: entryId, top }
        }
      })
      const winner = lastPast || firstAhead
      if (winner) {
        setActiveEntryId(winner.id)
        if (locatedEntryIdsRef.current.has(winner.id)) {
          mapRef.current?.highlightMarker(winner.id)
        }
      }
    }
    const onScroll = () => {
      if (rafRef.current != null) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        commitWinner()
      })
    }

    feed.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    // prime once so the map syncs on initial load
    commitWinner()
    scrollCleanupRef.current = () => {
      feed.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (current?.entries?.length) {
      const t = window.setTimeout(setupScrollSync, 300)
      return () => {
        window.clearTimeout(t)
        scrollCleanupRef.current?.()
      }
    }
    return () => scrollCleanupRef.current?.()
  }, [current?.entries, setupScrollSync])

  const handleMarkerClick = useCallback((entryId: string) => {
    const el = document.querySelector(`[data-entry-id="${entryId}"]`)
    if (!el) return
    // Commit the choice immediately so the highlighted marker stays pinned
    // to the clicked entry even while smooth-scroll passes over others.
    suppressScrollSyncRef.current = true
    setActiveEntryId(entryId)
    mapRef.current?.highlightMarker(entryId)
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (suppressTimerRef.current != null) window.clearTimeout(suppressTimerRef.current)
    // Smooth scroll typically finishes within ~500ms; 750ms gives a safety
    // buffer so the sync doesn't snap back to the wrong entry on the very
    // last frame.
    suppressTimerRef.current = window.setTimeout(() => {
      suppressScrollSyncRef.current = false
      suppressTimerRef.current = null
    }, 750)
  }, [])

  useEffect(() => () => {
    if (suppressTimerRef.current != null) window.clearTimeout(suppressTimerRef.current)
  }, [])

  const handleLocationClick = useCallback((id: string) => {
    setActiveLocationId(id)
  }, [])

  useEffect(() => {
    // give the sidebar map a chance to recalc its size when the view switches
    // (feed column width can shift slightly if the gallery vs timeline
    // renders with a different scrollbar state).
    requestAnimationFrame(() => mapRef.current?.invalidateSize())
  }, [view])

  // On desktop we run a two-pane layout where only the feed column scrolls;
  // the body must not scroll underneath it. Restore on unmount.
  useEffect(() => {
    if (isMobile) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isMobile])

  // Map only shows real journal entries — skeletons are trip-derived
  // suggestions, not something the user actually journaled at that spot.
  const mapEntries = useMemo(
    () => (current?.entries || []).filter(e =>
      e.location_lat && e.location_lng &&
      e.title !== 'Gallery' &&
      e.title !== '[Trip Photos]' &&
      e.type !== 'skeleton'
    ),
    [current?.entries]
  )

  const sidebarMapItems = useMemo(() => {
    const allDates = [...new Set(
      (current?.entries || [])
        .filter(e => e.title !== 'Gallery' && e.title !== '[Trip Photos]')
        .map(e => e.entry_date)
        .sort()
    )]
    const sorted = [...mapEntries].sort((a, b) => a.entry_date.localeCompare(b.entry_date))
    const dayCounters = new Map<string, number>()
    return sorted.map(e => {
      const dayIdx = allDates.indexOf(e.entry_date)
      const dayLabel = (dayCounters.get(e.entry_date) ?? 0) + 1
      dayCounters.set(e.entry_date, dayLabel)
      return {
        id: String(e.id),
        lat: e.location_lat!,
        lng: e.location_lng!,
        title: e.title || '',
        location_name: e.location_name || '',
        mood: e.mood,
        created_at: e.entry_date,
        entry_date: e.entry_date,
        dayColor: DAY_COLORS[dayIdx % DAY_COLORS.length],
        dayLabel,
      }
    })
  }, [mapEntries, current?.entries])

  const locatedEntryIdsRef = useRef(new Set<string>())
  useEffect(() => {
    locatedEntryIdsRef.current = new Set(sidebarMapItems.map(m => m.id))
  }, [sidebarMapItems])

  const tripDates = useMemo(() => {
    const dates = new Set<string>()
    if (!current?.trips) return dates
    for (const trip of current.trips) {
      if (!trip.start_date || !trip.end_date) continue
      const start = new Date(trip.start_date + 'T00:00:00')
      const end = new Date(trip.end_date + 'T00:00:00')
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.add(d.toISOString().split('T')[0])
      }
    }
    return dates
  }, [current?.trips])

  if (loading || !current) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <Navbar />
        <div style={{ paddingTop: 'var(--nav-h, 0px)' }} className="flex justify-center py-20">
          <div className="w-6 h-6 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
        </div>
      </div>
    )
  }

  const timelineEntries = current.entries.filter(e => e.title !== 'Gallery' && e.title !== '[Trip Photos]' && (!hideSkeletons || e.type !== 'skeleton'))
  const dayGroups = groupByDate(timelineEntries)
  const sortedDates = [...dayGroups.keys()].sort()

  const tripDateMin = current.trips.length
    ? current.trips.reduce((min: string, t: any) => t.start_date && (!min || t.start_date < min) ? t.start_date : min, '')
    : null
  const tripDateMax = current.trips.length
    ? current.trips.reduce((max: string, t: any) => t.end_date && (!max || t.end_date > max) ? t.end_date : max, '')
    : null
  const lifecycle = computeJourneyLifecycle(current.status, tripDateMin || null, tripDateMax || null)

  const showMobileCombined = isMobile && view === 'timeline'
  const showMobileGallery = isMobile && view === 'gallery'
  const isMobileChromeless = showMobileCombined || showMobileGallery

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Navbar />

      {/* Mobile combined map+timeline (Polarsteps-style) — renders as fullscreen overlay */}
      {showMobileCombined && (
        <MobileMapTimeline
          entries={timelineEntries}
          mapEntries={sidebarMapItems}
          dark={document.documentElement.classList.contains('dark')}
          readOnly={!canEditEntries}
          onEntryClick={(entry) => setViewingEntry(entry)}
          onAddEntry={canEditEntries ? () => {
            const today = new Date().toISOString().split('T')[0]
            setEditingEntry({ id: 0, journey_id: current.id, author_id: 0, type: 'entry', entry_date: today, visibility: 'private', sort_order: 0, photos: [], created_at: 0, updated_at: 0 } as JourneyEntry)
          } : undefined}
        />
      )}

      {/* Fullscreen entry view (mobile) */}
      {viewingEntry && (
        <MobileEntryView
          entry={viewingEntry}
          readOnly={!canEditEntries}
          onClose={() => setViewingEntry(null)}
          onEdit={() => { setViewingEntry(null); setEditingEntry(viewingEntry); }}
          onDelete={() => { setViewingEntry(null); setDeleteTarget(viewingEntry); }}
          onPhotoClick={(photos, idx) => setLightbox({ photos: photos.map(p => ({ id: p.id, src: photoUrl(p, 'original'), caption: p.caption, provider: p.provider, asset_id: p.asset_id, owner_id: p.owner_id })), index: idx })}
        />
      )}

      {/* Floating top bar on mobile Journey + Gallery views: back | tabs+title | settings */}
      {isMobileChromeless && (
        <div
          className="fixed left-0 right-0 z-30 flex items-start justify-between gap-2 px-4"
          style={{ top: 'calc(var(--nav-h, 56px) + 12px)' }}
        >
          <button
            onClick={() => navigate('/journey')}
            aria-label={t('journey.detail.backToJourney')}
            className="w-10 h-10 flex-shrink-0 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur-lg border border-zinc-200 dark:border-zinc-700 shadow-lg text-zinc-700 dark:text-zinc-200 flex items-center justify-center hover:bg-white dark:hover:bg-zinc-800 active:scale-95 transition-transform"
          >
            <ArrowLeft size={16} />
          </button>

          <div className="flex-1 min-w-0 flex justify-center">
            <div className="flex bg-white/90 dark:bg-zinc-800/90 backdrop-blur-lg border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden shadow-lg">
              <button
                onClick={() => setView('timeline')}
                className={`flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium ${
                  view === 'timeline'
                    ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
              >
                <MapPin size={13} />
                {t('journey.detail.journeyTab') || 'Journey'}
              </button>
              <button
                onClick={() => setView('gallery')}
                className={`flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium ${
                  view === 'gallery'
                    ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
              >
                <Grid size={13} />
                {t('journey.share.gallery')}
              </button>
            </div>
          </div>

          {canEditJourney ? (
            <button
              onClick={() => setShowSettings(true)}
              aria-label={t('journey.settings.title')}
              className="w-10 h-10 flex-shrink-0 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur-lg border border-zinc-200 dark:border-zinc-700 shadow-lg text-zinc-700 dark:text-zinc-200 flex items-center justify-center hover:bg-white dark:hover:bg-zinc-800 active:scale-95 transition-transform"
            >
              <MoreHorizontal size={16} />
            </button>
          ) : (
            <div className="w-10 h-10 flex-shrink-0" aria-hidden />
          )}
        </div>
      )}

      <div style={{ paddingTop: 'var(--nav-h, 0px)' }} className={showMobileCombined ? 'hidden' : ''}>
        <div
          className={
            isMobile
              ? 'max-w-[1440px] mx-auto px-0 pt-0'
              : 'flex w-full overflow-hidden'
          }
          style={!isMobile ? { height: 'calc(100dvh - var(--nav-h, 56px))' } : undefined}
        >
          {/* LEFT column (full width on mobile, scrollable feed on desktop) */}
          <div
            ref={feedRef}
            className={
              isMobile
                ? ''
                : 'flex-1 overflow-y-auto journey-feed-scroll'
            }
          >
            <div className={isMobile ? '' : 'w-full px-8 py-6'}>

          {/* Hero card — hidden on mobile gallery/journey views (floating top bar handles branding there) */}
          <div className={`px-4 md:px-0 mb-6 ${isMobileChromeless ? 'hidden' : ''}`}>
            <div className="rounded-none md:rounded-2xl -mx-4 md:mx-0 overflow-hidden relative p-5 md:p-7" style={{ background: pickGradient(current.id), color: 'white' }}>
                {current.cover_image && (
                  <div className="absolute inset-0 z-[1]">
                    <img src={`/uploads/${current.cover_image}`} className="w-full h-full object-cover" alt="" />
                    <div className="absolute inset-0" style={{ background: pickGradient(current.id), opacity: 0.55 }} />
                  </div>
                )}
                <div className="absolute inset-0 pointer-events-none z-[2]" style={{ background: 'radial-gradient(circle at 20% 20%, rgba(236,72,153,0.3), transparent 50%), radial-gradient(circle at 80% 80%, rgba(99,102,241,0.3), transparent 50%)' }} />

                <div className="relative z-[3] flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => navigate('/journey')}
                      aria-label={t('journey.detail.backToJourney')}
                      className="w-[34px] h-[34px] rounded-lg bg-white/15 backdrop-blur flex items-center justify-center hover:bg-white/25"
                    >
                      <ArrowLeft size={14} />
                    </button>
                    {/* Status badge — keep completed/upcoming/draft/archived, but drop live + synced-with-trips per UX trim */}
                    <div className="hidden md:flex items-center gap-2">
                      {lifecycle !== 'live' && lifecycle !== 'archived' && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/[0.12] backdrop-blur border border-white/15 rounded-full text-[11px] font-medium">
                          {t(`journey.status.${lifecycle === 'upcoming' ? 'upcoming' : lifecycle === 'draft' ? 'draft' : 'completed'}`)}
                        </div>
                      )}
                      {lifecycle === 'archived' && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/[0.12] backdrop-blur border border-white/15 rounded-full text-[11px] font-medium">
                          {t('journey.status.archived')}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => { import('../components/PDF/JourneyBookPDF').then(m => m.downloadJourneyBookPDF(current)) }} className="w-[34px] h-[34px] rounded-lg bg-white/15 backdrop-blur flex items-center justify-center hover:bg-white/25"><Download size={14} /></button>
                    <div className="relative group">
                      <button
                        onClick={async () => {
                          const next = !hideSkeletons
                          setHideSkeletons(next)
                          await journeyApi.updatePreferences(current.id, { hide_skeletons: next })
                        }}
                        className={`w-[34px] h-[34px] rounded-lg backdrop-blur flex items-center justify-center ${hideSkeletons ? 'bg-white/30' : 'bg-white/15 hover:bg-white/25'}`}
                      >
                        {hideSkeletons ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <span className="absolute top-full mt-2 right-0 px-2 py-1 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[11px] font-medium whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity">
                        {hideSkeletons ? t('journey.skeletons.show') : t('journey.skeletons.hide')}
                      </span>
                    </div>
                    {canEditJourney && (
                      <button onClick={() => setShowSettings(true)} className="w-[34px] h-[34px] rounded-lg bg-white/15 backdrop-blur flex items-center justify-center hover:bg-white/25"><MoreHorizontal size={14} /></button>
                    )}
                  </div>
                </div>

                <div className="relative z-[3] mb-5">
                  <h1 className="text-[32px] font-bold tracking-[-0.02em] leading-tight mb-1.5">{current.title}</h1>
                  {current.subtitle && <p className="text-[13px] opacity-85">{current.subtitle}</p>}
                </div>

                <div className="relative z-[3] border-t border-white/15 pt-5 flex items-end justify-between">
                  <div className="flex gap-8">
                    {[
                      { value: sortedDates.length, label: t('journey.stats.days') },
                      { value: current.stats.places, label: t('journey.stats.places') },
                      { value: current.stats.entries, label: t('journey.stats.entries') },
                      { value: current.stats.photos, label: t('journey.stats.photos') },
                    ].map(s => (
                      <div key={s.label} className="flex flex-col gap-0.5">
                        <span className="text-[20px] font-bold">{s.value}</span>
                        <span className="text-[10px] uppercase tracking-[0.08em] opacity-70">{s.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
            </div>
          </div>

          {/* Main content (was a 2-col grid with right-sidebar panels;
              now single column inside the left feed — right pane is a
              sticky fullscreen map further below). */}
          <div className={isMobile ? 'px-4' : ''}>
            <div>
              {/* View Controls — hidden on mobile (floating top bar has them) */}
              <div className={`flex items-center justify-between mt-5 mb-5 ${isMobileChromeless ? 'hidden' : ''}`}>
                <div className="flex bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
                  {(isMobile
                    ? [
                        { id: 'timeline' as const, icon: MapPin, label: t('journey.detail.journeyTab') || 'Journey' },
                        { id: 'gallery' as const, icon: Grid, label: t('journey.share.gallery') },
                      ]
                    : [
                        { id: 'timeline' as const, icon: List, label: t('journey.share.timeline') },
                        { id: 'gallery' as const, icon: Grid, label: t('journey.share.gallery') },
                      ]
                  ).map(v => (
                    <button
                      key={v.id}
                      onClick={() => setView(v.id)}
                      className={`flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium ${
                        view === v.id
                          ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                          : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                      }`}
                    >
                      <v.icon size={13} />
                      {v.label}
                    </button>
                  ))}
                </div>
                {canEditEntries && (!isMobile ? view === 'timeline' : view !== 'gallery') && (
                  <button
                    onClick={() => {
                      const today = new Date().toISOString().split('T')[0]
                      setEditingEntry({ id: 0, journey_id: current.id, author_id: 0, type: 'entry', entry_date: today, visibility: 'private', sort_order: 0, photos: [], created_at: 0, updated_at: 0 } as JourneyEntry)
                    }}
                    className={`w-8 h-8 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center hover:bg-zinc-800 dark:hover:bg-zinc-100 ${isMobile && view === 'timeline' ? 'hidden' : ''}`}
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>

              {/* Timeline (desktop only — mobile uses fullscreen combined view above) */}
              {!isMobile && (
                <div className={`flex flex-col gap-6 pb-24 md:pb-6${view === 'timeline' ? '' : ' hidden'}`}>
                  {sortedDates.length === 0 && (
                    <div className="text-center py-16">
                      <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-4">
                        <BookOpen size={24} className="text-zinc-400" />
                      </div>
                      <p className="text-[15px] font-medium text-zinc-700 dark:text-zinc-300">No entries yet</p>
                      <p className="text-[12px] text-zinc-500 mt-1">Add a trip to get started with skeleton entries</p>
                    </div>
                  )}

                  {sortedDates.map((date, dayIdx) => {
                    const entries = dayGroups.get(date)!
                    const fd = formatDate(date, locale)
                    const locations = [...new Set(entries.map(e => e.location_name).filter(Boolean))]

                    return (
                      <div key={date} className="flex flex-col gap-3 trek-stagger">
                        <div className="bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-y md:border border-zinc-200 dark:border-zinc-700 rounded-none md:rounded-xl -mx-4 md:mx-0 px-4 py-3.5 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-bold text-white" style={{ background: DAY_COLORS[dayIdx % DAY_COLORS.length] }}>
                              {dayIdx + 1}
                            </div>
                            <div>
                              <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-white">{new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                            <span className="flex items-center gap-1"><MapPin size={12} /> {entries.length} {t('journey.synced.places')}</span>
                          </div>
                        </div>

                        {entries.map((entry, idx) => {
                          // Skeletons are just "suggested" places pulled
                          // from the linked trip — they aren't real
                          // journey entries until the user edits them,
                          // so reordering them does not make sense.
                          const canReorder = !isMobile && canEditEntries && entries.length > 1 && entry.type !== 'skeleton'
                          const move = (direction: -1 | 1) => {
                            if (!current) return
                            const target = idx + direction
                            if (target < 0 || target >= entries.length) return
                            const reordered = [...entries]
                            const [moved] = reordered.splice(idx, 1)
                            reordered.splice(target, 0, moved)
                            reorderEntries(current.id, reordered.map(e => e.id))
                              .catch(() => toast.error(t('common.errorOccurred')))
                          }
                          return (
                            <div key={entry.id} data-entry-id={String(entry.id)} className={`relative ${canReorder ? 'flex items-stretch gap-2' : ''}`} onMouseEnter={() => { setActiveEntryId(String(entry.id)); mapRef.current?.highlightMarker(String(entry.id)) }} style={String(entry.id) === activeEntryId ? { outline: `2px solid ${DAY_COLORS[dayIdx % DAY_COLORS.length]}`, outlineOffset: '3px', borderRadius: '12px' } : undefined}>
                              {canReorder && (
                                <div className="flex flex-col gap-1 justify-center flex-shrink-0 py-1">
                                  <button
                                    type="button"
                                    onClick={() => move(-1)}
                                    disabled={idx === 0}
                                    aria-label="Move up"
                                    className="w-7 h-7 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    <ChevronUp size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => move(1)}
                                    disabled={idx === entries.length - 1}
                                    aria-label="Move down"
                                    className="w-7 h-7 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm text-zinc-600 dark:text-zinc-300 flex items-center justify-center hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    <ChevronDown size={14} />
                                  </button>
                                </div>
                              )}
                              <div className={canReorder ? 'flex-1 min-w-0' : ''}>
                                {entry.type === 'skeleton' ? (
                                  <SkeletonCard entry={entry} onClick={canEditEntries ? () => setEditingEntry(entry) : undefined} />
                                ) : entry.type === 'checkin' ? (
                                  <CheckinCard entry={entry} onClick={canEditEntries ? () => setEditingEntry(entry) : undefined} />
                                ) : (
                                  <EntryCard
                                    entry={entry}
                                    readOnly={!canEditEntries}
                                    onEdit={() => setEditingEntry(entry)}
                                    onDelete={() => setDeleteTarget(entry)}
                                    onPhotoClick={(photos, idx) => setLightbox({ photos: photos.map(p => ({ id: p.id, src: photoUrl(p, 'original'), caption: p.caption, provider: p.provider, asset_id: p.asset_id, owner_id: p.owner_id })), index: idx })}
                                  />
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Gallery View — mobile gets extra top padding so the floating top bar doesn't overlap */}
              <div
                className={view === 'gallery' ? '' : 'hidden'}
                style={showMobileGallery ? { paddingTop: 'calc(var(--nav-h, 56px) + 64px)' } : undefined}
              >
                <GalleryView
                  entries={current.entries}
                  journeyId={current.id}
                  userId={useAuthStore.getState().user?.id || 0}
                  trips={current.trips}
                  onPhotoClick={(photos, idx) => setLightbox({ photos: photos.map(p => ({ id: p.id, src: photoUrl(p, 'original'), caption: p.caption, provider: p.provider, asset_id: p.asset_id, owner_id: p.owner_id })), index: idx })}
                  onRefresh={() => loadJourney(Number(id))}
                />
              </div>

            </div>

          </div>
            </div>
          </div>

          {/* RIGHT column on desktop — sticky rounded map (polarsteps-style).
              Hidden on mobile; mobile gets its own chromeless combined view. */}
          {!isMobile && (
            <aside className="w-[44%] max-w-[760px] min-w-[420px] pt-6 pr-4 pb-4 pl-0">
              <div className="h-full rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-sm">
                <JourneyMap
                  ref={mapRef}
                  checkins={[]}
                  entries={sidebarMapItems as any}
                  height={9999}
                  activeMarkerId={activeEntryId}
                  onMarkerClick={handleMarkerClick}
                  fullScreen
                />
              </div>
            </aside>
          )}
        </div>
      </div>

      {/* Entry Editor */}
      {editingEntry && (
        <EntryEditor
          entry={editingEntry}
          journeyId={current.id}
          tripDates={tripDates}
          galleryPhotos={current.entries.flatMap(e => e.photos || [])}
          onClose={() => setEditingEntry(null)}
          onSave={async (data) => {
            let entryId = editingEntry.id
            if (editingEntry.id === 0) {
              const created = await useJourneyStore.getState().createEntry(current.id, data)
              entryId = created.id
            } else {
              await updateEntry(editingEntry.id, data)
            }
            return entryId
          }}
          onUploadPhotos={async (entryId, formData) => {
            return await uploadPhotos(entryId, formData)
          }}
          onDone={() => {
            setEditingEntry(null)
            loadJourney(Number(id))
          }}
        />
      )}

      {/* Journey Settings */}
      {showSettings && (
        <JourneySettingsDialog
          journey={current}
          onClose={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); loadJourney(Number(id)) }}
          onOpenInvite={() => { setShowInvite(true) }}
          onRefresh={() => loadJourney(Number(id))}
        />
      )}

      {/* Add Trip Dialog */}
      {showAddTrip && current && (
        <AddTripDialog
          journeyId={current.id}
          existingTripIds={current.trips.map((t: any) => t.trip_id)}
          onClose={() => setShowAddTrip(false)}
          onAdded={() => { setShowAddTrip(false); loadJourney(Number(id)) }}
        />
      )}

      {/* Contributor Invite Dialog */}
      {showInvite && (
        <ContributorInviteDialog
          journeyId={current.id}
          existingUserIds={current.contributors.map((c: any) => c.user_id)}
          onClose={() => setShowInvite(false)}
          onInvited={() => { setShowInvite(false); loadJourney(Number(id)) }}
        />
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          await deleteEntry(deleteTarget.id)
          setDeleteTarget(null)
          loadJourney(Number(id))
        }}
        title={t('journey.entries.deleteTitle')}
        message={t('journey.deleteConfirmMessage', { title: deleteTarget?.title || 'this entry' })}
        confirmLabel={t('common.delete')}
        danger
      />

      {/* Unlink Trip confirm */}
      <ConfirmDialog
        isOpen={!!unlinkTrip}
        onClose={() => setUnlinkTrip(null)}
        onConfirm={async () => {
          if (!unlinkTrip || !current) return
          try {
            await journeyApi.removeTrip(current.id, unlinkTrip.trip_id)
            toast.success(t('journey.trips.tripUnlinked'))
            setUnlinkTrip(null)
            loadJourney(Number(id))
          } catch {
            toast.error(t('journey.trips.unlinkFailed'))
          }
        }}
        title={t('journey.trips.unlinkTrip')}
        message={t('journey.trips.unlinkMessage', { title: unlinkTrip?.title })}
        confirmLabel={t('journey.trips.unlink')}
        danger
      />

      {/* Lightbox */}
      {lightbox && (
        <PhotoLightbox
          photos={lightbox.photos.map(p => ({ id: p.id.toString(), src: p.src, caption: p.caption, provider: p.provider, asset_id: p.asset_id, owner_id: p.owner_id }))}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

// ── Map View ──────────────────────────────────────────────────────────────

function MapView({ entries, mapEntries, sortedDates, activeLocationId, fullMapRef, onLocationClick }: {
  entries: JourneyEntry[]
  mapEntries: JourneyEntry[]
  sortedDates: string[]
  activeLocationId: string | null
  fullMapRef: React.RefObject<JourneyMapHandle | null>
  onLocationClick: (id: string) => void
}) {
  const { t, locale } = useTranslation()
  // group map entries by date
  const byDate = new Map<string, { entry: JourneyEntry; globalIdx: number }[]>()
  mapEntries.forEach((e, i) => {
    const d = e.entry_date
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d)!.push({ entry: e, globalIdx: i })
  })
  const dates = [...byDate.keys()].sort()

  // find first and last entry indices
  const firstId = mapEntries[0]?.id
  const lastId = mapEntries[mapEntries.length - 1]?.id

  const mapItems = useMemo(() => mapEntries.map(e => ({
    id: String(e.id),
    lat: e.location_lat!,
    lng: e.location_lng!,
    title: e.title || '',
    mood: e.mood,
    entry_date: e.entry_date,
  })), [mapEntries])

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
      <JourneyMap
        ref={fullMapRef}
        checkins={[]}
        entries={mapItems as any}
        height={560}
        activeMarkerId={activeLocationId}
        onMarkerClick={onLocationClick}
      />

      {/* Locations list */}
      <div>
        {/* Stats header */}
        {mapEntries.length > 0 && (
          <div className="mx-5 mt-4 mb-2 grid grid-cols-3 gap-2">
            {[
              { value: mapEntries.length, label: t('journey.stats.places') },
              { value: dates.length, label: t('journey.stats.days') },
              { value: entries.filter(e => e.type === 'entry').length, label: 'Stories' },
            ].map(s => (
              <div key={s.label} className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-3 text-center">
                <div className="text-[17px] font-bold text-zinc-900 dark:text-white tracking-tight">{s.value}</div>
                <div className="text-[9px] font-medium text-zinc-500 uppercase tracking-[0.06em]">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Day groups */}
        <div className="px-5 pb-5">
          {dates.map((date, dayIdx) => {
            const items = byDate.get(date)!
            const fd = formatDate(date, locale)

            return (
              <div key={date}>
                {/* Day separator */}
                <div className="flex items-center gap-2.5 py-3">
                  <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 tracking-[0.12em] uppercase">{t('journey.detail.day', { number: dayIdx + 1 })}</span>
                  <span className="text-[10px] text-zinc-400 font-medium">{fd.month} {fd.day}</span>
                  <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-700" />
                </div>

                {/* Location items */}
                {items.map(({ entry: e, globalIdx }, itemIdx) => {
                  const isActive = activeLocationId === String(e.id)
                  const isFirst = e.id === firstId
                  const isLast = e.id === lastId
                  const showConnector = itemIdx < items.length - 1

                  return (
                    <div key={e.id}>
                      <div
                        onClick={() => onLocationClick(String(e.id))}
                        className={`flex items-center gap-3 p-3 rounded-[14px] cursor-pointer transition-all ${
                          isActive
                            ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-900 dark:border-zinc-100 translate-x-0.5'
                            : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 hover:translate-x-0.5'
                        }`}
                      >
                        {/* Number badge */}
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold flex-shrink-0 border-2 border-white dark:border-zinc-900 ${
                          isActive
                            ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-[0_0_0_2px_rgba(0,0,0,0.15)]'
                            : 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-[0_0_0_1px_rgba(0,0,0,0.1)]'
                        }`}>
                          {globalIdx + 1}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="text-[14px] font-semibold text-zinc-900 dark:text-white truncate">{e.title || e.location_name}</span>
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate">
                            {formatLocationName(e.location_name)}{e.entry_time ? ` · ${e.entry_time}` : ''}
                          </div>
                        </div>

                        {/* Chevron */}
                        <ChevronRight size={14} className={`flex-shrink-0 ${isActive ? 'text-zinc-900 dark:text-white' : 'text-zinc-300 dark:text-zinc-600'}`} />
                      </div>

                      {/* Connector line */}
                      {showConnector && (
                        <div className="w-0.5 h-2 bg-zinc-200 dark:bg-zinc-700 ml-[18px] rounded-full" />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}

        </div>
      </div>
    </div>
  )
}

// ── Gallery View ──────────────────────────────────────────────────────────

function GalleryView({ entries, journeyId, userId, trips, onPhotoClick, onRefresh }: {
  entries: JourneyEntry[]
  journeyId: number
  userId: number
  trips: JourneyTrip[]
  onPhotoClick: (photos: JourneyPhoto[], index: number) => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const [showPicker, setShowPicker] = useState(false)
  const [pickerProvider, setPickerProvider] = useState<string | null>(null)
  const [availableProviders, setAvailableProviders] = useState<{ id: string; name: string }[]>([])
  const [galleryUploading, setGalleryUploading] = useState(false)
  const toast = useToast()

  // check which providers are enabled AND connected for the current user
  useEffect(() => {
    (async () => {
      try {
        const addonsData = await addonsApi.enabled()
        const enabledProviders = (addonsData.addons || []).filter(
          (a: any) => a.type === 'photo_provider' && a.enabled
        )
        const connected: { id: string; name: string }[] = []
        for (const p of enabledProviders) {
          try {
            const res = await fetch(`/api/integrations/memories/${p.id}/status`, { credentials: 'include' })
            if (res.ok) {
              const status = await res.json()
              if (status.connected) connected.push({ id: p.id, name: p.name })
            }
          } catch {}
        }
        setAvailableProviders(connected)
      } catch {}
    })()
  }, [])

  const allPhotos: { photo: JourneyPhoto; entry: JourneyEntry }[] = []
  const seenPhotoIds = new Map<number, number>() // photo_id → index in allPhotos
  for (const e of entries) {
    for (const p of e.photos) {
      const existing = seenPhotoIds.get(p.photo_id)
      if (existing === undefined) {
        seenPhotoIds.set(p.photo_id, allPhotos.length)
        allPhotos.push({ photo: p, entry: e })
      } else if (e.title === 'Gallery' && allPhotos[existing].entry.title !== 'Gallery') {
        allPhotos[existing] = { photo: p, entry: e }
      }
    }
  }

  const entriesWithContent = entries.filter(e => e.type !== 'skeleton' || e.title)

  const browseProvider = (provider: string) => {
    setPickerProvider(provider)
    setShowPicker(true)
  }

  const galleryFileRef = useRef<HTMLInputElement>(null)

  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    setGalleryUploading(true)
    try {
      // find existing "Gallery" entry or create one. The stored title is the
      // literal 'Gallery' (server-side checks look for this exact string) —
      // do not send a translated label here.
      let galleryEntry = entries.find(e => e.title === 'Gallery' && e.type === 'entry')
      let entryId = galleryEntry?.id
      if (!entryId) {
        const entry = await journeyApi.createEntry(journeyId, {
          title: 'Gallery',
          entry_date: new Date().toISOString().split('T')[0],
          type: 'entry',
        })
        entryId = entry.id
      }
      const formData = new FormData()
      for (const f of files) formData.append('photos', f)
      await journeyApi.uploadPhotos(entryId, formData)
      toast.success(t('journey.photosUploaded', { count: files.length }))
      onRefresh()
    } catch {
      toast.error(t('journey.settings.coverFailed'))
    } finally {
      setGalleryUploading(false)
    }
    e.target.value = ''
  }

  const handleDeletePhoto = async (photoId: number) => {
    const store = useJourneyStore.getState()
    if (!store.current) return
    const target = store.current.entries.flatMap(e => e.photos).find(p => p.id === photoId)
    if (!target) return
    const siblingIds = store.current.entries.flatMap(e => e.photos).filter(p => p.photo_id === target.photo_id).map(p => p.id)

    // Optimistic update — remove every row with this photo_id
    const updated = {
      ...store.current,
      entries: store.current.entries.map(e => ({
        ...e,
        photos: e.photos.filter(p => p.photo_id !== target.photo_id),
      })).filter(e => e.type !== 'entry' || e.title !== 'Gallery' || e.photos.length > 0 || e.story),
    }
    useJourneyStore.setState({ current: updated })

    try {
      await Promise.all(siblingIds.map(id => journeyApi.deletePhoto(id)))
    } catch {
      toast.error(t('common.error'))
      onRefresh()
    }
  }

  return (
    <div>
      <input ref={galleryFileRef} type="file" accept="image/*" multiple onChange={handleGalleryUpload} className="hidden" />

      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
          <Camera size={10} /> {allPhotos.length} {t('journey.detail.photos')}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => galleryFileRef.current?.click()}
            disabled={galleryUploading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[11px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-50"
          >
            {galleryUploading ? (
              <><div className="w-3 h-3 border-2 border-white/30 dark:border-zinc-900/30 border-t-white dark:border-t-zinc-900 rounded-full animate-spin" /> {t('journey.editor.uploading')}</>
            ) : (
              <><Plus size={12} /> {t('common.upload')}</>
            )}
          </button>
          {availableProviders.map(p => (
            <button
              key={p.id}
              onClick={() => browseProvider(p.id)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <Image size={12} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {allPhotos.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-16 h-16 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-4">
            <Image size={24} className="text-zinc-400" />
          </div>
          <p className="text-[15px] font-medium text-zinc-700 dark:text-zinc-300">{t('journey.detail.noPhotos')}</p>
          <p className="text-[12px] text-zinc-500 mt-1">{t('journey.detail.noPhotosHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 pb-24 md:pb-6">
          {allPhotos.map(({ photo, entry }, i) => (
            <div
              key={photo.id}
              className="relative aspect-square rounded-lg overflow-hidden cursor-pointer group"
              onClick={() => onPhotoClick(allPhotos.map(a => a.photo), i)}
            >
              <img
                src={photoUrl(photo, 'thumbnail')}
                alt={photo.caption || ''}
                className="w-full h-full object-cover transition-transform group-hover:scale-105"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              {/* Delete button */}
              <button
                onClick={(e) => { e.stopPropagation(); handleDeletePhoto(photo.id) }}
                className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 backdrop-blur text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
              >
                <X size={12} />
              </button>
              {photo.provider && photo.provider !== 'local' && (
                <div className="absolute top-1.5 left-1.5">
                  <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-white flex items-center gap-1">
                    <RefreshCw size={7} />
                    {photo.provider === 'immich' ? 'Immich' : photo.provider === 'synology' ? 'Synology' : photo.provider}
                  </span>
                </div>
              )}
              {photo.caption && (
                <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-[10px] text-white truncate">{photo.caption}</p>
                </div>
              )}
              <div className="absolute bottom-1.5 left-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-black/50 backdrop-blur text-white">
                  {new Date(entry.entry_date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Provider Photo Picker Modal */}
      {showPicker && (
        <ProviderPicker
          provider={pickerProvider!}
          userId={userId}
          entries={entriesWithContent}
          trips={trips}
          existingAssetIds={new Set(entries.flatMap(e => (e.photos || []).filter(p => p.asset_id).map(p => p.asset_id!)))}
          onClose={() => setShowPicker(false)}
          onAdd={async (groups, entryId) => {
            let targetId = entryId
            if (!targetId) {
              try {
                const entry = await journeyApi.createEntry(journeyId, {
                  title: 'Gallery',
                  entry_date: new Date().toISOString().split('T')[0],
                  type: 'entry',
                })
                targetId = entry.id
              } catch { return }
            }
            let added = 0
            for (const group of groups) {
              try {
                const result = await journeyApi.addProviderPhotos(targetId, pickerProvider!, group.assetIds, undefined, group.passphrase)
                added += result.added || 0
              } catch {}
            }
            if (added > 0) {
              toast.success(t('journey.photosAdded', { count: added }))
              onRefresh()
            }
            setShowPicker(false)
          }}
        />
      )}
    </div>
  )
}

// ── Expandable Story ─────────────────────────────────────────────────────

function ExpandableStory({ story }: { story: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const measuredRef = useRef(false)

  useEffect(() => {
    measuredRef.current = false
  }, [story])

  useEffect(() => {
    if (measuredRef.current) return
    const el = ref.current
    if (el && !expanded) {
      setClamped(el.scrollHeight > el.clientHeight)
      measuredRef.current = true
    }
  })

  return (
    <div>
      <div
        ref={ref}
        onClick={() => { if (clamped || expanded) setExpanded(e => !e) }}
        className={`text-[13px] text-zinc-700 dark:text-zinc-300 leading-relaxed ${
          expanded ? '' : 'line-clamp-3 md:line-clamp-[9]'
        } ${clamped || expanded ? 'cursor-pointer' : ''}`}
      >
        <JournalBody text={story} />
      </div>
      {clamped && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-95 transition-all"
        >
          {t('common.showMore')} <ChevronRight size={10} />
        </button>
      )}
      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-[10px] font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-95 transition-all"
        >
          {t('common.showLess')} <ChevronRight size={10} className="rotate-[-90deg]" />
        </button>
      )}
    </div>
  )
}

// ── Verdict Section (Pros & Cons) ────────────────────────────────────────

function VerdictSection({ pros, cons }: { pros: string[]; cons: string[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // On desktop always show, on mobile toggle
  return (
    <div className="mt-5">
      {/* Header — clickable on mobile */}
      <button
        onClick={() => setOpen(o => !o)}
        className="md:pointer-events-none w-full flex items-center gap-2.5 mb-3.5 group"
      >
        <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-700" />
        <span className="text-[10px] font-bold tracking-[0.14em] uppercase text-zinc-400 flex items-center gap-1.5">
          {t('journey.editor.prosCons')}
          <ChevronDown
            size={12}
            className={`md:hidden text-zinc-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          />
        </span>
        <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-700" />
      </button>

      {/* Collapsed summary on mobile */}
      {!open && (
        <div className="flex items-center justify-center gap-3 md:hidden">
          {pros.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-md bg-green-500 flex items-center justify-center">
                <Check size={11} className="text-white" strokeWidth={3} />
              </div>
              <span className="text-[12px] font-semibold text-green-700 dark:text-green-400">{pros.length}</span>
            </div>
          )}
          {cons.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-md bg-red-500 flex items-center justify-center">
                <Minus size={11} className="text-white" strokeWidth={3} />
              </div>
              <span className="text-[12px] font-semibold text-red-700 dark:text-red-400">{cons.length}</span>
            </div>
          )}
        </div>
      )}

      {/* Content — always visible on desktop, toggled on mobile */}
      <div
        className={`grid grid-cols-1 md:grid-cols-2 gap-3 overflow-hidden transition-all duration-300 ease-in-out ${
          open ? 'max-h-[800px] opacity-100' : 'max-h-0 md:max-h-none opacity-0 md:opacity-100'
        }`}
      >
        {pros.length > 0 && (
          <div className="rounded-xl border border-green-200 dark:border-green-800/30 p-4 bg-gradient-to-b from-green-50 to-white dark:from-green-950/30 dark:to-zinc-900">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-lg bg-green-500 flex items-center justify-center">
                <Check size={14} className="text-white" strokeWidth={3} />
              </div>
              <span className="hidden md:inline text-[11px] font-bold tracking-[0.1em] uppercase text-green-700 dark:text-green-400">{t('journey.verdict.lovedIt')}</span>
              <span className="ml-auto text-[11px] font-semibold text-green-600">{pros.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {pros.map((p, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="w-[5px] h-[5px] rounded-full bg-green-500 flex-shrink-0 mt-[7px]" />
                  <span className="text-[13px] text-green-900 dark:text-green-100 leading-snug">{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {cons.length > 0 && (
          <div className="rounded-xl border border-red-200 dark:border-red-800/30 p-4 bg-gradient-to-b from-red-50 to-white dark:from-red-950/30 dark:to-zinc-900">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-lg bg-red-500 flex items-center justify-center">
                <Minus size={14} className="text-white" strokeWidth={3} />
              </div>
              <span className="hidden md:inline text-[11px] font-bold tracking-[0.1em] uppercase text-red-700 dark:text-red-400">{t('journey.verdict.couldBeBetter')}</span>
              <span className="ml-auto text-[11px] font-semibold text-red-600">{cons.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {cons.map((c, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="w-[5px] h-[5px] rounded-full bg-red-500 flex-shrink-0 mt-[7px]" />
                  <span className="text-[13px] text-red-900 dark:text-red-100 leading-snug">{c}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Entry Card ────────────────────────────────────────────────────────────

function EntryCard({ entry, readOnly, onEdit, onDelete, onPhotoClick }: {
  entry: JourneyEntry
  readOnly?: boolean
  onEdit: () => void
  onDelete: () => void
  onPhotoClick: (photos: JourneyPhoto[], index: number) => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const photos = entry.photos || []
  const mood = entry.mood ? MOOD_CONFIG[entry.mood] : null
  const weather = entry.weather ? WEATHER_CONFIG[entry.weather] : null

  const prosArr = entry.pros_cons?.pros ?? []
  const consArr = entry.pros_cons?.cons ?? []
  const hasProscons = prosArr.length > 0 || consArr.length > 0

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-2xl overflow-hidden transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-zinc-400 dark:hover:border-zinc-500 hover:shadow-sm">

      {/* Hero area: photos with title overlay */}
      {photos.length > 0 ? (
        <div className="relative">
          <PhotoGrid photos={photos} onClick={(idx) => onPhotoClick(photos, idx)} />
          {/* Gradient overlay for title */}
          <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 50%, transparent 100%)', height: '60%' }} />

          {/* Badges top-left */}
          <div className="absolute top-3 left-4 right-14 flex items-center gap-1.5 z-[2]">
            {entry.location_name && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-black/40 backdrop-blur-sm rounded-full text-[10px] font-semibold text-white tracking-wide max-w-full overflow-hidden">
                <MapPin size={10} className="flex-shrink-0" />
                <span className="truncate">{formatLocationName(entry.location_name)}</span>
              </span>
            )}
            {entry.entry_time && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-black/40 backdrop-blur-sm rounded-full text-[10px] font-semibold text-white tracking-wide">
                <Clock size={10} />
                {entry.entry_time}
              </span>
            )}
          </div>

          {/* Menu top-right */}
          {!readOnly && (
            <div className="absolute top-2.5 right-3 z-[2]">
              <button ref={menuBtnRef} onClick={() => setMenuOpen(!menuOpen)} className="w-8 h-8 rounded-[10px] bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/50">
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && createPortal(
                <>
                  <div className="fixed inset-0 z-[99]" onClick={() => setMenuOpen(false)} />
                  <div className="fixed z-[100] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[120px]" style={{ top: (menuBtnRef.current?.getBoundingClientRect().bottom || 0) + 4, right: window.innerWidth - (menuBtnRef.current?.getBoundingClientRect().right || 0) }}>
                    <button onClick={() => { setMenuOpen(false); onEdit() }} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 flex items-center gap-2"><Pencil size={12} /> {t('common.edit')}</button>
                    <button onClick={() => { setMenuOpen(false); onDelete() }} className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"><Trash2 size={12} /> {t('common.delete')}</button>
                  </div>
                </>,
                document.body,
              )}
            </div>
          )}

          {/* Title on photo */}
          {entry.title && (
            <div className="absolute bottom-4 left-5 right-5 z-[2] pointer-events-none">
              <h3 className="text-[22px] font-bold text-white tracking-[-0.02em] leading-tight drop-shadow-sm">{entry.title}</h3>
            </div>
          )}
        </div>
      ) : (
        /* No photos: simple header */
        <div className="flex items-center justify-between px-4 pt-3">
          <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
            {entry.location_name && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-full text-[10px] font-semibold text-zinc-500 max-w-full overflow-hidden">
                <MapPin size={10} className="flex-shrink-0" /> <span className="truncate">{formatLocationName(entry.location_name)}</span>
              </span>
            )}
            {entry.entry_time && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-full text-[10px] font-semibold text-zinc-500">
                <Clock size={10} /> {entry.entry_time}
              </span>
            )}
          </div>
          {!readOnly && (
            <div className="relative">
              <button ref={menuBtnRef} onClick={() => setMenuOpen(!menuOpen)} className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && createPortal(
                <>
                  <div className="fixed inset-0 z-[99]" onClick={() => setMenuOpen(false)} />
                  <div className="fixed z-[100] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[120px]" style={{ top: (menuBtnRef.current?.getBoundingClientRect().bottom || 0) + 4, right: window.innerWidth - (menuBtnRef.current?.getBoundingClientRect().right || 0) }}>
                    <button onClick={() => { setMenuOpen(false); onEdit() }} className="w-full text-left px-3 py-1.5 text-[12px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 flex items-center gap-2"><Pencil size={12} /> {t('common.edit')}</button>
                    <button onClick={() => { setMenuOpen(false); onDelete() }} className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"><Trash2 size={12} /> {t('common.delete')}</button>
                  </div>
                </>,
                document.body,
              )}
            </div>
          )}
        </div>
      )}

      <div className="px-5 pt-4 pb-5">
        {/* Title (only if no photos — otherwise shown on image) */}
        {!photos.length && entry.title && (
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white tracking-tight leading-snug mb-1">{entry.title}</h3>
        )}
        {!photos.length && entry.location_name && !entry.title && (
          <div className="mb-2" />
        )}
        {entry.story && (
          <ExpandableStory story={entry.story} />
        )}

        {/* Pros & Cons — "Pros & Cons" style */}
        {hasProscons && (
          <VerdictSection pros={prosArr} cons={consArr} />
        )}

        {(mood || weather || (entry.tags && entry.tags.length > 0)) && (
          <div className="flex items-center justify-between pt-3 mt-3 border-t border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center gap-1.5">
              {mood && <MoodChip mood={entry.mood!} />}
              {weather && <WeatherChip weather={entry.weather!} />}
            </div>
            <div className="flex gap-1">
              {entry.tags?.map((tag, i) => (
                <span key={i} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">{tag}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SkeletonCard({ entry, onClick }: { entry: JourneyEntry; onClick?: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-zinc-900 border border-dashed border-zinc-200 dark:border-zinc-700 rounded-xl px-4 py-3.5 flex items-center gap-3 transition-[border-color,border-style] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${onClick ? 'hover:border-solid hover:border-zinc-400 dark:hover:border-zinc-500 cursor-pointer' : ''}`}
    >
      <div className="w-9 h-9 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 flex-shrink-0">
        <MapPin size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-zinc-900 dark:text-white">
          {entry.title || t('journey.detail.newEntry')}
        </div>
        <div className="text-[11px] text-zinc-500 mt-0.5">
          {formatLocationName(entry.location_name)}{entry.entry_time ? ` · ${entry.entry_time}` : ''}
        </div>
      </div>
      <div className="text-[11px] text-zinc-500 font-medium flex-shrink-0">
        {t('journey.detail.addEntry')} &rarr;
      </div>
    </div>
  )
}

function CheckinCard({ entry, onClick }: { entry: JourneyEntry; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 flex items-center gap-2.5 transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${onClick ? 'hover:border-zinc-400 dark:hover:border-zinc-500 cursor-pointer' : ''}`}
    >
      <div className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
        <MapPin size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-zinc-900 dark:text-white flex items-center gap-1.5">
          {entry.title}
          {entry.location_name && <span className="text-zinc-500 font-normal text-xs">· {entry.location_name}</span>}
        </div>
        {entry.story && <div className="text-[11px] text-zinc-500 mt-0.5">{entry.story}</div>}
      </div>
      <div className="flex items-center gap-2.5 flex-shrink-0">
        {entry.entry_time && <span className="text-[11px] text-zinc-400 tabular-nums">{entry.entry_time}</span>}
      </div>
    </div>
  )
}

function PhotoImg({ photo, className, style, onClick }: { photo: JourneyPhoto; className?: string; style?: React.CSSProperties; onClick?: () => void }) {
  const src = photoUrl(photo, 'thumbnail')
  return (
    <img
      src={src}
      alt=""
      className={className}
      style={style}
      onClick={onClick}
      loading="lazy"
    />
  )
}

function PhotoGrid({ photos, onClick }: { photos: JourneyPhoto[]; onClick: (idx: number) => void }) {
  const count = photos.length
  if (count === 0) return null

  if (count === 1) {
    return (
      <div className="overflow-hidden cursor-pointer" onClick={() => onClick(0)}>
        <PhotoImg photo={photos[0]} className="w-full h-72 object-cover" />
      </div>
    )
  }

  if (count === 2) {
    return (
      <div className="grid grid-cols-2 gap-0.5 overflow-hidden">
        {photos.slice(0, 2).map((p, i) => (
          <PhotoImg key={p.id} photo={p} className="w-full h-52 object-cover cursor-pointer" onClick={() => onClick(i)} />
        ))}
      </div>
    )
  }

  return (
    <div className="overflow-hidden flex" style={{ height: 300, gap: 2 }}>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onClick(0)}>
        <PhotoImg photo={photos[0]} className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 2 }}>
        <div className="flex-1 min-h-0 cursor-pointer" onClick={() => onClick(1)}>
          <PhotoImg photo={photos[1]} className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-h-0 relative cursor-pointer" onClick={() => onClick(2)}>
          <PhotoImg photo={photos[2]} className="w-full h-full object-cover" />
          {count > 3 && (
            <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur text-white rounded-full px-2 py-0.5 text-[10px] font-semibold flex items-center gap-1">
              <Image size={10} />
              +{count - 3}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MoodChip({ mood }: { mood: string }) {
  const { t } = useTranslation()
  const config = MOOD_CONFIG[mood]
  if (!config) return null
  const Icon = config.icon
  return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ background: config.bg, color: config.text }}>
      <Icon size={11} />
      {t(config.label)}
    </div>
  )
}

function WeatherChip({ weather }: { weather: string }) {
  const { t } = useTranslation()
  const config = WEATHER_CONFIG[weather]
  if (!config) return null
  const Icon = config.icon
  return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
      <Icon size={11} />
      {t(config.label)}
    </div>
  )
}

// ── Scroll Trigger ───────────────────────────────────────────────────────

function ScrollTrigger({ onVisible, loading }: { onVisible: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting && !loading) onVisible() }, { rootMargin: '200px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [onVisible, loading])
  return (
    <div ref={ref} className="flex justify-center py-4 mt-2">
      <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-600 dark:border-t-white rounded-full animate-spin" />
    </div>
  )
}

// ── Photo date grouping ───────────────────────────────────────────────────

function groupPhotosByDate(photos: any[]): { date: string; label: string; assets: any[] }[] {
  const map = new Map<string, any[]>()
  for (const asset of photos) {
    const key = asset.takenAt ? asset.takenAt.slice(0, 10) : '__unknown__'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(asset)
  }
  return [...map.entries()].map(([date, assets]) => ({
    date,
    label: date === '__unknown__'
      ? 'Unknown date'
      : new Date(date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    assets,
  }))
}

// ── Provider Picker ───────────────────────────────────────────────────────

function ProviderPicker({ provider, userId, entries, trips, existingAssetIds, onClose, onAdd }: {
  provider: string
  userId: number
  entries: JourneyEntry[]
  trips: JourneyTrip[]
  existingAssetIds: Set<string>
  onClose: () => void
  onAdd: (groups: Array<{ assetIds: string[]; passphrase?: string }>, entryId: number | null) => Promise<void>
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<'trip' | 'custom' | 'all' | 'album'>('trip')
  const [photos, setPhotos] = useState<any[]>([])
  const [albums, setAlbums] = useState<Array<{ id: string; albumName: string; assetCount: number; passphrase?: string }>>([])
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [selectedAlbumPassphrase, setSelectedAlbumPassphrase] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [searchPage, setSearchPage] = useState(1)
  const [searchFrom, setSearchFrom] = useState('')
  const [searchTo, setSearchTo] = useState('')
  const [selected, setSelected] = useState<Map<string, { albumId?: string; passphrase?: string }>>(new Map())
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [targetEntryId, setTargetEntryId] = useState<number | null>(null)
  const [addToOpen, setAddToOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  // compute trip range
  const tripRange = useMemo(() => {
    let from = '', to = ''
    for (const t of trips) {
      if (t.start_date && (!from || t.start_date < from)) from = t.start_date
      if (t.end_date && (!to || t.end_date > to)) to = t.end_date
    }
    return { from, to }
  }, [trips])

  const cancelPending = () => {
    if (abortRef.current) { abortRef.current.abort() }
    abortRef.current = new AbortController()
    return abortRef.current.signal
  }

  const searchPhotos = async (from: string, to: string, page: number = 1, append: boolean = false) => {
    const signal = cancelPending()
    if (page === 1) { setLoading(true); setPhotos([]) } else { setLoadingMore(true) }
    setSearchFrom(from)
    setSearchTo(to)
    setSearchPage(page)
    try {
      const res = await fetch(`/api/integrations/memories/${provider}/search`, {
        method: 'POST', credentials: 'include', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, page, size: 50 }),
      })
      if (res.ok) {
        const data = await res.json()
        const assets = data.assets || []
        setPhotos(prev => append ? [...prev, ...assets] : assets)
        setHasMore(!!data.hasMore)
      } else {
        setHasMore(false)
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setHasMore(false)
    }
    if (!signal.aborted) { setLoading(false); setLoadingMore(false) }
  }

  const loadMorePhotos = () => {
    if (loadingMore || !hasMore) return
    searchPhotos(searchFrom, searchTo, searchPage + 1, true)
  }

  const loadAlbumPhotos = async (album: { id: string; passphrase?: string }) => {
    const signal = cancelPending()
    setLoading(true)
    setPhotos([])
    setHasMore(false)
    try {
      const qs = album.passphrase ? `?passphrase=${encodeURIComponent(album.passphrase)}` : ''
      const res = await fetch(`/api/integrations/memories/${provider}/albums/${album.id}/photos${qs}`, { credentials: 'include', signal })
      if (res.ok) setPhotos((await res.json()).assets || [])
    } catch (e: any) { if (e.name !== 'AbortError') {} }
    if (!signal.aborted) setLoading(false)
  }

  const loadAlbums = async () => {
    try {
      const res = await fetch(`/api/integrations/memories/${provider}/albums`, { credentials: 'include' })
      if (res.ok) setAlbums((await res.json()).albums || [])
    } catch {}
  }

  // load on mount / filter change
  useEffect(() => {
    if (filter === 'trip' && tripRange.from && tripRange.to) {
      searchPhotos(tripRange.from, tripRange.to)
    } else if (filter === 'all') {
      searchPhotos('', '')
    } else if (filter === 'album' && albums.length === 0) {
      loadAlbums()
    }
  }, [filter])

  const handleCustomSearch = () => {
    if (customFrom && customTo) searchPhotos(customFrom, customTo)
  }

  const toggleAsset = (id: string) => {
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.set(id, { albumId: selectedAlbum ?? undefined, passphrase: selectedAlbumPassphrase })
      }
      return next
    })
  }

  const targetLabel = targetEntryId
    ? entries.find(e => e.id === targetEntryId)?.title || entries.find(e => e.id === targetEntryId)?.entry_date || t('journey.stats.entries')
    : t('journey.picker.newGallery')

  return (
    <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center md:p-5 overscroll-none" style={{ background: 'rgba(9,9,11,0.75)' }} onClick={onClose} onTouchMove={e => { if (e.target === e.currentTarget) e.preventDefault() }}>
      <div className="bg-white dark:bg-zinc-900 rounded-t-2xl md:rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] max-w-[720px] md:max-w-[960px] w-full max-h-[calc(100dvh-var(--bottom-nav-h)-20px)] md:max-h-[85vh] flex flex-col overflow-hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">
            {provider === 'immich' ? 'Immich' : 'Synology Photos'}
          </h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        {/* Filter bar */}
        <div className="px-6 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
          {/* Tabs */}
          <div className="flex gap-1.5 mb-3">
            {[
              { id: 'trip' as const, label: t('journey.picker.tripPeriod') },
              { id: 'custom' as const, label: t('journey.picker.dateRange') },
              { id: 'all' as const, label: t('journey.picker.allPhotos'), short: t('common.all') },
              { id: 'album' as const, label: t('journey.picker.albums') },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                  filter === f.id
                    ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                {f.short ? (
                  <>
                    <span className="hidden sm:inline">{f.label}</span>
                    <span className="sm:hidden">{f.short}</span>
                  </>
                ) : f.label}
              </button>
            ))}
          </div>

          {/* Filter content — always visible row */}
          <div className="min-h-[36px] flex items-center">
            {filter === 'trip' && (
              <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                {tripRange.from && tripRange.to ? (
                  <>
                    <Calendar size={13} className="text-zinc-400" />
                    <span className="font-medium text-zinc-900 dark:text-white">
                      {new Date(tripRange.from + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="text-zinc-400">&mdash;</span>
                    <span className="font-medium text-zinc-900 dark:text-white">
                      {new Date(tripRange.to + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    <span className="ml-1 text-zinc-400">
                      ({Math.ceil((new Date(tripRange.to).getTime() - new Date(tripRange.from).getTime()) / 86400000) + 1} days)
                    </span>
                  </>
                ) : (
                  <span className="text-zinc-400">{t('journey.trips.noTripsLinkedSettings')}</span>
                )}
              </div>
            )}

            {filter === 'custom' && (
              <div className="flex items-center gap-2 flex-1">
                <div className="flex-1"><DatePicker value={customFrom} onChange={setCustomFrom} /></div>
                <span className="text-zinc-400 text-[12px]">&mdash;</span>
                <div className="flex-1"><DatePicker value={customTo} onChange={setCustomTo} /></div>
                <button onClick={handleCustomSearch}
                  className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[12px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 flex-shrink-0">
                  {t('journey.picker.search')}
                </button>
              </div>
            )}

            {filter === 'album' && (
              <div className="flex gap-2 overflow-x-auto flex-1">
                {albums.map((a: any) => (
                  <button
                    key={a.id}
                    onClick={() => { setSelectedAlbum(a.id); setSelectedAlbumPassphrase(a.passphrase); loadAlbumPhotos(a) }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium whitespace-nowrap flex-shrink-0 border ${
                      selectedAlbum === a.id
                        ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white'
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {a.albumName || a.name || 'Album'}{a.assetCount != null ? ` (${a.assetCount})` : ''}
                  </button>
                ))}
                {albums.length === 0 && !loading && <span className="text-[12px] text-zinc-400">{t('journey.picker.noAlbums')}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Add-to entry selector */}
        <div className="px-6 py-2.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 flex-shrink-0">
          <div className="relative flex items-center gap-2">
            <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500">{t('journey.picker.addTo')}</span>
            <button
              onClick={() => setAddToOpen(!addToOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[12px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <span className={targetEntryId ? '' : 'font-semibold'}>{targetLabel}</span>
              <ChevronRight size={12} className="rotate-90 text-zinc-400" />
            </button>
            {addToOpen && (
              <>
                <div className="fixed inset-0 z-[9]" onClick={() => setAddToOpen(false)} />
                <div className="absolute left-12 top-full mt-1 z-10 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg py-1.5 min-w-[200px] max-h-[240px] overflow-y-auto">
                  <button
                    onClick={() => { setTargetEntryId(null); setAddToOpen(false) }}
                    className={`w-full text-left px-3 py-2 text-[12px] flex items-center gap-2 ${
                      !targetEntryId
                        ? 'bg-zinc-100 dark:bg-zinc-700 font-semibold text-zinc-900 dark:text-white'
                        : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                    }`}
                  >
                    <Camera size={12} />
                    {t('journey.picker.newGallery')}
                  </button>
                  {entries.filter(e => e.type !== 'skeleton' && e.title !== 'Gallery' && e.title !== '[Trip Photos]').length > 0 && (
                    <div className="h-px bg-zinc-200 dark:bg-zinc-700 my-1" />
                  )}
                  {entries.filter(e => e.type !== 'skeleton' && e.title !== 'Gallery' && e.title !== '[Trip Photos]').map(e => (
                    <button
                      key={e.id}
                      onClick={() => { setTargetEntryId(e.id); setAddToOpen(false) }}
                      className={`w-full text-left px-3 py-2 text-[12px] truncate ${
                        targetEntryId === e.id
                          ? 'bg-zinc-100 dark:bg-zinc-700 font-semibold text-zinc-900 dark:text-white'
                          : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {e.title || e.location_name || new Date(e.entry_date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Select all bar — sticky above grid */}
        {!loading && photos.length > 0 && (() => {
          const selectable = photos.filter((a: any) => !existingAssetIds.has(a.id))
          const allSelected = selectable.length > 0 && selectable.every((a: any) => selected.has(a.id))
          if (selectable.length === 0) return null
          return (
            <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex-shrink-0">
              <button
                onClick={() => {
                  if (allSelected) {
                    setSelected(new Map())
                  } else {
                    setSelected(new Map(selectable.map((a: any) => [a.id, { albumId: selectedAlbum ?? undefined, passphrase: selectedAlbumPassphrase }])))
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                  allSelected
                    ? 'bg-zinc-900 dark:bg-white border-zinc-900 dark:border-white'
                    : 'border-zinc-300 dark:border-zinc-600'
                }`}>
                  {allSelected && <Check size={9} className="text-white dark:text-zinc-900" strokeWidth={3} />}
                </div>
                {allSelected ? t('journey.picker.deselectAll') : t('journey.picker.selectAll')} ({selectable.length})
              </button>
            </div>
          )
        })()}

        {/* Photo grid */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 min-h-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="w-6 h-6 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
            </div>
          ) : photos.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-[13px] text-zinc-500">
                {filter === 'trip' && !tripRange.from ? t('journey.trips.noTripsLinkedSettings') : t('journey.detail.noPhotos')}
              </p>
            </div>
          ) : (
            <div>
              {groupPhotosByDate(photos).map(group => (
                <div key={group.date}>
                  <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-2 mt-4 first:mt-0">
                    {group.label}
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5 mb-1">
                    {group.assets.map((asset: any) => {
                      const isSelected = selected.has(asset.id)
                      const alreadyAdded = existingAssetIds.has(asset.id)
                      return (
                        <div
                          key={asset.id}
                          onClick={() => !alreadyAdded && toggleAsset(asset.id)}
                          className={`relative aspect-square rounded-lg overflow-hidden ${
                            alreadyAdded
                              ? 'opacity-40 cursor-not-allowed'
                              : isSelected
                                ? 'ring-2 ring-zinc-900 dark:ring-white ring-offset-2 dark:ring-offset-zinc-900 cursor-pointer'
                                : 'cursor-pointer'
                          }`}
                        >
                          <img
                            src={`/api/integrations/memories/${provider}/assets/0/${asset.id}/${userId}/thumbnail${selectedAlbumPassphrase ? `?passphrase=${encodeURIComponent(selectedAlbumPassphrase)}` : ''}`}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={e => {
                              const img = e.currentTarget
                              const original = `/api/integrations/memories/${provider}/assets/0/${asset.id}/${userId}/original${selectedAlbumPassphrase ? `?passphrase=${encodeURIComponent(selectedAlbumPassphrase)}` : ''}`
                              if (!img.src.includes('/original')) img.src = original
                            }}
                          />
                          {alreadyAdded && (
                            <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-500 text-white flex items-center justify-center">
                              <Check size={12} />
                            </div>
                          )}
                          {isSelected && !alreadyAdded && (
                            <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center">
                              <Check size={12} />
                            </div>
                          )}
                          {asset.city && (
                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/50 to-transparent">
                              <p className="text-[8px] text-white truncate">{asset.city}</p>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              {/* Infinite scroll trigger */}
              {hasMore && !selectedAlbum && <ScrollTrigger onVisible={loadMorePhotos} loading={loadingMore} />}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 flex-shrink-0">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-200/60 dark:bg-zinc-700/60 text-[11px] leading-none text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[10px] leading-none font-bold">{selected.size}</span>
            <span className="leading-[18px]">{t('journey.picker.selected')}</span>
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700">
              {t('common.cancel')}
            </button>
            <button
              onClick={() => {
                const groupMap = new Map<string | undefined, string[]>()
                for (const [assetId, { passphrase }] of selected.entries()) {
                  const list = groupMap.get(passphrase) || []
                  list.push(assetId)
                  groupMap.set(passphrase, list)
                }
                const groups = [...groupMap.entries()].map(([passphrase, assetIds]) => ({ assetIds, passphrase }))
                onAdd(groups, targetEntryId)
              }}
              disabled={selected.size === 0}
              className="px-3.5 py-2 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('common.add')} {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Date Picker ───────────────────────────────────────────────────────────

function DatePicker({ value, onChange, tripDates }: {
  value: string
  onChange: (date: string) => void
  tripDates?: Set<string>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  const daysInMonth = new Date(viewMonth.year, viewMonth.month + 1, 0).getDate()
  const firstDow = new Date(viewMonth.year, viewMonth.month, 1).getDay()
  const monthName = new Date(viewMonth.year, viewMonth.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  const prevMonth = () => {
    setViewMonth(p => p.month === 0 ? { year: p.year - 1, month: 11 } : { ...p, month: p.month - 1 })
  }
  const nextMonth = () => {
    setViewMonth(p => p.month === 11 ? { year: p.year + 1, month: 0 } : { ...p, month: p.month + 1 })
  }

  const pad = (n: number) => String(n).padStart(2, '0')

  const cells: (number | null)[] = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const formatted = value ? new Date(value + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[13px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white text-left flex items-center justify-between"
      >
        {formatted ? (
          <span>{formatted}</span>
        ) : (
          <span>
            <span className="hidden sm:inline">{t('journey.picker.selectDate')}</span>
            <span className="sm:hidden">{t('common.date')}</span>
          </span>
        )}
        <Calendar size={13} className="text-zinc-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[10]" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-[20] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg p-3 w-[280px]">
            {/* Month nav */}
            <div className="flex items-center justify-between mb-2">
              <button type="button" onClick={prevMonth} className="w-7 h-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center justify-center text-zinc-500">
                <ArrowLeft size={14} />
              </button>
              <span className="text-[13px] font-semibold text-zinc-900 dark:text-white">{monthName}</span>
              <button type="button" onClick={nextMonth} className="w-7 h-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center justify-center text-zinc-500">
                <ChevronRight size={14} />
              </button>
            </div>

            {/* Weekday headers */}
            <div className="grid grid-cols-7 mb-1">
              {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d, i) => (
                <div key={i} className="text-center text-[10px] font-medium text-zinc-400 py-1">{d}</div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7">
              {cells.map((day, i) => {
                if (day === null) return <div key={`e${i}`} />
                const dateStr = `${viewMonth.year}-${pad(viewMonth.month + 1)}-${pad(day)}`
                const isSelected = dateStr === value
                const isTrip = tripDates?.has(dateStr)
                const isToday = dateStr === new Date().toISOString().split('T')[0]

                return (
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => { onChange(dateStr); setOpen(false) }}
                    className={`w-9 h-9 rounded-lg text-[12px] font-medium flex items-center justify-center relative transition-colors ${
                      isSelected
                        ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                        : isToday
                          ? 'text-zinc-900 dark:text-white font-bold'
                          : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {day}
                    {isTrip && !isSelected && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-indigo-500" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function EntryEditor({ entry, journeyId, tripDates, galleryPhotos, onClose, onSave, onUploadPhotos, onDone }: {
  entry: JourneyEntry
  journeyId: number
  tripDates: Set<string>
  galleryPhotos: JourneyPhoto[]
  onClose: () => void
  onSave: (data: Record<string, unknown>) => Promise<number>
  onUploadPhotos: (entryId: number, formData: FormData) => Promise<JourneyPhoto[]>
  onDone: () => void
}) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [title, setTitle] = useState(entry.title || '')
  const [story, setStory] = useState(entry.story || '')
  const [entryDate, setEntryDate] = useState(entry.entry_date || new Date().toISOString().split('T')[0])
  const [entryTime, setEntryTime] = useState(entry.entry_time || '')
  const [locationName, setLocationName] = useState(entry.location_name || '')
  const [locationLat, setLocationLat] = useState<number | null>(entry.location_lat ?? null)
  const [locationLng, setLocationLng] = useState<number | null>(entry.location_lng ?? null)
  const [locationQuery, setLocationQuery] = useState('')
  const [locationResults, setLocationResults] = useState<{ name: string; address?: string; lat: number; lng: number }[]>([])
  const [locationSearching, setLocationSearching] = useState(false)
  const [showLocationResults, setShowLocationResults] = useState(false)
  const locationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mood, setMood] = useState(entry.mood || '')
  const [weather, setWeather] = useState(entry.weather || '')
  const [pros, setPros] = useState<string[]>(entry.pros_cons?.pros?.length ? entry.pros_cons.pros : [''])
  const [cons, setCons] = useState<string[]>(entry.pros_cons?.cons?.length ? entry.pros_cons.cons : [''])
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [photos, setPhotos] = useState<JourneyPhoto[]>(entry.photos || [])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [pendingLinkIds, setPendingLinkIds] = useState<number[]>([])
  const [showGalleryPick, setShowGalleryPick] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const storyRef = useRef<HTMLTextAreaElement>(null)

  // Track which fields differ from the entry we started editing so we can
  // warn before discarding on close/cancel.
  const originalPros = (entry.pros_cons?.pros ?? []).join('\n')
  const originalCons = (entry.pros_cons?.cons ?? []).join('\n')
  const isDirty = (
    title !== (entry.title || '') ||
    story !== (entry.story || '') ||
    entryDate !== (entry.entry_date || new Date().toISOString().split('T')[0]) ||
    entryTime !== (entry.entry_time || '') ||
    locationName !== (entry.location_name || '') ||
    (locationLat ?? null) !== (entry.location_lat ?? null) ||
    (locationLng ?? null) !== (entry.location_lng ?? null) ||
    mood !== (entry.mood || '') ||
    weather !== (entry.weather || '') ||
    pros.filter(p => p.trim()).join('\n') !== originalPros ||
    cons.filter(c => c.trim()).join('\n') !== originalCons ||
    pendingFiles.length > 0 ||
    pendingLinkIds.length > 0
  )

  const uniqueGalleryPhotos = Array.from(new Map(galleryPhotos.map(gp => [gp.photo_id, gp])).values())
  const availableGalleryPhotos = uniqueGalleryPhotos.filter(gp => !photos.some(p => p.photo_id === gp.photo_id))

  const handleClose = () => {
    if (isDirty && !window.confirm(t('journey.editor.discardChangesConfirm'))) return
    onClose()
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const entryId = await onSave({
        title: title || null,
        story: story || null,
        entry_date: entryDate,
        entry_time: entryTime || null,
        location_name: locationName || null,
        location_lat: locationLat,
        location_lng: locationLng,
        mood: mood || null,
        weather: weather || null,
        pros_cons: { pros: pros.filter(p => p.trim()), cons: cons.filter(c => c.trim()) },
        type: ((entry.type === 'skeleton' && (story.trim() || pendingFiles.length > 0 || pendingLinkIds.length > 0)) ? 'entry' : undefined),
      })
      // upload queued files after entry is created
      if (pendingFiles.length > 0 && entryId) {
        const formData = new FormData()
        for (const f of pendingFiles) formData.append('photos', f)
        await onUploadPhotos(entryId, formData)
      }
      // link gallery photos that were picked before save
      if (pendingLinkIds.length > 0 && entryId) {
        for (const photoId of pendingLinkIds) {
          try { await journeyApi.linkPhoto(entryId, photoId) } catch {}
        }
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    // Queue files locally until Save so cancel/close actually discards. This
    // keeps photo behavior consistent with text fields — no silent persistence.
    setPendingFiles(prev => [...prev, ...Array.from(files)])
  }

  return (
    <div className="fixed inset-0 z-[9999]" style={{ background: 'rgba(9,9,11,0.6)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
      {/* The modal itself is constrained to the feed column on desktop so it
          centers there — but the backdrop stays full-width (covering the map
          too) for a uniform dim/blur across the whole page. */}
      <div
        className="absolute top-0 bottom-0 left-0 flex items-end sm:items-center sm:justify-center sm:p-5"
        style={{ right: isMobile ? 0 : 'clamp(420px, 44vw, 760px)' }}
      >
        <div className="bg-white dark:bg-zinc-900 sm:rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] sm:max-w-[640px] w-full flex flex-col overflow-hidden h-full sm:h-auto sm:max-h-[90vh]" style={{ paddingBottom: 'var(--bottom-nav-h)' }}>


        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">{entry.id === 0 ? t('journey.detail.newEntry') : t('journey.detail.editEntry')}</h2>
          <button onClick={handleClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('journey.editor.titlePlaceholder')}
            className="w-full text-[20px] font-medium bg-transparent border-0 border-b border-transparent focus:border-zinc-300 dark:focus:border-zinc-600 outline-none text-zinc-900 dark:text-white placeholder:text-zinc-400 pb-2"
          />

          <div>
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={handleFileChange} onClick={e => { (e.target as HTMLInputElement).value = '' }} className="hidden" />
            <div className="flex gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex-1 border border-dashed border-zinc-200 dark:border-zinc-700 rounded-lg py-4 text-[12px] text-zinc-500 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {uploading ? (
                  <><div className="w-3.5 h-3.5 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" /> {t('journey.editor.uploading')}</>
                ) : (
                  <><Plus size={13} /> {t('journey.editor.uploadPhotos')}</>
                )}
              </button>
              {galleryPhotos.length > 0 && (
                <button
                  onClick={() => setShowGalleryPick(!showGalleryPick)}
                  className={`flex-1 border rounded-lg py-4 text-[12px] text-zinc-500 flex items-center justify-center gap-1.5 ${
                    showGalleryPick
                      ? 'border-zinc-900 dark:border-white bg-zinc-50 dark:bg-zinc-800'
                      : 'border-dashed border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <Image size={13} /> {t('journey.editor.fromGallery')}
                </button>
              )}
            </div>

            {/* Gallery picker — directly below buttons. Safari collapses
                `aspect-square` items inside an overflow-scroll grid, so
                the square is enforced with a padding-top spacer + an
                absolutely positioned image (works across all browsers). */}
            {showGalleryPick && (
              <div className="mt-2 border border-zinc-200 dark:border-zinc-700 rounded-xl p-3 bg-zinc-50 dark:bg-zinc-800/50">
                <div className="grid grid-cols-5 sm:grid-cols-6 gap-1.5 max-h-[160px] overflow-y-auto">
                  {availableGalleryPhotos.map(gp => (
                    <div
                      key={gp.id}
                      onClick={async () => {
                        if (entry.id > 0) {
                          try {
                            const linked = await journeyApi.linkPhoto(entry.id, gp.id)
                            if (linked) setPhotos(prev => [...prev, linked])
                          } catch {}
                        } else {
                          setPendingLinkIds(prev => [...prev, gp.id])
                          setPhotos(prev => [...prev, gp])
                        }
                      }}
                      className="relative w-full rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-zinc-900 dark:hover:ring-white hover:ring-offset-1 dark:hover:ring-offset-zinc-900 transition-all"
                      style={{ paddingTop: '100%' }}
                    >
                      <img src={photoUrl(gp)} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" onError={e => { const img = e.currentTarget; const orig = photoUrl(gp, 'original'); if (!img.src.includes('/original')) img.src = orig }} />
                    </div>
                  ))}
                  {availableGalleryPhotos.length === 0 && (
                    <div className="col-span-full text-center py-3 text-[11px] text-zinc-400">{t('journey.editor.allPhotosAdded')}</div>
                  )}
                </div>
              </div>
            )}
            {(photos.length > 0 || pendingFiles.length > 0) && (
              <div className="mt-3">
                <div className="flex flex-wrap gap-2">
                  {photos.map((p, idx) => (
                    <div key={p.id} className={`w-20 h-20 rounded-lg overflow-hidden relative group ${idx === 0 && photos.length > 1 ? 'ring-2 ring-zinc-900 dark:ring-white ring-offset-1 dark:ring-offset-zinc-900' : ''}`}>
                      <img src={photoUrl(p)} className="w-full h-full object-cover" alt="" onError={e => { const img = e.currentTarget; const orig = photoUrl(p, 'original'); if (!img.src.includes('/original')) img.src = orig }} />
                      {idx === 0 && photos.length > 1 && (
                        <span className="absolute bottom-0.5 left-0.5 px-1 py-px rounded text-[8px] font-bold bg-zinc-900/70 text-white">{t('journey.editor.photoFirst')}</span>
                      )}
                      {idx > 0 && photos.length > 1 && (
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            setPhotos(prev => {
                              const next = [...prev]
                              const [moved] = next.splice(idx, 1)
                              next.unshift(moved)
                              next.forEach((ph, i) => { journeyApi.updatePhoto(ph.id, { sort_order: i }).catch(() => {}) })
                              return next
                            })
                          }}
                          className="absolute bottom-0.5 left-0.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[8px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {t('journey.editor.makeFirst')}
                        </button>
                      )}
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          await journeyApi.deletePhoto(p.id)
                          setPhotos(prev => prev.filter(x => x.id !== p.id))
                        }}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {pendingFiles.map((f, i) => (
                    <div key={`pending-${i}`} className="w-20 h-20 rounded-lg overflow-hidden relative group">
                      <img src={URL.createObjectURL(f)} className="w-full h-full object-cover" alt="" />
                      <button
                        onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden focus-within:border-zinc-400 dark:focus-within:border-zinc-500">
            <MarkdownToolbar textareaRef={storyRef} onUpdate={setStory} />
            <textarea
              ref={storyRef}
              value={story}
              onChange={e => setStory(e.target.value)}
              placeholder={t('journey.editor.writeStory')}
              rows={6}
              style={{ minHeight: '144px' }}
              className="w-full px-3 py-2.5 text-[14px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none resize-none border-0 shrink-0"
            />
          </div>

          {/* Pros & Cons */}
          <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-2xl p-5">
            <div className="mb-4">
              <span className="text-[11px] font-semibold tracking-[0.12em] uppercase text-zinc-500">{t('journey.editor.prosCons')}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {/* Pros */}
              <div>
                <div className="flex items-center gap-[7px] mb-2.5">
                  <div className="w-4 h-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <Check size={9} className="text-green-700 dark:text-green-400" strokeWidth={3.5} />
                  </div>
                  <span className="text-[12px] font-semibold text-green-700 dark:text-green-400">{t('journey.editor.pros')}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {pros.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 h-9 px-3 border rounded-[10px] border-zinc-200 dark:border-zinc-700">
                      <span className="w-[5px] h-[5px] rounded-full bg-green-500 flex-shrink-0" />
                      <input
                        value={p}
                        onChange={e => { const next = [...pros]; next[i] = e.target.value; setPros(next) }}
                        placeholder={t('journey.editor.proPlaceholder')}
                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-zinc-900 dark:text-zinc-100 placeholder:text-green-400 dark:placeholder:text-green-600"
                      />
                      {pros.length > 1 && (
                        <button onClick={() => setPros(pros.filter((_, j) => j !== i))} className="p-1 text-green-300 dark:text-green-700 hover:text-green-600 dark:hover:text-green-400 flex-shrink-0">
                          <X size={13} strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setPros([...pros, ''])}
                    className="flex items-center justify-center gap-1.5 h-9 w-full border border-dashed border-green-200 dark:border-green-800/40 rounded-[10px] text-[12px] font-medium text-green-700 dark:text-green-400 hover:border-green-300 dark:hover:border-green-700 transition-colors"
                  >
                    <Plus size={13} strokeWidth={2.5} /> {t('journey.editor.addAnother')}
                  </button>
                </div>
              </div>

              {/* Cons */}
              <div>
                <div className="flex items-center gap-[7px] mb-2.5">
                  <div className="w-4 h-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <Minus size={9} className="text-red-700 dark:text-red-400" strokeWidth={3.5} />
                  </div>
                  <span className="text-[12px] font-semibold text-red-700 dark:text-red-400">{t('journey.editor.cons')}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {cons.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 h-9 px-3 border rounded-[10px] border-zinc-200 dark:border-zinc-700">
                      <span className="w-[5px] h-[5px] rounded-full bg-red-500 flex-shrink-0" />
                      <input
                        value={c}
                        onChange={e => { const next = [...cons]; next[i] = e.target.value; setCons(next) }}
                        placeholder={t('journey.editor.conPlaceholder')}
                        className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-zinc-900 dark:text-zinc-100 placeholder:text-red-400 dark:placeholder:text-red-600"
                      />
                      {cons.length > 1 && (
                        <button onClick={() => setCons(cons.filter((_, j) => j !== i))} className="p-1 text-red-300 dark:text-red-700 hover:text-red-600 dark:hover:text-red-400 flex-shrink-0">
                          <X size={13} strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => setCons([...cons, ''])}
                    className="flex items-center justify-center gap-1.5 h-9 w-full border border-dashed border-red-200 dark:border-red-800/40 rounded-[10px] text-[12px] font-medium text-red-700 dark:text-red-400 hover:border-red-300 dark:hover:border-red-700 transition-colors"
                  >
                    <Plus size={13} strokeWidth={2.5} /> {t('journey.editor.addAnother')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="h-px bg-zinc-200 dark:bg-zinc-700" />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.editor.date')}</label>
              <DatePicker value={entryDate} onChange={setEntryDate} tripDates={tripDates} />
            </div>
            <div className="relative">
              <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.editor.location')}</label>
              <div className="relative">
                <input
                  value={locationQuery || locationName}
                  onChange={e => {
                    const q = e.target.value
                    setLocationQuery(q)
                    setShowLocationResults(true)
                    if (locationTimerRef.current) clearTimeout(locationTimerRef.current)
                    if (q.trim().length >= 2) {
                      locationTimerRef.current = setTimeout(async () => {
                        setLocationSearching(true)
                        try {
                          const res = await mapsApi.search(q)
                          setLocationResults((res.places || []).slice(0, 6).map((p: any) => ({
                            name: p.name, address: p.address, lat: Number(p.lat), lng: Number(p.lng),
                          })))
                        } catch { setLocationResults([]) }
                        finally { setLocationSearching(false) }
                      }, 400)
                    } else {
                      setLocationResults([])
                    }
                  }}
                  onFocus={() => { if (locationResults.length > 0) setShowLocationResults(true) }}
                  placeholder={t('journey.editor.searchLocation')}
                  className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[13px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none focus:border-zinc-400 dark:focus:border-zinc-500"
                />
                {locationLat && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <MapPin size={13} className="text-zinc-500 dark:text-zinc-400" />
                  </div>
                )}
              </div>
              {showLocationResults && locationResults.length > 0 && (
                <>
                  <div className="fixed inset-0 z-[99]" onClick={() => setShowLocationResults(false)} />
                  <div className="absolute left-0 right-0 top-full mt-1 z-[100] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg overflow-hidden max-h-[240px] overflow-y-auto">
                    {locationResults.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setLocationName(r.name)
                          setLocationLat(r.lat)
                          setLocationLng(r.lng)
                          setLocationQuery('')
                          setShowLocationResults(false)
                          setLocationResults([])
                        }}
                        className="w-full text-left px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 flex items-start gap-2.5 border-b border-zinc-100 dark:border-zinc-700 last:border-0"
                      >
                        <MapPin size={13} className="text-zinc-400 flex-shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-zinc-900 dark:text-white truncate">{r.name}</div>
                          {r.address && <div className="text-[11px] text-zinc-500 truncate">{r.address}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {locationSearching && (
                <div className="absolute left-0 right-0 top-full mt-1 z-[100] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg px-3 py-3 text-center text-[12px] text-zinc-400">
                  {t('journey.editor.searching')}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.editor.mood')}</label>
            <div className="flex gap-2">
              {Object.entries(MOOD_CONFIG).map(([key, config]) => {
                const Icon = config.icon
                const active = mood === key
                return (
                  <button key={key} onClick={() => setMood(active ? '' : key)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all ${
                      active ? '' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'
                    }`}
                    style={active ? { background: config.bg, color: config.text, borderColor: config.text + '30' } : undefined}>
                    <Icon size={12} />
                    {t(config.label)}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.editor.weather')}</label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(WEATHER_CONFIG).map(([key, config]) => {
                const Icon = config.icon
                const active = weather === key
                return (
                  <button key={key} onClick={() => setWeather(active ? '' : key)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-all ${
                      active ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400'
                    }`}>
                    <Icon size={12} />
                    {t(config.label)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>


        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))' }}>
          <button onClick={handleClose} className="px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700">{t('common.cancel')}</button>
          <button onClick={handleSave} disabled={saving} className="px-3.5 py-2 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-50">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}

// ── Add Trip Dialog ──────────────────────────────────────────────────────

function AddTripDialog({ journeyId, existingTripIds, onClose, onAdded }: {
  journeyId: number
  existingTripIds: number[]
  onClose: () => void
  onAdded: () => void
}) {
  const { t } = useTranslation()
  const [trips, setTrips] = useState<{ id: number; title: string; destination?: string; start_date?: string; end_date?: string }[]>([])
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<number | null>(null)
  const toast = useToast()

  useEffect(() => {
    journeyApi.availableTrips().then(d => setTrips(d.trips || [])).catch(() => {})
  }, [])

  const filtered = trips.filter(trip => {
    if (existingTripIds.includes(trip.id)) return false
    if (!search) return true
    const q = search.toLowerCase()
    return trip.title.toLowerCase().includes(q) || (trip.destination || '').toLowerCase().includes(q)
  })

  const handleAdd = async (tripId: number) => {
    setAdding(tripId)
    try {
      await journeyApi.addTrip(journeyId, tripId)
      toast.success(t('journey.trips.tripLinked'))
      onAdded()
    } catch {
      toast.error(t('journey.trips.linkFailed'))
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-5" style={{ background: 'rgba(9,9,11,0.75)' }}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] max-w-[420px] w-full flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">{t('journey.trips.linkTrip')}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.trips.searchTrip')}</label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('journey.trips.searchPlaceholder')}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[13px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none focus:border-zinc-400 dark:focus:border-zinc-500"
            />
          </div>

          <div className="max-h-[280px] overflow-y-auto flex flex-col gap-1">
            {filtered.length === 0 && (
              <p className="text-[12px] text-zinc-400 text-center py-4">{t('journey.trips.noTripsAvailable')}</p>
            )}
            {filtered.map(trip => (
              <div
                key={trip.id}
                className="flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 border border-transparent"
              >
                <div className="w-9 h-9 rounded-md flex-shrink-0" style={{ background: pickGradient(trip.id) }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900 dark:text-white truncate">{trip.title}</div>
                  {(trip.destination || trip.start_date) && (
                    <div className="text-[11px] text-zinc-500 truncate">
                      {trip.destination}{trip.destination && trip.start_date ? ' · ' : ''}{trip.start_date}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleAdd(trip.id)}
                  disabled={adding === trip.id}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200 disabled:opacity-50"
                >
                  {adding === trip.id ? '...' : t('journey.trips.link')}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Contributor Invite Dialog ─────────────────────────────────────────────

function ContributorInviteDialog({ journeyId, existingUserIds, onClose, onInvited }: {
  journeyId: number
  existingUserIds: number[]
  onClose: () => void
  onInvited: () => void
}) {
  const { t } = useTranslation()
  const [users, setUsers] = useState<{ id: number; username: string; email: string; avatar?: string | null }[]>([])
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer')
  const [sending, setSending] = useState(false)
  const toast = useToast()

  useEffect(() => {
    authApi.listUsers().then(d => setUsers(d.users || [])).catch(() => {})
  }, [])

  const filtered = users.filter(u => {
    if (existingUserIds.includes(u.id)) return false
    if (!search) return true
    const q = search.toLowerCase()
    return u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  const handleInvite = async () => {
    if (!selectedUserId) return
    setSending(true)
    try {
      await journeyApi.addContributor(journeyId, selectedUserId, role)
      toast.success(t('journey.contributors.added'))
      onInvited()
    } catch {
      toast.error(t('journey.contributors.addFailed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-5" style={{ background: 'rgba(9,9,11,0.75)' }}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] max-w-[420px] w-full flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">{t('journey.contributors.invite')}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 flex flex-col gap-4">
          {/* Search */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.contributors.searchUser')}</label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('journey.contributors.searchPlaceholder')}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[13px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none focus:border-zinc-400 dark:focus:border-zinc-500"
            />
          </div>

          {/* User list */}
          <div className="max-h-[200px] overflow-y-auto flex flex-col gap-1">
            {filtered.length === 0 && (
              <p className="text-[12px] text-zinc-400 text-center py-4">{t('journey.contributors.noUsers')}</p>
            )}
            {filtered.map(u => (
              <div
                key={u.id}
                onClick={() => setSelectedUserId(u.id)}
                className={`flex items-center gap-2.5 p-2.5 rounded-lg cursor-pointer transition-all ${
                  selectedUserId === u.id
                    ? 'bg-zinc-100 dark:bg-zinc-800 border border-zinc-900 dark:border-white'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 border border-transparent'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 flex items-center justify-center text-[12px] font-semibold">
                  {u.username[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-zinc-900 dark:text-white">{u.username}</div>
                  <div className="text-[11px] text-zinc-500 truncate">{u.email}</div>
                </div>
                {selectedUserId === u.id && (
                  <div className="w-5 h-5 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center">
                    <Check size={12} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Role selector */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.invite.role')}</label>
            <div className="flex gap-2">
              {(['viewer', 'editor'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`flex-1 py-2 rounded-lg text-[12px] font-medium border transition-all ${
                    role === r
                      ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400'
                  }`}
                >
                  {t(`journey.invite.${r}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700">
            {t('common.cancel')}
          </button>
          <button
            onClick={handleInvite}
            disabled={!selectedUserId || sending}
            className="px-3.5 py-2 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? t('journey.invite.inviting') : t('journey.invite.invite')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Journey Settings Dialog ───────────────────────────────────────────────

// ── Journey Share Section ─────────────────────────────────────────────────

function JourneyShareSection({ journeyId }: { journeyId: number }) {
  const { t } = useTranslation()
  const [link, setLink] = useState<{ token: string; share_timeline: boolean; share_gallery: boolean; share_map: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const toast = useToast()

  useEffect(() => {
    journeyApi.getShareLink(journeyId).then(d => setLink(d.link || null)).catch(() => {}).finally(() => setLoading(false))
  }, [journeyId])

  const createLink = async () => {
    try {
      const res = await journeyApi.createShareLink(journeyId, { share_timeline: true, share_gallery: true, share_map: true })
      setLink({ token: res.token, share_timeline: true, share_gallery: true, share_map: true })
      toast.success(t('journey.share.linkCreated'))
    } catch { toast.error(t('journey.share.createFailed')) }
  }

  const togglePerm = async (key: 'share_timeline' | 'share_gallery' | 'share_map') => {
    if (!link) return
    const updated = { ...link, [key]: !link[key] }
    setLink(updated)
    try {
      await journeyApi.createShareLink(journeyId, { share_timeline: updated.share_timeline, share_gallery: updated.share_gallery, share_map: updated.share_map })
    } catch { setLink(link); toast.error(t('journey.share.updateFailed')) }
  }

  const deleteLink = async () => {
    try {
      await journeyApi.deleteShareLink(journeyId)
      setLink(null)
      toast.success(t('journey.share.linkDeleted'))
    } catch { toast.error(t('journey.share.deleteFailed')) }
  }

  const shareUrl = link ? `${window.location.origin}/public/journey/${link.token}` : ''

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) return null

  return (
    <div>
      <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.share.publicShare')}</label>

      {!link ? (
        <button
          onClick={createLink}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-[12px] font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:hover:border-zinc-500 dark:hover:text-zinc-300 transition-colors"
        >
          <Link size={14} /> {t('journey.share.createLink')}
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          {/* URL + Copy */}
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
            <Link size={13} className="text-zinc-400 flex-shrink-0" />
            <span className="flex-1 text-[11px] text-zinc-600 dark:text-zinc-400 truncate">{shareUrl}</span>
            <button
              onClick={copyLink}
              className="flex-shrink-0 px-2.5 py-1 rounded-md bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[11px] font-medium hover:bg-zinc-700 dark:hover:bg-zinc-200"
            >
              {copied ? t('journey.share.copied') : t('journey.share.copy')}
            </button>
          </div>

          {/* Permission toggles */}
          <div className="flex flex-col gap-1.5">
            {[
              { key: 'share_timeline' as const, label: t('journey.share.timeline'), icon: List },
              { key: 'share_gallery' as const, label: t('journey.share.gallery'), icon: Grid },
              { key: 'share_map' as const, label: t('journey.share.map'), icon: MapPin },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => togglePerm(key)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-[12px] font-medium transition-all ${
                  link[key]
                    ? 'border-zinc-900 dark:border-white bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-zinc-400'
                }`}
              >
                <Icon size={13} />
                {label}
                {link[key] && <Check size={12} className="ml-auto" />}
              </button>
            ))}
          </div>

          {/* Delete link */}
          <button
            onClick={deleteLink}
            className="text-[11px] font-medium text-red-500 hover:text-red-600 self-start"
          >
            {t('share.deleteLink')}
          </button>
        </div>
      )}
    </div>
  )
}

function JourneySettingsDialog({ journey, onClose, onSaved, onOpenInvite, onRefresh }: {
  journey: JourneyDetail
  onClose: () => void
  onSaved: () => void
  onOpenInvite: () => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(journey.title)
  const [subtitle, setSubtitle] = useState(journey.subtitle || '')
  const [saving, setSaving] = useState(false)
  const [showAddTrip, setShowAddTrip] = useState(false)
  const [unlinkTarget, setUnlinkTarget] = useState<{ trip_id: number; title: string } | null>(null)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)

  const isDirty = title !== journey.title || subtitle !== (journey.subtitle || '')
  const handleClose = () => { if (isDirty) setShowDiscardConfirm(true); else onClose() }
  const coverRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const navigate = useNavigate()
  const { updateJourney, deleteJourney } = useJourneyStore()

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateJourney(journey.id, { title, subtitle: subtitle || null })
      onSaved()
    } catch {
      toast.error(t('journey.settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('cover', file)
    try {
      await journeyApi.uploadCover(journey.id, formData)
      toast.success(t('journey.settings.coverUpdated'))
      onSaved()
    } catch {
      toast.error(t('journey.settings.coverFailed'))
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const handleArchiveToggle = async () => {
    setArchiving(true)
    try {
      const newStatus = journey.status === 'archived' ? 'active' : 'archived'
      await updateJourney(journey.id, { status: newStatus })
      toast.success(newStatus === 'archived' ? t('journey.settings.archived') : t('journey.settings.reopened'))
      onSaved()
    } catch {
      toast.error(t('journey.settings.saveFailed'))
    } finally {
      setArchiving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteJourney(journey.id)
      navigate('/journey')
    } catch {
      toast.error(t('journey.settings.failedToDelete'))
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center md:p-5 overscroll-none" style={{ background: 'rgba(9,9,11,0.75)' }} onClick={handleClose} onTouchMove={e => { if (e.target === e.currentTarget) e.preventDefault() }}>
      <div className="bg-white dark:bg-zinc-900 rounded-t-2xl md:rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] max-w-[480px] w-full max-h-[85vh] md:max-h-[90vh] flex flex-col overflow-hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-[16px] font-bold text-zinc-900 dark:text-white">{t('journey.settings.title')}</h2>
          <button onClick={handleClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5 flex flex-col gap-5">
          {/* Cover Image */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.settings.coverImage')}</label>
            <input ref={coverRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" />
            <button
              onClick={() => coverRef.current?.click()}
              className="w-full h-28 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 flex items-center justify-center gap-2 text-[12px] text-zinc-500 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 overflow-hidden relative"
            >
              {journey.cover_image ? (
                <>
                  <img src={`/uploads/${journey.cover_image}`} className="absolute inset-0 w-full h-full object-cover opacity-50" alt="" />
                  <span className="relative z-10 flex items-center gap-1.5"><ImagePlus size={14} /> {t('journey.settings.changeCover')}</span>
                </>
              ) : (
                <span className="flex items-center gap-1.5"><ImagePlus size={14} /> {t('journey.settings.addCover')}</span>
              )}
            </button>
          </div>

          {/* Title */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.settings.name')}</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[14px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none focus:border-zinc-400"
            />
          </div>

          {/* Subtitle */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-1.5">{t('journey.settings.subtitle')}</label>
            <input
              value={subtitle}
              onChange={e => setSubtitle(e.target.value)}
              placeholder={t('journey.settings.subtitlePlaceholder')}
              className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[14px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white outline-none focus:border-zinc-400"
            />
          </div>

          <div className="h-px bg-zinc-200 dark:bg-zinc-700" />

          {/* Synced Trips */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.detail.syncedTrips')}</label>
            <div className="flex flex-col gap-1.5">
              {journey.trips.map((trip: any) => (
                <div key={trip.trip_id} className="flex items-center gap-2.5 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800">
                  <div className="w-8 h-8 rounded-md flex-shrink-0" style={{ background: pickGradient(trip.trip_id) }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-zinc-900 dark:text-white">{trip.title}</div>
                    <div className="text-[10px] text-zinc-500">{trip.place_count || 0} {t('journey.synced.places')}</div>
                  </div>
                  <button
                    onClick={() => setUnlinkTarget({ trip_id: trip.trip_id, title: trip.title })}
                    className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center bg-red-500/10 text-red-500 hover:bg-red-500/20 dark:bg-red-500/15 dark:hover:bg-red-500/25 transition-colors"
                    title="Unlink trip"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {journey.trips.length === 0 && <p className="text-[11px] text-zinc-400">{t('journey.trips.noTripsLinkedSettings')}</p>}
              <button
                onClick={() => setShowAddTrip(true)}
                className="w-full mt-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-[12px] font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:hover:border-zinc-500 dark:hover:text-zinc-300 transition-colors"
              >
                <Plus size={14} /> {t('journey.trips.addTrip')}
              </button>
            </div>
          </div>

          {/* Contributors */}
          <div>
            <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2">{t('journey.detail.contributors')}</label>
            <div className="flex flex-col gap-2">
              {journey.contributors.map((c: any) => (
                <div key={c.user_id} className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center text-[11px] font-semibold">
                    {(c.username || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 text-[12px] font-medium text-zinc-900 dark:text-white">{c.username}</div>
                  <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${c.role === 'owner' ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'}`}>{c.role}</span>
                  {c.role !== 'owner' && (
                    <button
                      onClick={async () => {
                        if (!window.confirm(t('journey.contributors.removeConfirm', { username: c.username }))) return
                        try {
                          await journeyApi.removeContributor(journey.id, c.user_id)
                          toast.success(t('journey.contributors.removed'))
                          onRefresh()
                        } catch {
                          toast.error(t('journey.contributors.removeFailed'))
                        }
                      }}
                      aria-label={t('journey.contributors.remove')}
                      title={t('journey.contributors.remove')}
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={onOpenInvite}
                className="w-full mt-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-[12px] font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:hover:border-zinc-500 dark:hover:text-zinc-300 transition-colors"
              >
                <UserPlus size={14} /> {t('journey.contributors.invite')}
              </button>
            </div>
          </div>

          <div className="h-px bg-zinc-200 dark:bg-zinc-700" />

          {/* Public Share */}
          <JourneyShareSection journeyId={journey.id} />

        </div>

        {/* Footer */}
        <div className="flex items-center gap-1.5 px-4 md:px-6 py-4 pb-6 md:pb-4 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
          <button
            onClick={() => setShowDeleteConfirm(true)}
            aria-label={t('journey.settings.delete')}
            title={t('journey.settings.delete')}
            className="flex items-center justify-center gap-1.5 h-9 min-w-9 px-2 md:px-2.5 text-[12px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
          >
            <Trash2 size={14} />
            <span className="hidden md:inline">{t('journey.settings.delete')}</span>
          </button>
          <button
            onClick={handleArchiveToggle}
            disabled={archiving}
            aria-label={journey.status === 'archived' ? t('journey.settings.reopenJourney') : t('journey.settings.endJourney')}
            title={t('journey.settings.endDescription')}
            className="flex items-center justify-center gap-1.5 h-9 min-w-9 px-2 md:px-2.5 text-[12px] font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded-lg mr-auto disabled:opacity-40"
          >
            {journey.status === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            <span className="hidden md:inline">{journey.status === 'archived' ? t('journey.settings.reopenJourney') : t('journey.settings.endJourney')}</span>
          </button>
          <button onClick={handleClose} className="h-9 px-3.5 rounded-lg border border-zinc-200 dark:border-zinc-600 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700">{t('common.cancel')}</button>
          <button onClick={handleSave} disabled={saving || !title.trim()} className="h-9 px-3.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-40">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {/* Unlink Trip confirm */}
      <ConfirmDialog
        isOpen={!!unlinkTarget}
        onClose={() => setUnlinkTarget(null)}
        onConfirm={async () => {
          if (!unlinkTarget) return
          try {
            await journeyApi.removeTrip(journey.id, unlinkTarget.trip_id)
            toast.success(t('journey.trips.tripUnlinked'))
            setUnlinkTarget(null)
            onSaved()
          } catch {
            toast.error(t('journey.trips.unlinkFailed'))
          }
        }}
        title={t('journey.trips.unlinkTrip')}
        message={t('journey.trips.unlinkMessage', { title: unlinkTarget?.title })}
        confirmLabel={t('journey.trips.unlink')}
        danger
      />

      {/* Add Trip */}
      {showAddTrip && (
        <AddTripDialog
          journeyId={journey.id}
          existingTripIds={journey.trips.map((t: any) => t.trip_id)}
          onClose={() => setShowAddTrip(false)}
          onAdded={() => { setShowAddTrip(false); onSaved() }}
        />
      )}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('journey.settings.deleteJourney')}
        message={t('journey.settings.deleteMessage', { title: journey.title })}
        confirmLabel={t('common.delete')}
        danger
      />

      <ConfirmDialog
        isOpen={showDiscardConfirm}
        onClose={() => setShowDiscardConfirm(false)}
        onConfirm={() => { setShowDiscardConfirm(false); onClose() }}
        title={t('common.discardChanges')}
        message={t('journey.editor.discardChangesConfirm')}
        confirmLabel={t('common.discard')}
        danger
      />
    </div>
  )
}
