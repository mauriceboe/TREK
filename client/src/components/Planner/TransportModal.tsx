import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { Plane, Train, Car, Ship, Bus, Sailboat, Bike, CarTaxiFront, Route, TramFront, Paperclip, FileText, X, ExternalLink, Link2, Plus, Trash2 } from 'lucide-react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import CustomTimePicker from '../shared/CustomTimePicker'
import AirportSelect, { type Airport } from './AirportSelect'
import LocationSelect, { type LocationPoint } from './LocationSelect'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { useTripStore } from '../../store/tripStore'
import { useAddonStore } from '../../store/addonStore'
import { formatDate, splitReservationDateTime, resolveDayId } from '../../utils/formatters'
import { openFile } from '../../utils/fileDownload'
import apiClient from '../../api/client'
import type { Day, Place, Accommodation, Reservation, ReservationEndpoint, TripFile, BudgetItem, AssignmentsMap } from '../../types'
import { parseReservationMetadata, orderedEndpoints } from '../../utils/flightLegs'
import { BookingCostsSection } from './BookingCostsSection'
import { TravelerPicker } from './TravelerPicker'
import type { TripMember } from '../Budget/BudgetPanelMemberChips'
import type { BookingExpenseRequest } from './BookingCostsSection.types'
import type { BookingReviewDraft } from './parsedItemToDraft'
import TransitSearchPanel, { type PickedPlace } from './TransitSearchPanel'
import { typeToCostCategory } from '@trek/shared'

const TRANSPORT_TYPES = ['flight', 'train', 'bus', 'car', 'taxi', 'bicycle', 'cruise', 'ferry', 'transit', 'transport_other'] as const
type TransportType = typeof TRANSPORT_TYPES[number]

interface EndpointPick {
  airport?: Airport
  location?: LocationPoint
}

function endpointFromAirport(a: Airport, role: 'from' | 'to' | 'stop', sequence: number, date: string | null, time: string | null): Omit<ReservationEndpoint, 'id' | 'reservation_id'> {
  return {
    role, sequence,
    name: a.city ? `${a.city} (${a.iata})` : a.name,
    code: a.iata,
    lat: a.lat, lng: a.lng,
    timezone: a.tz,
    local_date: date,
    local_time: time,
  }
}

function endpointFromLocation(l: LocationPoint, role: 'from' | 'to' | 'stop', sequence: number, date: string | null, time: string | null): Omit<ReservationEndpoint, 'id' | 'reservation_id'> {
  return {
    role, sequence,
    name: l.name,
    code: null,
    lat: l.lat, lng: l.lng,
    timezone: null,
    local_date: date,
    local_time: time,
  }
}

// "Paris Charles de Gaulle (CDG)" → "Paris Charles de Gaulle". Done as a trim
// plus an anchored test instead of /\s*\([A-Z]{3}\)\s*$/, because the leading
// \s* backtracks over every space in a long name for a quadratic worst case.
function stripAirportCode(name: string): string {
  const trimmed = name.trimEnd()
  return /\([A-Z]{3}\)$/.test(trimmed) ? trimmed.slice(0, -5).trimEnd() : name
}

function airportFromEndpoint(e: ReservationEndpoint | undefined): Airport | null {
  if (!e || !e.code) return null
  return {
    iata: e.code, icao: null,
    name: e.name, city: stripAirportCode(e.name),
    country: '',
    lat: e.lat, lng: e.lng,
    tz: e.timezone || '',
  }
}

function locationFromEndpoint(e: ReservationEndpoint | undefined): LocationPoint | null {
  if (!e) return null
  return { name: e.name, lat: e.lat, lng: e.lng, address: null }
}

// ── Multi-leg flight waypoints ─────────────────────────────────────────────
// A flight is an ordered list of airports. The origin has only a departure, the
// destination only an arrival, and each intermediate stop has both — plus the
// airline/flight number of the flight LEAVING it. N waypoints = N-1 legs. A
// single-leg flight is just two waypoints, so it persists exactly as before.
interface WaypointForm {
  airport: Airport | null
  arrDayId: string | number
  arrTime: string
  depDayId: string | number
  depTime: string
  airline: string
  flight_number: string
  seat: string
  // Booking reference of the leg leaving this waypoint: airlines often issue one
  // per flight rather than one per booking (#1943). Empty means the booking's own.
  confirmation_number: string
}
function emptyWaypoint(dayId: string | number = ''): WaypointForm {
  return { airport: null, arrDayId: dayId, arrTime: '', depDayId: dayId, depTime: '', airline: '', flight_number: '', seat: '', confirmation_number: '' }
}

// ── Multi-leg train stations ───────────────────────────────────────────────
// A train mirrors the flight route model, but its waypoints are STATIONS
// (location search, no timezone) and each leg carries a train number + platform
// instead of an airline + flight number. N stations = N-1 legs.
interface StationWaypointForm {
  location: LocationPoint | null
  arrDayId: string | number
  arrTime: string
  depDayId: string | number
  depTime: string
  train_number: string
  platform: string
  seat: string
  confirmation_number: string
}
function emptyStationWaypoint(dayId: string | number = ''): StationWaypointForm {
  return { location: null, arrDayId: dayId, arrTime: '', depDayId: dayId, depTime: '', train_number: '', platform: '', seat: '', confirmation_number: '' }
}

const TYPE_OPTIONS = [
  { value: 'flight',          labelKey: 'reservations.type.flight',          Icon: Plane },
  { value: 'train',           labelKey: 'reservations.type.train',           Icon: Train },
  { value: 'bus',             labelKey: 'reservations.type.bus',             Icon: Bus },
  { value: 'car',             labelKey: 'reservations.type.car',             Icon: Car },
  { value: 'taxi',            labelKey: 'reservations.type.taxi',            Icon: CarTaxiFront },
  { value: 'bicycle',         labelKey: 'reservations.type.bicycle',         Icon: Bike },
  { value: 'cruise',          labelKey: 'reservations.type.cruise',          Icon: Ship },
  { value: 'ferry',           labelKey: 'reservations.type.ferry',           Icon: Sailboat },
  { value: 'transport_other', labelKey: 'reservations.type.transport_other', Icon: Route },
]

const defaultForm = {
  title: '',
  type: 'flight' as TransportType,
  status: 'pending' as 'pending' | 'confirmed',
  start_day_id: '' as string | number,
  end_day_id: '' as string | number,
  departure_time: '',
  arrival_time: '',
  confirmation_number: '',
  notes: '',
  meta_airline: '',
  meta_flight_number: '',
  meta_train_number: '',
  meta_platform: '',
  meta_seat: '',
}

