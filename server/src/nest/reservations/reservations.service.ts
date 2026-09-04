import { Injectable } from '@nestjs/common';
import { DatabaseService, type TripAccess } from '../database/database.service';
import type { TrekWsPayload, TrekWsTripEventName } from '@trek/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ReservationsReadRepository, toTraveler } from './reservations-read.repository';
import type { Reservation, User } from '../../types';
import { BudgetService } from '../budget/budget.service';
import { typeToCostCategory } from '@trek/shared';
import { NotificationsService } from '../notifications/notifications.service';

type Trip = TripAccess;
type BudgetEntry = { total_price?: number; category?: string } | undefined;

export interface ReservationEndpoint {
  id?: number;
  reservation_id?: number;
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

export type EndpointInput = Omit<ReservationEndpoint, 'id' | 'reservation_id' | 'sequence'> & { sequence?: number };

// --- Travelers (#1517): trip members / named guests assigned to a booking -----

export interface ReservationTraveler {
  user_id: number;
  username: string;
  avatar: string | null;
  avatar_url?: string | null;
  is_guest?: number | null;
}

/** A reservation row as the joined list/get queries return it (open record —
 *  the legacy queries selected `r.*` and callers pass the row through; the
 *  named fields are the columns consumers read in a typed position). */
export type ReservationRow = Record<string, unknown> & {
  id: number;
  trip_id: number;
  title: string;
  status: string;
  type: string;
  metadata?: string | null;
  accommodation_id?: number | string | null;
  day_positions?: Record<number, number> | null;
  endpoints?: ReservationEndpoint[];
  travelers?: ReservationTraveler[];
};

interface CreateAccommodation {
  place_id?: number;
  start_day_id?: number;
  end_day_id?: number;
  check_in?: string;
  check_out?: string;
  confirmation?: string;
}

export interface CreateReservationData {
  title: string;
  reservation_time?: string;
  reservation_end_time?: string;
  location?: string;
  confirmation_number?: string;
  notes?: string;
  url?: string;
  day_id?: number;
  end_day_id?: number;
  place_id?: number;
  assignment_id?: number;
  status?: string;
  type?: string;
  accommodation_id?: number;
  metadata?: unknown;
  create_accommodation?: CreateAccommodation;
  endpoints?: EndpointInput[];
  needs_review?: boolean;
}

export interface UpdateReservationData {
  title?: string;
  reservation_time?: string;
  reservation_end_time?: string;
  location?: string;
  confirmation_number?: string;
  notes?: string;
  url?: string;
  day_id?: number;
  end_day_id?: number | null;
  place_id?: number;
  assignment_id?: number;
  status?: string;
  type?: string;
  accommodation_id?: number;
  metadata?: unknown;
  create_accommodation?: CreateAccommodation;
  endpoints?: EndpointInput[];
  needs_review?: boolean;
}

/**
 * True when `reservation_time` actually carries a date and not just a bare
 * `HH:MM`. Both shapes reach this column — the booking form writes the
 * datetime-local `YYYY-MM-DDTHH:MM`, while day-anchored rows (the demo seed
 * among them) hold only a time — and comparing the two against an ISO
 * timestamp as strings silently sorts `'20:00'` above `'2026-…'` while
 * dropping `'08:30'` below it, which is how half a trip's bookings vanished
 * from the dashboard widget (#1934).
 */
const DATED = "r.reservation_time GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";

type AccommodationTimesMeta = {
  check_in_time?: string | null;
  check_in_end_time?: string | null;
  check_out_time?: string | null;
};

/**
 * Reservations domain service — owns the reservation SQL (moved 1:1 from the
 * legacy services/reservationService.ts: identical statements, the `||`
 * falsy-coercion defaults, the COALESCE update semantics and the post-write
 * re-selects; the multi-statement writes gained db.transaction() wrappers in
 * the post-fold quirk-fix commit, and the accommodation metadata sync now
 * keys off the resolved accommodation id so auto-created accommodations get
 * their check-in/out times too). Trip access,
 * the 'reservation_edit' permission and the WebSocket broadcast keep their
 * legacy call paths. The legacy route's budget side effects (auto-create /
 * update / delete a linked budget item) and the booking notification are
 * encapsulated here so the controller stays thin — behaviour is 1:1.
 * Every consumer injects this class now. reservations.bridge.ts existed for
 * the legacy tripService, airtrail import/sync and the transit/transports MCP
 * registrars, all of which have folded in; the plugin RPC host reaches it
 * through ReservationsRpc.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly budget: BudgetService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly reads: ReservationsReadRepository,
  ) {}

  verifyTripAccess(tripId: string | number, userId: number) {
    return this.db.canAccessTrip(tripId, userId);
  }

  canEdit(trip: Trip, user: User): boolean {
    return this.permissions.checkPermission('reservation_edit', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  broadcast<E extends TrekWsTripEventName>(tripId: string, event: E, payload: TrekWsPayload<E>, socketId: string | undefined): void {
    this.realtime.broadcast(tripId, event, payload, socketId);
  }

  /** Fire-and-forget booking-change notification, mirroring the legacy dynamic import. */
  notifyBookingChange(tripId: string | number, actorId: number, booking: string, type: string): void {
    // Injected, not a lazy import of the old notifications bridge. The laziness bought
    // nothing the module graph does not already give — NotificationsModule
    // reaches nothing in this direction — and it hid the edge while handing the
    // send a second NotificationsService built outside the container.
    try {
      const actor = this.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', actorId);
      if (!actor) return;
      const trip = this.db.get<{ title: string }>('SELECT title FROM trips WHERE id = ?', tripId);
      this.notifications.send({
        event: 'booking_change',
        actorId,
        scope: 'trip',
        targetId: Number(tripId),
        params: {
          trip: trip?.title || 'Untitled',
          actor: actor.email,
          booking,
          type: type || 'booking',
          tripId: String(tripId),
        },
      }).catch(() => {});
    } catch {
      // Notifications must never make the booking write fail.
    }
  }

