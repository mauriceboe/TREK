import { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useJourneyStore } from '../store/journeyStore'
import { journeyApi } from '../api/client'
import Navbar from '../components/Layout/Navbar'
import { useToast } from '../components/shared/Toast'
import { useTranslation } from '../i18n'
import {
  Plus, Search, Sparkles, Calendar, MapPin, BookOpen, Camera,
  Check, X, ChevronRight, RefreshCw, Users,
} from 'lucide-react'
import type { Journey } from '../store/journeyStore'
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

function timeAgo(timestamp: number, t: (k: string, p?: any) => string): string {
  const diff = Date.now() - timestamp
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return t('common.justNow')
  if (hours < 24) return t('common.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('common.daysAgo', { count: days })
}

export default function JourneyPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { t } = useTranslation()
  const { journeys, loading, loadJourneys, createJourney } = useJourneyStore()

  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [availableTrips, setAvailableTrips] = useState<any[]>([])
  const [selectedTripIds, setSelectedTripIds] = useState<Set<number>>(new Set())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // suggestion
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<number>>(new Set())

  useEffect(() => {
    loadJourneys()
    journeyApi.suggestions().then(d => setSuggestions(d.trips || [])).catch(() => {})
  }, [])

  const activeSuggestion = suggestions.find(s => !dismissedSuggestions.has(s.id))

  const activeJourney = useMemo(() => {
    if (searchQuery.trim()) return null
    return journeys.find(j => {
      const j2 = j as any
      return computeJourneyLifecycle(j.status, j2.trip_date_min, j2.trip_date_max) === 'live'
    }) || null
  }, [journeys, searchQuery])

  const filteredJourneys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return journeys.filter(j => j.id !== activeJourney?.id)
    return journeys.filter(j => {
      const inTitle = j.title.toLowerCase().includes(q)
      const inSubtitle = j.subtitle?.toLowerCase().includes(q) ?? false
      return inTitle || inSubtitle
    })
  }, [journeys, activeJourney, searchQuery])

  const openCreateModal = async (preSelectedTripId?: number) => {
    setShowCreate(true)
    setNewTitle('')
    const initial = new Set<number>()
    if (preSelectedTripId) initial.add(preSelectedTripId)
    setSelectedTripIds(initial)
    try {
      const data = await journeyApi.availableTrips()
      setAvailableTrips(data.trips || [])
    } catch {}
  }

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    try {
      const j = await createJourney({
        title: newTitle.trim(),
        trip_ids: [...selectedTripIds],
      })
      setShowCreate(false)
      navigate(`/journey/${j.id}`)
    } catch {
      toast.error(t('journey.createError'))
    }
  }

  const totalPlaces = useMemo(() => {
    return availableTrips.filter(t => selectedTripIds.has(t.id)).reduce((sum: number, t: any) => sum + (t.place_count || 0), 0)
  }, [availableTrips, selectedTripIds])

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Navbar />
      <div style={{ paddingTop: 'var(--nav-h, 56px)' }}>
        <div className="max-w-[1440px] mx-auto">

          {/* Header — mobile */}
          <div className="md:hidden px-5 pt-5 pb-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false)
                    setSearchQuery('')
                  } else {
                    setSearchOpen(true)
                    setTimeout(() => searchInputRef.current?.focus(), 50)
                  }
                }}
                className="w-10 h-10 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-700 flex-shrink-0"
              >
                {searchOpen ? <X size={15} /> : <Search size={15} />}
              </button>
              <button
                onClick={() => openCreateModal()}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[14px] font-semibold active:scale-[0.98] transition-transform"
              >
                <Plus size={16} strokeWidth={2.5} />
                {t('journey.frontpage.createJourney')}
              </button>
            </div>
            {searchOpen && (
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false) } }}
                placeholder={t('journey.search.placeholder')}
                className="w-full px-3.5 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl text-[14px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white focus:border-zinc-400 focus:outline-none"
              />
            )}
          </div>

          {/* Header — desktop (unified toolbar) */}
          <div className="hidden md:block px-8 pt-10 pb-7">
            <div style={{
              background: 'var(--bg-tertiary)', borderRadius: 18,
              border: '1px solid var(--border-primary)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
              padding: '14px 16px 14px 22px',
              display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
            }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', flexShrink: 0 }}>
                {t('journey.title')}
              </h2>
              <div style={{ width: 1, height: 22, background: 'var(--border-faint)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {t('journey.frontpage.subtitle')}
              </span>

              <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexShrink: 0 }}>
                {searchOpen && (
                  <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false) } }}
                    placeholder={t('journey.search.placeholder')}
                    autoFocus
                    className="w-52 px-3 py-2 rounded-[10px] text-[13px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white focus:outline-none"
                    style={{ border: '1px solid var(--border-primary)' }}
                  />
                )}
                <button
                  onClick={() => {
                    setSearchOpen(s => !s)
                    if (searchOpen) setSearchQuery('')
                  }}
                  title={t('journey.search.placeholder')}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '7px 11px', borderRadius: 99,
                    background: searchOpen ? 'var(--bg-card)' : 'transparent',
                    color: searchOpen ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: searchOpen ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={e => { if (!searchOpen) { e.currentTarget.style.background = 'var(--bg-card)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
                  onMouseLeave={e => { if (!searchOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' } }}
                >
                  {searchOpen ? <X size={15} /> : <Search size={15} />}
                </button>
                <button
                  onClick={() => openCreateModal()}
                  style={{
                    appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                    background: 'var(--accent)', color: 'var(--accent-text)', flexShrink: 0,
                    marginLeft: 2,
                    transition: 'opacity 0.15s ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <Plus size={14} strokeWidth={2.5} />
                  {t('journey.frontpage.createJourney')}
                </button>
              </div>
            </div>
          </div>

          <div className="px-4 md:px-8 pb-16">

            {/* Suggestion banner */}
            {activeSuggestion && (
              <div className="relative rounded-2xl overflow-hidden mb-8" style={{ background: 'linear-gradient(135deg, #1E293B 0%, #334155 100%)' }}>
                <div className="absolute inset-0 pointer-events-none hidden md:block" style={{ background: 'radial-gradient(circle at 85% 50%, rgba(99,102,241,0.4), transparent 50%), radial-gradient(circle at 100% 100%, rgba(236,72,153,0.3), transparent 50%)' }} />
                <div className="absolute inset-0 pointer-events-none md:hidden" style={{ background: 'radial-gradient(circle at 80% 20%, rgba(99,102,241,0.5), transparent 60%), radial-gradient(circle at 20% 90%, rgba(236,72,153,0.35), transparent 60%)' }} />
                <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-6 p-5 text-white">
                  <div className="flex items-center gap-3.5">
                    <div className="w-10 h-10 rounded-[10px] bg-white/15 backdrop-blur flex items-center justify-center flex-shrink-0">
                      <Sparkles size={18} />
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold tracking-[0.12em] uppercase opacity-70">{t("journey.frontpage.suggestionLabel")}</div>
                      <div className="text-[13px] mt-0.5">
                        <span dangerouslySetInnerHTML={{ __html: t('journey.frontpage.suggestionText', { title: activeSuggestion.title }) }} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => setDismissedSuggestions(prev => new Set([...prev, activeSuggestion.id]))}
                      className="px-3 py-1.5 rounded-lg bg-white/10 border border-white/20 text-[12px] font-medium text-white hover:bg-white/20"
                    >
                      {t('journey.frontpage.dismiss')}
                    </button>
                    <button
                      onClick={() => openCreateModal(activeSuggestion.id)}
                      className="px-3 py-1.5 rounded-lg !bg-white !text-zinc-900 text-[12px] font-medium hover:!bg-zinc-100"
                    >
                      {t('journey.frontpage.createJourney')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Active Journey Hero */}
            {activeJourney && (
              <div className="mb-10">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-bold tracking-[0.14em] uppercase text-zinc-500">{t("journey.frontpage.activeJourney")}</span>
                  <span className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {t('journey.frontpage.updated', { time: timeAgo(activeJourney.updated_at, t) })}
                  </span>
                </div>

                <div
                  onClick={() => navigate(`/journey/${activeJourney.id}`)}
                  className="relative rounded-3xl overflow-hidden cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:shadow-xl h-[340px] md:h-[400px]"
                  style={{ background: pickGradient(activeJourney.id) }}
                >
                  {/* Cover image */}
                  {activeJourney.cover_image && (
                    <div className="absolute inset-0 z-[1]">
                      <img src={`/uploads/${activeJourney.cover_image}`} className="w-full h-full object-cover" alt="" />
                      <div className="absolute inset-0" style={{ background: pickGradient(activeJourney.id), opacity: 0.45 }} />
                    </div>
                  )}

                  {/* Gradient overlays */}
                  <div className="absolute inset-0 pointer-events-none z-[2]" style={{ background: 'radial-gradient(circle at 15% 20%, rgba(236,72,153,0.35), transparent 40%), radial-gradient(circle at 85% 80%, rgba(251,146,60,0.3), transparent 45%), radial-gradient(circle at 50% 50%, rgba(99,102,241,0.25), transparent 50%)' }} />
                  <div className="absolute inset-0 pointer-events-none z-[2]" style={{ background: 'linear-gradient(180deg, transparent 0%, transparent 50%, rgba(0,0,0,0.4) 100%), linear-gradient(90deg, rgba(0,0,0,0.15) 0%, transparent 50%)' }} />

                  <div className="relative h-full p-6 md:p-8 flex flex-col z-[3] text-white">
                    {/* Top badges */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/12 backdrop-blur-sm border border-white/15 rounded-full text-[10px] font-semibold uppercase tracking-[0.08em]">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)] animate-pulse" />
                          {t('journey.frontpage.live')}
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/12 backdrop-blur-sm border border-white/15 rounded-full text-[10px] font-medium">
                          <RefreshCw size={10} />
                          {t('journey.frontpage.synced')}
                        </span>
                      </div>
                    </div>

                    {/* Middle — title */}
                    <div className="flex-1 flex flex-col justify-center py-4">
                      {activeJourney.subtitle && (
                        <p className="text-[13px] font-medium opacity-85 mb-3">{activeJourney.subtitle}</p>
                      )}
                      <h2 className="text-[40px] md:text-[56px] font-extrabold tracking-[-0.035em] leading-[0.95] mb-3" style={{ textShadow: '0 2px 30px rgba(0,0,0,0.15)' }}>
                        {activeJourney.title}
                      </h2>
                    </div>

                    {/* Bottom stats */}
                    <div className="flex items-end justify-between gap-6">
                      <div className="flex gap-7">
                        {[
                          { val: (activeJourney as any).entry_count ?? '--', label: t("journey.stats.entries") },
                          { val: (activeJourney as any).photo_count ?? '--', label: t("journey.stats.photos") },
                          { val: (activeJourney as any).place_count ?? '--', label: t("journey.stats.places") },
                        ].map(s => (
                          <div key={s.label} className="flex flex-col gap-1">
                            <span className="text-[28px] font-extrabold tracking-[-0.02em] leading-none">{s.val}</span>
                            <span className="text-[10px] uppercase tracking-[0.12em] opacity-70 font-semibold">{s.label}</span>
                          </div>
                        ))}
                      </div>
                      <span className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/15 backdrop-blur-sm rounded-full text-[11px] font-medium">
                        {t('journey.frontpage.continueWriting')}<ChevronRight size={12} />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Search results info */}
            {searchQuery.trim() && (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-[13px] text-zinc-500">
                  {filteredJourneys.length === 0
                    ? t('journey.search.noResults', { query: searchQuery.trim() })
                    : `${filteredJourneys.length} ${t('journey.frontpage.journeys')}`}
                </span>
              </div>
            )}

            {/* All Journeys */}
            {!searchQuery.trim() && (
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-[0.14em] uppercase text-zinc-500">{t("journey.frontpage.allJourneys")}</span>
                <span className="text-[11px] text-zinc-400">{journeys.length} {t('journey.frontpage.journeys')}</span>
              </div>
            )}

            {loading && journeys.length === 0 ? (
              <div className="flex justify-center py-16">
                <div className="w-6 h-6 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-[18px]">
                {filteredJourneys.map(j => (
                  <JourneyCard key={j.id} journey={j} onClick={() => navigate(`/journey/${j.id}`)} />
                ))}

                {/* Create card */}
                <button
                  onClick={() => openCreateModal()}
                  className="group min-h-[320px] rounded-2xl border-[1.5px] border-dashed border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex flex-col items-center justify-center gap-2.5 hover:border-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all cursor-pointer hover:-translate-y-0.5"
                >
                  <div className="w-14 h-14 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 group-hover:bg-white dark:group-hover:bg-zinc-700 transition-all group-hover:rotate-90 duration-300">
                    <Plus size={22} />
                  </div>
                  <span className="text-[14px] font-semibold text-zinc-700 dark:text-zinc-300">{t("journey.frontpage.createNew")}</span>
                  <span className="text-[12px] text-zinc-400 max-w-[180px] text-center leading-snug">{t("journey.frontpage.createNewSub")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-5" style={{ background: 'rgba(9,9,11,0.6)', backdropFilter: 'blur(6px)' }}>
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-[0_20px_40px_rgba(0,0,0,0.2)] max-w-[640px] w-full max-h-[90vh] flex flex-col overflow-hidden" style={{ paddingBottom: 'var(--bottom-nav-h)' }}>

            {/* Header */}
            <div className="px-7 pt-6 pb-5 border-b border-zinc-200 dark:border-zinc-700">
              <h2 className="text-[18px] font-bold tracking-[-0.01em] text-zinc-900 dark:text-white">{t("journey.frontpage.createJourney")}</h2>
              <p className="text-[13px] text-zinc-500 mt-1">{t('journey.frontpage.createNewSub')}</p>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-7 py-5">
              <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2.5">{t('journey.frontpage.journeyName')}</label>
              <input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder={t('journey.frontpage.namePlaceholder')}
                className="w-full px-3.5 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-lg text-[14px] bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-zinc-400 focus:outline-none mb-5"
              />

              <label className="text-[10px] font-semibold tracking-[0.12em] uppercase text-zinc-500 block mb-2.5">{t('journey.frontpage.selectTrips')}</label>
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto">
                {availableTrips.map(trip => {
                  const selected = selectedTripIds.has(trip.id)
                  const status = trip.end_date && trip.end_date < new Date().toISOString().split('T')[0]
                    ? 'completed'
                    : trip.start_date && trip.start_date <= new Date().toISOString().split('T')[0]
                      ? 'active'
                      : 'upcoming'
                  const statusColors: Record<string, string> = {
                    completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
                    active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
                    upcoming: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
                  }

                  return (
                    <div
                      key={trip.id}
                      onClick={() => {
                        setSelectedTripIds(prev => {
                          const next = new Set(prev)
                          if (next.has(trip.id)) next.delete(trip.id)
                          else next.add(trip.id)
                          return next
                        })
                      }}
                      className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                        selected
                          ? 'border-zinc-900 dark:border-zinc-400 bg-zinc-50 dark:bg-zinc-800'
                          : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 ${
                        selected
                          ? 'bg-zinc-900 dark:bg-white border-zinc-900 dark:border-white'
                          : 'border-zinc-300 dark:border-zinc-600'
                      }`}>
                        {selected && <Check size={12} className="text-white dark:text-zinc-900" />}
                      </div>
                      <div className="w-12 h-12 rounded-lg flex-shrink-0 overflow-hidden" style={{ background: pickGradient(trip.id) }}>
                        {trip.cover_image && (
                          <img src={trip.cover_image} className="w-full h-full object-cover" alt="" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-semibold text-zinc-900 dark:text-white">{trip.title}</div>
                        <div className="text-[12px] text-zinc-500 flex items-center gap-2.5 mt-0.5">
                          <span className="flex items-center gap-1"><Calendar size={11} /> {trip.start_date ? Math.ceil((new Date(trip.end_date || trip.start_date).getTime() - new Date(trip.start_date).getTime()) / 86400000) + 1 : '?'}<span className="hidden md:inline"> {t('journey.stats.days').toLowerCase()}</span></span>
                          <span className="flex items-center gap-1"><MapPin size={11} /> {trip.place_count || 0}<span className="hidden md:inline"> {t("journey.frontpage.places")}</span></span>
                        </div>
                      </div>
                      <span className={`text-[10px] font-medium uppercase tracking-[0.05em] px-2 py-0.5 rounded-full ${statusColors[status]}`}>
                        {t(`journey.status.${status}`)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="px-7 py-4 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 flex items-center justify-between">
              <div className="text-[12px] text-zinc-500">
                <strong className="text-zinc-900 dark:text-white">{selectedTripIds.size}</strong> <span className="hidden md:inline">{t('journey.frontpage.tripsSelected')}</span><span className="md:hidden">{t('journey.frontpage.trips')}</span>
                {selectedTripIds.size > 0 && <> · <strong className="text-zinc-900 dark:text-white">{totalPlaces}</strong> <span className="hidden md:inline">{t('journey.frontpage.placesImported')}</span><span className="md:hidden">{t('journey.frontpage.places')}</span></>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!newTitle.trim()}
                  className="px-3.5 py-2 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="md:hidden">{t('journey.create')}</span><span className="hidden md:inline">{t('journey.frontpage.createJourney')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function JourneyCard({ journey, onClick }: { journey: Journey & { entry_count?: number; photo_count?: number; place_count?: number; trip_date_min?: string | null; trip_date_max?: string | null }; onClick: () => void }) {
  const { t } = useTranslation()
  const j = journey
  const entryCount = j.entry_count ?? 0
  const photoCount = j.photo_count ?? 0
  const placeCount = j.place_count ?? 0
  const lifecycle = computeJourneyLifecycle(j.status, j.trip_date_min, j.trip_date_max)

  return (
    <div
      onClick={onClick}
      className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden cursor-pointer transition-all duration-250 hover:border-zinc-400 hover:-translate-y-1 hover:shadow-[0_20px_40px_rgba(0,0,0,0.06)] flex flex-col"
    >
      {/* Cover */}
      <div className="h-[170px] relative overflow-hidden" style={{ background: pickGradient(j.id) }}>
        {j.cover_image && (
          <>
            <img src={`/uploads/${j.cover_image}`} className="absolute inset-0 w-full h-full object-cover" alt="" />
            <div className="absolute inset-0" style={{ background: pickGradient(j.id), opacity: 0.4 }} />
          </>
        )}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.4) 100%)' }} />

        {/* Top overlay */}
        <div className="absolute top-3.5 left-3.5 right-3.5 flex items-start justify-between z-[2]">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-black/45 backdrop-blur-sm rounded-full text-white text-[10px] font-semibold tracking-wide">
            <Calendar size={10} />
            {new Date(j.created_at).getFullYear()}
          </span>
        </div>

      </div>

      {/* Body */}
      <div className="px-[18px] pt-4 pb-[18px] flex flex-col flex-1">
        <h3 className="text-[16px] font-bold tracking-[-0.01em] text-zinc-900 dark:text-white">{j.title}</h3>
        {j.subtitle && (
          <p className="text-[12px] text-zinc-500 mt-1">{j.subtitle}</p>
        )}
        {lifecycle !== 'live' && (
          <span className={`inline-flex self-start mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${
            lifecycle === 'archived' ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500' :
            lifecycle === 'upcoming' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' :
            lifecycle === 'completed' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' :
            'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
          }`}>
            {t(`journey.status.${lifecycle}`)}
          </span>
        )}

        <div className="grid grid-cols-3 gap-2.5 mt-auto pt-3.5 border-t border-zinc-100 dark:border-zinc-800" style={{ marginTop: j.subtitle ? 14 : 'auto' }}>
          {[
            { val: entryCount, label: t('journey.stats.entries') },
            { val: photoCount, label: t('journey.stats.photos') },
            { val: placeCount, label: t('journey.stats.places') },
          ].map(s => (
            <div key={s.label} className="flex flex-col gap-1">
              <span className={`text-[16px] font-bold leading-none tracking-[-0.01em] ${s.val > 0 ? 'text-zinc-900 dark:text-white' : 'text-zinc-300 dark:text-zinc-600'}`}>
                {s.val > 0 ? s.val : '--'}
              </span>
              <span className="text-[9px] uppercase tracking-[0.06em] text-zinc-500 font-medium">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
