import { Request } from 'express';

export interface User {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  password_hash?: string;
  maps_api_key?: string | null;
  unsplash_api_key?: string | null;
  openweather_api_key?: string | null;
  avatar?: string | null;
  oidc_sub?: string | null;
  oidc_issuer?: string | null;
  last_login?: string | null;
  mfa_enabled?: number | boolean;
  mfa_secret?: string | null;
  mfa_backup_codes?: string | null;
  must_change_password?: number | boolean;
  first_seen_version?: string;
  login_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Trip {
  id: number;
  user_id: number;
  title: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  currency: string;
  cover_image?: string | null;
  is_archived: number;
  reminder_days: number;
  created_at?: string;
  updated_at?: string;
}

export interface Day {
  id: number;
  trip_id: number;
  day_number: number;
  date?: string | null;
  notes?: string | null;
  title?: string | null;
}

export interface Place {
  id: number;
  trip_id: number;
  name: string;
  description?: string | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  category_id?: number | null;
  price?: number | null;
  currency?: string | null;
  reservation_status?: string;
  reservation_notes?: string | null;
  reservation_datetime?: string | null;
  place_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number;
  notes?: string | null;
  image_url?: string | null;
  google_place_id?: string | null;
  osm_id?: string | null;
  website?: string | null;
  phone?: string | null;
  transport_mode?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  icon: string;
  user_id?: number | null;
  created_at?: string;
}

export interface Tag {
  id: number;
  user_id: number;
  name: string;
  color: string;
  created_at?: string;
}

export interface DayAssignment {
  id: number;
  day_id: number;
  place_id: number;
  order_index: number;
  notes?: string | null;
  reservation_status?: string;
  reservation_notes?: string | null;
  reservation_datetime?: string | null;
  assignment_time?: string | null;
  assignment_end_time?: string | null;
  created_at?: string;
}

export interface PackingItem {
  id: number;
  trip_id: number;
  name: string;
  checked: number;
  category?: string | null;
  sort_order: number;
  created_at?: string;
}

export interface BudgetItem {
  id: number;
  trip_id: number;
  category: string;
  name: string;
  total_price: number;
  persons?: number | null;
  days?: number | null;
  note?: string | null;
  sort_order: number;
  created_at?: string;
  members?: BudgetItemMember[];
}

export interface BudgetItemMember {
  user_id: number;
  paid: number;
  username: string;
  avatar_url?: string | null;
  avatar?: string | null;
  budget_item_id?: number;
}

export interface ReservationEndpoint {
  id: number;
  reservation_id: number;
  role: 'from' | 'to' | 'stop';
  sequence: number;
  name: string;
  code: string | null;
  lat: number;
  lng: number;
  timezone: string | null;
  local_time: string | null;
  local_date: string | null;
}

export interface Reservation {
  id: number;
  trip_id: number;
  day_id?: number | null;
  end_day_id?: number | null;
  place_id?: number | null;
  assignment_id?: number | null;
  title: string;
  reservation_time?: string | null;
  reservation_end_time?: string | null;
  location?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  status: string;
  type: string;
  accommodation_id?: number | null;
  metadata?: string | null;
  needs_review?: number;
  endpoints?: ReservationEndpoint[];
  created_at?: string;
  day_number?: number;
  place_name?: string;
}

export interface TripFile {
  id: number;
  trip_id: number;
  place_id?: number | null;
  reservation_id?: number | null;
  note_id?: number | null;
  uploaded_by?: number | null;
  uploaded_by_name?: string | null;
  filename: string;
  original_name: string;
  file_size?: number | null;
  mime_type?: string | null;
  description?: string | null;
  starred?: number;
  deleted_at?: string | null;
  created_at?: string;
  reservation_title?: string;
  url?: string;
}

export interface TripMember {
  id: number;
  trip_id: number;
  user_id: number;
  invited_by?: number | null;
  added_at?: string;
}

export interface DayNote {
  id: number;
  day_id: number;
  trip_id: number;
  text: string;
  time?: string | null;
  icon: string;
  sort_order: number;
  created_at?: string;
}

export interface CollabNote {
  id: number;
  trip_id: number;
  user_id: number;
  category: string;
  title: string;
  content?: string | null;
  color: string;
  pinned: number;
  website?: string | null;
  username?: string;
  avatar?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CollabPoll {
  id: number;
  trip_id: number;
  user_id: number;
  question: string;
  options: string;
  multiple: number;
  closed: number;
  deadline?: string | null;
  username?: string;
  avatar?: string | null;
  created_at?: string;
}

export interface CollabMessage {
  id: number;
  trip_id: number;
  user_id: number;
  text: string;
  reply_to?: number | null;
  deleted?: number;
  username?: string;
  avatar?: string | null;
  reply_text?: string | null;
  reply_username?: string | null;
  created_at?: string;
}

export interface Addon {
  id: string;
  name: string;
  description?: string | null;
  type: string;
  icon: string;
  enabled: number;
  config: string;
  sort_order: number;
}

export interface AppSetting {
  key: string;
  value?: string | null;
}

export interface Setting {
  id: number;
  user_id: number;
  key: string;
  value?: string | null;
}

export interface AuthRequest extends Request {
  user: { id: number; username: string; email: string; role: string };
  trip?: { id: number; user_id: number };
}

export interface OptionalAuthRequest extends Request {
  user: { id: number; username: string; email: string; role: string } | null;
}

export interface AssignmentRow extends DayAssignment {
  place_name: string;
  place_description: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category_id: number | null;
  price: number | null;
  place_currency: string | null;
  place_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  place_notes: string | null;
  image_url: string | null;
  transport_mode: string;
  google_place_id: string | null;
  website: string | null;
  phone: string | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

export interface Participant {
  user_id: number;
  username: string;
  avatar?: string | null;
}

// ── Journey addon ─────────────────────────────────────────────────────────

export interface Journey {
  id: number;
  user_id: number;
  title: string;
  subtitle?: string | null;
  cover_gradient?: string | null;
  cover_image?: string | null;
  status: 'draft' | 'active' | 'completed' | 'archived';
  created_at: number;
  updated_at: number;
}

export interface JourneyEntry {
  id: number;
  journey_id: number;
  source_trip_id?: number | null;
  source_place_id?: number | null;
  author_id: number;
  type: 'entry' | 'checkin' | 'skeleton';
  title?: string | null;
  story?: string | null;
  entry_date: string;
  entry_time?: string | null;
  location_name?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  mood?: string | null;
  weather?: string | null;
  tags?: string | null;
  visibility: 'private' | 'shared' | 'public';
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface TrekPhoto {
  id: number;
  provider: string;
  asset_id?: string | null;
  owner_id?: number | null;
  file_path?: string | null;
  thumbnail_path?: string | null;
  width?: number | null;
  height?: number | null;
  passphrase?: string | null;
  created_at: string;
}

export interface JourneyPhoto {
  id: number;
  entry_id: number;
  photo_id: number;
  caption?: string | null;
  sort_order: number;
  shared: number;
  created_at: number;
  // Joined from trek_photos for API responses
  provider?: string;
  asset_id?: string | null;
  owner_id?: number | null;
  file_path?: string | null;
  thumbnail_path?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface JourneyTrip {
  journey_id: number;
  trip_id: number;
  added_at: number;
}

export interface JourneyContributor {
  journey_id: number;
  user_id: number;
  role: 'owner' | 'editor' | 'viewer';
  added_at: number;
}
