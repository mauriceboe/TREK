import { useState, useEffect, useCallback, useRef } from 'react'
import Modal from '../shared/Modal'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { duffelApi, mapsApi } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { getApiErrorMessage } from '../../types'
import {
  Plane, Hotel, Search, ArrowRight, Clock, ChevronLeft, Users, Loader2, CheckCircle2,
  ArrowLeftRight, MapPin, Calendar, CreditCard, AlertTriangle, X, Plus, Minus,
} from 'lucide-react'

interface DuffelSearchModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: number
}

type Step = 'search' | 'results' | 'passengers' | 'confirmation'
type Mode = 'flights' | 'stays'

interface FlightSearchForm {
  origin: string
  destination: string
  departure_date: string
  return_date: string
  passengers: number
  cabin_class: string
}

interface StaySearchForm {
  latitude: string
  longitude: string
  location_name: string
  check_in_date: string
  check_out_date: string
  adults: number
  children_ages: number[]  // array of ages for each child
  rooms: number
}

interface PassengerForm {
  given_name: string
  family_name: string
  born_on: string
  gender: string
  email: string
  phone_number: string
  type: string
}

function formatDuration(dur: string | null | undefined): string {
  if (!dur) return ''
  const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?/)
  if (!match) return dur
  const h = match[1] || '0'
  const m = match[2] || '0'
  return `${h}h ${m}m`
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch { return iso }
}