  loadEndpointsByTrip(tripId: string | number): Map<number, ReservationEndpoint[]> {
    const rows = this.db.all<ReservationEndpoint>(`
    SELECT e.* FROM reservation_endpoints e
    JOIN reservations r ON e.reservation_id = r.id
    WHERE r.trip_id = ?
    ORDER BY e.reservation_id, e.sequence
  `, tripId);
    const map = new Map<number, ReservationEndpoint[]>();
    for (const r of rows) {
      const list = map.get(r.reservation_id!) ?? [];
      list.push(r);
      map.set(r.reservation_id!, list);
    }
    return map;
  }

  /** Users assignable on a trip: its members (guests included) plus the owner. */
  private assignableUserIds(tripId: string | number): Set<number> {
    const members = this.db.all<{ user_id: number }>('SELECT user_id FROM trip_members WHERE trip_id = ?', tripId);
    const ids = new Set(members.map(m => m.user_id));
    const owner = this.db.get<{ user_id: number }>('SELECT user_id FROM trips WHERE id = ?', tripId);
    if (owner) ids.add(owner.user_id);
    return ids;
  }

  loadTravelersByTrip(tripId: string | number): Map<number, ReservationTraveler[]> {
    const rows = this.db.all<ReservationTraveler & { reservation_id: number }>(`
    SELECT rt.reservation_id, rt.user_id, COALESCE(u.display_name, u.username) AS username, u.avatar, u.is_guest
    FROM reservation_travelers rt
    JOIN reservations r ON rt.reservation_id = r.id
    JOIN users u ON rt.user_id = u.id
    WHERE r.trip_id = ?
    ORDER BY rt.reservation_id
  `, tripId);
    const map = new Map<number, ReservationTraveler[]>();
    for (const row of rows) {
      const list = map.get(row.reservation_id) ?? [];
      list.push(toTraveler(row));
      map.set(row.reservation_id, list);
    }
    return map;
  }

  loadTravelers(reservationId: number | string): ReservationTraveler[] {
    return this.reads.loadTravelers(reservationId);
  }

