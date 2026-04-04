import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

type AdminConvexHttpClient = ConvexHttpClient & {
  setAdminAuth: (token: string) => void;
};

type ImportSummary = {
  inserted: number;
  updated: number;
};

type CliOptions = {
  batchSize: number;
  dryRun: boolean;
  sqlitePath?: string;
};

type UserRow = {
  id: number;
  better_auth_user_id: string | null;
  username: string;
  email: string;
  role: string;
  avatar: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type TripRow = {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
  cover_image: string | null;
  is_archived: number | null;
  destination_name: string | null;
  destination_address: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_viewport_south: number | null;
  destination_viewport_west: number | null;
  destination_viewport_north: number | null;
  destination_viewport_east: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type TripMemberRow = {
  id: number;
  trip_id: number;
  user_id: number;
  invited_by: number | null;
  added_at: string | null;
};

type DayRow = {
  id: number;
  trip_id: number;
  day_number: number;
  date: string | null;
  notes: string | null;
  title: string | null;
};

type PlaceRow = {
  id: number;
  trip_id: number;
  name: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category_id: number | null;
  price: number | null;
  currency: string | null;
  reservation_status: string | null;
  reservation_notes: string | null;
  reservation_datetime: string | null;
  place_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  notes: string | null;
  image_url: string | null;
  google_place_id: string | null;
  website: string | null;
  phone: string | null;
  transport_mode: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const UPSERT_USERS = makeFunctionReference<'mutation'>('planner:upsertUsers');
const UPSERT_TRIPS = makeFunctionReference<'mutation'>('planner:upsertTrips');
const UPSERT_TRIP_MEMBERS = makeFunctionReference<'mutation'>('planner:upsertTripMembers');
const UPSERT_DAYS = makeFunctionReference<'mutation'>('planner:upsertDays');
const UPSERT_PLACES = makeFunctionReference<'mutation'>('planner:upsertPlaces');
const GET_MIGRATION_COUNTS = makeFunctionReference<'query'>('planner:getMigrationCounts');

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 100,
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg.startsWith('--batch-size=')) {
      options.batchSize = parsePositiveInteger(arg.slice('--batch-size='.length), 'batch size');
      continue;
    }

    if (arg.startsWith('--sqlite-path=')) {
      options.sqlitePath = arg.slice('--sqlite-path='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run migrate:planner:convex -- [options]

Options:
  --dry-run             Read SQLite and print migration counts without calling Convex
  --batch-size=<n>      Number of rows sent per mutation batch (default: 100)
  --sqlite-path=<path>  Override the SQLite database path
  --help, -h            Show this help
`);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function resolveSqlitePath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(process.cwd(), explicitPath);
  }

  if (process.env.SQLITE_PATH) {
    return path.resolve(process.cwd(), process.env.SQLITE_PATH);
  }

  return path.resolve(__dirname, '../../data/travel.db');
}

function deriveConvexUrlFromSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim().replace(/\/$/, '');
  if (!trimmed) {
    throw new Error('CONVEX_SITE_URL is empty');
  }

  if (trimmed.includes('.convex.site')) {
    return trimmed.replace('.convex.site', '.convex.cloud');
  }

  if (trimmed.endsWith('.site')) {
    return trimmed.replace(/\.site$/, '.cloud');
  }

  throw new Error(`Cannot derive Convex cloud URL from CONVEX_SITE_URL=${trimmed}`);
}

function resolveConvexUrl(): string {
  const explicitUrl = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL;
  if (explicitUrl) {
    return explicitUrl.trim().replace(/\/$/, '');
  }

  if (process.env.CONVEX_SITE_URL) {
    return deriveConvexUrlFromSiteUrl(process.env.CONVEX_SITE_URL);
  }

  throw new Error('Set CONVEX_URL, VITE_CONVEX_URL, or CONVEX_SITE_URL before running the Convex migration');
}

function resolveConvexAdminKey(): string {
  const adminKey =
    process.env.CONVEX_DEPLOY_KEY ||
    process.env.CONVEX_ADMIN_KEY ||
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;

  if (!adminKey) {
    throw new Error('Set CONVEX_DEPLOY_KEY, CONVEX_ADMIN_KEY, or CONVEX_SELF_HOSTED_ADMIN_KEY before running the Convex migration');
  }

  return adminKey.trim();
}

function openSqlite(sqlitePath: string): Database.Database {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function toEpochMillis(value: string | number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    normalized = normalized.replace(' ', 'T') + 'Z';
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Failed to parse timestamp: ${value}`);
  }

  return parsed;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

async function runBatches<TArgs extends Record<string, unknown>>(
  label: string,
  rows: unknown[],
  batchSize: number,
  runBatch: (args: TArgs) => Promise<ImportSummary>,
  buildArgs: (batch: unknown[]) => TArgs,
): Promise<ImportSummary> {
  const totals: ImportSummary = { inserted: 0, updated: 0 };
  const batches = chunk(rows, batchSize);

  console.log(`[migrate] ${label}: ${rows.length} ${pluralize('row', rows.length)} in ${batches.length} ${pluralize('batch', batches.length)}`);

  for (let index = 0; index < batches.length; index += 1) {
    const summary = await runBatch(buildArgs(batches[index]));
    totals.inserted += summary.inserted || 0;
    totals.updated += summary.updated || 0;
    console.log(`[migrate] ${label}: batch ${index + 1}/${batches.length} inserted=${summary.inserted || 0} updated=${summary.updated || 0}`);
  }

  console.log(`[migrate] ${label}: done inserted=${totals.inserted} updated=${totals.updated}`);
  return totals;
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const sqlitePath = resolveSqlitePath(options.sqlitePath);
  const sqlite = openSqlite(sqlitePath);

  console.log(`[migrate] SQLite source: ${sqlitePath}`);

  const users = sqlite.prepare(`
    SELECT id, better_auth_user_id, username, email, role, avatar, created_at, updated_at
    FROM users
    ORDER BY id
  `).all() as UserRow[];

  const trips = sqlite.prepare(`
    SELECT
      id, user_id, title, description, start_date, end_date, currency, cover_image, is_archived,
      destination_name, destination_address, destination_lat, destination_lng,
      destination_viewport_south, destination_viewport_west, destination_viewport_north, destination_viewport_east,
      created_at, updated_at
    FROM trips
    ORDER BY id
  `).all() as TripRow[];

  const tripMembers = sqlite.prepare(`
    SELECT id, trip_id, user_id, invited_by, added_at
    FROM trip_members
    ORDER BY id
  `).all() as TripMemberRow[];

  const days = sqlite.prepare(`
    SELECT id, trip_id, day_number, date, notes, title
    FROM days
    ORDER BY id
  `).all() as DayRow[];

  const places = sqlite.prepare(`
    SELECT
      id, trip_id, name, description, lat, lng, address, category_id, price, currency,
      reservation_status, reservation_notes, reservation_datetime, place_time, end_time,
      duration_minutes, notes, image_url, google_place_id, website, phone, transport_mode,
      created_at, updated_at
    FROM places
    ORDER BY id
  `).all() as PlaceRow[];

  console.log('[migrate] Source counts');
  console.log(`  users=${users.length}`);
  console.log(`  trips=${trips.length}`);
  console.log(`  tripMembers=${tripMembers.length}`);
  console.log(`  days=${days.length}`);
  console.log(`  places=${places.length}`);

  if (options.dryRun) {
    console.log('[migrate] Dry run complete. No Convex mutations were executed.');
    sqlite.close();
    return;
  }

  const convexUrl = resolveConvexUrl();
  const adminKey = resolveConvexAdminKey();
  const convex = new ConvexHttpClient(convexUrl, { logger: false }) as AdminConvexHttpClient;
  convex.setAdminAuth(adminKey);

  console.log(`[migrate] Convex target: ${convexUrl}`);

  await runBatches(
    'users',
    users.map((user) => {
      const createdAt = toEpochMillis(user.created_at, 0);
      const updatedAt = toEpochMillis(user.updated_at, createdAt);
      return {
        legacyUserId: user.id,
        betterAuthUserId: user.better_auth_user_id,
        username: user.username,
        email: user.email,
        role: user.role || 'user',
        avatarUrl: user.avatar,
        createdAt,
        updatedAt,
      };
    }),
    options.batchSize,
    (args) => convex.mutation(UPSERT_USERS, args),
    (batch) => ({ users: batch }),
  );

  await runBatches(
    'trips',
    trips.map((trip) => {
      const createdAt = toEpochMillis(trip.created_at, 0);
      const updatedAt = toEpochMillis(trip.updated_at, createdAt);
      return {
        legacyId: trip.id,
        ownerLegacyUserId: trip.user_id,
        title: trip.title,
        description: trip.description,
        startDate: trip.start_date,
        endDate: trip.end_date,
        currency: trip.currency || 'EUR',
        coverImage: trip.cover_image,
        isArchived: Boolean(trip.is_archived),
        destinationName: trip.destination_name,
        destinationAddress: trip.destination_address,
        destinationLat: trip.destination_lat,
        destinationLng: trip.destination_lng,
        destinationViewportSouth: trip.destination_viewport_south,
        destinationViewportWest: trip.destination_viewport_west,
        destinationViewportNorth: trip.destination_viewport_north,
        destinationViewportEast: trip.destination_viewport_east,
        createdAt,
        updatedAt,
      };
    }),
    options.batchSize,
    (args) => convex.mutation(UPSERT_TRIPS, args),
    (batch) => ({ trips: batch }),
  );

  await runBatches(
    'tripMembers',
    tripMembers.map((member) => ({
      legacyId: member.id,
      tripLegacyId: member.trip_id,
      memberLegacyUserId: member.user_id,
      invitedByLegacyUserId: member.invited_by,
      addedAt: toEpochMillis(member.added_at, 0),
    })),
    options.batchSize,
    (args) => convex.mutation(UPSERT_TRIP_MEMBERS, args),
    (batch) => ({ members: batch }),
  );

  await runBatches(
    'days',
    days.map((day) => ({
      legacyId: day.id,
      tripLegacyId: day.trip_id,
      dayNumber: day.day_number,
      date: day.date,
      notes: day.notes,
      title: day.title,
    })),
    options.batchSize,
    (args) => convex.mutation(UPSERT_DAYS, args),
    (batch) => ({ days: batch }),
  );

  await runBatches(
    'places',
    places.map((place) => {
      const createdAt = toEpochMillis(place.created_at, 0);
      const updatedAt = toEpochMillis(place.updated_at, createdAt);
      return {
        legacyId: place.id,
        tripLegacyId: place.trip_id,
        name: place.name,
        description: place.description,
        lat: place.lat,
        lng: place.lng,
        address: place.address,
        categoryId: place.category_id,
        price: place.price,
        currency: place.currency,
        reservationStatus: place.reservation_status || 'none',
        reservationNotes: place.reservation_notes,
        reservationDatetime: place.reservation_datetime,
        placeTime: place.place_time,
        endTime: place.end_time,
        durationMinutes: place.duration_minutes || 60,
        notes: place.notes,
        imageUrl: place.image_url,
        googlePlaceId: place.google_place_id,
        website: place.website,
        phone: place.phone,
        transportMode: place.transport_mode || 'walking',
        createdAt,
        updatedAt,
      };
    }),
    options.batchSize,
    (args) => convex.mutation(UPSERT_PLACES, args),
    (batch) => ({ places: batch }),
  );

  const convexCounts = await convex.query(GET_MIGRATION_COUNTS, {});
  console.log('[migrate] Convex counts after import');
  console.log(`  users=${convexCounts.users}`);
  console.log(`  trips=${convexCounts.trips}`);
  console.log(`  tripMembers=${convexCounts.tripMembers}`);
  console.log(`  days=${convexCounts.days}`);
  console.log(`  places=${convexCounts.places}`);

  sqlite.close();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] Failed: ${message}`);
  process.exit(1);
});
