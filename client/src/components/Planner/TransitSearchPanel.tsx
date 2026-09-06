import React, { useEffect, useMemo, useRef, useState } from 'react'
import tzlookup from 'tz-lookup'
import { ArrowLeftRight, ArrowRight, Bus, CableCar, ChevronDown, ChevronUp, Clock, Footprints, MapPin, Sailboat, Search, TramFront, TrainFront, TrainFrontTunnel } from 'lucide-react'
import CustomTimePicker from '../shared/CustomTimePicker'
import { TransitMetaBadges } from './transitDisplay'
import { transitApi } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import type { Day, Place, Accommodation } from '../../types'
import type { TransitProvider } from '@trek/shared'

/**
 * Public transit route search (#1065), backed by Transitous (MOTIS) through the
 * server proxy — no paid providers. Google-Maps-like flow in TREK's clean style:
 * pick from/to (stop search + the day's own places as quick picks), filter by
 * mode and preference, compare the returned itineraries, then add the chosen
 * one to the day. The result is saved as a regular transport reservation
 * (endpoints + metadata.transit), so timeline slotting, editing, deleting and
 * drag/drop all reuse the existing machinery.
 */

// ── transit data shapes (mirrors the server's compact mapping) ──────────────

interface TransitLegStop { name: string; lat: number; lng: number; time: string | null; scheduledTime: string | null; track: string | null }
interface TransitLeg {
  mode: string; from: TransitLegStop; to: TransitLegStop; duration: number; distance: number | null
  headsign: string | null; line: string | null; lineColor: string | null; lineTextColor: string | null
  agency: string | null; intermediateStops: number
  geometry?: string | null; geometryPrecision?: number
}
export interface TransitItinerary {
  startTime: string; endTime: string; duration: number; transfers: number; walkSeconds: number; legs: TransitLeg[]
}

interface TransitPlaceResult { name: string; lat: number; lng: number; type: string; area: string | null }

export interface PickedPlace { name: string; lat: number; lng: number }

