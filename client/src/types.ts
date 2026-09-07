// Shared types for the TREK travel planner.
//
// Domain entity/response types are now sourced from @trek/shared — the single
// source of truth shared with the server. The Zod schemas there are built to
// match the REAL server response shapes (see shared/src/<domain>/*.schema.ts,
// each documented against the producing service). Re-exported here so the rest
// of the client keeps importing from '../types' unchanged.
import type {
  TrekWsEventName,
  TrekWsPluginEventName,
  Trip,
  TripMember,
  Day,
  DayNote,
  Place,
  AssignmentPlace,
  PlaceCategory,
  Assignment,
  AssignmentParticipant,
  PackingItem,
  PackingBag,
  PackingBagMember,
  BudgetItem,
  BudgetItemMember,
  Reservation,
  ReservationEndpoint,
  Accommodation,
  Tag,
  Category,
  AppearanceConfig,
} from '@trek/shared'

export type {
  Trip,
  TripMember,
  Day,
  DayNote,
  Place,
  AssignmentPlace,
  PlaceCategory,
  Assignment,
  AssignmentParticipant,
  PackingItem,
  PackingBag,
  PackingBagMember,
  BudgetItem,
  BudgetItemMember,
  Reservation,
  ReservationEndpoint,
  Accommodation,
  Tag,
  Category,
  AppearanceConfig,
}

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  avatar_url: string | null
  maps_api_key: string | null
  created_at: string
  /** Present after load; true when TOTP MFA is enabled for password login */
  mfa_enabled?: boolean
  /** True when a password change is required before the user can continue */
  must_change_password?: boolean
}

export interface TodoItem {
  id: number
  trip_id: number
  name: string
  category: string | null
  checked: number
  sort_order: number
  due_date: string | null
  description: string | null
  assigned_user_id: number | null
  priority: number
}

export interface TripFile {
  id: number
  trip_id: number
  place_id?: number | null
  reservation_id?: number | null
  note_id?: number | null
  uploaded_by?: number | null
  uploaded_by_name?: string | null
  uploaded_by_avatar?: string | null
  filename: string
  original_name: string
  file_size?: number | null
  mime_type: string
  description?: string | null
  starred?: number
  deleted_at?: string | null
  created_at: string
  reservation_title?: string
  linked_reservation_ids?: (number | null)[]
  linked_place_ids?: (number | null)[]
  /** Served download path — always present on list/create/update responses (formatFile). */
  url: string
}

export type DistanceUnit = 'metric' | 'imperial'

export interface Settings {
  map_tile_url: string
  dark_mode: boolean | string
  /** Display currency for Costs. Empty/null = follow each trip's own currency. */
  default_currency: string | null
  language: string
  temperature_unit: string
  distance_unit?: DistanceUnit
  time_format: string
  show_place_description: boolean
  blur_booking_codes?: boolean
  map_booking_labels?: boolean
  map_poi_pill_enabled?: boolean
  map_always_show_routes?: boolean
  optimize_from_accommodation?: boolean
  map_provider?: 'leaflet' | 'mapbox-gl' | 'maplibre-gl'
  /** Leaflet base layer: default street tiles or a satellite/aerial view. */
  map_base_layer?: 'default' | 'satellite'
  /** CARTO basemaps watermark keyless tiles; the key is appended as ?key= (#2054). */
  carto_api_key?: string
  mapbox_access_token?: string
  mapbox_style?: string
  maplibre_style?: string
  mapbox_3d_enabled?: boolean
  mapbox_quality_mode?: boolean
  // Dashboard widget prefs — persisted server-side so a (docker) upgrade keeps them (#1311).
  dashboard_fx_from?: string
  dashboard_fx_to?: string
  dashboard_timezones?: string[]
  /** Where opening TREK lands: the dashboard, or straight in the active trip. */
  start_page?: 'dashboard' | 'active_trip'
  /** Which planner tab 'active_trip' opens on — a TripTabId (constants/tripTabs). */
  start_trip_tab?: string
  // AI booking-import fallback (per-user config; used when the admin has not set
  // instance-wide config on the llm_parsing addon). llm_api_key is masked on read.
  llm_provider?: 'local' | 'openai' | 'anthropic'
  llm_model?: string
  llm_base_url?: string
  llm_multimodal?: boolean
  llm_api_key?: string
  /** Per-user appearance/customization config (theming, transparency, typography, dashboard widgets). */
  appearance?: AppearanceConfig
}