  /**
   * Replace a reservation's assigned travelers. Only real trip members/guests are
   * accepted — ids that aren't on the trip are silently dropped so a stale client
   * can't leak a cross-trip user. #1517.
   */
  setReservationTravelers(reservationId: number | string, tripId: string | number, userIds: number[]): void {
    const allowed = this.assignableUserIds(tripId);
    const ids = [...new Set(userIds)].filter(uid => allowed.has(uid));
    this.db.transaction(() => {
      this.db.run('DELETE FROM reservation_travelers WHERE reservation_id = ?', reservationId);
      if (ids.length > 0) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO reservation_travelers (reservation_id, user_id) VALUES (?, ?)');
        for (const uid of ids) insert.run(reservationId, uid);
      }
    });
  }

  /** Assign trip members / named guests to a reservation (#1517). Null when off-trip. */
  setTravelers(id: string, tripId: string, userIds: number[]) {
    if (!this.getReservation(id, tripId)) return null;
    this.setReservationTravelers(id, tripId, userIds);
    return { travelers: this.loadTravelers(id), reservation: this.getReservationWithJoins(Number(id)) };
  }

  // Resolve the day row whose date matches the date portion of an ISO-ish
  // timestamp. Used to keep `day_id` / `end_day_id` in sync with
  // `reservation_time` / `reservation_end_time` so non-transport bookings
  // (tours, restaurants, events, ...) end up on the right day in the UI,
  // which now filters by day_id instead of reservation_time.
  private resolveDayIdFromTime(
    tripId: string | number,
    time: string | null | undefined,
    clampToNearest = true,
  ): number | null {
    if (!time) return null;
    const datePart = time.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
    const exact = this.db.get<{ id: number }>('SELECT id FROM days WHERE trip_id = ? AND date = ? LIMIT 1', tripId, datePart);
    if (exact) return exact.id;
    // Fallback: clamp to the nearest day in the trip so an imported booking whose
    // exact date has no day row (or sits just outside the span) still lands on a day.
    // Skipped by callers (e.g. resyncReservationDays) that must leave a booking whose
    // date now falls outside the range untouched instead of snapping it to an edge day.
    if (!clampToNearest) return null;
    const nearest = this.db.get<{ id: number }>(
      'SELECT id FROM days WHERE trip_id = ? ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) ASC, date ASC LIMIT 1',
      tripId, datePart
    );
    return nearest?.id ?? null;
  }

  // After a trip's date range changes, generateDays positionally re-dates the day rows
  // (keeping their ids), so a dated booking's day_id stays glued to a now-re-dated day and
  // the booking visually shifts by the offset (#1288). Re-anchor non-hotel bookings to the
  // day matching their absolute reservation_time — the same derivation create/update
  // use. Only updates when a matching day exists, so a booking whose date now falls outside
  // the new range is left untouched. Hotels linked to a day_accommodation are excluded here —
  // resyncAccommodationDays re-anchors the accommodation span and its linked reservation;
  // unlinked dated hotels (e.g. imported ones) re-anchor like any other booking.
  resyncReservationDays(tripId: string | number): void {
    const rows = this.db.all<{
      id: number; reservation_time: string | null; reservation_end_time: string | null;
      day_id: number | null; end_day_id: number | null;
    }>(
      `SELECT id, reservation_time, reservation_end_time, day_id, end_day_id
       FROM reservations
      WHERE trip_id = ? AND (type != 'hotel' OR accommodation_id IS NULL) AND reservation_time IS NOT NULL`,
      tripId
    );
    const update = this.db.prepare('UPDATE reservations SET day_id = ?, end_day_id = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const r of rows) {
        const newDayId = this.resolveDayIdFromTime(tripId, r.reservation_time, false);
        if (newDayId == null) continue;
        const newEndDayId = r.reservation_end_time
          ? (this.resolveDayIdFromTime(tripId, r.reservation_end_time, false) ?? r.end_day_id)
          : r.end_day_id;
        if (newDayId !== r.day_id || newEndDayId !== r.end_day_id) {
          update.run(newDayId, newEndDayId, r.id);
        }
      }
    });
  }

  private saveEndpoints(reservationId: number, endpoints: EndpointInput[]): void {
    // Run the transaction through DatabaseService (which re-derives the
    // statement from the injected connection on each call). The bridge
    // instance is built over the reinitialize-proof `db` Proxy, so a
    // demo-reset / restore-from-backup that closes and reinitialises the
    // connection can't leave this holding a dead handle — the legacy module
    // bound its transaction lazily per call for the same reason ("The
    // database connection is not open").
    this.db.transaction(() => {
      this.db.run('DELETE FROM reservation_endpoints WHERE reservation_id = ?', reservationId);
      const insert = this.db.prepare(`
      INSERT INTO reservation_endpoints (reservation_id, role, sequence, name, code, lat, lng, timezone, local_time, local_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      // lat/lng are NOT NULL: an imported transport whose pick-up/return (or station/
      // stop) couldn't be geocoded reaches here with null coords. Skip those rows rather
      // than let the INSERT throw and fail the entire booking save — the dates still live
      // on reservation_time/reservation_end_time, so the booking lands on its day either way.
      endpoints
        .filter((e) => e.lat != null && e.lng != null)
        .forEach((e, i) => {
          insert.run(reservationId, e.role, e.sequence ?? i, e.name, e.code ?? null, e.lat, e.lng, e.timezone ?? null, e.local_time ?? null, e.local_date ?? null);
        });
    });
  }

  list(tripId: string | number) {
    const reservations = this.db.all<ReservationRow>(`
    SELECT r.*, d.day_number, p.name as place_name, r.assignment_id,
      ap.place_id as accommodation_place_id, acc_p.name as accommodation_name,
      ap.start_day_id as accommodation_start_day_id, ap.end_day_id as accommodation_end_day_id
    FROM reservations r
    LEFT JOIN days d ON r.day_id = d.id
    LEFT JOIN places p ON r.place_id = p.id
    LEFT JOIN day_accommodations ap ON r.accommodation_id = ap.id
    LEFT JOIN places acc_p ON ap.place_id = acc_p.id
    WHERE r.trip_id = ?
    ORDER BY r.reservation_time ASC, r.created_at ASC
  `, tripId);

    const dayPositions = this.db.all<{ reservation_id: number; day_id: number; position: number }>(`
    SELECT rdp.reservation_id, rdp.day_id, rdp.position
    FROM reservation_day_positions rdp
    JOIN reservations r ON rdp.reservation_id = r.id
    WHERE r.trip_id = ?
  `, tripId);

    const posMap = new Map<number, Record<number, number>>();
    for (const dp of dayPositions) {
      if (!posMap.has(dp.reservation_id)) posMap.set(dp.reservation_id, {});
      posMap.get(dp.reservation_id)![dp.day_id] = dp.position;
    }

    const endpointsMap = this.loadEndpointsByTrip(tripId);
    const travelersMap = this.loadTravelersByTrip(tripId);

    for (const r of reservations) {
      r.day_positions = posMap.get(r.id) || null;
      r.endpoints = endpointsMap.get(r.id) || [];
      r.travelers = travelersMap.get(r.id) || [];
      // accommodation_id is a TEXT column; the integer FK reads back as a numeric
      // string (e.g. "14.0"). Normalize to an int so clients can parse it.
      r.accommodation_id = r.accommodation_id == null ? null : Math.trunc(Number(r.accommodation_id));
    }

    return reservations;
  }

  /**
   * Upcoming reservations across all of a user's active trips, soonest first.
   * Used by the dashboard's "Upcoming reservations" widget. A reservation counts
   * as upcoming when its own time is in the future, or — for timeless entries —
   * when its day falls on or after today. Cancelled bookings are skipped.
   * The default limit (6) matches the legacy inline handler.
   *
   * Hotels are left out on purpose (#1934). A stay covers a range rather than a
   * moment, so a week in one hotel would hold a slot in a six-entry widget for
   * the whole week and push out the bookings that actually happen on a day. The
   * accommodation belongs to the day plan, which shows it across its span.
   *
   * They also never worked here. A hotel keeps its dates on the linked stay, not
   * on the reservation: the booking form writes reservation_time = NULL and no
   * day_id, so a form-created hotel matched neither arm of the date test and was
   * invisible. The one path that did produce a visible row, the accommodation
   * panel's auto-created booking, stamps the start day into reservation_time
   * once and never restamps it, so moving the stay left the widget showing the
   * old date. Both halves of the report come from reading a hotel's date off
   * fields hotels do not use.
   */
  listUpcoming(userId: number, limit = 6) {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const reservations = this.db.all<Record<string, unknown>>(`
    WITH visible_trips AS (
      SELECT t.id, t.title, t.cover_image
      FROM trips t
      LEFT JOIN trip_members tm ON tm.trip_id = t.id AND tm.user_id = ?
      WHERE (t.user_id = ? OR tm.user_id IS NOT NULL) AND t.is_archived = 0
    ),
    -- One row per candidate with its date and time already separated, so the
    -- filter and the sort below never have to guess what reservation_time holds.
    entries AS (
      SELECT r.id, r.trip_id, r.title, r.type, r.status, r.location,
             r.reservation_time, r.confirmation_number,
             tr.title as trip_title, tr.cover_image as trip_cover,
             d.date as day_date, p.name as place_name, p.image_url as place_image,
             CASE WHEN ${DATED} THEN substr(r.reservation_time, 1, 10) ELSE d.date END as at_date,
             CASE WHEN ${DATED} THEN substr(r.reservation_time, 12) ELSE r.reservation_time END as at_time
      FROM reservations r
      JOIN visible_trips tr ON tr.id = r.trip_id
      LEFT JOIN days d ON r.day_id = d.id
      LEFT JOIN places p ON r.place_id = p.id
      WHERE r.status != 'cancelled'
        AND COALESCE(r.type, '') != 'hotel'

      UNION ALL

      -- Check-in and check-out as their own moments (#1934). The stay itself is
      -- still left out: it covers a range, and a week in one hotel would hold a
      -- slot in a six-entry widget for the whole week. Arriving and leaving are
      -- points in time, which is exactly what this widget is for, and they are
      -- the two the traveller needs reminding of.
      SELECT a.id, a.trip_id,
             COALESCE(p.name, (SELECT res.title FROM reservations res
                                WHERE CAST(res.accommodation_id AS INTEGER) = a.id
                                  AND res.status != 'cancelled'
                                ORDER BY res.id LIMIT 1), tr.title) as title,
             'checkin' as type, 'confirmed' as status, NULL as location,
             CASE WHEN a.check_in IS NOT NULL THEN d.date || 'T' || a.check_in END as reservation_time,
             a.confirmation as confirmation_number,
             tr.title as trip_title, tr.cover_image as trip_cover,
             d.date as day_date, p.name as place_name, p.image_url as place_image,
             d.date as at_date, a.check_in as at_time
      FROM day_accommodations a
      JOIN visible_trips tr ON tr.id = a.trip_id
      JOIN days d ON d.id = a.start_day_id
      LEFT JOIN places p ON p.id = a.place_id

      UNION ALL

      SELECT a.id, a.trip_id,
             COALESCE(p.name, (SELECT res.title FROM reservations res
                                WHERE CAST(res.accommodation_id AS INTEGER) = a.id
                                  AND res.status != 'cancelled'
                                ORDER BY res.id LIMIT 1), tr.title) as title,
             'checkout' as type, 'confirmed' as status, NULL as location,
             CASE WHEN a.check_out IS NOT NULL THEN d.date || 'T' || a.check_out END as reservation_time,
             a.confirmation as confirmation_number,
             tr.title as trip_title, tr.cover_image as trip_cover,
             d.date as day_date, p.name as place_name, p.image_url as place_image,
             d.date as at_date, a.check_out as at_time
      FROM day_accommodations a
      JOIN visible_trips tr ON tr.id = a.trip_id
      JOIN days d ON d.id = a.end_day_id
      LEFT JOIN places p ON p.id = a.place_id
    )
    SELECT id, trip_id, title, type, status, location, reservation_time,
           confirmation_number, trip_title, trip_cover, day_date, place_name, place_image
    FROM entries
    WHERE at_date IS NOT NULL
      AND (at_date > ? OR (at_date = ? AND COALESCE(at_time, '23:59') >= ?))
    ORDER BY at_date ASC, COALESCE(at_time, '00:00') ASC, id ASC
    LIMIT ?
  `, userId, userId, today, today, now.slice(11, 16), limit);

    return reservations;
  }

  getReservationWithJoins(id: string | number) {
    return this.reads.getReservationWithJoins(id);
  }

  /**
   * Name every id in the body that points outside this trip.
   *
   * Permission on the trip in the URL does not cover the body: it carries ids
   * of its own, and a reservation happily stores a foreign accommodation_id,
   * whose delete cascade then follows it out of the caller's own trip. The MCP
   * tools have validated their referenced ids since they were written; this is
   * the same check where every writer can reach it.
   *
   * Returns the offending field names, empty when the body is clean.
   */
  referencesOutsideTrip(tripId: string | number, data: CreateReservationData | UpdateReservationData): string[] {
    const offenders: string[] = [];
    // An id that resolves to nothing is not an offender. accommodation_id in
    // particular carries no foreign key, so shortening a trip's date range
    // cascades the day_accommodations row away and leaves the reservation
    // pointing at a gap; update() has always healed that by clearing the link,
    // and refusing the whole write instead would make such a booking
    // permanently uneditable. Only a row that exists in a DIFFERENT trip is one
    // the caller must not have reached for.
    const elsewhere = (table: 'days' | 'places' | 'day_accommodations', id: unknown) => {
      const row = this.db.get<{ trip_id: number }>(`SELECT trip_id FROM ${table} WHERE id = ?`, id);
      return !!row && String(row.trip_id) !== String(tripId);
    };

    const check = (field: string, offending: boolean) => { if (offending) offenders.push(field); };

    if (data.day_id != null) check('day_id', elsewhere('days', data.day_id));
    if (data.end_day_id != null) check('end_day_id', elsewhere('days', data.end_day_id));
    if (data.place_id != null) check('place_id', elsewhere('places', data.place_id));
    if (data.accommodation_id != null) check('accommodation_id', elsewhere('day_accommodations', data.accommodation_id));
    if (data.assignment_id != null) {
      // An assignment belongs to a trip through its day, so the join is the
      // lookup — same shape as the MCP tool's getAssignmentForTrip.
      const row = this.db.get<{ trip_id: number }>(
        'SELECT d.trip_id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ?',
        data.assignment_id,
      );
      check('assignment_id', !!row && String(row.trip_id) !== String(tripId));
    }

    const acc = data.create_accommodation;
    if (acc) {
      if (acc.place_id != null) check('create_accommodation.place_id', elsewhere('places', acc.place_id));
      if (acc.start_day_id != null) check('create_accommodation.start_day_id', elsewhere('days', acc.start_day_id));
      if (acc.end_day_id != null) check('create_accommodation.end_day_id', elsewhere('days', acc.end_day_id));
    }

    return offenders;
  }

  /** The accommodation insert, the reservation insert, the endpoint save and
   *  the metadata sync are one logical write — all-or-nothing. */
  create(tripId: string | number, data: CreateReservationData): { reservation: ReservationRow; accommodationCreated: boolean } {
    return this.db.transaction(() => this.createInTx(tripId, data));
  }

  private createInTx(tripId: string | number, data: CreateReservationData): { reservation: ReservationRow; accommodationCreated: boolean } {
    const {
      title, reservation_time, reservation_end_time, location,
      confirmation_number, notes, url, day_id, end_day_id, place_id, assignment_id,
      status, type, accommodation_id, metadata, create_accommodation,
      endpoints, needs_review
    } = data;

    let accommodationCreated = false;

    // Auto-create accommodation for hotel reservations
    let resolvedAccommodationId: number | null = accommodation_id || null;
    if (type === 'hotel' && !resolvedAccommodationId && create_accommodation) {
      const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
      if (start_day_id && end_day_id) {
        const accResult = this.db.run(
          'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)',
          tripId, accPlaceId || null, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null
        );
        resolvedAccommodationId = Number(accResult.lastInsertRowid);
        accommodationCreated = true;
      }
    }

    // Derive day_id / end_day_id from reservation_time when the client
    // didn't explicitly set them (non-hotel bookings only — hotels store
    // their date range on the linked day_accommodation).
    const resolvedType = type || 'other';
    let resolvedDayId: number | null = day_id ?? null;
    if (resolvedDayId == null && resolvedType !== 'hotel' && reservation_time) {
      resolvedDayId = this.resolveDayIdFromTime(tripId, reservation_time);
    }
    let resolvedEndDayId: number | null = end_day_id ?? null;
    if (resolvedEndDayId == null && resolvedType !== 'hotel' && reservation_end_time) {
      resolvedEndDayId = this.resolveDayIdFromTime(tripId, reservation_end_time);
    }

    const result = this.db.run(`
    INSERT INTO reservations (trip_id, day_id, end_day_id, place_id, assignment_id, title, reservation_time, reservation_end_time, location, confirmation_number, notes, url, status, type, accommodation_id, metadata, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      tripId,
      resolvedDayId,
      resolvedEndDayId,
      place_id || null,
      assignment_id || null,
      title,
      reservation_time || null,
      reservation_end_time || null,
      location || null,
      confirmation_number || null,
      notes || null,
      url || null,
      status || 'pending',
      resolvedType,
      resolvedAccommodationId,
      metadata ? JSON.stringify(metadata) : null,
      needs_review ? 1 : 0
    );

    if (endpoints && endpoints.length > 0) {
      this.saveEndpoints(Number(result.lastInsertRowid), endpoints);
    }

    // Sync check-in/out to accommodation if linked. Keyed off the RESOLVED id
    // (quirk fix): the legacy gate read the raw accommodation_id, so a hotel
    // whose accommodation was just auto-created above never received its
    // metadata check-in/out times or confirmation.
    if (resolvedAccommodationId && metadata) {
      const meta = (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) as AccommodationTimesMeta;
      if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
        this.db.run(
          'UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_in_end = COALESCE(?, check_in_end), check_out = COALESCE(?, check_out) WHERE id = ?',
          meta.check_in_time || null, meta.check_in_end_time || null, meta.check_out_time || null, resolvedAccommodationId
        );
      }
      if (confirmation_number) {
        this.db.run(
          'UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?',
          confirmation_number, resolvedAccommodationId
        );
      }
    }

    // The row was just inserted, so the re-select can't miss (legacy typed this any).
    const reservation = this.getReservationWithJoins(Number(result.lastInsertRowid))!;
    return { reservation, accommodationCreated };
  }

  updatePositions(tripId: string | number, positions: { id: number; day_plan_position?: number }[], dayId?: number | string | null) {
    if (dayId) {
      // Per-day positions for multi-day reservations, scoped the way the legacy
      // branch below already scopes its update. The table carries no trip_id and
      // its two foreign keys only ask that the ids exist, so the trip has to come
      // from the join: the row materialises only when the reservation and the day
      // agree on it. Doing that in the statement rather than as a pre-check also
      // makes a stale id a quiet no-op instead of a foreign-key error surfacing
      // as a 500.
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO reservation_day_positions (reservation_id, day_id, position)
        SELECT r.id, d.id, ?
          FROM reservations r
          JOIN days d ON d.trip_id = r.trip_id
         WHERE r.id = ? AND d.id = ? AND r.trip_id = ?
      `);
      this.db.transaction(() => {
        for (const item of positions) {
          // position is NOT NULL while the wire contract leaves the value optional.
          stmt.run(item.day_plan_position ?? 0, item.id, dayId, tripId);
        }
      });
    } else {
      // Legacy: update global position
      const stmt = this.db.prepare('UPDATE reservations SET day_plan_position = ? WHERE id = ? AND trip_id = ?');
      this.db.transaction(() => {
        for (const item of positions) {
          stmt.run(item.day_plan_position, item.id, tripId);
        }
      });
    }
  }

  getReservation(id: string | number, tripId: string | number) {
    return this.db.get<Reservation>('SELECT * FROM reservations WHERE id = ? AND trip_id = ?', id, tripId);
  }

  /** The accommodation upsert, the reservation update, the endpoint replace
   *  and the metadata sync are one logical write — all-or-nothing. */
  update(id: string | number, tripId: string | number, data: UpdateReservationData, current: Reservation): { reservation: ReservationRow; accommodationChanged: boolean } {
    return this.db.transaction(() => this.updateInTx(id, tripId, data, current));
  }

  private updateInTx(id: string | number, tripId: string | number, data: UpdateReservationData, current: Reservation): { reservation: ReservationRow; accommodationChanged: boolean } {
    const {
      title, reservation_time, reservation_end_time, location,
      confirmation_number, notes, url, day_id, end_day_id, place_id, assignment_id,
      status, type, accommodation_id, metadata, create_accommodation,
      endpoints, needs_review
    } = data;

    let accommodationChanged = false;

    // Update or create accommodation for hotel reservations
    let resolvedAccId: number | null = accommodation_id !== undefined ? (accommodation_id || null) : (current.accommodation_id ?? null);
    if (resolvedAccId) {
      // Scoped to the trip on purpose: an id belonging to someone else's trip
      // must read as absent here, not as an accommodation to write through to.
      const accExists = this.db.get('SELECT id FROM day_accommodations WHERE id = ? AND trip_id = ?', resolvedAccId, tripId);
      if (!accExists) resolvedAccId = null;
    }
    if (type === 'hotel' && create_accommodation) {
      const { place_id: accPlaceId, start_day_id, end_day_id, check_in, check_out, confirmation: accConf } = create_accommodation;
      if (start_day_id && end_day_id) {
        if (resolvedAccId) {
          this.db.run(
            'UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ? WHERE id = ?',
            accPlaceId || null, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null, resolvedAccId
          );
        } else if (accPlaceId) {
          const accResult = this.db.run(
            'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?)',
            tripId, accPlaceId, start_day_id, end_day_id, check_in || null, check_out || null, accConf || confirmation_number || null
          );
          resolvedAccId = Number(accResult.lastInsertRowid);
        }
        accommodationChanged = true;
      }
    }

    // metadata.price / priceCurrency are owned by the linked expense
    // (BudgetService.syncReservationPrice writes them), not by the booking form:
    // the client rebuilds metadata from the form on every save and only carries
    // transit / airtrail_ids over, so a plain edit used to wipe the price off the
    // card until the expense was re-saved. Keep them while a linked item exists;
    // a payload that sets them itself, or a booking without a linked expense,
    // is left untouched.
    const nextMetadata = this.keepLinkedExpensePrice(id, tripId, metadata, current.metadata);

    const resolvedType = (type ?? current.type) || 'other';
    const nextReservationTime = resolvedType === 'hotel'
      ? null
      : (reservation_time !== undefined ? (reservation_time || null) : current.reservation_time);
    const nextReservationEndTime = resolvedType === 'hotel'
      ? null
      : (reservation_end_time !== undefined ? (reservation_end_time || null) : current.reservation_end_time);

    // day_id / end_day_id: honour an explicit value from the client,
    // otherwise derive from the (possibly updated) reservation_time so the
    // planner renders the booking on the correct day.
    let nextDayId: number | null;
    if (day_id != null) {
      // Explicit day from the client (e.g. moved on the planner).
      nextDayId = day_id;
    } else if (resolvedType !== 'hotel' && nextReservationTime) {
      // No day set but we have a date — pin it to the matching day so the booking
      // still shows in the Plan (covers bookings saved without a selected day, and
      // the case where an earlier edit cleared day_id).
      nextDayId = this.resolveDayIdFromTime(tripId, nextReservationTime);
    } else if (day_id === undefined) {
      // Field absent and nothing to derive from — keep whatever it had.
      nextDayId = current.day_id ?? null;
    } else {
      nextDayId = null;
    }

    let nextEndDayId: number | null;
    if (end_day_id !== undefined) {
      nextEndDayId = end_day_id ?? null;
    } else if (reservation_end_time !== undefined && resolvedType !== 'hotel') {
      nextEndDayId = this.resolveDayIdFromTime(tripId, nextReservationEndTime);
    } else {
      nextEndDayId = current.end_day_id ?? null;
    }

    this.db.run(`
    UPDATE reservations SET
      title = COALESCE(?, title),
      reservation_time = ?,
      reservation_end_time = ?,
      location = ?,
      confirmation_number = ?,
      notes = ?,
      url = ?,
      day_id = ?,
      end_day_id = ?,
      place_id = ?,
      assignment_id = ?,
      status = COALESCE(?, status),
      type = COALESCE(?, type),
      accommodation_id = ?,
      metadata = ?,
      needs_review = COALESCE(?, needs_review)
    WHERE id = ?
  `,
      title || null,
      nextReservationTime,
      nextReservationEndTime,
      location !== undefined ? (location || null) : current.location,
      confirmation_number !== undefined ? (confirmation_number || null) : current.confirmation_number,
      notes !== undefined ? (notes || null) : current.notes,
      url !== undefined ? (url || null) : (current as Reservation & { url?: string | null }).url,
      nextDayId,
      nextEndDayId,
      place_id !== undefined ? (place_id || null) : current.place_id,
      assignment_id !== undefined ? (assignment_id || null) : current.assignment_id,
      status || null,
      type || null,
      resolvedAccId,
      nextMetadata !== undefined ? (nextMetadata ? JSON.stringify(nextMetadata) : null) : current.metadata,
      needs_review === undefined ? null : (needs_review ? 1 : 0),
      id
    );

    if (endpoints !== undefined) {
      this.saveEndpoints(Number(id), endpoints);
    }

    // Sync check-in/out to accommodation if linked
    const resolvedMeta = nextMetadata !== undefined ? nextMetadata : (current.metadata ? JSON.parse(current.metadata as string) : null);
    if (resolvedAccId && resolvedMeta) {
      const meta = (typeof resolvedMeta === 'string' ? JSON.parse(resolvedMeta) : resolvedMeta) as AccommodationTimesMeta;
      if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
        this.db.run(
          'UPDATE day_accommodations SET check_in = COALESCE(?, check_in), check_in_end = COALESCE(?, check_in_end), check_out = COALESCE(?, check_out) WHERE id = ?',
          meta.check_in_time || null, meta.check_in_end_time || null, meta.check_out_time || null, resolvedAccId
        );
      }
      const resolvedConf = confirmation_number !== undefined ? confirmation_number : current.confirmation_number;
      if (resolvedConf) {
        this.db.run(
          'UPDATE day_accommodations SET confirmation = COALESCE(?, confirmation) WHERE id = ?',
          resolvedConf, resolvedAccId
        );
      }
    }

    // The caller passed the pre-checked `current` row, so the re-select can't
    // miss (legacy typed this any).
    const reservation = this.getReservationWithJoins(id)!;
    return { reservation, accommodationChanged };
  }

  /**
   * Carry `price` / `priceCurrency` from the stored metadata into an incoming
   * metadata object that doesn't set them, as long as a budget item is still
   * linked to the booking. Returns the incoming value untouched otherwise —
   * `undefined` (field absent) and `null` (explicit clear) pass straight through.
   */
  private keepLinkedExpensePrice(id: string | number, tripId: string | number, incoming: unknown, stored: string | null | undefined): unknown {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || !stored) return incoming;
    const next = incoming as Record<string, unknown>;
    if (next.price !== undefined) return incoming;
    let prev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object') return incoming;
      prev = parsed as Record<string, unknown>;
    } catch {
      return incoming;
    }
    if (prev.price === undefined) return incoming;
    const linked = this.db.get('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?', tripId, id);
    if (!linked) return incoming;
    const kept: Record<string, unknown> = { ...next, price: prev.price };
    if (prev.priceCurrency !== undefined && next.priceCurrency === undefined) kept.priceCurrency = prev.priceCurrency;
    return kept;
  }

  /** The accommodation + budget-item + reservation deletes are one logical
   *  cascade — all-or-nothing. */
  remove(id: string | number, tripId: string | number): { deleted: { id: number; title: string; type: string; accommodation_id: number | null } | undefined; accommodationDeleted: boolean; deletedBudgetItemId: number | null } {
    return this.db.transaction(() => {
      const reservation = this.db.get<{ id: number; title: string; type: string; accommodation_id: number | null }>(
        'SELECT id, title, type, accommodation_id FROM reservations WHERE id = ? AND trip_id = ?', id, tripId
      );
      if (!reservation) return { deleted: undefined, accommodationDeleted: false, deletedBudgetItemId: null };

      let accommodationDeleted = false;
      if (reservation.accommodation_id) {
        // trip_id in the WHERE, not just the reservation's own scope: a row
        // written before referencesOutsideTrip existed can still carry a
        // foreign accommodation_id, and the cascade must not follow it.
        const removed = this.db.run(
          'DELETE FROM day_accommodations WHERE id = ? AND trip_id = ?', reservation.accommodation_id, tripId,
        );
        accommodationDeleted = removed.changes > 0;
      }

      const linkedBudget = this.db.get<{ id: number }>('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?', tripId, id);
      if (linkedBudget) {
        this.db.run('DELETE FROM budget_items WHERE id = ?', linkedBudget.id);
      }

      this.db.run('DELETE FROM reservations WHERE id = ?', id);
      return { deleted: reservation, accommodationDeleted, deletedBudgetItemId: linkedBudget ? linkedBudget.id : null };
    });
  }

  /** POST side effect: auto-create a linked budget item when a price is provided. */
  syncBudgetOnCreate(tripId: string, reservationId: number, title: string, type: string | undefined, entry: BudgetEntry, socketId: string | undefined): void {
    if (!entry || !(Number(entry.total_price) > 0)) return;
    try {
      const item = this.budget.linkBudgetItemToReservation(tripId, reservationId, {
        name: title,
        category: entry.category || type || 'Other',
        total_price: entry.total_price!,
      });
      this.realtime.broadcast(tripId, 'budget:created', { item }, socketId);
    } catch (err) {
      console.error('[reservations] Failed to create budget entry:', err);
    }
  }

  /** PUT side effect: drop the linked budget item when the price is cleared, else create/update it. */
  syncBudgetOnUpdate(tripId: string, id: string, title: string, type: string | undefined, currentTitle: string, currentType: string | undefined, entry: BudgetEntry, socketId: string | undefined): void {
    // When the booking type changes, keep a linked expense's category in sync —
    // but only if it still carries the auto-derived category (so a manual pick in
    // the Costs editor is preserved). Runs regardless of create_budget_entry.
    if (type && currentType && type !== currentType) {
      const linked = this.db.get<{ id: number; category: string }>('SELECT id, category FROM budget_items WHERE trip_id = ? AND reservation_id = ?', tripId, id);
      if (linked) {
        const oldCat = typeToCostCategory(currentType);
        const newCat = typeToCostCategory(type);
        if (oldCat !== newCat && linked.category === oldCat) {
          const updated = this.budget.updateBudgetItem(linked.id, tripId, { category: newCat });
          this.realtime.broadcast(tripId, 'budget:updated', { item: updated }, socketId);
        }
      }
    }

    // No budget entry on the payload — the booking edit isn't touching its linked
    // expense, so leave any linked item alone. Expenses are managed from the
    // booking's Costs section / the Costs tab, not by re-saving the booking.
    if (!entry) return;

    if (!(Number(entry.total_price) > 0)) {
      // Explicit clear (total_price 0/empty) — drop the linked item.
      const linked = this.db.get<{ id: number }>('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?', tripId, id);
      if (linked) {
        this.budget.deleteBudgetItem(linked.id, tripId);
        this.realtime.broadcast(tripId, 'budget:deleted', { itemId: linked.id }, socketId);
      }
      return;
    }

    try {
      const itemName = title || currentTitle;
      const category = entry.category || type || currentType || 'Other';
      const existing = this.db.get<{ id: number }>('SELECT id FROM budget_items WHERE trip_id = ? AND reservation_id = ?', tripId, id);
      if (existing) {
        const updated = this.budget.updateBudgetItem(existing.id, tripId, { name: itemName, category, total_price: entry.total_price });
        this.realtime.broadcast(tripId, 'budget:updated', { item: updated }, socketId);
      } else {
        const item = this.budget.createBudgetItem(tripId, { name: itemName, category, total_price: entry.total_price });
        this.db.run('UPDATE budget_items SET reservation_id = ? WHERE id = ?', id, item.id);
        item.reservation_id = Number(id);
        this.realtime.broadcast(tripId, 'budget:created', { item }, socketId);
      }
    } catch (err) {
      console.error('[reservations] Failed to create/update budget entry:', err);
    }
  }
}
