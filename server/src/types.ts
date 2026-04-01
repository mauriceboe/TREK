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

export interface Reservation {
  id: number;
  trip_id: number;
  day_id?: number | null;
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