export interface AssignmentsMap {
  [dayId: string]: Assignment[]
}

export interface DayNotesMap {
  [dayId: string]: DayNote[]
}

export interface RouteSegment {
  mid: [number, number]
  from: [number, number]
  to: [number, number]
  distance: number
  duration: number
  walkingText: string
  drivingText: string
  distanceText: string
  durationText?: string
  /** Extra text a plugin route attached to this leg (e.g. "25 min charge"). */
  noteText?: string
  /** The travel mode this leg was routed with (#1281) — drives the connector icon. */
  mode?: string
}

/** An intermediate stop a plugin route places on the drawn line (charging stop, rest area). */
export interface RouteVia {
  lat: number
  lng: number
  label?: string
  tone: 'default' | 'success' | 'warn' | 'danger'
  dwellSeconds?: number
}

export interface RouteWithLegs {
  coordinates: [number, number][]
  distance: number
  duration: number
  legs: RouteSegment[]
  /** Present on plugin-provided routes only. */
  vias?: RouteVia[]
}

export interface RouteResult {
  coordinates: [number, number][]
  distance: number
  duration: number
  distanceText: string
  durationText: string
  walkingText: string
  drivingText: string
}

export interface Waypoint {
  lat: number
  lng: number
}

// Optional fixed start/end points for route optimization (e.g. the day's accommodation).
export interface RouteAnchors {
  start?: Waypoint
  end?: Waypoint
}

// User with optional OIDC fields
export interface UserWithOidc extends User {
  oidc_issuer?: string | null
}

// Atlas place detail
export interface AtlasPlace {
  id: number
  name: string
  lat: number | null
  lng: number | null
}