export default function DuffelSearchModal({ isOpen, onClose, tripId }: DuffelSearchModalProps) {
  const { t } = useTranslation()
  const toast = useToast()

  const [step, setStep] = useState<Step>('search')
  const [mode, setMode] = useState<Mode>('flights')
  const [searching, setSearching] = useState(false)
  const [booking, setBooking] = useState(false)

  // Flight search
  const [flightForm, setFlightForm] = useState<FlightSearchForm>({
    origin: '', destination: '', departure_date: '', return_date: '',
    passengers: 1, cabin_class: 'economy',
  })

  // Stay search
  const [stayForm, setStayForm] = useState<StaySearchForm>({
    latitude: '', longitude: '', location_name: '',
    check_in_date: '', check_out_date: '', adults: 1, children_ages: [], rooms: 1,
  })

  // Google Places search for hotel location
  const hasMapsKey = useAuthStore(s => s.hasMapsKey)
  const { language } = useTranslation()
  const [locationSearch, setLocationSearch] = useState('')
  const [locationResults, setLocationResults] = useState<any[]>([])
  const [isSearchingLocation, setIsSearchingLocation] = useState(false)
  const locationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Results
  const [offers, setOffers] = useState<any[]>([])
  const [stayResults, setStayResults] = useState<any[]>([])
  const [selectedOffer, setSelectedOffer] = useState<any>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<string>('')

  // Passengers
  const [passengerForms, setPassengerForms] = useState<PassengerForm[]>([])

  // Confirmation
  const [confirmationData, setConfirmationData] = useState<any>(null)

  // Reset on close/reopen
  useEffect(() => {
    if (isOpen) {
      setStep('search')
      setOffers([])
      setStayResults([])
      setSelectedOffer(null)
      setConfirmationData(null)
    }
  }, [isOpen])

  // Countdown timer for offer expiry
  useEffect(() => {
    if (!expiresAt) { setTimeLeft(''); return }
    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now()
      if (diff <= 0) { setTimeLeft(t('duffel.expired')); return }
      const m = Math.floor(diff / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setTimeLeft(`${m}:${s.toString().padStart(2, '0')}`)
    }
    update()
    const iv = setInterval(update, 1000)
    return () => clearInterval(iv)
  }, [expiresAt, t])

  // ── Search ──────────────────────────────────────────────────────────

  const handleFlightSearch = useCallback(async () => {
    if (!flightForm.origin || !flightForm.destination || !flightForm.departure_date) return
    setSearching(true)
    try {
      const passengers = Array.from({ length: flightForm.passengers }, () => ({ type: 'adult' }))
      const result = await duffelApi.searchFlights(tripId, {
        origin: flightForm.origin.toUpperCase(),
        destination: flightForm.destination.toUpperCase(),
        departure_date: flightForm.departure_date,
        return_date: flightForm.return_date || undefined,
        passengers,
        cabin_class: flightForm.cabin_class,
      })
      const sortedOffers = (result.offers || []).sort((a: any, b: any) =>
        parseFloat(a.total_amount) - parseFloat(b.total_amount)
      )
      setOffers(sortedOffers)
      if (sortedOffers.length > 0 && sortedOffers[0].expires_at) {
        setExpiresAt(sortedOffers[0].expires_at)
      }
      setStep('results')
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('duffel.searchError')))
    } finally {
      setSearching(false)
    }
  }, [flightForm, tripId, t, toast])

  // Google Places location search
  const handleLocationSearch = useCallback(async (query: string) => {
    if (!query.trim()) { setLocationResults([]); return }
    setIsSearchingLocation(true)
    try {
      const result = await mapsApi.search(query, language)
      setLocationResults(result.places || [])
    } catch {
      setLocationResults([])
    } finally {
      setIsSearchingLocation(false)
    }
  }, [language])

  const handleLocationInput = useCallback((value: string) => {
    setLocationSearch(value)
    setStayForm(f => ({ ...f, location_name: value }))
    if (locationDebounceRef.current) clearTimeout(locationDebounceRef.current)
    if (value.trim().length >= 2 && hasMapsKey) {
      locationDebounceRef.current = setTimeout(() => handleLocationSearch(value), 400)
    } else {
      setLocationResults([])
    }
  }, [hasMapsKey, handleLocationSearch])

  const handleSelectLocation = useCallback((place: any) => {
    setStayForm(f => ({
      ...f,
      location_name: place.name || place.address || f.location_name,
      latitude: String(place.lat),
      longitude: String(place.lng),
    }))
    setLocationSearch(place.name || place.address || '')
    setLocationResults([])
  }, [])

  const handleStaySearch = useCallback(async () => {
    if (!stayForm.latitude || !stayForm.longitude || !stayForm.check_in_date || !stayForm.check_out_date) return
    setSearching(true)
    try {
      const guests: { type: string; age?: number }[] = []
      for (let i = 0; i < stayForm.adults; i++) {
        guests.push({ type: 'adult' })
      }
      for (const age of stayForm.children_ages) {
        guests.push({ type: 'child', age })
      }
      const result = await duffelApi.searchStays(tripId, {
        latitude: stayForm.latitude,
        longitude: stayForm.longitude,
        check_in_date: stayForm.check_in_date,
        check_out_date: stayForm.check_out_date,
        guests,
        rooms: stayForm.rooms,
      })
      setStayResults(result.results || [])
      setStep('results')
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('duffel.searchError')))
    } finally {
      setSearching(false)
    }
  }, [stayForm, tripId, t, toast])

  // ── Select Offer ────────────────────────────────────────────────────

  const handleSelectOffer = useCallback((offer: any) => {
    setSelectedOffer(offer)
    if (mode === 'flights') {
      const count = offer.passengers?.length || flightForm.passengers
      setPassengerForms(Array.from({ length: count }, (_, i) => ({
        given_name: '', family_name: '', born_on: '', gender: 'm',
        email: '', phone_number: '',
        type: offer.passengers?.[i]?.type || 'adult',
      })))
    } else {
      setPassengerForms([{
        given_name: '', family_name: '', born_on: '', gender: 'm',
        email: '', phone_number: '', type: 'adult',
      }])
    }
    setStep('passengers')
  }, [mode, flightForm.passengers])

  // ── Book ────────────────────────────────────────────────────────────

  const handleBook = useCallback(async () => {
    setBooking(true)
    try {
      if (mode === 'flights') {
        const passengers = passengerForms.map((p, i) => ({
          id: selectedOffer.passengers?.[i]?.id,
          given_name: p.given_name,
          family_name: p.family_name,
          born_on: p.born_on,
          gender: p.gender,
          email: p.email,
          phone_number: p.phone_number.startsWith('+') ? p.phone_number : `+${p.phone_number}`,
          type: p.type,
        }))
        const result = await duffelApi.bookFlight(tripId, {
          offer_id: selectedOffer.id,
          passengers,
        })
        setConfirmationData(result)
      } else {
        const guest = {
          given_name: passengerForms[0].given_name,
          family_name: passengerForms[0].family_name,
          email: passengerForms[0].email,
          phone_number: passengerForms[0].phone_number.startsWith('+') ? passengerForms[0].phone_number : `+${passengerForms[0].phone_number}`,
        }
        const result = await duffelApi.bookStay(tripId, {
          quote_id: selectedOffer.id,
          guest,
        })
        setConfirmationData(result)
      }
      setStep('confirmation')
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('duffel.bookingError')))
    } finally {
      setBooking(false)
    }
  }, [mode, selectedOffer, passengerForms, tripId, t, toast])

  // ── Update passenger form ───────────────────────────────────────────

  const updatePassenger = (idx: number, field: string, value: string) => {
    setPassengerForms(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p))
  }

  // ── Render ──────────────────────────────────────────────────────────

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-faint)',
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4,
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
    border: '1px solid var(--border-primary)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
  }

  const btnPrimary: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px',
    borderRadius: 10, border: 'none', background: 'var(--accent)',
    color: 'var(--accent-text)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  }

  const stepperBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: 8,
    border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
    color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
  }

  const btnSecondary: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px',
    borderRadius: 10, border: '1px solid var(--border-primary)', background: 'transparent',
    color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('duffel.title')} size="3xl">
      {/* ── Step: Search ──────────────────────────────────── */}
      {step === 'search' && (
        <div>
          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, padding: 4, borderRadius: 10, background: 'var(--bg-secondary)' }}>
            {(['flights', 'stays'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  flex: 1, padding: '10px 16px', borderRadius: 8, border: 'none',
                  background: mode === m ? 'var(--bg-card)' : 'transparent',
                  color: mode === m ? 'var(--text-primary)' : 'var(--text-faint)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                {m === 'flights' ? <Plane size={14} /> : <Hotel size={14} />}
                {m === 'flights' ? t('duffel.flights') : t('duffel.hotels')}
              </button>
            ))}
          </div>

          {mode === 'flights' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.origin')}</label>
                  <input
                    style={inputStyle}
                    value={flightForm.origin}
                    onChange={e => setFlightForm(f => ({ ...f, origin: e.target.value }))}
                    placeholder="LHR"
                    maxLength={3}
                  />
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.destination')}</label>
                  <input
                    style={inputStyle}
                    value={flightForm.destination}
                    onChange={e => setFlightForm(f => ({ ...f, destination: e.target.value }))}
                    placeholder="JFK"
                    maxLength={3}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.departureDate')}</label>
                  <input type="date" style={inputStyle} value={flightForm.departure_date}
                    onChange={e => setFlightForm(f => ({ ...f, departure_date: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.returnDate')}</label>
                  <input type="date" style={inputStyle} value={flightForm.return_date}
                    onChange={e => setFlightForm(f => ({ ...f, return_date: e.target.value }))} />
                  <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>{t('duffel.returnDateHint')}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.passengers')}</label>
                  <select style={inputStyle} value={flightForm.passengers}
                    onChange={e => setFlightForm(f => ({ ...f, passengers: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.cabinClass')}</label>
                  <select style={inputStyle} value={flightForm.cabin_class}
                    onChange={e => setFlightForm(f => ({ ...f, cabin_class: e.target.value }))}>
                    <option value="economy">{t('duffel.economy')}</option>
                    <option value="premium_economy">{t('duffel.premiumEconomy')}</option>
                    <option value="business">{t('duffel.business')}</option>
                    <option value="first">{t('duffel.first')}</option>
                  </select>
                </div>
              </div>
              <button
                onClick={handleFlightSearch}
                disabled={searching || !flightForm.origin || !flightForm.destination || !flightForm.departure_date}
                style={{ ...btnPrimary, opacity: searching ? 0.7 : 1, alignSelf: 'flex-start' }}
              >
                {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                {searching ? t('duffel.searching') : t('duffel.searchFlights')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Location search - Google Places or manual lat/lng */}
              <div style={{ position: 'relative' }}>
                <label style={labelStyle}>{t('duffel.locationName')}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    style={inputStyle}
                    value={locationSearch || stayForm.location_name}
                    onChange={e => handleLocationInput(e.target.value)}
                    placeholder={hasMapsKey ? t('duffel.locationSearchPlaceholder') : t('duffel.locationNamePlaceholder')}
                  />
                  {isSearchingLocation && (
                    <Loader2 size={14} className="animate-spin" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)' }} />
                  )}
                </div>
                {hasMapsKey && <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>{t('duffel.locationSearchHint')}</p>}
                {/* Location search results dropdown */}
                {locationResults.length > 0 && (
                  <div style={{
                    position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4,
                    background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border-primary)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 200, overflowY: 'auto',
                  }}>
                    {locationResults.map((place: any, idx: number) => (
                      <button
                        key={place.google_place_id || place.osm_id || idx}
                        onClick={() => handleSelectLocation(place)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '10px 12px', border: 'none', background: 'transparent',
                          cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                          borderBottom: idx < locationResults.length - 1 ? '1px solid var(--border-faint)' : 'none',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <MapPin size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {place.name}
                          </div>
                          {place.address && (
                            <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {place.address}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Manual lat/lng fallback (shown when no maps key or when coords are set) */}
              {(!hasMapsKey || stayForm.latitude) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>{t('duffel.latitude')}</label>
                    <input style={inputStyle} type="number" step="any" value={stayForm.latitude}
                      onChange={e => setStayForm(f => ({ ...f, latitude: e.target.value }))}
                      placeholder="48.8566" />
                  </div>
                  <div>
                    <label style={labelStyle}>{t('duffel.longitude')}</label>
                    <input style={inputStyle} type="number" step="any" value={stayForm.longitude}
                      onChange={e => setStayForm(f => ({ ...f, longitude: e.target.value }))}
                      placeholder="2.3522" />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.checkIn')}</label>
                  <input type="date" style={inputStyle} value={stayForm.check_in_date}
                    onChange={e => setStayForm(f => ({ ...f, check_in_date: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.checkOut')}</label>
                  <input type="date" style={inputStyle} value={stayForm.check_out_date}
                    onChange={e => setStayForm(f => ({ ...f, check_out_date: e.target.value }))} />
                </div>
              </div>
              {/* Adults, Children, Rooms */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.adults')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => setStayForm(f => ({ ...f, adults: Math.max(1, f.adults - 1) }))}
                      disabled={stayForm.adults <= 1}
                      style={{ ...stepperBtn, opacity: stayForm.adults <= 1 ? 0.3 : 1 }}
                    ><Minus size={12} /></button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', minWidth: 20, textAlign: 'center' }}>{stayForm.adults}</span>
                    <button
                      onClick={() => setStayForm(f => ({ ...f, adults: Math.min(9, f.adults + 1) }))}
                      disabled={stayForm.adults >= 9}
                      style={{ ...stepperBtn, opacity: stayForm.adults >= 9 ? 0.3 : 1 }}
                    ><Plus size={12} /></button>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.children')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      onClick={() => setStayForm(f => ({ ...f, children_ages: f.children_ages.slice(0, -1) }))}
                      disabled={stayForm.children_ages.length === 0}
                      style={{ ...stepperBtn, opacity: stayForm.children_ages.length === 0 ? 0.3 : 1 }}
                    ><Minus size={12} /></button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', minWidth: 20, textAlign: 'center' }}>{stayForm.children_ages.length}</span>
                    <button
                      onClick={() => setStayForm(f => ({ ...f, children_ages: [...f.children_ages, 5] }))}
                      disabled={stayForm.children_ages.length >= 6}
                      style={{ ...stepperBtn, opacity: stayForm.children_ages.length >= 6 ? 0.3 : 1 }}
                    ><Plus size={12} /></button>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.rooms')}</label>
                  <select style={inputStyle} value={stayForm.rooms}
                    onChange={e => setStayForm(f => ({ ...f, rooms: parseInt(e.target.value) }))}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              {/* Child ages */}
              {stayForm.children_ages.length > 0 && (
                <div>
                  <label style={labelStyle}>{t('duffel.childrenAges')}</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {stayForm.children_ages.map((age, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('duffel.childN', { n: idx + 1 })}</span>
                        <select
                          style={{ ...inputStyle, width: 60, padding: '4px 6px', fontSize: 12 }}
                          value={age}
                          onChange={e => {
                            const newAges = [...stayForm.children_ages]
                            newAges[idx] = parseInt(e.target.value)
                            setStayForm(f => ({ ...f, children_ages: newAges }))
                          }}
                        >
                          {Array.from({ length: 18 }, (_, i) => (
                            <option key={i} value={i}>{i}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={handleStaySearch}
                disabled={searching || !stayForm.latitude || !stayForm.longitude || !stayForm.check_in_date || !stayForm.check_out_date}
                style={{ ...btnPrimary, opacity: searching ? 0.7 : 1, alignSelf: 'flex-start' }}
              >
                {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                {searching ? t('duffel.searching') : t('duffel.searchHotels')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Step: Results ─────────────────────────────────── */}
      {step === 'results' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <button onClick={() => { setStep('search'); setOffers([]); setStayResults([]) }} style={btnSecondary}>
              <ChevronLeft size={14} /> {t('duffel.backToSearch')}
            </button>
            {expiresAt && timeLeft && mode === 'flights' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-faint)' }}>
                <Clock size={12} />
                {t('duffel.offersExpire', { time: timeLeft })}
              </div>
            )}
          </div>

          {mode === 'flights' ? (
            offers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                <Plane size={32} style={{ color: 'var(--text-faint)', margin: '0 auto 8px', display: 'block' }} />
                <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{t('duffel.noFlightsFound')}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 4 }}>
                  {t('duffel.resultsCount', { count: offers.length })}
                </p>
                {offers.map((offer: any) => {
                  const firstSlice = offer.slices?.[0]
                  const firstSeg = firstSlice?.segments?.[0]
                  const lastSeg = firstSlice?.segments?.[firstSlice.segments.length - 1]
                  const stops = (firstSlice?.segments?.length || 1) - 1
                  const airline = firstSeg?.operating_carrier?.name || firstSeg?.marketing_carrier?.name || ''
                  const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false

                  return (
                    <div
                      key={offer.id}
                      style={{
                        padding: '14px 16px', borderRadius: 12,
                        border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                        display: 'flex', alignItems: 'center', gap: 16,
                        opacity: isExpired ? 0.5 : 1,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{airline}</span>
                          {firstSeg?.operating_carrier_flight_number && (
                            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                              {firstSeg.operating_carrier?.iata_code || ''}{firstSeg.operating_carrier_flight_number}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                          <span style={{ fontWeight: 500 }}>{formatTime(firstSeg?.departing_at)}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{firstSeg?.origin?.iata_code}</span>
                          <ArrowRight size={12} style={{ color: 'var(--text-faint)' }} />
                          <span style={{ fontWeight: 500 }}>{formatTime(lastSeg?.arriving_at)}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{lastSeg?.destination?.iata_code}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 11, color: 'var(--text-faint)' }}>
                          <span>{formatDuration(firstSlice?.duration)}</span>
                          <span>{stops === 0 ? t('duffel.direct') : t('duffel.stops', { count: stops })}</span>
                          {firstSeg?.passengers?.[0]?.cabin_class_marketing_name && (
                            <span>{firstSeg.passengers[0].cabin_class_marketing_name}</span>
                          )}
                        </div>
                        {offer.slices?.length > 1 && (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-faint)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-faint)' }}>
                              <ArrowLeftRight size={10} />
                              {(() => {
                                const retSlice = offer.slices[1]
                                const retFirst = retSlice?.segments?.[0]
                                const retLast = retSlice?.segments?.[retSlice.segments.length - 1]
                                const retStops = (retSlice?.segments?.length || 1) - 1
                                return (
                                  <span>
                                    {t('duffel.returnFlight')}: {formatTime(retFirst?.departing_at)} {retFirst?.origin?.iata_code} → {formatTime(retLast?.arriving_at)} {retLast?.destination?.iata_code} · {formatDuration(retSlice?.duration)} · {retStops === 0 ? t('duffel.direct') : t('duffel.stops', { count: retStops })}
                                  </span>
                                )
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                          {offer.total_currency} {parseFloat(offer.total_amount).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 6 }}>
                          {t('duffel.totalPerBooking')}
                        </div>
                        <button
                          onClick={() => handleSelectOffer(offer)}
                          disabled={isExpired}
                          style={{
                            ...btnPrimary, padding: '6px 14px', fontSize: 12,
                            opacity: isExpired ? 0.5 : 1,
                          }}
                        >
                          {t('duffel.select')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          ) : (
            stayResults.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                <Hotel size={32} style={{ color: 'var(--text-faint)', margin: '0 auto 8px', display: 'block' }} />
                <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{t('duffel.noHotelsFound')}</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 4 }}>
                  {t('duffel.resultsCount', { count: stayResults.length })}
                </p>
                {stayResults.map((stay: any, idx: number) => (
                  <div
                    key={stay.id || idx}
                    style={{
                      padding: '14px 16px', borderRadius: 12,
                      border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
                      display: 'flex', alignItems: 'center', gap: 16,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                        {stay.accommodation?.name || stay.name || 'Hotel'}
                      </div>
                      {stay.accommodation?.location?.address && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-faint)' }}>
                          <MapPin size={11} /> {stay.accommodation.location.address}
                        </div>
                      )}
                      {stay.accommodation?.rating && (
                        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                          {'★'.repeat(Math.round(stay.accommodation.rating))} {stay.accommodation.rating}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {stay.total_currency || stay.cheapest_rate_currency} {parseFloat(stay.total_amount || stay.cheapest_rate_total_amount || '0').toFixed(2)}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 6 }}>
                        {t('duffel.totalStay')}
                      </div>
                      <button onClick={() => handleSelectOffer(stay)} style={{ ...btnPrimary, padding: '6px 14px', fontSize: 12 }}>
                        {t('duffel.select')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* ── Step: Passenger Details ───────────────────────── */}
      {step === 'passengers' && (
        <div>
          <button onClick={() => setStep('results')} style={{ ...btnSecondary, marginBottom: 16 }}>
            <ChevronLeft size={14} /> {t('duffel.backToResults')}
          </button>

          {selectedOffer && (
            <div style={{
              padding: '12px 16px', borderRadius: 10, marginBottom: 20,
              background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {mode === 'flights' ? (
                    <>
                      {selectedOffer.slices?.[0]?.segments?.[0]?.operating_carrier?.name || 'Flight'}
                      {' '}{selectedOffer.slices?.[0]?.segments?.[0]?.origin?.iata_code} → {selectedOffer.slices?.[0]?.segments?.[selectedOffer.slices[0].segments.length - 1]?.destination?.iata_code}
                    </>
                  ) : (
                    selectedOffer.accommodation?.name || selectedOffer.name || 'Hotel'
                  )}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {selectedOffer.total_currency || selectedOffer.cheapest_rate_currency} {parseFloat(selectedOffer.total_amount || selectedOffer.cheapest_rate_total_amount || '0').toFixed(2)}
                </div>
              </div>
            </div>
          )}

          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
            {mode === 'flights' ? t('duffel.passengerDetails') : t('duffel.guestDetails')}
          </h3>

          {passengerForms.map((p, idx) => (
            <div key={idx} style={{
              padding: 16, borderRadius: 12, marginBottom: 12,
              border: '1px solid var(--border-primary)', background: 'var(--bg-card)',
            }}>
              {passengerForms.length > 1 && (
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 8 }}>
                  {t('duffel.passengerN', { n: idx + 1 })} ({p.type})
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>{t('duffel.firstName')}</label>
                  <input style={inputStyle} value={p.given_name}
                    onChange={e => updatePassenger(idx, 'given_name', e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.lastName')}</label>
                  <input style={inputStyle} value={p.family_name}
                    onChange={e => updatePassenger(idx, 'family_name', e.target.value)} />
                </div>
                {mode === 'flights' && (
                  <>
                    <div>
                      <label style={labelStyle}>{t('duffel.dateOfBirth')}</label>
                      <input type="date" style={inputStyle} value={p.born_on}
                        onChange={e => updatePassenger(idx, 'born_on', e.target.value)} />
                    </div>
                    <div>
                      <label style={labelStyle}>{t('duffel.gender')}</label>
                      <select style={inputStyle} value={p.gender}
                        onChange={e => updatePassenger(idx, 'gender', e.target.value)}>
                        <option value="m">{t('duffel.male')}</option>
                        <option value="f">{t('duffel.female')}</option>
                      </select>
                    </div>
                  </>
                )}
                <div>
                  <label style={labelStyle}>{t('duffel.email')}</label>
                  <input type="email" style={inputStyle} value={p.email}
                    onChange={e => updatePassenger(idx, 'email', e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>{t('duffel.phone')}</label>
                  <input style={inputStyle} value={p.phone_number}
                    onChange={e => updatePassenger(idx, 'phone_number', e.target.value)}
                    placeholder="+1234567890" />
                </div>
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              onClick={handleBook}
              disabled={booking || passengerForms.some(p => !p.given_name || !p.family_name || !p.email || !p.phone_number)}
              style={{ ...btnPrimary, opacity: booking ? 0.7 : 1 }}
            >
              {booking ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
              {booking ? t('duffel.booking') : t('duffel.confirmBooking')}
            </button>
          </div>
        </div>
      )}

      {/* ── Step: Confirmation ────────────────────────────── */}
      {step === 'confirmation' && confirmationData && (
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <CheckCircle2 size={48} style={{ color: '#22c55e', margin: '0 auto 16px', display: 'block' }} />
          <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
            {t('duffel.bookingSuccess')}
          </h3>
          {confirmationData.duffel_order?.booking_reference && (
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('duffel.bookingReference')}: <strong>{confirmationData.duffel_order.booking_reference}</strong>
            </p>
          )}
          {confirmationData.duffel_booking?.booking_reference && (
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('duffel.bookingReference')}: <strong>{confirmationData.duffel_booking.booking_reference}</strong>
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 12 }}>
            {t('duffel.bookingAddedToReservations')}
          </p>
          <button onClick={onClose} style={{ ...btnPrimary, margin: '24px auto 0', justifyContent: 'center' }}>
            {t('common.close')}
          </button>
        </div>
      )}
    </Modal>
  )
}
