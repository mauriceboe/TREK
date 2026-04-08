// Shared types for the TREK travel planner

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
}

export interface Trip {
  id: number | string
  name: string
  title?: string | null
  description: string | null
  currency: string | null
  start_date: string
  end_date: string
  cover_url: string | null
  cover_image?: string | null
  is_archived: boolean
  owner_id: number
  user_id?: number
  reminder_days?: number
  day_count?: number
  destination_name: string | null
  destination_address: string | null
  destination_lat: number | null
  destination_lng: number | null
  destination_viewport_south: number | null
  destination_viewport_west: number | null
  destination_viewport_north: number | null
  destination_viewport_east: number | null
  created_at: string
  updated_at: string
}

export interface TripLeg {
  id: number | string
  trip_id: number | string
  destination_name: string
  destination_address: string | null
  destination_lat: number | null
  destination_lng: number | null
  destination_viewport_south: number | null
  destination_viewport_west: number | null
  destination_viewport_north: number | null
  destination_viewport_east: number | null
  start_day_number: number
  end_day_number: number
  color: string
  created_at: string
  updated_at: string
}

export interface RecommendedPlace {
  google_place_id: string | null
  name: string
  address: string
  lat: number | null
  lng: number | null
  rating: number | null
  rating_count: number | null
  primary_type: string | null
  primary_type_label: string | null
  types: string[]
  website: string | null
  phone: string | null
  google_maps_url: string | null
  source: 'google'
}

export interface AutocompleteSuggestion {
  place_id: string
  text: string
  primary_text: string
  secondary_text: string
  types: string[]
}

export interface Day {
  id: number | string
  trip_id: number | string
  date: string
  day_number: number
  title: string | null
  notes: string | null
  assignments: Assignment[]
  notes_items: DayNote[]
}

export interface Place {
  id: number | string
  trip_id: number | string
  name: string
  description: string | null
  notes?: string | null
  lat: number | null
  lng: number | null
  address: string | null
  category_id: number | null
  category?: string | null
  category_name?: string | null
  category_icon?: string | null
  category_color?: string | null
  icon: string | null
  price: string | null
  currency?: string | null
  image_url: string | null
  google_place_id: string | null
  osm_id: string | null
  place_time: string | null
  end_time: string | null
  phone?: string | null
  website?: string | null
  transport_mode?: string | null
  route_geometry?: string | null
  created_at: string
}

export interface Assignment {
  id: number | string
  day_id: number | string
  place_id?: number | string
  start_day_id?: number | string
  end_day_id?: number | string
  order_index: number
  sort_order?: number
  notes: string | null
  place: Place
  place_name?: string
  participants?: { user_id: number; username: string; avatar?: string | null }[]
}

export interface DayNote {
  id: number | string
  day_id: number | string
  text: string
  time: string | null
  icon: string | null
  sort_order?: number
  created_at: string
}

export interface PackingItem {
  id: number
  trip_id: number
  name: string
  category: string | null
  checked: number
  quantity: number
  weight_grams: number | null
  bag_id: number | null
}

export interface Tag {
  id: number | string
  name: string
  color: string | null
  user_id: number
}

export interface Category {
  id: number | string
  name: string
  icon: string | null
  color?: string | null
  user_id: number
}

export interface BudgetItem {
  id: number
  trip_id: number
  name: string
  amount: number
  total_price: number | null
  currency: string
  category: string | null
  paid_by: number | null
  persons: number
  days?: number
  date?: string | null
  expense_date?: string | null
  note?: string | null
  members: BudgetMember[]
}

export interface BudgetMember {
  user_id: number
  username: string
  avatar_url: string | null
  paid: boolean
}

export interface Reservation {
  id: number
  trip_id: number
  name: string
  title?: string
  type: string | null
  status: 'pending' | 'confirmed'
  date: string | null
  time: string | null
  reservation_time?: string | null
  reservation_end_time?: string | null
  location?: string | null
  confirmation_number: string | null
  notes: string | null
  url: string | null
  assignment_id?: number | string | null
  accommodation_id?: number | null
  accommodation_name?: string | null
  day_plan_position?: number | null
  metadata?: Record<string, string> | null
  created_at: string
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
  url?: string
  linked_place_ids?: number[]
  linked_reservation_ids?: number[]
}

export interface Settings {
  map_tile_url: string
  default_lat: number
  default_lng: number
  default_zoom: number
  dark_mode: boolean | string
  default_currency: string
  language: string
  temperature_unit: string
  time_format: string
  show_place_description: boolean
  route_calculation?: boolean
  blur_booking_codes?: boolean
  dashboard_currency?: string
  dashboard_timezone?: string
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
  walkingText: string
  drivingText: string
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
  _assignmentId?: number | string
}

// User with optional OIDC fields
export interface UserWithOidc extends User {
  oidc_issuer?: string | null
}

// Accommodation type
export interface Accommodation {
  id: number
  trip_id: number
  name: string
  address: string | null
  check_in: string | null
  check_out: string | null
  confirmation_number: string | null
  notes: string | null
  url: string | null
  place_id?: number | null
  start_day_id?: number | string | null
  end_day_id?: number | string | null
  created_at: string
}

// Trip member (owner or collaborator)
export interface TripMember {
  id: number
  username: string
  email?: string
  avatar_url?: string | null
  avatar?: string | null
  role?: string
}

// Photo type
export interface Photo {
  id: number
  trip_id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  file_size: number | null
  url: string
  caption: string | null
  place_id: number | null
  day_id: number | null
  created_at: string
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
  demo_mode: boolean
  oidc_configured: boolean
  oidc_display_name?: string
  has_maps_key?: boolean
  allowed_file_types?: string
}

// Translation function type
export type TranslationFn = (key: string, params?: Record<string, string | number | null>) => string

// WebSocket event type
export interface WebSocketEvent {
  type: string
  [key: string]: unknown
}

// Vacay types
export interface VacayHolidayCalendar {
  id: number
  plan_id: number
  region: string
  label: string | null
  color: string
  sort_order: number
}

export interface VacayPlan {
  id: number
  holidays_enabled: boolean
  holidays_region: string | null
  holiday_calendars: VacayHolidayCalendar[]
  block_weekends: boolean
  weekend_days: string | null
  carry_over_enabled: boolean
  company_holidays_enabled: boolean
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
}

export interface VacayStat {
  user_id: number
  person_name?: string
  vacation_days: number
  used: number
}

export interface HolidayInfo {
  name: string
  localName: string
  color: string
  label: string | null
}

export interface HolidaysMap {
  [date: string]: HolidayInfo
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
    if (apiErr.response?.data?.error) return apiErr.response.data.error
  }
  if (err instanceof Error) return err.message
  return fallback
}

// MergedItem used in day notes hook
export interface MergedItem {
  type: 'assignment' | 'note' | 'transport'
  sortKey: number
  data: Assignment | DayNote | Reservation
}
