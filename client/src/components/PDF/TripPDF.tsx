// Trip PDF via browser print window
import { createElement } from 'react'
import { getCategoryIcon } from '../shared/categoryIcons'
import { FileText, Info, Clock, MapPin, Navigation, Train, Plane, Bus, Car, Ship, Coffee, Ticket, Star, Heart, Camera, Flag, Lightbulb, AlertTriangle, ShoppingBag, Bookmark, Hotel, LogIn, LogOut, KeyRound, BedDouble, Utensils, Users, LucideIcon } from 'lucide-react'
import { accommodationsApi, mapsApi } from '../../api/client'
import type { Trip, Day, Place, Category, AssignmentsMap, DayNotesMap } from '../../types'

function renderLucideIcon(icon:LucideIcon, props = {}) {
  if (!_renderToStaticMarkup) return ''
  return _renderToStaticMarkup(
    createElement(icon, props)
  );
}

const NOTE_ICON_MAP = { FileText, Info, Clock, MapPin, Navigation, Train, Plane, Bus, Car, Ship, Coffee, Ticket, Star, Heart, Camera, Flag, Lightbulb, AlertTriangle, ShoppingBag, Bookmark }
function noteIconSvg(iconId) {
  const Icon = NOTE_ICON_MAP[iconId] || FileText
  return renderLucideIcon(Icon, { size: 14, strokeWidth: 1.8, color: '#94a3b8' })
}

const RESERVATION_ICON_MAP = { flight: Plane, train: Train, bus: Bus, car: Car, cruise: Ship, restaurant: Utensils, event: Ticket, tour: Users, other: FileText }
const RESERVATION_COLOR_MAP = { flight: '#3b82f6', train: '#06b6d4', bus: '#6b7280', car: '#6b7280', cruise: '#0ea5e9', restaurant: '#ef4444', event: '#f59e0b', tour: '#10b981', other: '#6b7280' }
function reservationIconSvg(type) {
  const Icon = RESERVATION_ICON_MAP[type] || Ticket
  const color = RESERVATION_COLOR_MAP[type] || '#3b82f6'
  return renderLucideIcon(Icon, { size: 14, strokeWidth: 1.8, color })
}

const ACCOMMODATION_ICON_MAP = { accommodation: Hotel, checkin: LogIn, checkout: LogOut, location: MapPin, note: FileText, confirmation: KeyRound }
function accommodationIconSvg(type) {
  const Icon = ACCOMMODATION_ICON_MAP[type] || BedDouble
  return renderLucideIcon(Icon, { size: 14, strokeWidth: 1.8, color: '#03398f', className: 'accommodation-icon' })
}

// ── SVG inline icons (for chips) ─────────────────────────────────────────────
const svgPin   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="#94a3b8" style="flex-shrink:0;margin-top:1px"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5" fill="white"/></svg>`
const svgClock = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`
const svgClock2= `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`
const svgCheck = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg>`
const svgEuro  = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round"><path d="M14 5c-3.87 0-7 3.13-7 7s3.13 7 7 7c2.17 0 4.1-.99 5.4-2.55"/><path d="M5 11h8M5 13h8"/></svg>`

function escHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function absUrl(url) {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url
  return window.location.origin + (url.startsWith('/') ? '' : '/') + url
}

function safeImg(url) {
  if (!url) return null
  if (url.startsWith('https://') || url.startsWith('http://')) return url
  return /\.(jpe?g|png|webp|bmp|tiff?)(\?.*)?$/i.test(url) ? absUrl(url) : null
}

// Generate SVG string from Lucide icon name (for category thumbnails)
let _renderToStaticMarkup = null
async function ensureRenderer() {
  if (!_renderToStaticMarkup) {
    const mod = await import('react-dom/server')
    _renderToStaticMarkup = mod.renderToStaticMarkup
  }
}
function categoryIconSvg(iconName, color = '#6366f1', size = 24) {
  if (!_renderToStaticMarkup) return ''
  const Icon = getCategoryIcon(iconName)
  return _renderToStaticMarkup(
    createElement(Icon, { size, strokeWidth: 1.8, color: 'rgba(255,255,255,0.92)' })
  )
}