// GeoJSON types (simplified for atlas map)
export interface GeoJsonFeature {
  type: 'Feature'
  properties: Record<string, string | number | null | undefined>
  geometry: {
    type: string
    coordinates: unknown
  }
  id?: string
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

// App config from /auth/app-config
export interface AppConfig {
  has_users: boolean
  allow_registration: boolean
  /** True when the operator of this install owns its configuration, not the admin */
  managed?: boolean
  demo_mode: boolean
  oidc_configured: boolean
  oidc_display_name?: string
  oidc_only_mode?: boolean
  has_maps_key?: boolean
  /** Amap (高德地图) key present for this caller — the alternative places provider. */
  has_amap_key?: boolean
  /** The admin's places provider choice: 'auto' | 'google' | 'amap' | 'openstreetmap'. */
  places_provider?: string
  allowed_file_types?: string
  timezone?: string
  /** When true, users without MFA cannot use the app until they enable it */
  require_mfa?: boolean
  // Granular auth toggles
  password_login?: boolean
  password_registration?: boolean
  oidc_login?: boolean
  oidc_registration?: boolean
  env_override_oidc_only?: boolean
}

// Translation function type
export type TranslationFn = (key: string, params?: Record<string, string | number | null>) => string

// WebSocket event type — `type` is derived from the shared WS event registry
// (TREK_WS_EVENTS): a registered name, the reserved plugin namespace, or (via
// the `string & {}` widening) a transport control frame the registry
// deliberately excludes (welcome/joined/left/error). Payload fields stay
// index-typed at this boundary; per-event payload contracts live in
// TrekWsPayload<E> from @trek/shared.
export interface WebSocketEvent {
  type: TrekWsEventName | TrekWsPluginEventName | (string & {})
  [key: string]: unknown
}

// Vacay types
export interface VacayHolidayCalendar {
  id: number
  plan_id: number
  type?: 'public_holiday' | 'school_holiday'
  region: string
  label: string | null
  color: string
  sort_order: number
}

export interface VacayPlan {
  id: number
  holidays_enabled: boolean
  school_holidays_enabled?: boolean
  holidays_region: string | null
  holiday_calendars: VacayHolidayCalendar[]
  block_weekends: boolean
  carry_over_enabled: boolean
  company_holidays_enabled: boolean
  // Comma-separated weekday indices (e.g. '0,6'); stored as TEXT on vacay_plans.
  weekend_days?: string
  week_start?: number
  name?: string
  year?: number
  owner_id?: number
  created_at?: string
  updated_at?: string
}

export interface VacayUser {
  id: number
  username: string
  color: string | null
}

export interface VacayEntry {
  date: string
  user_id: number
  plan_id?: number
  person_color?: string
  person_name?: string
  // Portion of a vacation day this entry counts as: 1 = full day, 0.5 = half
  // day (#552). Absent on legacy entries, which are treated as full days.
  fraction?: number
  // Leave type (#1074): 'comp' = flex/comp day (does not touch the entitlement),
  // 'vacation' (or absent, for legacy entries) = a regular vacation day.
  kind?: 'vacation' | 'comp'
}

// Vacay per-user stats row as returned by getStats
// (server/src/services/vacayService.ts -> getStats).
export interface VacayStat {
  user_id: number
  person_name: string
  person_color: string
  year: number
  vacation_days: number
  carried_over: number
  total_available: number
  used: number
  remaining: number
  // Comp/flex days used this year (#1074) — informational, not deducted from the
  // entitlement. Absent on older server builds.
  comp_used?: number
  // The leave-year window this row was computed over (#737), as YYYY-MM-DD.
  // `window_end` is exclusive. Absent on older server builds.
  window_start?: string
  window_end?: string
}

export type VacayYearType = 'calendar' | 'fiscal' | 'anniversary'

/**
 * Per-user leave-year configuration (#737). 'calendar' is the unchanged Jan–Dec
 * default, 'fiscal' starts on a fixed month/day, 'anniversary' on the month/day
 * of the hire date.
 */
export interface VacayYearSettings {
  year_type: VacayYearType
  year_start_month: number
  year_start_day: number
  hire_date: string | null
}

export interface HolidayInfo {
  name: string
  localName: string
  color: string
  label: string | null
  type?: 'public_holiday' | 'school_holiday'
}

export interface HolidaysMap {
  [date: string]: HolidayInfo | HolidayInfo[]
}

// Read-only calendar shares (#444/#667)
export interface VacayShareOutgoing {
  id: number
  user_id: number
  username: string
}

export interface VacayShareIncoming {
  id: number
  owner_id: number
  username: string
  color: string
  hidden: boolean
}

export interface SharedVacayCalendar {
  share_id: number
  owner_id: number
  owner_name: string
  color: string
  hidden: boolean
  entries: { date: string; fraction?: number; kind?: 'vacation' | 'comp' }[]
  companyHolidays: { date: string; note?: string }[]
}

// API error shape from axios
export interface ApiError {
  response?: {
    data?: {
      error?: string
    }
    status?: number
  }
  message: string
}

/** Safely extract an error message from an unknown catch value */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const apiErr = err as ApiError
    // Axios' own message ("Request failed with status code 500") is untranslated
    // boilerplate, so only the server's error text beats the localized fallback.
    return apiErr.response?.data?.error || fallback
  }
  if (err instanceof Error) return err.message
  return fallback
}

// MergedItem used in day notes hook
export interface MergedItem {
  type: 'assignment' | 'note' | 'place' | 'transport'
  sortKey: number
  data: Assignment | DayNote | Reservation
}