interface TransportModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: Record<string, any> & { title: string }) => Promise<Reservation | undefined>
  reservation: Reservation | null
  days: Day[]
  selectedDayId: number | null
  files?: TripFile[]
  onFileUpload?: (fd: FormData) => Promise<unknown>
  onFileDelete?: (fileId: number) => Promise<void>
  onOpenExpense?: (req: BookingExpenseRequest) => void
  // Pre-fill a brand-new transport booking from a parsed import item (review-
  // before-save); like `reservation` for the form but stays in create mode.
  prefill?: BookingReviewDraft | null
  /** Data for the Automated (public transit) mode's quick picks. */
  places?: Place[]
  /** Day→assignments map, used to scope the quick picks to the chosen day (#1460). */
  assignments?: AssignmentsMap
  accommodations?: Accommodation[]
  /** Open directly in the Automated public-transit mode (day-header tram button, "change route"). */
  initialAutomated?: boolean
  /** Transit search needs real dates to depart on, so the Automated mode is hidden on a dateless trip. */
  tripHasDates?: boolean
  /** Pre-seed the transit search — used by "change route" and by per-leg planning. */
  transitPrefill?: { from?: PickedPlace | null; to?: PickedPlace | null; time?: string | null } | null
  /** Trip members + guests, for the traveler picker (#1517). */
  tripMembers?: TripMember[]
}