function shortDate(d, locale) {
  if (!d) return ''
  return new Date(d + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function longDateRange(days, locale) {
  const dd = [...days].filter(d => d.date).sort((a, b) => a.day_number - b.day_number)
  if (!dd.length) return null
  const f = new Date(dd[0].date + 'T00:00:00Z')
  const l = new Date(dd[dd.length - 1].date + 'T00:00:00Z')
  return `${f.toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })} – ${l.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
}

function dayCost(assignments, dayId, locale) {
  const total = (assignments[String(dayId)] || []).reduce((s, a) => s + (parseFloat(a.place?.price) || 0), 0)
  return total > 0 ? `${total.toLocaleString(locale)} EUR` : null
}

// Pre-fetch Google Place photos for all assigned places
async function fetchPlacePhotos(assignments) {
  const photoMap = {} // placeId → photoUrl
  const allPlaces = Object.values(assignments).flatMap(a => a.map(x => x.place)).filter(Boolean)
  const unique = [...new Map(allPlaces.map(p => [p.id, p])).values()]

  const toFetch = unique.filter(p => !p.image_url && (p.google_place_id || p.osm_id))

  await Promise.allSettled(
    toFetch.map(async (place) => {
      try {
        const data = await mapsApi.placePhoto(place.google_place_id || place.osm_id, place.lat, place.lng, place.name)
        if (data.photoUrl) photoMap[place.id] = data.photoUrl
      } catch {}
    })
  )
  return photoMap
}

interface downloadTripPDFProps {
  trip: Trip
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  categories: Category[]
  dayNotes: DayNotesMap
  reservations?: any[]
  t: (key: string, params?: Record<string, string | number>) => string
  locale: string
}

export async function downloadTripPDF({ trip, days, places, assignments, categories, dayNotes, reservations = [], t: _t, locale: _locale }: downloadTripPDFProps) {
  await ensureRenderer()
  const loc = _locale || undefined
  const tr = _t || (k => k)
  const sorted = [...(days || [])].sort((a, b) => a.day_number - b.day_number)
  const range = longDateRange(sorted, loc)
  const coverImg = safeImg(trip?.cover_image)
  //retrieve accommodations for the trip to display on the day sections and prefetch their photos if needed
  const accommodations = await accommodationsApi.list(trip.id);

  // Pre-fetch place photos from Google
  const photoMap = await fetchPlacePhotos(assignments)

  const totalAssigned = new Set(
    Object.values(assignments || {}).flatMap(a => a.map(x => x.place?.id)).filter(Boolean)
  ).size
  const totalCost = Object.values(assignments || {})
    .flatMap(a => a).reduce((s, a) => s + (parseFloat(a.place?.price) || 0), 0)

  // Span helpers for multi-day transport (mirrors DayPlanSidebar logic)
  const pdfGetDayOrder = (d: Day) => d.day_number
  const pdfGetSpanPhase = (r: any, dayId: number): 'single' | 'start' | 'middle' | 'end' => {
    const startId = r.day_id
    const endId = r.end_day_id ?? startId
    if (!startId || startId === endId) return 'single'
    if (dayId === startId) return 'start'
    if (dayId === endId) return 'end'
    return 'middle'
  }
  const pdfGetDisplayTime = (r: any, dayId: number): string | null => {
    const phase = pdfGetSpanPhase(r, dayId)
    if (phase === 'end') return r.reservation_end_time || null
    if (phase === 'middle') return null
    return r.reservation_time || null
  }
  const pdfGetSpanLabel = (r: any, phase: string): string | null => {
    if (phase === 'single') return null
    if (r.type === 'flight') return tr(`reservations.span.${phase === 'start' ? 'departure' : phase === 'end' ? 'arrival' : 'inTransit'}`)
    if (r.type === 'car') return tr(`reservations.span.${phase === 'start' ? 'pickup' : phase === 'end' ? 'return' : 'active'}`)
    return tr(`reservations.span.${phase === 'start' ? 'start' : phase === 'end' ? 'end' : 'ongoing'}`)
  }
  const pdfGetTransportForDay = (dayId: number) => (reservations || []).filter(r => {
    if (r.type === 'hotel') return false
    const startId = r.day_id
    const endId = r.end_day_id ?? startId
    if (startId == null) return false
    if (endId !== startId) {
      const startDay = sorted.find(d => d.id === startId)
      const endDay = sorted.find(d => d.id === endId)
      const thisDay = sorted.find(d => d.id === dayId)
      if (!startDay || !endDay || !thisDay) return false
      return pdfGetDayOrder(thisDay) >= pdfGetDayOrder(startDay) && pdfGetDayOrder(thisDay) <= pdfGetDayOrder(endDay)
    }
    return startId === dayId
  })

  // Build day HTML
  const daysHtml = sorted.map((day, di) => {
    const assigned = assignments[String(day.id)] || []
    const notes = (dayNotes || []).filter(n => n.day_id === day.id)
    const cost = dayCost(assignments, day.id, loc)

    // Reservations for this day (hotel rendered via accommodations block; car middle-phase rendered in sidebar header only)
    const dayReservations = pdfGetTransportForDay(day.id)
      .filter(r => !(r.type === 'car' && pdfGetSpanPhase(r, day.id) === 'middle'))

    const merged = []
    assigned.forEach(a => merged.push({ type: 'place', k: a.order_index ?? a.sort_order ?? 0, data: a }))
    notes.forEach(n    => merged.push({ type: 'note',  k: n.sort_order ?? 0, data: n }))
    dayReservations.forEach(r => {
      const pos = r.day_positions?.[day.id] ?? r.day_positions?.[String(day.id)] ?? r.day_plan_position ?? (merged.length > 0 ? Math.max(...merged.map(m => m.k)) + 0.5 : 0.5)
      merged.push({ type: 'reservation', k: pos, data: r })
    })
    merged.sort((a, b) => a.k - b.k)

    let pi = 0
    const itemsHtml = merged.length === 0
      ? `<div class="empty-day">${escHtml(tr('dayplan.emptyDay'))}</div>`
      : merged.map(item => {
          if (item.type === 'reservation') {
            const r = item.data
            const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {})
            const icon = reservationIconSvg(r.type)
            const color = RESERVATION_COLOR_MAP[r.type] || '#3b82f6'
            let subtitle = ''
            if (r.type === 'flight') subtitle = [meta.airline, meta.flight_number, meta.departure_airport && meta.arrival_airport ? `${meta.departure_airport} → ${meta.arrival_airport}` : ''].filter(Boolean).join(' · ')
            else if (r.type === 'train') subtitle = [meta.train_number, meta.platform ? `Gl. ${meta.platform}` : '', meta.seat ? `Seat ${meta.seat}` : ''].filter(Boolean).join(' · ')
            else if (r.type === 'restaurant') subtitle = [meta.party_size ? `${meta.party_size} guests` : ''].filter(Boolean).join(' · ')
            else if (r.type === 'event') subtitle = [meta.venue].filter(Boolean).join(' · ')
            else if (r.type === 'tour') subtitle = [meta.operator].filter(Boolean).join(' · ')
            const locationLine = r.location || meta.location || ''
            const phase = pdfGetSpanPhase(r, day.id)
            const spanLabel = pdfGetSpanLabel(r, phase)
            const displayTime = pdfGetDisplayTime(r, day.id)
            const time = displayTime?.includes('T') ? displayTime.split('T')[1]?.substring(0, 5) : ''
            const titleHtml = `${spanLabel ? escHtml(spanLabel) + ': ' : ''}${escHtml(r.title)}`
            return `
              <div class="note-card" style="border-left: 3px solid ${color};">
                <div class="note-line" style="background: ${color};"></div>
                <span class="note-icon">${icon}</span>
                <div class="note-body">
                  <div class="note-text" style="font-weight: 600;">${titleHtml}${time ? ` <span style="color:#6b7280;font-weight:400;font-size:10px;">${time}</span>` : ''}</div>
                  ${subtitle ? `<div class="note-time">${escHtml(subtitle)}</div>` : ''}
                  ${locationLine ? `<div class="note-time">${escHtml(locationLine)}</div>` : ''}
                  ${r.confirmation_number ? `<div class="note-time" style="font-size:9px;">Code: ${escHtml(r.confirmation_number)}</div>` : ''}
                </div>
              </div>`
          }

          if (item.type === 'note') {
            const note = item.data
            return `
              <div class="note-card">
                <div class="note-line"></div>
                <span class="note-icon">${noteIconSvg(note.icon)}</span>
                <div class="note-body">
                  <div class="note-text">${escHtml(note.text)}</div>
                  ${note.time ? `<div class="note-time">${escHtml(note.time)}</div>` : ''}
                </div>
              </div>`
          }

          pi++
          const place = item.data.place
          if (!place) return ''
          const cat = categories.find(c => c.id === place.category_id)
          const color = cat?.color || '#6366f1'

          // Image: direct > google photo > fallback icon
          const directImg = safeImg(place.image_url)
          const googleImg = photoMap[place.id] || null
          const img = directImg || googleImg

          const iconSvg = categoryIconSvg(cat?.icon, color, 24)
          const thumbHtml = img
            ? `<img class="place-thumb" src="${escHtml(img)}" />`
            : `<div class="place-thumb-fallback" style="background:${color}">
                 ${iconSvg}
               </div>`

          const chips = [
            place.place_time ? `<span class="chip">${svgClock}${escHtml(place.place_time)}</span>` : '',
            place.price && parseFloat(place.price) > 0 ? `<span class="chip chip-green">${svgEuro}${Number(place.price).toLocaleString(loc)} EUR</span>` : '',
          ].filter(Boolean).join('')

          return `
            <div class="place-card">
              <div class="place-bar" style="background:${color}"></div>
              ${thumbHtml}
              <div class="place-info">
                <div class="place-name-row">
                  <span class="place-num">${pi}</span>
                  <span class="place-name">${escHtml(place.name)}</span>
                  ${cat ? `<span class="cat-badge" style="background:${color}">${escHtml(cat.name)}</span>` : ''}
                </div>
                ${place.address ? `<div class="info-row">${svgPin}<span class="info-text">${escHtml(place.address)}</span></div>` : ''}
                ${place.description ? `<div class="info-row"><span class="info-spacer"></span><span class="info-text muted italic">${escHtml(place.description)}</span></div>` : ''}
                ${chips ? `<div class="chips">${chips}</div>` : ''}
                ${place.notes ? `<div class="info-row"><span class="info-spacer"></span><span class="info-text muted italic">${escHtml(place.notes)}</span></div>` : ''}
              </div>
            </div>`
      }).join('')

    const accommodationsForDay = (accommodations.accommodations || []).filter(a =>
      days.some(d => d.id >= a.start_day_id && d.id <= a.end_day_id && d.id === day?.id)
    ).sort((a, b) => a.start_day_id - b.start_day_id)

    const accommodationDetails = accommodationsForDay.map(item => {
      const isCheckIn = day.id === item.start_day_id
      const isCheckOut = day.id === item.end_day_id
      const actionLabel = isCheckIn ? tr('reservations.meta.checkIn')
        : isCheckOut ? tr('reservations.meta.checkOut')
        : tr('reservations.meta.linkAccommodation')
      const actionIcon = isCheckIn ? accommodationIconSvg('checkin')
        : isCheckOut ? accommodationIconSvg('checkout')
        : accommodationIconSvg('accommodation')
      const timeStr = isCheckIn ? (item.check_in || '')
        : isCheckOut ? (item.check_out || '')
        : ''

      return `
        <div class="day-accommodation">
          <div class="day-accommodation-title accommodation-center-icon">${actionIcon} ${escHtml(actionLabel)}</div>
          ${timeStr ? `<div class="accommodation-center-icon">${accommodationIconSvg('checkin')} <b>${escHtml(timeStr)}</b></div>` : ''}
          <div class="accommodation-center-icon">${accommodationIconSvg('accommodation')} ${escHtml(item.place_name)}</div>
          ${item.place_address ? `<div class="accommodation-center-icon">${accommodationIconSvg('location')} ${escHtml(item.place_address)}</div>` : ''}
          ${item.notes ? `<div class="accommodation-center-icon">${accommodationIconSvg('note')} ${escHtml(item.notes)}</div>` : ''}
          ${isCheckIn && item.confirmation ? `<div class="accommodation-center-icon">${accommodationIconSvg('confirmation')} ${escHtml(item.confirmation)}</div>` : ''}
        </div>`
    }).join('')

    const accommodationsHtml = accommodationsForDay.length > 0
      ? `<div class="day-accommodations-overview">
          <div class="day-accommodations ${accommodationsForDay.length === 1 ? 'single' : ''}">${accommodationDetails}</div>
        </div>`
      : ''

    return `
      <div class="day-section${di > 0 ? ' page-break' : ''}">
        <div class="day-header">
          <span class="day-tag">${escHtml(tr('dayplan.dayN', { n: day.day_number })).toUpperCase()}</span>
          <span class="day-title">${escHtml(day.title || tr('dayplan.dayN', { n: day.day_number }))}</span>
          ${day.date ? `<span class="day-date">${shortDate(day.date, loc)}</span>` : ''}
          ${cost ? `<span class="day-cost">${cost}</span>` : ''}
        </div>
        <div class="day-body">${accommodationsHtml}${itemsHtml}</div>
      </div>`  
  }).join('')

  const html = `<!DOCTYPE html>
<html lang="${loc.split('-')[0]}">
<head>
<meta charset="UTF-8">
<base href="${window.location.origin}/">
<title>${escHtml(trip?.title || tr('pdf.travelPlan'))}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Poppins', sans-serif; background: #fff; color: #1e293b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  svg { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* Footer on every printed page */
  .pdf-footer {
    position: fixed;
    bottom: 20px;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    opacity: 0.3;
  }
  .pdf-footer span {
    font-size: 7px;
    color: #64748b;
    letter-spacing: 0.5px;
  }

  /* ── Cover ─────────────────────────────────────── */
  .cover {
    width: 100%; min-height: 100vh;
    background: #0f172a;
    display: flex; flex-direction: column; justify-content: flex-end;
    padding: 52px; position: relative; overflow: hidden;
  }
  .cover-bg {
    position: absolute; inset: 0;
    background-size: cover; background-position: center;
    opacity: 0.28;
  }
  .cover-dim { position: absolute; inset: 0; background: rgba(8,12,28,0.55); }
  .cover-brand {
    position: absolute; top: 36px; right: 52px;
    z-index: 2;
  }
  .cover-body { position: relative; z-index: 1; }
  .cover-circle {
    width: 100px; height: 100px; border-radius: 50%;
    overflow: hidden; border: 2.5px solid rgba(255,255,255,0.25);
    margin-bottom: 26px; flex-shrink: 0;
  }
  .cover-circle img { width: 100%; height: 100%; object-fit: cover; }
  .cover-circle-ph {
    width: 100px; height: 100px; border-radius: 50%;
    background: rgba(255,255,255,0.07);
    margin-bottom: 26px;
  }
  .cover-label { font-size: 9px; font-weight: 600; letter-spacing: 2.5px; color: rgba(255,255,255,0.4); text-transform: uppercase; margin-bottom: 8px; }
  .cover-title { font-size: 42px; font-weight: 700; color: #fff; line-height: 1.1; margin-bottom: 8px; }
  .cover-desc  { font-size: 13px; color: rgba(255,255,255,0.55); line-height: 1.6; margin-bottom: 18px; max-width: 420px; }
  .cover-dates { font-size: 12px; color: rgba(255,255,255,0.45); margin-bottom: 30px; }
  .cover-line  { height: 1px; background: rgba(255,255,255,0.1); margin-bottom: 24px; }
  .cover-stats { display: flex; gap: 36px; }
  .cover-stat-num { font-size: 28px; font-weight: 700; color: #fff; line-height: 1; }
  .cover-stat-lbl { font-size: 9px; font-weight: 500; color: rgba(255,255,255,0.4); letter-spacing: 1px; margin-top: 4px; text-transform: uppercase; }

  /* ── Day ───────────────────────────────────────── */
  .page-break { page-break-before: always; }
  .day-header {
    background: #0f172a; padding: 11px 28px;
    display: flex; align-items: center; gap: 8px;
  }
  .day-tag { font-size: 8px; font-weight: 700; color: #fff; letter-spacing: 0.8px; background: rgba(255,255,255,0.12); border-radius: 4px; padding: 3px 8px; flex-shrink: 0; }
  .day-title { font-size: 13px; font-weight: 600; color: #fff; flex: 1; }
  .day-date  { font-size: 9px; color: rgba(255,255,255,0.45); }
  .day-cost  { font-size: 9px; font-weight: 600; color: rgba(255,255,255,0.65); }
  .day-body  { padding: 12px 28px 6px; }

  /* accommodation info */
  .day-accommodations-overview { font-size: 12px; }
  .day-accommodations { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
  .day-accommodations.single { justify-content: center; }
  .day-accommodation {
    flex: 1 1 45%; min-width: 200px; margin: 4px 0; padding: 10px;
    border: 2px solid #e2e8f0; border-radius: 12px;
    display: flex; flex-direction: column;
  }
  .day-accommodation-title {
    font-size: 16px; font-weight: 600; text-align: center;
    margin-bottom: 4px; align-self: center;
  }
  .accommodation-center-icon { display: flex; align-items: center; gap: 4px; }


  /* ── Place card ────────────────────────────────── */
  .place-card {
    display: flex; align-items: stretch;
    border: 1px solid #e2e8f0; border-radius: 8px;
    margin-bottom: 8px; overflow: hidden;
    background: #fff; page-break-inside: avoid;
  }
  .place-bar { width: 4px; flex-shrink: 0; }
  .place-thumb {
    width: 52px; height: 52px; object-fit: cover;
    margin: 8px; border-radius: 6px; flex-shrink: 0;
  }
  .place-thumb-fallback {
    width: 52px; height: 52px; margin: 8px; border-radius: 8px;
    flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  }
  .place-thumb-fallback svg { width: 24px; height: 24px; }
  .place-info { flex: 1; padding: 9px 10px 8px 0; min-width: 0; }

  .place-name-row { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
  .place-num {
    width: 16px; height: 16px; border-radius: 50%;
    background: #1e293b; color: #fff; font-size: 8px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .place-name { font-size: 11.5px; font-weight: 600; color: #1e293b; flex: 1; }
  .cat-badge { font-size: 7.5px; font-weight: 600; color: #fff; border-radius: 99px; padding: 2px 7px; flex-shrink: 0; white-space: nowrap; }

  .info-row { display: flex; align-items: flex-start; gap: 4px; margin-bottom: 2px; padding-left: 21px; }
  .info-row svg { flex-shrink: 0; margin-top: 1px; }
  .info-spacer { width: 13px; flex-shrink: 0; }
  .info-text { font-size: 9px; color: #64748b; line-height: 1.5; }
  .info-text.muted { color: #94a3b8; }
  .info-text.italic { font-style: italic; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding-left: 21px; margin-top: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; font-size: 8px; font-weight: 600; background: #f1f5f9; color: #374151; border-radius: 99px; padding: 2px 7px; white-space: nowrap; }
  .chip svg { flex-shrink: 0; }
  .chip-green { background: #ecfdf5; color: #059669; }
  .chip-amber { background: #fffbeb; color: #d97706; }

  /* ── Note card ─────────────────────────────────── */
  .note-card {
    display: flex; align-items: center; gap: 8px;
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    padding: 8px 10px; margin-bottom: 7px; page-break-inside: avoid;
  }
  .note-line { width: 3px; border-radius: 99px; background: #94a3b8; align-self: stretch; flex-shrink: 0; }
  .note-icon { flex-shrink: 0; }
  .note-body { flex: 1; min-width: 0; }
  .note-text { font-size: 9.5px; color: #334155; line-height: 1.55; }
  .note-time { font-size: 8px; color: #94a3b8; margin-top: 2px; }

  .empty-day { font-size: 9.5px; color: #cbd5e1; font-style: italic; text-align: center; padding: 14px 0; }

  /* ── Print ─────────────────────────────────────── */
  @media print {
    body { margin: 0; }
    .cover { min-height: 100vh; page-break-after: always; }
    @page { margin: 0; }
  }
</style>
</head>
<body>

<!-- Footer on every page -->
<div class="pdf-footer">
  <span>made with</span>
  <img src="${absUrl('/logo-dark.svg')}" style="height:10px;opacity:0.6;" />
</div>

<!-- Cover -->
<div class="cover">
  ${coverImg ? `<div class="cover-bg" style="background-image:url('${escHtml(coverImg)}')"></div>` : ''}
  <div class="cover-dim"></div>
  <div class="cover-brand"><img src="${absUrl('/logo-light.svg')}" style="height:28px;opacity:0.5;" /></div>
  <div class="cover-body">
    ${coverImg
      ? `<div class="cover-circle"><img src="${escHtml(coverImg)}" /></div>`
      : `<div class="cover-circle-ph"></div>`}
    <div class="cover-label">${escHtml(tr('pdf.travelPlan'))}</div>
    <div class="cover-title">${escHtml(trip?.title || 'My Trip')}</div>
    ${trip?.description ? `<div class="cover-desc">${escHtml(trip.description)}</div>` : ''}
    ${range ? `<div class="cover-dates">${range}</div>` : ''}
    <div class="cover-line"></div>
    <div class="cover-stats">
      <div>
        <div class="cover-stat-num">${sorted.length}</div>
        <div class="cover-stat-lbl">${escHtml(tr('dashboard.days'))}</div>
      </div>
      <div>
        <div class="cover-stat-num">${places?.length || 0}</div>
        <div class="cover-stat-lbl">${escHtml(tr('dashboard.places'))}</div>
      </div>
      <div>
        <div class="cover-stat-num">${totalAssigned}</div>
        <div class="cover-stat-lbl">${escHtml(tr('pdf.planned'))}</div>
      </div>
      ${totalCost > 0 ? `<div>
        <div class="cover-stat-num">${totalCost.toLocaleString(loc)}</div>
        <div class="cover-stat-lbl">${escHtml(tr('pdf.costLabel'))}</div>
      </div>` : ''}
    </div>
  </div>
</div>

<!-- Days -->
${daysHtml}

</body></html>`

  // Open in modal with srcdoc iframe (no URL loading = no X-Frame-Options issue)
  const overlay = document.createElement('div')
  overlay.id = 'pdf-preview-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:8px;'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const card = document.createElement('div')
  card.style.cssText = 'width:100%;max-width:1000px;height:95vh;background:var(--bg-card);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);'

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border-primary);flex-shrink:0;'
  header.innerHTML = `
    <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${escHtml(trip?.title || tr('pdf.travelPlan'))}</span>
    <div style="display:flex;align-items:center;gap:8px">
      <button id="pdf-print-btn" style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;font-family:inherit">${tr('pdf.saveAsPdf')}</button>
      <button id="pdf-close-btn" style="background:none;border:none;cursor:pointer;color:var(--text-faint);display:flex;padding:4px;border-radius:6px">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `

  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'flex:1;width:100%;border:none;'
  iframe.sandbox = 'allow-same-origin allow-modals allow-scripts'
  iframe.srcdoc = html

  card.appendChild(header)
  card.appendChild(iframe)
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  header.querySelector('#pdf-close-btn').onclick = () => overlay.remove()
  header.querySelector('#pdf-print-btn').onclick = () => { iframe.contentWindow?.print() }
}
