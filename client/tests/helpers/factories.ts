/**
 * Pure data builder functions for frontend tests.
 * These return typed objects matching interfaces in src/types.ts.
 * They do NOT touch a database.
 */

import type {
  User,
  Trip,
  Day,
  Place,
  Assignment,
  DayNote,
  PackingItem,
  TodoItem,
  BudgetItem,
  Reservation,
  TripFile,
  Tag,
  Category,
  Settings,
  AppConfig,
} from '../../src/types';

// ── Counters ──────────────────────────────────────────────────────────────────

let _seq = 0;
function next(): number {
  return ++_seq;
}

// ── InAppNotification (local interface, not in types.ts) ──────────────────────

export interface InAppNotification {
  id: number;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
  trip_id?: number | null;
}

// ── Builders ──────────────────────────────────────────────────────────────────

export function buildUser(overrides: Partial<User> = {}): User {
  const id = next();
  return {
    id,
    username: `user${id}`,
    email: `user${id}@example.com`,
    role: 'user',
    avatar_url: null,
    maps_api_key: null,
    created_at: '2025-01-01T00:00:00.000Z',
    mfa_enabled: false,
    must_change_password: false,
    ...overrides,
  };
}

export function buildAdmin(overrides: Partial<User> = {}): User {
  return buildUser({ role: 'admin', ...overrides });
}

export function buildTrip(overrides: Partial<Trip> = {}): Trip {
  const id = next();
  return {
    id,
    name: `Trip ${id}`,
    description: null,
    start_date: '2025-06-01',
    end_date: '2025-06-05',
    cover_url: null,
    is_archived: false,
    reminder_days: 7,
    owner_id: 1,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildDay(overrides: Partial<Day> = {}): Day {
  const id = next();
  return {
    id,
    trip_id: 1,
    date: '2025-06-01',
    title: null,
    notes: null,
    assignments: [],
    notes_items: [],
    ...overrides,
  };
}

export function buildPlace(overrides: Partial<Place> = {}): Place {
  const id = next();
  return {
    id,
    trip_id: 1,
    name: `Place ${id}`,
    description: null,
    lat: 48.8566,
    lng: 2.3522,
    address: null,
    category_id: null,
    icon: null,
    price: null,
    image_url: null,
    google_place_id: null,
    osm_id: null,
    route_geometry: null,
    place_time: null,
    end_time: null,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildAssignment(overrides: Partial<Assignment> = {}): Assignment {
  const id = next();
  const place = overrides.place ?? buildPlace();
  return {
    id,
    day_id: 1,
    place_id: place.id,
    order_index: 0,
    notes: null,
    place,
    ...overrides,
  };
}

export function buildDayNote(overrides: Partial<DayNote> = {}): DayNote {
  const id = next();
  return {
    id,
    day_id: 1,
    text: 'Test note',
    time: null,
    icon: null,
    sort_order: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Deterministic category_id per category name so test items with the same
// category text land in the same group when overrides don't supply category_id.
const _packingCategoryIds = new Map<string, number>();
export function packingCategoryIdFor(name: string | null | undefined): number | null {
  if (!name) return null;
  const existing = _packingCategoryIds.get(name);
  if (existing !== undefined) return existing;
  const id = 10_000 + _packingCategoryIds.size;
  _packingCategoryIds.set(name, id);
  return id;
}
export function resetPackingCategoryIds() {
  _packingCategoryIds.clear();
}

export function buildPackingItem(overrides: Partial<PackingItem> = {}): PackingItem {
  const id = next();
  const category = overrides.category ?? null;
  return {
    id,
    trip_id: 1,
    name: `Packing item ${id}`,
    category,
    category_id: overrides.category_id ?? packingCategoryIdFor(category),
    category_type: 'shared',
    category_owner_id: null,
    checked: 0,
    quantity: 1,
    ...overrides,
  };
}

export function buildTodoItem(overrides: Partial<TodoItem> = {}): TodoItem {
  const id = next();
  return {
    id,
    trip_id: 1,
    name: `Todo ${id}`,
    category: null,
    checked: 0,
    sort_order: 0,
    due_date: null,
    description: null,
    assigned_user_id: null,
    priority: 0,
    ...overrides,
  };
}

export function buildBudgetItem(overrides: Partial<BudgetItem> = {}): BudgetItem {
  const id = next();
  return {
    id,
    trip_id: 1,
    name: `Budget item ${id}`,
    amount: 100,
    currency: 'EUR',
    category: null,
    paid_by: null,
    persons: 1,
    members: [],
    expense_date: null,
    ...overrides,
  };
}

export function buildReservation(overrides: Partial<Reservation> = {}): Reservation {
  const id = next();
  return {
    id,
    trip_id: 1,
    name: `Reservation ${id}`,
    type: 'restaurant',
    status: 'confirmed',
    date: null,
    time: null,
    confirmation_number: null,
    notes: null,
    url: null,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildTripFile(overrides: Partial<TripFile> = {}): TripFile {
  const id = next();
  return {
    id,
    trip_id: 1,
    filename: 'test.pdf',
    original_name: 'test.pdf',
    mime_type: 'application/pdf',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildTag(overrides: Partial<Tag> = {}): Tag {
  const id = next();
  return {
    id,
    name: `Tag ${id}`,
    color: '#ff0000',
    user_id: 1,
    ...overrides,
  };
}

export function buildCategory(overrides: Partial<Category> = {}): Category {
  const id = next();
  return {
    id,
    name: `Category ${id}`,
    icon: 'restaurant',
    user_id: 1,
    ...overrides,
  };
}

export function buildSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    map_tile_url: '',
    default_lat: 48.8566,
    default_lng: 2.3522,
    default_zoom: 10,
    dark_mode: false,
    default_currency: 'USD',
    language: 'en',
    temperature_unit: 'fahrenheit',
    time_format: '12h',
    show_place_description: false,
    route_calculation: false,
    blur_booking_codes: false,
    ...overrides,
  };
}

export function buildInAppNotification(overrides: Partial<InAppNotification> = {}): InAppNotification {
  const id = next();
  return {
    id,
    type: 'trip_invite',
    message: `Notification ${id}`,
    read: false,
    created_at: '2025-01-01T00:00:00.000Z',
    trip_id: null,
    ...overrides,
  };
}

export function buildAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    has_users: true,
    allow_registration: true,
    demo_mode: false,
    oidc_configured: false,
    oidc_only_mode: false,
    password_login: true,
    password_registration: true,
    oidc_login: true,
    oidc_registration: true,
    env_override_oidc_only: false,
    ...overrides,
  };
}