// Backend names as they are written, not translated — the empty state says
// which one answered so "nothing here" can be told apart from "not the one you
// picked" (#1699).
const PROVIDER_NAMES: Record<TransitProvider, string> = {
  transitous: 'Transitous',
  google: 'Google',
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MODE_GROUPS: { key: string; labelKey: string; Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; modes: string }[] = [
  // lucide's `Train` is an alias of TramFront, so rail keeps TrainFront and the
  // subway takes the tunnel variant — otherwise the chips share a glyph.
  { key: 'rail', labelKey: 'transit.mode.rail', Icon: TrainFront, modes: 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN' },
  { key: 'subway', labelKey: 'transit.mode.subway', Icon: TrainFrontTunnel, modes: 'SUBWAY' },
  { key: 'tram', labelKey: 'transit.mode.tram', Icon: TramFront, modes: 'TRAM' },
  { key: 'bus', labelKey: 'transit.mode.bus', Icon: Bus, modes: 'BUS,COACH' },
  { key: 'ferry', labelKey: 'transit.mode.ferry', Icon: Sailboat, modes: 'FERRY' },
  { key: 'cable', labelKey: 'transit.mode.cable', Icon: CableCar, modes: 'FUNICULAR,AERIAL_LIFT' },
]

// Only called for non-WALK legs — walking renders its own Footprints inline.
function legIcon(mode: string) {
  if (mode === 'BUS' || mode === 'COACH') return Bus
  if (mode === 'TRAM') return TramFront
  if (mode === 'SUBWAY') return TrainFrontTunnel
  if (mode === 'FERRY') return Sailboat
  if (mode === 'FUNICULAR' || mode === 'AERIAL_LIFT') return CableCar
  return TrainFront
}

function tzAt(lat: number, lng: number): string {
  try { return tzlookup(lat, lng) } catch { return 'UTC' }
}

/** 'YYYY-MM-DD' + 'HH:mm' in an IANA zone → UTC ISO string. */
function localToUtcIso(dateStr: string, timeStr: string, tz: string): string {
  const naive = Date.parse(`${dateStr}T${timeStr}:00Z`)
  const inTz = new Date(new Date(naive).toLocaleString('en-US', { timeZone: tz })).getTime()
  const inUtc = new Date(new Date(naive).toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  return new Date(naive - (inTz - inUtc)).toISOString()
}

function fmtTimeInTz(iso: string | null, tz: string, is12h: boolean): string {
  if (!iso) return ''
  try { return new Intl.DateTimeFormat(is12h ? 'en-US' : 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: is12h }).format(new Date(iso)) } catch { return '' }
}

function timeHHmmInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

function dateYMDInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

function fmtDuration(seconds: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return t('transit.min', { count: mins })
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h} h ${m} min` : `${h} h`
}

// ── from/to stop picker ──────────────────────────────────────────────────────

function StopPicker({ label, value, onPick, quickPicks, near, placeholder }: {
  label: string
  value: PickedPlace | null
  onPick: (p: PickedPlace | null) => void
  quickPicks: PickedPlace[]
  near: string | null
  placeholder: string
}) {
  const { language } = useTranslation()
  const [text, setText] = useState('')
  const [results, setResults] = useState<TransitPlaceResult[]>([])
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  const search = (q: string) => {
    setText(q)
    onPick(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(() => {
      transitApi.geocode(q, { lang: language, near: near || undefined })
        .then((d: { results: TransitPlaceResult[] }) => setResults(d.results || []))
        .catch(() => setResults([]))
    }, 300)
  }

  const display = value ? value.name : text

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <label className="block text-[11px] font-semibold text-content-faint mb-[5px] uppercase tracking-[0.03em]">{label}</label>
      <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 7, borderRadius: 10, padding: '0 10px', height: 38 }}>
        <MapPin size={14} className="text-content-faint" style={{ flexShrink: 0 }} />
        <input
          value={display}
          onChange={e => search(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="text-content"
          style={{ border: 0, background: 'none', outline: 'none', fontSize: 'calc(13px * var(--fs-scale-body, 1))', width: '100%', fontFamily: 'inherit' }}
        />
      </div>
      {open && (results.length > 0 || (!value && text.trim().length < 2 && quickPicks.length > 0)) && (
        <div className="bg-surface-card border border-edge" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', zIndex: 30, overflow: 'hidden', maxHeight: 240, overflowY: 'auto' }}>
          {results.length > 0
            ? results.map((r, i) => (
              <button type="button" key={i} onClick={() => { onPick({ name: r.name, lat: r.lat, lng: r.lng }); setText(''); setResults([]); setOpen(false) }}
                className="text-content"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <MapPin size={13} className="text-content-faint" style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}
                  {r.area && <span className="text-content-faint"> · {r.area}</span>}
                </span>
              </button>
            ))
            : quickPicks.map((p, i) => (
              <button type="button" key={i} onClick={() => { onPick(p); setText(''); setOpen(false) }}
                className="text-content"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <MapPin size={13} className="text-content-faint" style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

// ── itinerary card ───────────────────────────────────────────────────────────

function LineBadge({ leg }: { leg: TransitLeg }) {
  const bg = leg.lineColor || 'var(--bg-tertiary)'
  const fg = leg.lineColor ? (leg.lineTextColor || '#fff') : 'var(--text-primary)'
  const Icon = legIcon(leg.mode)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: bg, color: fg, borderRadius: 6, padding: '2px 7px', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 700, whiteSpace: 'nowrap' }}>
      <Icon size={11} strokeWidth={2.2} />
      {leg.line || leg.mode}
    </span>
  )
}

function ItineraryCard({ it, tzFrom, tzTo, is12h, expanded, onToggle, onAdd, adding, t }: {
  it: TransitItinerary
  tzFrom: string
  tzTo: string
  is12h: boolean
  expanded: boolean
  onToggle: () => void
  onAdd: () => void
  adding: boolean
  t: (k: string, p?: Record<string, string | number>) => string
}) {
  const transitLegs = it.legs.filter(l => l.mode !== 'WALK')
  const walkMins = Math.round(it.walkSeconds / 60)
  return (
    <div className="bg-surface-card border border-edge" style={{ borderRadius: 14, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 700, letterSpacing: '-0.01em' }}>
            {fmtTimeInTz(it.startTime, tzFrom, is12h)} – {fmtTimeInTz(it.endTime, tzTo, is12h)}
          </span>
          <span className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600 }}>{fmtDuration(it.duration, t)}</span>
          <span className="text-content-faint" style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fs-scale-body, 1))', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span>{it.transfers === 0 ? t('transit.direct') : t('transit.transfers', { count: it.transfers })}</span>
            {walkMins > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Footprints size={12} />{t('transit.min', { count: walkMins })}</span>}
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </div>
        {/* signature: Walk › U2 › Bus 100 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
          {it.legs.map((leg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-content-faint" style={{ fontSize: 10 }}>›</span>}
              {leg.mode === 'WALK'
                ? <Footprints size={13} className="text-content-faint" />
                : <LineBadge leg={leg} />}
            </React.Fragment>
          ))}
        </div>
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-faint)', padding: '10px 14px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/*
              Every row is anchored at the leg's START: its time, its stop name and its
              platform. A leg's arrival shows up as the next row's heading, and the last
              arrival gets the closing row below.

              The walking legs used to break that and print leg.to.name, which is the stop
              the NEXT row already names. The stop where you actually get off is a walking
              leg's from.name, so it had no row of its own and vanished from the card
              entirely, along with the train's arrival time, which the same branch blanked
              (#2106). MOTIS brackets every journey in walking legs, so this hit the exit
              of any real connection.

              The time falls back to scheduledTime for the same reason the save path does
              (see stopTime below): a feed without realtime data carries only the schedule,
              and this row is now the one that shows the arrival.
            */}
            {it.legs.map((leg, i) => {
              const color = leg.mode === 'WALK' ? 'var(--border-primary)' : (leg.lineColor || 'var(--text-muted)')
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px 18px 1fr', gap: 8, alignItems: 'stretch' }}>
                  <div className="text-content-muted" style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, paddingTop: 2, textAlign: 'right' }}>
                    {fmtTimeInTz(leg.from.time ?? leg.from.scheduledTime, tzAt(leg.from.lat, leg.from.lng), is12h)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', border: `2.5px solid ${color}`, background: 'var(--bg-card)', flexShrink: 0, marginTop: 4 }} />
                    <span style={{ flex: 1, width: 3, borderRadius: 2, background: color, opacity: leg.mode === 'WALK' ? 0.45 : 1, margin: '2px 0', ...(leg.mode === 'WALK' ? { backgroundImage: 'repeating-linear-gradient(to bottom, var(--border-primary) 0 4px, transparent 4px 8px)', background: 'none' } : {}) }} />
                  </div>
                  <div style={{ paddingBottom: 14, minWidth: 0 }}>
                    <div className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {leg.from.name}
                      {leg.from.track && <span className="text-content-faint" style={{ fontWeight: 500 }}> · {t('transit.platform', { track: leg.from.track })}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      {leg.mode === 'WALK' ? (
                        <TransitMetaBadges size="sm" items={[
                          { icon: Footprints, text: t('transit.walkLabel') },
                          { text: fmtDuration(leg.duration, t) },
                          { text: leg.distance ? (leg.distance >= 1000 ? `${(leg.distance / 1000).toFixed(1)} km` : `${leg.distance} m`) : '' },
                        ]} />
                      ) : (
                        <>
                          <LineBadge leg={leg} />
                          <TransitMetaBadges size="sm" items={[
                            { icon: ArrowRight, text: leg.headsign || '' },
                            { text: fmtDuration(leg.duration, t) },
                            { text: leg.intermediateStops > 0 ? t('transit.stops', { count: leg.intermediateStops }) : '' },
                          ]} />
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {/* arrival row */}
            <div style={{ display: 'grid', gridTemplateColumns: '44px 18px 1fr', gap: 8, alignItems: 'center' }}>
              <div className="text-content-muted" style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, textAlign: 'right' }}>
                {fmtTimeInTz(it.endTime, tzTo, is12h)}
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--text-primary)', flexShrink: 0 }} />
              </div>
              <div className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.legs[it.legs.length - 1]?.to.name}
              </div>
            </div>
          </div>
          {transitLegs[0]?.agency && (
            <div className="text-content-faint" style={{ marginTop: 8, fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>
              {[...new Set(transitLegs.map(l => l.agency).filter(Boolean))].join(' · ')}
            </div>
          )}
          <button type="button"
            onClick={onAdd}
            disabled={adding}
            className="bg-accent text-accent-text"
            style={{ marginTop: 12, width: '100%', border: 'none', borderRadius: 10, padding: '9px 0', fontWeight: 600, fontSize: 'calc(13px * var(--fs-scale-body, 1))', cursor: adding ? 'default' : 'pointer', fontFamily: 'inherit', opacity: adding ? 0.6 : 1 }}
          >
            {adding ? t('transit.adding') : t('transit.addToDay')}
          </button>
        </div>
      )}
    </div>
  )
}

// ── the search panel ─────────────────────────────────────────────────────────
// Modal-less on purpose: it renders as the "Automated transport" mode inside
// the TransportModal (and could embed anywhere else). The host owns the modal
// chrome and closes itself once onAdd resolves.

interface TransitSearchPanelProps {
  day: Day
  days: Day[]
  places: Place[]
  accommodations?: Accommodation[]
  /** Persist the built reservation payload; resolves when saved. */
  onAdd: (payload: Record<string, unknown>) => Promise<unknown>
  /** Pre-seed from/to — used by "change route" on an existing journey. */
  initialFrom?: PickedPlace | null
  initialTo?: PickedPlace | null
  /** Pre-seed the departure time ('HH:mm') — used when planning a specific leg. */
  initialTime?: string | null
}

export default function TransitSearchPanel({ day, days, places, accommodations = [], onAdd, initialFrom = null, initialTo = null, initialTime = null }: TransitSearchPanelProps) {
  const { t, language } = useTranslation()
  const toast = useToast()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  const [from, setFrom] = useState<PickedPlace | null>(initialFrom)
  const [to, setTo] = useState<PickedPlace | null>(initialTo)
  const [time, setTime] = useState(initialTime || '09:00')
  const [arriveBy, setArriveBy] = useState(false)
  const [activeModes, setActiveModes] = useState<Set<string>>(() => new Set(MODE_GROUPS.map(m => m.key)))
  const [pref, setPref] = useState<'best' | 'transfers' | 'walking'>('best')
  const [itineraries, setItineraries] = useState<TransitItinerary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [addingIdx, setAddingIdx] = useState<number | null>(null)
  const [provider, setProvider] = useState<TransitProvider | null>(null)

  // Quick picks: the day's located places, plus the trip's located accommodations.
  const quickPicks = useMemo<PickedPlace[]>(() => {
    const picks: PickedPlace[] = []
    for (const p of places) {
      if (p.lat != null && p.lng != null) picks.push({ name: p.name, lat: p.lat, lng: p.lng })
    }
    for (const a of accommodations) {
      const lat = (a as { place_lat?: number | null }).place_lat
      const lng = (a as { place_lng?: number | null }).place_lng
      const name = (a as { place_name?: string | null }).place_name
      if (lat != null && lng != null && name) picks.push({ name, lat, lng })
    }
    const seen = new Set<string>()
    return picks.filter(p => { const k = `${p.name}:${p.lat}`; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 8)
  }, [places, accommodations])

  const near = quickPicks.length > 0 ? `${quickPicks[0].lat},${quickPicks[0].lng}` : null

  const toggleMode = (key: string) => {
    setActiveModes(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) } else { next.add(key) }
      return next
    })
  }

  const search = async () => {
    if (!from || !to || !day.date) return
    setLoading(true)
    setItineraries(null)
    setExpandedIdx(null)
    setProvider(null)
    try {
      const tzFrom = tzAt(from.lat, from.lng)
      const tzTo = tzAt(to.lat, to.lng)
      // Depart-by anchors the entered time at the origin; arrive-by anchors it at
      // the destination (#1479), so each mode must convert with the matching zone.
      const timeIso = localToUtcIso(day.date, time, arriveBy ? tzTo : tzFrom)
      const allModes = activeModes.size === MODE_GROUPS.length
      const modes = allModes ? undefined : MODE_GROUPS.filter(m => activeModes.has(m.key)).map(m => m.modes).join(',')
      const d = await transitApi.plan({ from: `${from.lat},${from.lng}`, to: `${to.lat},${to.lng}`, time: timeIso, arriveBy, modes, lang: language })
      // Which backend actually answered (#1699). Named in the empty state so
      // "nothing found" can be told apart from "the provider you picked never
      // ran" — the fallback to Transitous is silent by design.
      setProvider(d.provider ?? null)
      // MOTIS names the request coordinates START/END — swap in the places the
      // user actually picked so walks read "Walk to Zoologischer Garten".
      const cleanStop = (n: string) => (n === 'START' ? from.name : n === 'END' ? to.name : n)
      const cleaned = (d.itineraries || []).map((it: TransitItinerary) => ({
        ...it,
        legs: it.legs.map(l => ({
          ...l,
          from: { ...l.from, name: cleanStop(l.from.name) },
          to: { ...l.to, name: cleanStop(l.to.name) },
        })),
      }))
      // MOTIS returns arrive-by results ascending with the deadline-adjacent
      // connection last (#1479) — flip so the itinerary arriving closest to the
      // requested time leads the list, mirroring depart-by.
      if (arriveBy) cleaned.sort((a, b) => Date.parse(b.endTime) - Date.parse(a.endTime))
      setItineraries(cleaned)
    } catch {
      toast.error(t('transit.searchError'))
      setItineraries([])
    } finally {
      setLoading(false)
    }
  }

  // Preference is a client-side ranking over one result set — no extra API calls.
  const ranked = useMemo(() => {
    if (!itineraries) return null
    const list = itineraries.slice()
    if (pref === 'transfers') list.sort((a, b) => a.transfers - b.transfers || a.duration - b.duration)
    if (pref === 'walking') list.sort((a, b) => a.walkSeconds - b.walkSeconds || a.duration - b.duration)
    return list
  }, [itineraries, pref])

  const addItinerary = async (it: TransitItinerary, idx: number) => {
    if (!from || !to || !day.date) return
    setAddingIdx(idx)
    try {
      const tzFrom = tzAt(from.lat, from.lng)
      const tzTo = tzAt(to.lat, to.lng)
      const depDate = dateYMDInTz(it.startTime, tzFrom)
      const depTime = timeHHmmInTz(it.startTime, tzFrom)
      const arrDate = dateYMDInTz(it.endTime, tzTo)
      const arrTime = timeHHmmInTz(it.endTime, tzTo)

      // An after-midnight arrival lands on the next trip day when it exists.
      const endDay = arrDate !== depDate ? days.find(d2 => d2.date === arrDate) : null

      // Realtime time with scheduled fallback — the same `time ?? scheduledTime`
      // the server's buildTransitReservationParts applies, so a scheduled-only
      // feed still yields stop times instead of nulls.
      const stopTime = (s: TransitLegStop) => s.time ?? s.scheduledTime

      // Endpoints: origin, each transfer stop, destination — the same shape
      // flights persist, so the map + connectors work unchanged.
      const transitLegs = it.legs.filter(l => l.mode !== 'WALK')
      const endpoints: Record<string, unknown>[] = []
      endpoints.push({ role: 'from', sequence: 0, name: from.name, code: null, lat: from.lat, lng: from.lng, timezone: tzFrom, local_date: depDate, local_time: depTime })
      transitLegs.slice(0, -1).forEach((leg, i) => {
        const s = leg.to
        const t2 = stopTime(s)
        endpoints.push({ role: 'stop', sequence: i + 1, name: s.name, code: null, lat: s.lat, lng: s.lng, timezone: tzAt(s.lat, s.lng), local_date: t2 ? dateYMDInTz(t2, tzAt(s.lat, s.lng)) : null, local_time: t2 ? timeHHmmInTz(t2, tzAt(s.lat, s.lng)) : null })
      })
      endpoints.push({ role: 'to', sequence: endpoints.length, name: to.name, code: null, lat: to.lat, lng: to.lng, timezone: tzTo, local_date: arrDate, local_time: arrTime })

      const payload = {
        title: `${from.name} → ${to.name}`,
        // Its own first-class type: transit journeys get their own icon, their
        // rich timeline row and the itinerary detail view instead of the
        // generic transport rendering.
        type: 'transit',
        status: 'confirmed',
        day_id: day.id,
        end_day_id: endDay ? endDay.id : day.id,
        reservation_time: `${depDate}T${depTime}`,
        reservation_end_time: `${arrDate}T${arrTime}`,
        location: null,
        confirmation_number: null,
        notes: null,
        metadata: {
          transit: {
            provider: 'transitous',
            duration: it.duration,
            transfers: it.transfers,
            walk_seconds: it.walkSeconds,
            legs: it.legs.map(l => ({
              mode: l.mode,
              line: l.line,
              line_color: l.lineColor,
              line_text_color: l.lineTextColor,
              headsign: l.headsign,
              agency: l.agency,
              duration: l.duration,
              stops: l.intermediateStops,
              from: { name: l.from.name, time: stopTime(l.from) ? timeHHmmInTz(stopTime(l.from)!, tzAt(l.from.lat, l.from.lng)) : null, track: l.from.track },
              to: { name: l.to.name, time: stopTime(l.to) ? timeHHmmInTz(stopTime(l.to)!, tzAt(l.to.lat, l.to.lng)) : null, track: l.to.track },
              geometry: l.geometry || null,
              geometry_precision: l.geometryPrecision ?? 6,
            })),
          },
        },
        endpoints,
        needs_review: false,
      }

      await onAdd(payload)
    } catch {
      toast.error(t('common.unknownError'))
    } finally {
      setAddingIdx(null)
    }
  }

  const tzFrom = from ? tzAt(from.lat, from.lng) : 'UTC'
  const tzTo = to ? tzAt(to.lat, to.lng) : tzFrom

  const segBtn = (active: boolean): React.CSSProperties => ({
    padding: isMobile ? '6px 5px' : '6px 11px', fontSize: isMobile ? 'calc(11px * var(--fs-scale-body, 1))' : 'calc(12px * var(--fs-scale-body, 1))', borderRadius: 7, fontWeight: 500,
    border: 0, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
  })

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--font-system)' }}>
        {/* from / to — stacked tight on mobile, swap button on desktop only */}
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8, alignItems: isMobile ? 'stretch' : 'flex-end' }}>
          <StopPicker label={t('transit.from')} value={from} onPick={setFrom} quickPicks={quickPicks} near={near} placeholder={t('transit.searchStop')} />
          {!isMobile && (
            <button type="button"
              onClick={() => { const f = from; setFrom(to); setTo(f) }}
              aria-label={t('transit.swap')}
              title={t('transit.swap')}
              className="bg-surface-secondary text-content-muted"
              style={{ border: 'none', borderRadius: 10, width: 38, height: 38, display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}
            >
              <ArrowLeftRight size={15} />
            </button>
          )}
          <StopPicker label={t('transit.to')} value={to} onPick={setTo} quickPicks={quickPicks} near={near} placeholder={t('transit.searchStop')} />
        </div>

        {/* search options — one calm card: when + how on top, modes + go below */}
        <div className="bg-surface-tertiary" style={{ borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="bg-surface-secondary" style={{ display: 'flex', borderRadius: 9, padding: 3 }}>
                <button type="button" onClick={() => setArriveBy(false)} style={segBtn(!arriveBy)}>{t('transit.depart')}</button>
                <button type="button" onClick={() => setArriveBy(true)} style={segBtn(arriveBy)}>{t('transit.arrive')}</button>
              </div>
              <div style={{ width: 110 }}>
                <CustomTimePicker value={time} onChange={setTime} />
              </div>
              {day.date && (
                <span className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Clock size={12} />
                  {new Date(day.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
                </span>
              )}
            </div>
            <div className="bg-surface-secondary" style={{ display: 'flex', borderRadius: 9, padding: 3, width: isMobile ? '100%' : undefined }}>
              <button type="button" onClick={() => setPref('best')} style={{ ...segBtn(pref === 'best'), flex: isMobile ? 1 : undefined }}>{t('transit.pref.best')}</button>
              <button type="button" onClick={() => setPref('transfers')} style={{ ...segBtn(pref === 'transfers'), flex: isMobile ? 1 : undefined }}>{t('transit.pref.transfers')}</button>
              <button type="button" onClick={() => setPref('walking')} style={{ ...segBtn(pref === 'walking'), flex: isMobile ? 1 : undefined }}>{t('transit.pref.walking')}</button>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--border-faint)' }} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {MODE_GROUPS.map(m => {
                const active = activeModes.has(m.key)
                return (
                  <button type="button" key={m.key} onClick={() => toggleMode(m.key)}
                    className={active ? 'bg-surface-card text-content' : 'text-content-faint'}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99,
                      border: '1px solid', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 500,
                      cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s',
                      background: active ? undefined : 'transparent',
                      borderColor: active ? 'var(--border-primary)' : 'transparent',
                      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                      opacity: active ? 1 : 0.75,
                    }}>
                    <m.Icon size={12} strokeWidth={2} />
                    {t(m.labelKey)}
                  </button>
                )
              })}
            </div>
            <button type="button"
              onClick={search}
              disabled={!from || !to || loading}
              className="bg-accent text-accent-text"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: 'none', borderRadius: 10, padding: '9px 18px', fontWeight: 600, fontSize: 'calc(13px * var(--fs-scale-body, 1))', cursor: (!from || !to || loading) ? 'default' : 'pointer', fontFamily: 'inherit', opacity: (!from || !to || loading) ? 0.55 : 1, flexShrink: 0, width: isMobile ? '100%' : undefined }}
            >
              <Search size={14} strokeWidth={2.2} />
              {loading ? t('transit.searching') : t('transit.search')}
            </button>
          </div>
        </div>

        {/* results */}
        {loading && (
          <div className="text-content-faint" style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ width: 20, height: 20, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
          </div>
        )}
        {!loading && ranked && ranked.length === 0 && (
          <div className="text-content-faint" style={{ textAlign: 'center', padding: '24px 0', fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>
            {provider
              ? t('transit.noResultsVia', { provider: PROVIDER_NAMES[provider] })
              : t('transit.noResults')}
          </div>
        )}
        {!loading && ranked && ranked.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ranked.map((it, idx) => (
              <ItineraryCard
                key={`${it.startTime}-${it.endTime}-${idx}`}
                it={it}
                tzFrom={tzFrom}
                tzTo={tzTo}
                is12h={is12h}
                expanded={expandedIdx === idx}
                onToggle={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                onAdd={() => addItinerary(it, idx)}
                adding={addingIdx === idx}
                t={t}
              />
            ))}
            <div className="text-content-faint" style={{ fontSize: 'calc(10.5px * var(--fs-scale-caption, 1))', textAlign: 'center', marginTop: 2 }}>
              {t('transit.attribution')}{' '}
              <a href="https://transitous.org/sources/" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>Transitous</a>
            </div>
          </div>
        )}
      </div>
  )
}