export function TransportModal({ isOpen, onClose, onSave, reservation, days, selectedDayId, files = [], onFileUpload, onFileDelete, onOpenExpense, prefill = null, places = [], assignments = {}, accommodations = [], initialAutomated = false, transitPrefill = null, tripHasDates = true, tripMembers = [] }: TransportModalProps) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const isBudgetEnabled = useAddonStore(s => s.isEnabled('budget'))
  const budgetItems = useTripStore(s => s.budgetItems)
  const deleteBudgetItem = useTripStore(s => s.deleteBudgetItem)
  const loadFiles = useTripStore(s => s.loadFiles)
  const setReservationTravelers = useTripStore(s => s.setReservationTravelers)
  const { id: tripId } = useParams<{ id: string }>()
  // Set right before submitting when the user clicked "create/edit expense", so
  // the post-save handler knows to open the Costs editor for the saved booking.
  const expenseIntentRef = useRef<{ editItem?: BudgetItem; create?: boolean } | null>(null)
  const [form, setForm] = useState({ ...defaultForm })
  // Manual vs Automated (public transit search) creation mode (#1065).
  const [automated, setAutomated] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [fromPick, setFromPick] = useState<EndpointPick>({})
  const [toPick, setToPick] = useState<EndpointPick>({})
  // Flight route as an ordered list of airports (origin .. stops .. destination).
  const [waypoints, setWaypoints] = useState<WaypointForm[]>([emptyWaypoint(), emptyWaypoint()])
  // Train route as an ordered list of stations (origin .. stops .. destination).
  const [trainWaypoints, setTrainWaypoints] = useState<StationWaypointForm[]>([emptyStationWaypoint(), emptyStationWaypoint()])
  const [uploadingFile, setUploadingFile] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [linkedFileIds, setLinkedFileIds] = useState<number[]>([])
  // Travelers assigned to this booking (#1517) — seeded on open, persisted after save.
  const [travelerIds, setTravelerIds] = useState<Set<number>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setTravelerIds(new Set((reservation?.travelers || []).map(tv => tv.user_id)))
    // Edit uses the saved `reservation`; a review-import populates from `prefill`.
    // Either way the init reads the same fields — `reservation` still decides
    // edit-vs-create at submit time.
    const src = (reservation ?? prefill) as Reservation | null
    if (src) setAutomated(initialAutomated)
    // On a review-import, seed the booking's Files with the parsed source document.
    setPendingFiles(!reservation && prefill?._sourceFiles ? prefill._sourceFiles : [])
    if (src) {
      const meta = typeof src.metadata === 'string'
        ? JSON.parse(src.metadata || '{}')
        : (src.metadata || {})
      const eps = src.endpoints || []
      const from = eps.find(e => e.role === 'from')
      const to = eps.find(e => e.role === 'to')
      // 'transport_other', not 'flight': an import whose type could not be read has
      // to arrive as something the user corrects, and a wrong flight looks right
      // enough to be saved unnoticed (#2076).
      const type = (TRANSPORT_TYPES as readonly string[]).includes(src.type)
        ? src.type as TransportType
        : 'transport_other'
      setForm({
        title: src.title || '',
        type,
        status: src.status === 'confirmed' ? 'confirmed' : 'pending',
        // For an edit, keep the saved day; for an imported prefill (no day_id), resolve it
        // from the parsed pick-up/return date so the date isn't lost on save.
        start_day_id: src.day_id ?? resolveDayId(days, splitReservationDateTime(src.reservation_time).date),
        end_day_id: src.end_day_id ?? resolveDayId(days, splitReservationDateTime(src.reservation_end_time).date),
        departure_time: splitReservationDateTime(src.reservation_time).time ?? '',
        arrival_time: splitReservationDateTime(src.reservation_end_time).time ?? '',
        confirmation_number: src.confirmation_number || '',
        notes: src.notes || '',
        meta_airline: meta.airline || '',
        meta_flight_number: meta.flight_number || '',
        meta_train_number: meta.train_number || '',
        meta_platform: meta.platform || '',
        meta_seat: meta.seat || '',
      })
      // Only an import prefill carries a per-endpoint local_date without a day_id. On an
      // edit the saved day wins: local_date is denormalised and can lag behind after a
      // day drag, insertDay or a trip-date shift, so resolving from it would silently
      // move the booking to another day on a plain re-save.
      const endpointDayId = (ep?: { local_date?: string | null } | null) =>
        reservation ? '' : resolveDayId(days, ep?.local_date)

      if (type === 'flight') {
        const orderedEps = orderedEndpoints(src)
        const metaLegs: any[] = Array.isArray(meta.legs) ? meta.legs : []
        let wps: WaypointForm[]
        if (orderedEps.length >= 2) {
          wps = orderedEps.map((ep, i) => {
            const legInto = metaLegs[i - 1] // leg arriving INTO waypoint i
            const legOut = metaLegs[i] // leg departing FROM waypoint i
            const isFirst = i === 0
            const isLast = i === orderedEps.length - 1
            return {
              airport: airportFromEndpoint(ep),
              // An import prefill gives each endpoint its own local_date but no day_id, so
              // resolve the day from that date — otherwise the review's per-leg day
              // selectors render empty even though the time, read from the same
              // endpoint, is filled.
              arrDayId: legInto?.arr_day_id ?? (endpointDayId(ep) || (isLast ? (src.end_day_id ?? '') : '')),
              arrTime: legInto?.arr_time ?? (!isFirst ? (ep.local_time ?? '') : ''),
              depDayId: legOut?.dep_day_id ?? (endpointDayId(ep) || (isFirst ? (src.day_id ?? '') : '')),
              depTime: legOut?.dep_time ?? (!isLast ? (ep.local_time ?? '') : ''),
              airline: legOut?.airline ?? (isFirst ? (meta.airline ?? '') : ''),
              flight_number: legOut?.flight_number ?? (isFirst ? (meta.flight_number ?? '') : ''),
              seat: legOut?.seat ?? (isFirst ? (meta.seat ?? '') : ''),
              // No fallback to src.confirmation_number: that one belongs to the
              // whole booking and stays in the form's own field, otherwise a
              // plain re-save would copy it onto the first leg.
              confirmation_number: legOut?.confirmation_number ?? '',
            }
          })
        } else {
          // Legacy flight with no (or partial) endpoints — seed two waypoints.
          const dep = emptyWaypoint(endpointDayId(from) || (src.day_id ?? ''))
          dep.airport = airportFromEndpoint(from)
          dep.depTime = splitReservationDateTime(src.reservation_time).time ?? ''
          dep.airline = meta.airline ?? ''
          dep.flight_number = meta.flight_number ?? ''
          dep.seat = meta.seat ?? ''
          const arr = emptyWaypoint(endpointDayId(to) || (src.end_day_id ?? src.day_id ?? ''))
          arr.airport = airportFromEndpoint(to)
          arr.arrTime = splitReservationDateTime(src.reservation_end_time).time ?? ''
          wps = [dep, arr]
        }
        setWaypoints(wps)
      } else if (type === 'train') {
        // Mirror the flight seeding with stations + per-leg train fields. A
        // current single-leg train (2 endpoints, no metadata.legs) round-trips
        // through the >=2 branch: the flat train_number/platform/seat land on
        // the first station, dep/arr day+time from src.day_id/end_day_id.
        const orderedEps = orderedEndpoints(src)
        const metaLegs: any[] = Array.isArray(meta.legs) ? meta.legs : []
        let wps: StationWaypointForm[]
        if (orderedEps.length >= 2) {
          wps = orderedEps.map((ep, i) => {
            const legInto = metaLegs[i - 1]
            const legOut = metaLegs[i]
            const isFirst = i === 0
            const isLast = i === orderedEps.length - 1
            return {
              location: locationFromEndpoint(ep),
              // See the flight branch: resolve each station's day from its endpoint local_date
              // so an import prefill doesn't leave the per-leg day selectors empty.
              arrDayId: legInto?.arr_day_id ?? (endpointDayId(ep) || (isLast ? (src.end_day_id ?? '') : '')),
              arrTime: legInto?.arr_time ?? (!isFirst ? (ep.local_time ?? '') : ''),
              depDayId: legOut?.dep_day_id ?? (endpointDayId(ep) || (isFirst ? (src.day_id ?? '') : '')),
              depTime: legOut?.dep_time ?? (!isLast ? (ep.local_time ?? '') : ''),
              train_number: legOut?.train_number ?? (isFirst ? (meta.train_number ?? '') : ''),
              platform: legOut?.platform ?? (isFirst ? (meta.platform ?? '') : ''),
              seat: legOut?.seat ?? (isFirst ? (meta.seat ?? '') : ''),
              // See the flight branch: the booking's own reference stays out of the legs.
              confirmation_number: legOut?.confirmation_number ?? '',
            }
          })
        } else {
          const dep = emptyStationWaypoint(endpointDayId(from) || (src.day_id ?? ''))
          dep.location = locationFromEndpoint(from)
          dep.depTime = splitReservationDateTime(src.reservation_time).time ?? ''
          dep.train_number = meta.train_number ?? ''
          dep.platform = meta.platform ?? ''
          dep.seat = meta.seat ?? ''
          const arr = emptyStationWaypoint(endpointDayId(to) || (src.end_day_id ?? src.day_id ?? ''))
          arr.location = locationFromEndpoint(to)
          arr.arrTime = splitReservationDateTime(src.reservation_end_time).time ?? ''
          wps = [dep, arr]
        }
        setTrainWaypoints(wps)
        setFromPick({})
        setToPick({})
      } else {
        setFromPick({ location: locationFromEndpoint(from) || undefined })
        setToPick({ location: locationFromEndpoint(to) || undefined })
      }
    } else {
      setForm({ ...defaultForm, start_day_id: selectedDayId ?? '', end_day_id: selectedDayId ?? '' })
      setAutomated(initialAutomated)
      setFromPick({})
      setToPick({})
      setWaypoints([emptyWaypoint(selectedDayId ?? ''), emptyWaypoint(selectedDayId ?? '')])
      setTrainWaypoints([emptyStationWaypoint(selectedDayId ?? ''), emptyStationWaypoint(selectedDayId ?? '')])
    }
  }, [isOpen, reservation, prefill, selectedDayId, budgetItems])

  const set = (field: string, value: any) => setForm(prev => ({ ...prev, [field]: value }))

  const toggleTraveler = (id: number) => setTravelerIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!form.title.trim()) return
    setIsSaving(true)
    try {
      const startDay = days.find(d => d.id === Number(form.start_day_id))
      const endDay = days.find(d => d.id === Number(form.end_day_id))

      const buildTime = (day: Day | undefined, time: string): string | null => {
        if (!time) return null
        return day?.date ? `${day.date}T${time}` : time
      }

      const dayDate = (id: string | number): string | null => days.find(d => d.id === Number(id))?.date ?? null
      // Flight route as an ordered list of airports (origin .. stops .. destination).
      const flightWps = form.type === 'flight' ? waypoints.filter(w => w.airport) : []
      const firstWp = flightWps[0]
      const lastWp = flightWps[flightWps.length - 1]
      // Train route: the first/last waypoint drive the span + flat metadata
      // (day/time/train number are entered independently of geocoding, exactly
      // like the old form fields, so a train with no map-picked station still
      // saves its day/time/train number). Only geocoded stations become map
      // endpoints + legs, mirroring the old "push only if the location is set".
      const trainWps = form.type === 'train' ? trainWaypoints : []
      const firstTrainWp = trainWps[0]
      const lastTrainWp = trainWps[trainWps.length - 1]
      const trainStations = form.type === 'train' ? trainWaypoints.filter(w => w.location) : []
      // Per-leg day-plan positions are owned by the day planner, not this form — keep
      // them when re-saving so editing a flight doesn't reset where its legs sit.
      const origLegs: any[] = reservation ? (parseReservationMetadata(reservation).legs || []) : []

      const metadata: Record<string, any> = {}
      if (form.type === 'flight') {
        // Top-level keys mirror the first/last leg so legacy readers keep working.
        if (firstWp?.airline) metadata.airline = firstWp.airline
        if (firstWp?.flight_number) metadata.flight_number = firstWp.flight_number
        if (firstWp?.airport) {
          metadata.departure_airport = firstWp.airport.iata
          metadata.departure_timezone = firstWp.airport.tz
        }
        if (lastWp?.airport) {
          metadata.arrival_airport = lastWp.airport.iata
          metadata.arrival_timezone = lastWp.airport.tz
        }
        // Per-leg detail only for true multi-leg flights — a single-leg flight
        // keeps the exact same (flat) metadata it had before this feature.
        if (flightWps.length > 2) {
          metadata.legs = flightWps.slice(0, -1).map((w, i) => {
            const next = flightWps[i + 1]
            return {
              from: w.airport!.iata,
              to: next.airport!.iata,
              ...(w.airline ? { airline: w.airline } : {}),
              ...(w.flight_number ? { flight_number: w.flight_number } : {}),
              ...(w.seat ? { seat: w.seat } : {}),
              ...(w.confirmation_number ? { confirmation_number: w.confirmation_number } : {}),
              dep_day_id: w.depDayId ? Number(w.depDayId) : null,
              dep_time: w.depTime || null,
              arr_day_id: next.arrDayId ? Number(next.arrDayId) : null,
              arr_time: next.arrTime || null,
              ...(origLegs[i]?.day_positions ? { day_positions: origLegs[i].day_positions } : {}),
            }
          })
        }
        if (firstWp?.seat) metadata.seat = firstWp.seat
      } else if (form.type === 'train') {
        // Flat keys mirror the first leg so legacy readers keep working; a
        // 2-station train emits exactly {train_number?,platform?,seat?} — the
        // same shape it saved before this feature.
        if (firstTrainWp?.train_number) metadata.train_number = firstTrainWp.train_number
        if (firstTrainWp?.platform) metadata.platform = firstTrainWp.platform
        if (firstTrainWp?.seat) metadata.seat = firstTrainWp.seat
        // Per-leg detail only for a true multi-leg train (>2 geocoded stations);
        // a simple train keeps the same flat metadata it saved before.
        if (trainStations.length > 2) {
          metadata.legs = trainStations.slice(0, -1).map((w, i) => {
            const next = trainStations[i + 1]
            return {
              from: w.location!.name,
              to: next.location!.name,
              ...(w.train_number ? { train_number: w.train_number } : {}),
              ...(w.platform ? { platform: w.platform } : {}),
              ...(w.seat ? { seat: w.seat } : {}),
              ...(w.confirmation_number ? { confirmation_number: w.confirmation_number } : {}),
              dep_day_id: w.depDayId ? Number(w.depDayId) : null,
              dep_time: w.depTime || null,
              arr_day_id: next.arrDayId ? Number(next.arrDayId) : null,
              arr_time: next.arrTime || null,
              ...(origLegs[i]?.day_positions ? { day_positions: origLegs[i].day_positions } : {}),
            }
          })
        }
      }

      // A transit itinerary (#1065) lives in metadata.transit + 'stop' endpoints,
      // neither of which this form shows or edits — so re-saving must not wipe
      // them. They're kept only while from/to are unchanged: picking a different
      // origin or destination invalidates the stored connection.
      const prevMeta = reservation ? parseReservationMetadata(reservation) : {}
      const prevEndpointsAll = reservation?.endpoints || []
      const prevFrom = prevEndpointsAll.find(ep => ep.role === 'from')
      const prevTo = prevEndpointsAll.find(ep => ep.role === 'to')
      const near = (a?: number | null, b?: number | null) => a != null && b != null && Math.abs(a - b) < 1e-6
      const keepTransit = !!(prevMeta.transit && form.type !== 'flight' &&
        prevFrom && prevTo && fromPick.location && toPick.location &&
        near(prevFrom.lat, fromPick.location.lat) && near(prevFrom.lng, fromPick.location.lng) &&
        near(prevTo.lat, toPick.location.lat) && near(prevTo.lng, toPick.location.lng))
      if (keepTransit) metadata.transit = prevMeta.transit
      // A joined AirTrail import (#1535) records every source flight id in
      // metadata.airtrail_ids so the picker doesn't offer those legs again —
      // an edit in this form must not drop that linkage.
      if (Array.isArray(prevMeta.airtrail_ids)) metadata.airtrail_ids = prevMeta.airtrail_ids

      const startDate = startDay?.date ?? null
      const endDate = (endDay ?? startDay)?.date ?? null
      const endpoints: ReturnType<typeof endpointFromAirport>[] = []
      if (form.type === 'flight') {
        flightWps.forEach((w, i) => {
          const isFirst = i === 0
          const isLast = i === flightWps.length - 1
          const role: 'from' | 'to' | 'stop' = isFirst ? 'from' : isLast ? 'to' : 'stop'
          const dId = isLast ? w.arrDayId : w.depDayId
          const time = isLast ? w.arrTime : w.depTime
          endpoints.push(endpointFromAirport(w.airport!, role, i, dayDate(dId), time || null))
        })
      } else if (form.type === 'train') {
        trainStations.forEach((w, i) => {
          const isFirst = i === 0
          const isLast = i === trainStations.length - 1
          const role: 'from' | 'to' | 'stop' = isFirst ? 'from' : isLast ? 'to' : 'stop'
          const dId = isLast ? w.arrDayId : w.depDayId
          const time = isLast ? w.arrTime : w.depTime
          // The destination date falls back to the departure day (as the old flat
          // path did via `endDay ?? startDay`) when the arrival day is left blank.
          const date = dayDate(dId) ?? (isLast ? dayDate(firstTrainWp?.depDayId ?? '') : null)
          endpoints.push(endpointFromLocation(w.location!, role, i, date, time || null))
        })
      } else {
        if (fromPick.location) endpoints.push(endpointFromLocation(fromPick.location, 'from', 0, startDate, form.departure_time || null))
        // Keep the itinerary's transfer stops while the route is unchanged (#1065).
        const stops = keepTransit
          ? prevEndpointsAll.filter(ep => ep.role === 'stop').slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
          : []
        stops.forEach((s, i) => endpoints.push({
          role: 'stop', sequence: i + 1, name: s.name, code: s.code ?? null,
          lat: s.lat, lng: s.lng, timezone: s.timezone ?? null,
          local_date: s.local_date ?? null, local_time: s.local_time ?? null,
        }))
        if (toPick.location) endpoints.push(endpointFromLocation(toPick.location, 'to', stops.length + 1, endDate, form.arrival_time || null))
      }

      // Flights and trains derive their span from the first/last waypoint; other
      // transports keep using the single departure/arrival form fields unchanged.
      const flightDepDay = firstWp && firstWp.depDayId ? Number(firstWp.depDayId) : null
      const flightArrDay = lastWp && lastWp.arrDayId ? Number(lastWp.arrDayId) : null
      const trainDepDay = firstTrainWp && firstTrainWp.depDayId ? Number(firstTrainWp.depDayId) : null
      const trainArrDay = lastTrainWp && lastTrainWp.arrDayId ? Number(lastTrainWp.arrDayId) : null
      const payload = {
        title: form.title,
        type: form.type,
        status: form.status,
        day_id: form.type === 'flight' ? flightDepDay : form.type === 'train' ? trainDepDay : (form.start_day_id ? Number(form.start_day_id) : null),
        end_day_id: form.type === 'flight' ? flightArrDay : form.type === 'train' ? trainArrDay : (form.end_day_id ? Number(form.end_day_id) : null),
        reservation_time: form.type === 'flight'
          ? buildTime(days.find(d => d.id === flightDepDay), firstWp?.depTime || '')
          : form.type === 'train'
            ? buildTime(days.find(d => d.id === trainDepDay), firstTrainWp?.depTime || '')
            : buildTime(startDay, form.departure_time),
        reservation_end_time: form.type === 'flight'
          ? buildTime(days.find(d => d.id === flightArrDay), lastWp?.arrTime || '')
          : form.type === 'train'
            // Fall back to the departure day so a same-day train (arrival day left
            // blank) still gets its date, matching the non-flight `endDay ?? startDay`.
            ? buildTime(days.find(d => d.id === trainArrDay) ?? days.find(d => d.id === trainDepDay), lastTrainWp?.arrTime || '')
            : buildTime(endDay ?? startDay, form.arrival_time),
        location: null,
        confirmation_number: form.confirmation_number || null,
        notes: form.notes || null,
        // An empty object, not null: null clears the column outright, and that
        // took the mirrored booking price with it on every edit of a type that
        // fills no metadata of its own — restaurant, event, tour, parking, other,
        // a hotel without check-in times (#2233). An object still clears what the
        // form dropped, and lets the server carry the price across.
        metadata,
        endpoints,
        needs_review: false,
      }
      // Imported booking → auto-create the linked cost from the parsed price (what the
      // old direct import did). Only on create (not edit) and only when there's a price.
      if (!reservation && prefill && isBudgetEnabled) {
        const pmeta = prefill.metadata && typeof prefill.metadata === 'object' ? (prefill.metadata as Record<string, unknown>) : {}
        const price = Number(pmeta.price)
        if (Number.isFinite(price) && price > 0) {
          ;(payload as Record<string, unknown>).create_budget_entry = { total_price: price, category: typeToCostCategory(form.type) }
        }
      }
      const saved = await onSave(payload)
      // Persist the traveler assignment once we have the reservation id (create → save
      // result, edit → existing reservation), and only when it actually changed (#1517).
      const savedId = saved?.id ?? reservation?.id
      if (savedId && tripId) {
        const original = (reservation?.travelers || []).map(tv => tv.user_id)
        const nextIds = [...travelerIds]
        const changed = original.length !== nextIds.length || nextIds.some(id => !original.includes(id))
        if (changed) {
          try { await setReservationTravelers(tripId, savedId, nextIds) } catch { toast.error(t('common.unknownError')) }
        }
      }
      if (!reservation?.id && saved?.id && pendingFiles.length > 0 && onFileUpload) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('reservation_id', String(saved.id))
          fd.append('description', form.title)
          await onFileUpload(fd)
        }
      }
      // The user asked to create/edit the linked expense — open the Costs editor
      // for the now-saved booking. Gated on saved?.id so a failed save doesn't.
      const intent = expenseIntentRef.current
      expenseIntentRef.current = null
      if (intent && onOpenExpense && saved?.id) {
        if (intent.editItem) onOpenExpense({ editItem: intent.editItem })
        else onOpenExpense({ prefill: { reservationId: saved.id, name: form.title, category: typeToCostCategory(form.type) } })
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.unknownError'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleCreateExpense = () => { expenseIntentRef.current = { create: true }; handleSubmit() }
  const handleEditExpense = (item: BudgetItem) => { expenseIntentRef.current = { editItem: item }; handleSubmit() }
  const handleRemoveExpense = async (item: BudgetItem) => {
    try { await deleteBudgetItem(Number(tripId), item.id) } catch { toast.error(t('common.unknownError')) }
  }

  // On an import review (not yet saved), preview the parsed price as the cost that will be linked.
  const prefillMeta = prefill?.metadata && typeof prefill.metadata === 'object' ? (prefill.metadata as Record<string, unknown>) : null
  const prefillPrice = Number(prefillMeta?.price)
  const pendingExpense = !reservation && Number.isFinite(prefillPrice) && prefillPrice > 0
    ? { total_price: prefillPrice, currency: (prefillMeta?.priceCurrency as string | null) ?? null, category: typeToCostCategory(form.type) }
    : null

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (reservation?.id) {
      setUploadingFile(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('reservation_id', String(reservation.id))
        fd.append('description', reservation.title)
        await onFileUpload!(fd)
        toast.success(t('reservations.toast.fileUploaded'))
      } catch {
        toast.error(t('reservations.toast.uploadError'))
      } finally {
        setUploadingFile(false)
        e.target.value = ''
      }
    } else {
      setPendingFiles(prev => [...prev, file])
      e.target.value = ''
    }
  }

  const attachedFiles = reservation?.id
    ? files.filter(f =>
        f.reservation_id === reservation.id ||
        linkedFileIds.includes(f.id) ||
        (f.linked_reservation_ids && f.linked_reservation_ids.includes(reservation.id))
      )
    : []

  const inputClass = 'w-full border border-edge rounded-[10px] px-[12px] py-[8px] text-[13px] font-[inherit] outline-none box-border text-content bg-surface-input'
  const labelClass = 'block text-[11px] font-semibold text-content-faint mb-[5px] uppercase tracking-[0.03em]'

  const dayOptions = [
    { value: '', label: '—' },
    ...days.map(d => {
      const dateBadge = d.date ? (formatDate(d.date, locale) ?? undefined) : undefined
      const dayBadge = d.title ? t('dayplan.dayN', { n: d.day_number }) : undefined
      return {
        value: d.id,
        label: d.title || t('dayplan.dayN', { n: d.day_number }),
        badge: dateBadge ?? dayBadge,
      }
    }),
  ]

  // The per-leg booking code is only offered where handleSubmit actually writes
  // metadata.legs: the SAME condition, over the waypoints that become endpoints,
  // not over the raw rows. Anywhere else the value would vanish on save (#1943).
  const writesFlightLegs = waypoints.filter(w => w.airport).length > 2
  const writesTrainLegs = trainWaypoints.filter(w => w.location).length > 2

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={automated ? t('transit.title') : reservation ? t('transport.modalTitle.edit') : t('transport.modalTitle.create')}
      size="2xl"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} className="text-content-muted" style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 'calc(12px * var(--fs-scale-body, 1))', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('common.cancel')}
          </button>
          {!automated && (
          <button type="button" onClick={handleSubmit} disabled={isSaving || !form.title.trim()} className="bg-[var(--text-primary)] text-[var(--bg-primary)]" style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: isSaving || !form.title.trim() ? 0.5 : 1 }}>
            {isSaving ? t('common.saving') : reservation ? t('common.update') : t('common.add')}
          </button>
          )}
        </div>
      }
    >
      {/* Manual vs Automated creation switch (#1065) — creating only; editing a
          journey re-enters via "change route" with the switch hidden. Without
          trip dates there is nothing to plan a departure against, so Automated
          is not offered and only the manual form shows. */}
      {!reservation && tripHasDates && (
        <div className="bg-surface-secondary" style={{ display: 'flex', borderRadius: 11, padding: 3, gap: 2, marginBottom: 14 }}>
          {([['manual', t('transport.modeManual')], ['automated', t('transport.modeAutomated')]] as const).map(([m, label]) => {
            const active = (m === 'automated') === automated
            return (
              <button key={m} type="button" onClick={() => setAutomated(m === 'automated')}
                className={active ? 'bg-surface-card text-content' : 'text-content-muted'}
                style={{ flex: 1, padding: '8px 6px', fontSize: 'calc(12.5px * var(--fs-scale-body, 1))', fontWeight: 500, borderRadius: 8, border: 0, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', background: active ? undefined : 'transparent', boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none' }}>
                {label}
              </button>
            )
          })}
        </div>
      )}

      {automated ? (
        /* ── Automated: public transit search (#1065) ── */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* search header: what this is + the day it plans for */}
          <div className="bg-surface-tertiary" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, flexWrap: 'wrap' }}>
            <div style={{ width: 42, height: 42, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: '#7c3aed18' }}>
              <TramFront size={20} strokeWidth={1.8} color="#7c3aed" />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div className="text-content" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 700, letterSpacing: '-0.01em' }}>{t('transit.title')}</div>
              <div className="text-content-faint" style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', marginTop: 1 }}>{t('transit.searchHint')}</div>
            </div>
            <div style={{ width: typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : 210, flexShrink: 0 }}>
              <CustomSelect value={form.start_day_id} onChange={v => set('start_day_id', v)} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
            </div>
          </div>
          {(() => {
            const transitDay = days.find(d => d.id === Number(form.start_day_id))
            if (!transitDay) return <div className="text-content-faint" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', padding: '4px 2px 12px' }}>{t('transit.pickDay')}</div>
            // Quick picks offer the chosen day's itinerary, not the whole trip (#1460).
            const dayPlaces = (assignments[String(transitDay.id)] || [])
              .slice().sort((a, b) => a.order_index - b.order_index)
              .map(a => places.find(p => p.id === a.place_id))
              .filter((p): p is Place => p != null)
            return (
              <TransitSearchPanel
                day={transitDay}
                days={days}
                places={dayPlaces}
                accommodations={accommodations}
                onAdd={(payload) => onSave(payload as Record<string, any> & { title: string })}
                initialFrom={transitPrefill?.from ?? null}
                initialTo={transitPrefill?.to ?? null}
                initialTime={transitPrefill?.time ?? null}
              />
            )
          })()}
        </div>
      ) : (
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Type selector */}
        <div>
          <label className={labelClass}>{t('reservations.bookingType')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {TYPE_OPTIONS.map(({ value, labelKey, Icon }) => (
              <button key={value} type="button" onClick={() => set('type', value)} className={form.type === value ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]' : 'bg-surface-card text-content-muted'} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', borderRadius: 99, border: '1px solid',
                fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s',
                borderColor: form.type === value ? 'var(--text-primary)' : 'var(--border-primary)',
              }}>
                <Icon size={11} /> {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className={labelClass}>{t('reservations.titleLabel')} *</label>
          <input type="text" value={form.title} onChange={e => set('title', e.target.value)} required
            placeholder={t('reservations.titlePlaceholder')} className={inputClass} />
        </div>

        {form.type === 'flight' ? (
          /* ── Flight route: ordered airports (origin · stops · destination) ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className={labelClass}>{t('reservations.layover.route')}</label>
            {waypoints.map((wp, i) => {
              const isFirst = i === 0
              const isLast = i === waypoints.length - 1
              const updateWp = (patch: Partial<WaypointForm>) => setWaypoints(prev => prev.map((w, j) => (j === i ? { ...w, ...patch } : w)))
              const roleLabel = isFirst ? t('reservations.meta.from') : isLast ? t('reservations.meta.to') : t('reservations.layover.stop')
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="bg-surface-card" style={{ border: '1px solid var(--border-primary)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="text-content-faint" style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0 }}>{roleLabel}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <AirportSelect value={wp.airport} onChange={a => updateWp({ airport: a || null })} />
                      </div>
                      {!isFirst && !isLast && (
                        <button type="button" onClick={() => setWaypoints(prev => prev.filter((_, j) => j !== i))} aria-label={t('common.delete')} className="text-content-faint" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4, flexShrink: 0 }}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    {!isFirst && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label className={labelClass}>{t('reservations.arrivalDate')}</label>
                          <CustomSelect value={wp.arrDayId} onChange={v => updateWp({ arrDayId: v })} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label className={labelClass}>{t('reservations.arrivalTime')}</label>
                          <CustomTimePicker value={wp.arrTime} onChange={v => updateWp({ arrTime: v })} />
                        </div>
                        {wp.airport && (
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <label className={labelClass}>{t('reservations.meta.arrivalTimezone')}</label>
                            <div className={inputClass} style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fs-scale-body, 1))', background: 'var(--bg-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={wp.airport.tz}>{wp.airport.tz}</div>
                          </div>
                        )}
                      </div>
                    )}
                    {!isLast && (
                      <>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <label className={labelClass}>{t('reservations.departureDate')}</label>
                            <CustomSelect value={wp.depDayId} onChange={v => updateWp({ depDayId: v })} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <label className={labelClass}>{t('reservations.departureTime')}</label>
                            <CustomTimePicker value={wp.depTime} onChange={v => updateWp({ depTime: v })} />
                          </div>
                          {wp.airport && (
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <label className={labelClass}>{t('reservations.meta.departureTimezone')}</label>
                              <div className={inputClass} style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fs-scale-body, 1))', background: 'var(--bg-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={wp.airport.tz}>{wp.airport.tz}</div>
                            </div>
                          )}
                        </div>
                        <div className={`grid grid-cols-1 ${writesFlightLegs ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-3`}>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.airline')}</label>
                            <input type="text" value={wp.airline} onChange={e => updateWp({ airline: e.target.value })} placeholder="Lufthansa" className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.flightNumber')}</label>
                            <input type="text" value={wp.flight_number} onChange={e => updateWp({ flight_number: e.target.value })} placeholder="LH 123" className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.seat')}</label>
                            <input type="text" value={wp.seat} onChange={e => updateWp({ seat: e.target.value })} placeholder="12A" className={inputClass} />
                          </div>
                          {writesFlightLegs && (
                            <div>
                              <label className={labelClass}>{t('reservations.confirmationCode')}</label>
                              <input type="text" value={wp.confirmation_number} onChange={e => updateWp({ confirmation_number: e.target.value })}
                                placeholder={t('reservations.confirmationPlaceholder')} className={inputClass} />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {!isLast && (
                    <button type="button" onClick={() => setWaypoints(prev => [...prev.slice(0, i + 1), emptyWaypoint(prev[i]?.depDayId || ''), ...prev.slice(i + 1)])}
                      className="text-content-faint hover:text-content-secondary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '6px 10px', border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', cursor: 'pointer', fontFamily: 'inherit' }}>
                      <Plus size={12} /> {t('reservations.layover.addStop')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : form.type === 'train' ? (
          /* ── Train route: ordered stations (origin · stops · destination) ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className={labelClass}>{t('reservations.layover.route')}</label>
            {trainWaypoints.map((wp, i) => {
              const isFirst = i === 0
              const isLast = i === trainWaypoints.length - 1
              const updateWp = (patch: Partial<StationWaypointForm>) => setTrainWaypoints(prev => prev.map((w, j) => (j === i ? { ...w, ...patch } : w)))
              const roleLabel = isFirst ? t('reservations.meta.from') : isLast ? t('reservations.meta.to') : t('reservations.layover.stop')
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="bg-surface-card" style={{ border: '1px solid var(--border-primary)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="text-content-faint" style={{ fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0 }}>{roleLabel}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <LocationSelect value={wp.location} onChange={l => updateWp({ location: l || null })} />
                      </div>
                      {!isFirst && !isLast && (
                        <button type="button" onClick={() => setTrainWaypoints(prev => prev.filter((_, j) => j !== i))} aria-label={t('common.delete')} className="text-content-faint" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4, flexShrink: 0 }}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    {!isFirst && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label className={labelClass}>{t('reservations.arrivalDate')}</label>
                          <CustomSelect value={wp.arrDayId} onChange={v => updateWp({ arrDayId: v })} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <label className={labelClass}>{t('reservations.arrivalTime')}</label>
                          <CustomTimePicker value={wp.arrTime} onChange={v => updateWp({ arrTime: v })} />
                        </div>
                      </div>
                    )}
                    {!isLast && (
                      <>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <label className={labelClass}>{t('reservations.departureDate')}</label>
                            <CustomSelect value={wp.depDayId} onChange={v => updateWp({ depDayId: v })} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <label className={labelClass}>{t('reservations.departureTime')}</label>
                            <CustomTimePicker value={wp.depTime} onChange={v => updateWp({ depTime: v })} />
                          </div>
                        </div>
                        <div className={`grid grid-cols-1 ${writesTrainLegs ? 'sm:grid-cols-4' : 'sm:grid-cols-3'} gap-3`}>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.trainNumber')}</label>
                            <input type="text" value={wp.train_number} onChange={e => updateWp({ train_number: e.target.value })} placeholder="ICE 123" className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.platform')}</label>
                            <input type="text" value={wp.platform} onChange={e => updateWp({ platform: e.target.value })} placeholder="12" className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>{t('reservations.meta.seat')}</label>
                            <input type="text" value={wp.seat} onChange={e => updateWp({ seat: e.target.value })} placeholder="42A" className={inputClass} />
                          </div>
                          {writesTrainLegs && (
                            <div>
                              <label className={labelClass}>{t('reservations.confirmationCode')}</label>
                              <input type="text" value={wp.confirmation_number} onChange={e => updateWp({ confirmation_number: e.target.value })}
                                placeholder={t('reservations.confirmationPlaceholder')} className={inputClass} />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {!isLast && (
                    <button type="button" onClick={() => setTrainWaypoints(prev => [...prev.slice(0, i + 1), emptyStationWaypoint(prev[i]?.depDayId || ''), ...prev.slice(i + 1)])}
                      className="text-content-faint hover:text-content-secondary" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '6px 10px', border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none', fontSize: 'calc(11px * var(--fs-scale-caption, 1))', cursor: 'pointer', fontFamily: 'inherit' }}>
                      <Plus size={12} /> {t('reservations.layover.addStop')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            {/* From / To endpoints (non-flight) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('reservations.meta.from')}</label>
                <LocationSelect value={fromPick.location || null} onChange={l => setFromPick({ location: l || undefined })} />
              </div>
              <div>
                <label className={labelClass}>{t('reservations.meta.to')}</label>
                <LocationSelect value={toPick.location || null} onChange={l => setToPick({ location: l || undefined })} />
              </div>
            </div>

            {/* Departure row */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label className={labelClass}>{form.type === 'car' ? t('reservations.pickupDate') : t('reservations.date')}</label>
                <CustomSelect value={form.start_day_id} onChange={value => set('start_day_id', value)} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label className={labelClass}>{form.type === 'car' ? t('reservations.pickupTime') : t('reservations.startTime')}</label>
                <CustomTimePicker value={form.departure_time} onChange={v => set('departure_time', v)} />
              </div>
            </div>

            {/* Arrival row */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label className={labelClass}>{form.type === 'car' ? t('reservations.returnDate') : t('reservations.endDate')}</label>
                <CustomSelect value={form.end_day_id} onChange={value => set('end_day_id', value)} placeholder={t('dayplan.dayN', { n: '?' })} options={dayOptions} size="sm" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label className={labelClass}>{form.type === 'car' ? t('reservations.returnTime') : t('reservations.endTime')}</label>
                <CustomTimePicker value={form.arrival_time} onChange={v => set('arrival_time', v)} />
              </div>
            </div>
          </>
        )}

        {/* Train-specific fields */}
        {/* Train number / platform / seat are per-leg now (in the route above). */}

        {/* Booking Code + Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>{t('reservations.confirmationCode')}</label>
            <input type="text" value={form.confirmation_number} onChange={e => set('confirmation_number', e.target.value)}
              placeholder={t('reservations.confirmationPlaceholder')} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>{t('reservations.status')}</label>
            <CustomSelect
              value={form.status}
              onChange={value => set('status', value)}
              options={[
                { value: 'pending', label: t('reservations.pending') },
                { value: 'confirmed', label: t('reservations.confirmed') },
              ]}
              size="sm"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className={labelClass}>{t('reservations.notes')}</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
            placeholder={t('reservations.notesPlaceholder')}
            className={inputClass} style={{ resize: 'none', lineHeight: 1.5 }} />
        </div>

        {/* Travelers — assign trip members & guests to this transport (#1517) */}
        <div>
          <label className={labelClass}>{t('reservations.travelers.label')}</label>
          <TravelerPicker tripMembers={tripMembers} selectedIds={travelerIds} onToggle={toggleTraveler} />
        </div>

        {/* Files */}
        <div>
          <label className={labelClass}>{t('files.title')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {attachedFiles.map(f => (
              <div key={f.id} className="bg-surface-secondary" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 8 }}>
                <FileText size={12} className="text-content-muted" style={{ flexShrink: 0 }} />
                <span className="text-content-secondary" style={{ flex: 1, fontSize: 'calc(12px * var(--fs-scale-body, 1))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                <button type="button" onClick={() => { openFile(f.url).catch(() => {}) }} aria-label={t('common.open')} className="text-content-faint" style={{ background: 'none', border: 'none', padding: 0, display: 'flex', flexShrink: 0, cursor: 'pointer' }}><ExternalLink size={11} /></button>
                <button type="button" onClick={async () => {
                  if (f.reservation_id === reservation?.id) {
                    try { await apiClient.put(`/trips/${tripId}/files/${f.id}`, { reservation_id: null }) } catch { toast.error(t('reservations.toast.updateError')) }
                  }
                  try {
                    const linksRes = await apiClient.get(`/trips/${tripId}/files/${f.id}/links`)
                    const link = (linksRes.data.links || []).find((l: any) => l.reservation_id === reservation?.id)
                    if (link) await apiClient.delete(`/trips/${tripId}/files/${f.id}/link/${link.id}`)
                  } catch { toast.error(t('reservations.toast.updateError')) }
                  setLinkedFileIds(prev => prev.filter(id => id !== f.id))
                  if (tripId) loadFiles(tripId)
                }} className="text-content-faint" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, flexShrink: 0 }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            {pendingFiles.map((f, i) => (
              <div key={i} className="bg-surface-secondary" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 8 }}>
                <FileText size={12} className="text-content-muted" style={{ flexShrink: 0 }} />
                <span className="text-content-secondary" style={{ flex: 1, fontSize: 'calc(12px * var(--fs-scale-body, 1))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                  className="text-content-faint" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, flexShrink: 0 }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.pkpass,.pkpasses,image/*,application/vnd.apple.pkpass,application/vnd.apple.pkpasses" style={{ display: 'none' }} onChange={handleFileChange} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {onFileUpload && <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile} className="text-content-faint" style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
                fontSize: 'calc(11px * var(--fs-scale-caption, 1))', cursor: uploadingFile ? 'default' : 'pointer', fontFamily: 'inherit',
              }}>
                <Paperclip size={11} />
                {uploadingFile ? t('reservations.uploading') : t('reservations.attachFile')}
              </button>}
              {reservation?.id && files.filter(f => !f.deleted_at && !attachedFiles.some(af => af.id === f.id)).length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button type="button" onClick={() => setShowFilePicker(v => !v)} className="text-content-faint" style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
                    border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
                    fontSize: 'calc(11px * var(--fs-scale-caption, 1))', cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    <Link2 size={11} /> {t('reservations.linkExisting')}
                  </button>
                  {showFilePicker && (
                    <div className="bg-surface-card" style={{
                      position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50,
                      border: '1px solid var(--border-primary)', borderRadius: 10,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 4, minWidth: 220, maxHeight: 200, overflowY: 'auto',
                    }}>
                      {files.filter(f => !f.deleted_at && !attachedFiles.some(af => af.id === f.id)).map(f => (
                        <button key={f.id} type="button" onClick={async () => {
                          try {
                            await apiClient.post(`/trips/${tripId}/files/${f.id}/link`, { reservation_id: reservation.id })
                            setLinkedFileIds(prev => [...prev, f.id])
                            setShowFilePicker(false)
                            if (tripId) loadFiles(tripId)
                          } catch { toast.error(t('reservations.toast.updateError')) }
                        }}
                          className="text-content-secondary"
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
                            background: 'none', border: 'none', cursor: 'pointer', fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontFamily: 'inherit',
                            borderRadius: 7, textAlign: 'left',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                          <FileText size={12} className="text-content-faint" style={{ flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Costs — create / view the expense linked to this booking */}
        {isBudgetEnabled && (
          <BookingCostsSection
            reservationId={reservation?.id ?? null}
            pendingExpense={pendingExpense}
            onCreate={handleCreateExpense}
            onEdit={handleEditExpense}
            onRemove={handleRemoveExpense}
          />
        )}

      </form>
      )}
    </Modal>
  )
}
