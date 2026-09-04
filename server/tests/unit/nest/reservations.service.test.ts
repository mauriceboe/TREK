/**
 * Unit tests for the DI-native ReservationsService — RESV-SVC-001+ (real-SQL
 * cases over the folded legacy services/reservationService.ts statements),
 * RES-TRAV-001..005 (moved 1:1 from tests/unit/services/reservationTravelers.test.ts)
 * and RESV-BRIDGE-001..009, which kept their assertions when the bridge went.
 * Uses a real in-memory SQLite DB so the SQL logic — falsy-coercion defaults,
 * COALESCE update semantics, day derivation, the accommodation/budget cascades
 * and the TEXT accommodation_id normalization — is exercised faithfully.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db, closeDb: () => {}, reinitialize: () => {}, getPlaceWithTags: () => null,
    canAccessTrip: (tripId: unknown, userId: number) => db.prepare(`
        SELECT t.* FROM trips t
        LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ?
        WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)
      `).get(userId, tripId, userId),
    isOwner: (tripId: unknown, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../../../src/websocket', () => ({ broadcast }));

const checkPermission = vi.fn(() => true);
const permissionsStub = { checkPermission } as unknown as PermissionsService;

// Constructor-injected since the budget fold (was a path mock of the deleted
// services/budgetService).
const budget = { createBudgetItem: vi.fn(), updateBudgetItem: vi.fn(), deleteBudgetItem: vi.fn(), linkBudgetItemToReservation: vi.fn() };

const { notif } = vi.hoisted(() => ({ notif: { send: vi.fn().mockResolvedValue(undefined) } }));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, createReservation, createBudgetItem, createPlace, createDay, createDayAccommodation, addTripMember } from '../../helpers/factories';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import { ReservationsService } from '../../../src/nest/reservations/reservations.service';
import { ReservationsReadRepository } from '../../../src/nest/reservations/reservations-read.repository';
import type { BudgetService } from '../../../src/nest/budget/budget.service';
// Was reservations.bridge, deleted along with the other three that had no
// consumer outside the container. The cases below kept their assertions and
// point at the service the bridge delegated to; only the delegation itself is
// gone, and there was nothing left to delegate for.
const bridge = {
  listReservations: (tripId: string | number) => svc.list(tripId),
  loadEndpointsByTrip: (tripId: string | number) => svc.loadEndpointsByTrip(tripId),
  resyncReservationDays: (tripId: string | number) => svc.resyncReservationDays(tripId),
  createReservation: (tripId: string | number, data: Parameters<ReservationsService['create']>[1]) => svc.create(tripId, data),
  getReservation: (id: string | number, tripId: string | number) => svc.getReservation(id, tripId),
  getReservationWithJoins: (id: string | number) => svc.getReservationWithJoins(id),
  updateReservation: (
    id: string | number,
    tripId: string | number,
    data: Parameters<ReservationsService['update']>[2],
    current: Parameters<ReservationsService['update']>[3],
  ) => svc.update(id, tripId, data, current),
  deleteReservation: (id: string | number, tripId: string | number) => svc.remove(id, tripId),
  notifyBookingChange: (...a: Parameters<ReservationsService['notifyBookingChange']>) => svc.notifyBookingChange(...a),
};
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import { notificationsStub } from '../../helpers/notifications';

const svc = new ReservationsService(new DatabaseService(testDb), permissionsStub, budget as unknown as BudgetService, new RealtimeService(), notificationsStub(notif.send), new ReservationsReadRepository(new DatabaseService(testDb)));

beforeAll(() => { createTables(testDb); runMigrations(testDb); });
beforeEach(() => {
  resetTestDb(testDb);
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => testDb.close());

/** Owner + trip helper for the common single-user cases. */
function ownerTrip(overrides: Parameters<typeof createTrip>[2] = {}) {
  const { user } = createUser(testDb);
  const trip = createTrip(testDb, user.id, overrides);
  return { user, trip };
}

describe('ReservationsService (DI-native, real SQL)', () => {
  it('RESV-SVC-001: canEdit delegates to checkPermission with reservation_edit', () => {
    svc.canEdit({ user_id: 2 } as never, { id: 1, role: 'user' } as never);
    expect(checkPermission).toHaveBeenCalledWith('reservation_edit', 'user', 2, 1, true);
  });

  describe('create', () => {
    it('RESV-SVC-002: applies the legacy falsy-coercion defaults and re-selects the joined row', () => {
      const { trip } = ownerTrip();
      const { reservation, accommodationCreated } = svc.create(String(trip.id), { title: 'Dinner', location: '' } as never);
      expect(accommodationCreated).toBe(false);
      expect(reservation).toMatchObject({
        title: 'Dinner',
        type: 'other',        // type || 'other'
        status: 'pending',    // status || 'pending'
        location: null,       // '' || null
        accommodation_id: null,
        endpoints: [],
        travelers: [],
      });
    });

    it('RESV-SVC-003: derives day_id from reservation_time for non-hotel bookings', () => {
      const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
      const day2 = testDb.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ?').get(trip.id, '2030-05-02') as { id: number };
      const { reservation } = svc.create(String(trip.id), { title: 'Tour', type: 'tour', reservation_time: '2030-05-02T10:00:00' });
      expect(reservation.day_id).toBe(day2.id);
      // Out-of-range time clamps to the nearest day (create path clamps).
      const day3 = testDb.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ?').get(trip.id, '2030-05-03') as { id: number };
      const { reservation: clamped } = svc.create(String(trip.id), { title: 'Late', type: 'tour', reservation_time: '2030-06-20T10:00:00' });
      expect(clamped.day_id).toBe(day3.id);
    });

    it('RESV-SVC-004: auto-creates the accommodation for a hotel with create_accommodation', () => {
      const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
      const place = createPlace(testDb, trip.id);
      const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
      const { reservation, accommodationCreated } = svc.create(String(trip.id), {
        title: 'Hotel', type: 'hotel',
        create_accommodation: { place_id: place.id, start_day_id: days[0].id, end_day_id: days[2].id, check_in: '15:00' },
        confirmation_number: 'ABC123',
      });
      expect(accommodationCreated).toBe(true);
      const acc = testDb.prepare('SELECT * FROM day_accommodations WHERE trip_id = ?').get(trip.id) as Record<string, unknown>;
      expect(acc).toMatchObject({ place_id: place.id, check_in: '15:00', confirmation: 'ABC123' });
      // TEXT accommodation_id column reads back normalized to an int.
      expect(reservation.accommodation_id).toBe(Number(acc.id));
      expect(reservation.accommodation_name).toBe(place.name);
    });

    it('RESV-SVC-005: saves endpoints, skipping null-coordinate rows; sequence defaults to the post-filter index', () => {
      const { trip } = ownerTrip();
      const endpoints = [
        { role: 'from', name: 'A', code: 'AAA', lat: 1, lng: 2, timezone: null, local_time: null, local_date: null },
        { role: 'to', name: 'NoGeo', code: null, lat: null, lng: null, timezone: null, local_time: null, local_date: null },
        { role: 'to', name: 'B', code: 'BBB', lat: 3, lng: 4, timezone: null, local_time: null, local_date: null },
      ];
      const { reservation } = svc.create(String(trip.id), { title: 'Bus', type: 'other', endpoints } as never);
      const rows = testDb.prepare('SELECT name, sequence FROM reservation_endpoints WHERE reservation_id = ? ORDER BY sequence').all(reservation.id) as { name: string; sequence: number }[];
      // The index fallback runs AFTER the null-coord filter, so 'B' (third on
      // the wire, second surviving row) gets sequence 1.
      expect(rows).toEqual([{ name: 'A', sequence: 0 }, { name: 'B', sequence: 1 }]);
    });

    it('RESV-SVC-006 (quirk fixed): metadata check-in sync keys off the resolved id, so an auto-created accommodation gets its times too', () => {
      const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
      const place = createPlace(testDb, trip.id);
      const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
      svc.create(String(trip.id), {
        title: 'Hotel', type: 'hotel',
        create_accommodation: { place_id: place.id, start_day_id: days[0].id, end_day_id: days[1].id },
        metadata: { check_in_time: '16:00' },
      });
      // The legacy gate read the raw accommodation_id and left this NULL.
      const acc = testDb.prepare('SELECT check_in FROM day_accommodations WHERE trip_id = ?').get(trip.id) as { check_in: string | null };
      expect(acc.check_in).toBe('16:00');
    });
  });

  describe('update', () => {
    it('RESV-SVC-007: an empty-string title silently keeps the old value (COALESCE + `|| null`)', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Old title' });
      const current = svc.getReservation(String(res.id), String(trip.id))!;
      const { reservation } = svc.update(String(res.id), String(trip.id), { title: '', notes: 'updated' }, current);
      expect(reservation.title).toBe('Old title');
      expect(reservation.notes).toBe('updated');
    });

    it('RESV-SVC-008: switching to hotel forces reservation_time/reservation_end_time to null', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'X', type: 'tour' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2030-05-01T10:00:00', res.id);
      const current = svc.getReservation(String(res.id), String(trip.id))!;
      const { reservation } = svc.update(String(res.id), String(trip.id), { type: 'hotel' }, current);
      expect(reservation.reservation_time).toBeNull();
      expect(reservation.reservation_end_time).toBeNull();
    });

    it('RESV-SVC-009: a stale accommodation_id pointing at a deleted row is nulled out', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
      testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run('999', res.id);
      const current = svc.getReservation(String(res.id), String(trip.id))!;
      const { reservation } = svc.update(String(res.id), String(trip.id), { notes: 'n' }, current);
      expect(reservation.accommodation_id).toBeNull();
    });

    it('RESV-SVC-033: a metadata payload without `price` keeps the linked expense price (and currency) from the stored metadata', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Flight', type: 'flight' });
      const item = createBudgetItem(testDb, trip.id, { name: 'Flight', total_price: 2040 });
      testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);
      testDb.prepare('UPDATE reservations SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ airline: 'CZ', seat: '72K', price: '2040', priceCurrency: 'CNY' }), res.id);
      const current = svc.getReservation(String(res.id), String(trip.id))!;
      // What the booking form sends back: rebuilt from its fields, price not among them.
      const { reservation } = svc.update(String(res.id), String(trip.id), { metadata: { airline: 'CZ', seat: '12A' } }, current);
      expect(JSON.parse(reservation.metadata as string)).toEqual({ airline: 'CZ', seat: '12A', price: '2040', priceCurrency: 'CNY' });
    });

    it('RESV-SVC-034: a payload that names `price` is taken at face value, set or cleared', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Linked', type: 'flight' });
      const item = createBudgetItem(testDb, trip.id, { name: 'Linked', total_price: 100 });
      testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);
      testDb.prepare('UPDATE reservations SET metadata = ? WHERE id = ?').run(JSON.stringify({ price: '100' }), res.id);

      let current = svc.getReservation(String(res.id), String(trip.id))!;
      let { reservation } = svc.update(String(res.id), String(trip.id), { metadata: { price: '150' } }, current);
      expect(JSON.parse(reservation.metadata as string)).toEqual({ price: '150' });

      // Naming the key with a null is how a caller removes the price on purpose;
      // it must not be read as "the form did not mention it".
      current = svc.getReservation(String(res.id), String(trip.id))!;
      ({ reservation } = svc.update(String(res.id), String(trip.id), { metadata: { price: null, seat: '1A' } }, current));
      expect(JSON.parse(reservation.metadata as string)).toEqual({ price: null, seat: '1A' });
    });

    it('RESV-SVC-036: a price with no linked expense is kept too, because the importer stamps one either way', () => {
      // booking-import writes metadata.price unconditionally but only creates the
      // linked cost when the Costs addon is on and the price is above zero, so an
      // instance with that addon off has bookings carrying a price and no budget
      // row at all. Keying the carry-over on a linked item would drop those.
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Imported', type: 'flight' });
      testDb.prepare('UPDATE reservations SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ price: '999', priceCurrency: 'EUR' }), res.id);
      const current = svc.getReservation(String(res.id), String(trip.id))!;

      const { reservation } = svc.update(String(res.id), String(trip.id), { metadata: { seat: '1A' } }, current);
      expect(JSON.parse(reservation.metadata as string)).toEqual({ seat: '1A', price: '999', priceCurrency: 'EUR' });
    });

    it('RESV-SVC-035: metadata null still clears the stored metadata, linked expense or not', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Flight', type: 'flight' });
      const item = createBudgetItem(testDb, trip.id, { name: 'Flight', total_price: 50 });
      testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);
      testDb.prepare('UPDATE reservations SET metadata = ? WHERE id = ?').run(JSON.stringify({ price: '50' }), res.id);
      const current = svc.getReservation(String(res.id), String(trip.id))!;
      const { reservation } = svc.update(String(res.id), String(trip.id), { metadata: null }, current);
      expect(reservation.metadata).toBeNull();
    });

    it('RESV-SVC-010: endpoints [] wipes stored endpoints; an absent field leaves them alone', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Bus' });
      testDb.prepare('INSERT INTO reservation_endpoints (reservation_id, role, sequence, name, lat, lng) VALUES (?, ?, 0, ?, 1, 2)').run(res.id, 'from', 'A');
      let current = svc.getReservation(String(res.id), String(trip.id))!;
      svc.update(String(res.id), String(trip.id), { notes: 'no endpoints field' }, current);
      expect(testDb.prepare('SELECT COUNT(*) as c FROM reservation_endpoints WHERE reservation_id = ?').get(res.id)).toEqual({ c: 1 });
      current = svc.getReservation(String(res.id), String(trip.id))!;
      svc.update(String(res.id), String(trip.id), { endpoints: [] }, current);
      expect(testDb.prepare('SELECT COUNT(*) as c FROM reservation_endpoints WHERE reservation_id = ?').get(res.id)).toEqual({ c: 0 });
    });
  });

  describe('remove', () => {
    it('RESV-SVC-011: cascades to the linked accommodation and budget item, reporting both', () => {
      const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
      const place = createPlace(testDb, trip.id);
      const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
      const acc = createDayAccommodation(testDb, trip.id, place.id, days[0].id, days[1].id);
      const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
      testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(String(acc.id), res.id);
      const item = createBudgetItem(testDb, trip.id);
      testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);

      const result = svc.remove(String(res.id), String(trip.id));
      expect(result.deleted).toMatchObject({ id: res.id, title: 'Hotel', type: 'hotel' });
      expect(result.accommodationDeleted).toBe(true);
      expect(result.deletedBudgetItemId).toBe(item.id);
      expect(testDb.prepare('SELECT COUNT(*) as c FROM reservations WHERE id = ?').get(res.id)).toEqual({ c: 0 });
      expect(testDb.prepare('SELECT COUNT(*) as c FROM day_accommodations WHERE id = ?').get(acc.id)).toEqual({ c: 0 });
      expect(testDb.prepare('SELECT COUNT(*) as c FROM budget_items WHERE id = ?').get(item.id)).toEqual({ c: 0 });
    });

    it('RESV-SVC-012: returns the empty shape when the reservation is missing', () => {
      const { trip } = ownerTrip();
      expect(svc.remove('999', String(trip.id))).toEqual({ deleted: undefined, accommodationDeleted: false, deletedBudgetItemId: null });
    });
  });

  describe('updatePositions', () => {
    it('RESV-SVC-013: without dayId updates the global day_plan_position (legacy branch)', () => {
      const { trip } = ownerTrip();
      const r1 = createReservation(testDb, trip.id, { title: 'A' });
      const r2 = createReservation(testDb, trip.id, { title: 'B' });
      svc.updatePositions(String(trip.id), [{ id: r2.id, day_plan_position: 0 }, { id: r1.id, day_plan_position: 1 }]);
      expect(testDb.prepare('SELECT day_plan_position FROM reservations WHERE id = ?').get(r2.id)).toEqual({ day_plan_position: 0 });
      expect(testDb.prepare('SELECT day_plan_position FROM reservations WHERE id = ?').get(r1.id)).toEqual({ day_plan_position: 1 });
    });

    it('RESV-SVC-014: with dayId upserts per-day positions into reservation_day_positions', () => {
      const { trip } = ownerTrip();
      const day = createDay(testDb, trip.id, { date: '2030-05-01' });
      const r1 = createReservation(testDb, trip.id, { title: 'A' });
      svc.updatePositions(String(trip.id), [{ id: r1.id, day_plan_position: 3 }], day.id);
      svc.updatePositions(String(trip.id), [{ id: r1.id, day_plan_position: 5 }], day.id); // OR REPLACE
      expect(testDb.prepare('SELECT position FROM reservation_day_positions WHERE reservation_id = ? AND day_id = ?').get(r1.id, day.id)).toEqual({ position: 5 });
      expect(testDb.prepare('SELECT day_plan_position FROM reservations WHERE id = ?').get(r1.id)).toEqual({ day_plan_position: null });
    });
  });

  describe('list / getReservationWithJoins', () => {
    it('RESV-SVC-015: attaches day_positions, endpoints, travelers and normalizes the TEXT accommodation_id', () => {
      const { user, trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
      const place = createPlace(testDb, trip.id);
      const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
      const acc = createDayAccommodation(testDb, trip.id, place.id, days[0].id, days[1].id);
      const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
      // The TEXT column quirk: the FK reads back as a numeric string like "14.0".
      testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(`${acc.id}.0`, res.id);
      testDb.prepare('INSERT INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)').run(res.id, days[0].id, 2);
      svc.setReservationTravelers(res.id, trip.id, [user.id]);

      const [row] = svc.list(String(trip.id));
      expect(row.accommodation_id).toBe(acc.id);
      expect(row.accommodation_name).toBe(place.name);
      expect(row.day_positions).toEqual({ [days[0].id]: 2 });
      expect(row.travelers).toHaveLength(1);

      const single = svc.getReservationWithJoins(res.id)!;
      expect(single.accommodation_id).toBe(acc.id);
      expect(single.travelers).toHaveLength(1);
    });

    it('RESV-SVC-016: getReservationWithJoins returns undefined for a missing id', () => {
      expect(svc.getReservationWithJoins(999)).toBeUndefined();
    });
  });

  describe('listUpcoming', () => {
    it('RESV-SVC-017: returns future reservations across owned + member trips, skipping cancelled', () => {
      const { user, trip } = ownerTrip();
      const future = createReservation(testDb, trip.id, { title: 'Future' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-01-01T10:00:00', future.id);
      const past = createReservation(testDb, trip.id, { title: 'Past' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2000-01-01T10:00:00', past.id);
      const cancelled = createReservation(testDb, trip.id, { title: 'Cancelled' });
      testDb.prepare("UPDATE reservations SET reservation_time = ?, status = 'cancelled' WHERE id = ?").run('2999-01-02T10:00:00', cancelled.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Future']);
    });

    // #1934 — a stay covers a range, so it would hold a widget slot for its
    // whole span. Both ways a hotel can be dated are kept out.
    it('RESV-SVC-017b: leaves out a hotel dated through its own reservation_time', () => {
      const { user, trip } = ownerTrip();
      const hotel = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-01-01T10:00:00', hotel.id);
      const flight = createReservation(testDb, trip.id, { title: 'Flight' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-01-02T10:00:00', flight.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Flight']);
    });

    it('RESV-SVC-017c: leaves out a hotel dated through its day', () => {
      const { user, trip } = ownerTrip();
      const day = createDay(testDb, trip.id, { date: '2999-06-01' });
      createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel', day_id: day.id });

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual([]);
    });

    // The type column defaults to 'other' but nothing stops a NULL, and a
    // NULL-unsafe `type != 'hotel'` would silently drop those rows.
    it('RESV-SVC-017d: a reservation with no type at all still shows', () => {
      const { user, trip } = ownerTrip();
      const res = createReservation(testDb, trip.id, { title: 'Untyped' });
      testDb.prepare('UPDATE reservations SET type = NULL, reservation_time = ? WHERE id = ?').run('2999-01-01T10:00:00', res.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Untyped']);
    });

    // The column holds two shapes: the booking form writes 'YYYY-MM-DDTHH:MM',
    // day-anchored rows hold a bare 'HH:MM'. Compared as strings against an ISO
    // timestamp, ':' sorts above '2', so a bare time was an arbitrary filter:
    // everything from 20:00 on passed and everything before it vanished (#1934).
    it('RESV-SVC-017e: a bare clock time falls back to its day instead of being read as a date', () => {
      const { user, trip } = ownerTrip();
      const day = createDay(testDb, trip.id, { date: '2999-06-01' });
      const morning = createReservation(testDb, trip.id, { title: 'Ferry', day_id: day.id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('08:30', morning.id);
      const evening = createReservation(testDb, trip.id, { title: 'Show', day_id: day.id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('20:00', evening.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Ferry', 'Show']);
    });

    it('RESV-SVC-017f: orders by the day and the clock, not by the raw column', () => {
      const { user, trip } = ownerTrip();
      const early = createDay(testDb, trip.id, { date: '2999-06-01' });
      const late = createDay(testDb, trip.id, { date: '2999-06-02' });
      const bare = createReservation(testDb, trip.id, { title: 'Bare morning', day_id: early.id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('08:30', bare.id);
      const dated = createReservation(testDb, trip.id, { title: 'Dated day two' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-06-02T09:00', dated.id);
      const later = createReservation(testDb, trip.id, { title: 'Bare evening', day_id: early.id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('20:00', later.id);
      const dayOnly = createReservation(testDb, trip.id, { title: 'No time', day_id: late.id });
      testDb.prepare('UPDATE reservations SET reservation_time = NULL WHERE id = ?').run(dayOnly.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Bare morning', 'Bare evening', 'No time', 'Dated day two']);
    });

    // The stay stays out, but arriving and leaving are moments, and they are the
    // two the traveller needs reminding of.
    it('RESV-SVC-017g: a stay contributes a check-in and a check-out named after its place', () => {
      const { user, trip } = ownerTrip();
      const start = createDay(testDb, trip.id, { date: '2999-06-01' });
      const end = createDay(testDb, trip.id, { date: '2999-06-05' });
      const place = createPlace(testDb, trip.id, { name: 'The Plaza' });
      createDayAccommodation(testDb, trip.id, place.id, start.id, end.id, { check_in: '15:00', check_out: '11:00' });

      const rows = svc.listUpcoming(user.id) as { title: string; type: string; day_date: string }[];
      expect(rows).toEqual([
        expect.objectContaining({ title: 'The Plaza', type: 'checkin', day_date: '2999-06-01' }),
        expect.objectContaining({ title: 'The Plaza', type: 'checkout', day_date: '2999-06-05' }),
      ]);
    });

    it('RESV-SVC-017h: the two moments sort among the bookings rather than after them', () => {
      const { user, trip } = ownerTrip();
      const start = createDay(testDb, trip.id, { date: '2999-06-01' });
      const end = createDay(testDb, trip.id, { date: '2999-06-03' });
      const place = createPlace(testDb, trip.id, { name: 'Hostel' });
      createDayAccommodation(testDb, trip.id, place.id, start.id, end.id, { check_in: '15:00', check_out: '10:00' });
      const dinner = createReservation(testDb, trip.id, { title: 'Dinner' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-06-01T19:00', dinner.id);
      const museum = createReservation(testDb, trip.id, { title: 'Museum' });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2999-06-02T09:00', museum.id);

      const rows = svc.listUpcoming(user.id) as { title: string }[];
      expect(rows.map(r => r.title)).toEqual(['Hostel', 'Dinner', 'Museum', 'Hostel']);
    });

    it('RESV-SVC-017i: a stay that is already over contributes nothing', () => {
      const { user, trip } = ownerTrip();
      const start = createDay(testDb, trip.id, { date: '2000-06-01' });
      const end = createDay(testDb, trip.id, { date: '2000-06-05' });
      const place = createPlace(testDb, trip.id, { name: 'Old Inn' });
      createDayAccommodation(testDb, trip.id, place.id, start.id, end.id, { check_in: '15:00', check_out: '11:00' });

      expect(svc.listUpcoming(user.id)).toEqual([]);
    });

    it('RESV-SVC-017j: a nameless stay falls back to its linked booking', () => {
      const { user, trip } = ownerTrip();
      const start = createDay(testDb, trip.id, { date: '2999-06-01' });
      const end = createDay(testDb, trip.id, { date: '2999-06-02' });
      const acc = testDb.prepare(
        'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out) VALUES (?, NULL, ?, ?, ?, ?)'
      ).run(trip.id, start.id, end.id, '15:00', '11:00');
      const booking = createReservation(testDb, trip.id, { title: 'Hotel Ibis', type: 'hotel' });
      testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(String(acc.lastInsertRowid), booking.id);

      const rows = svc.listUpcoming(user.id) as { title: string; type: string }[];
      expect(rows.map(r => r.type + ':' + r.title)).toEqual(['checkin:Hotel Ibis', 'checkout:Hotel Ibis']);
    });
  });

  describe('resyncReservationDays', () => {
    it('RESV-SVC-018: re-anchors a dated booking to the day matching its time; out-of-range stays untouched', () => {
      const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
      const days = testDb.prepare('SELECT id, date FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number; date: string }[];
      const res = createReservation(testDb, trip.id, { title: 'Tour', type: 'tour', day_id: days[0].id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2030-05-03T09:00:00', res.id);
      const outside = createReservation(testDb, trip.id, { title: 'Outside', type: 'tour', day_id: days[0].id });
      testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2031-01-01T09:00:00', outside.id);

      svc.resyncReservationDays(String(trip.id));
      expect(testDb.prepare('SELECT day_id FROM reservations WHERE id = ?').get(res.id)).toEqual({ day_id: days[2].id });
      expect(testDb.prepare('SELECT day_id FROM reservations WHERE id = ?').get(outside.id)).toEqual({ day_id: days[0].id });
    });
  });

  describe('setTravelers (controller-facing composition)', () => {
    it('returns null when the reservation is not on the trip (off-trip guard)', () => {
      const { trip } = ownerTrip();
      expect(svc.setTravelers('999', String(trip.id), [2])).toBeNull();
    });

    it('assigns travelers and returns the refreshed travelers + reservation', () => {
      const { user, trip } = ownerTrip();
      const res = createReservation(testDb, trip.id);
      const result = svc.setTravelers(String(res.id), String(trip.id), [user.id])!;
      expect(result.travelers).toHaveLength(1);
      expect(result.travelers[0]).toMatchObject({ user_id: user.id });
      expect(result.reservation).toMatchObject({ id: res.id });
    });
  });

  describe('syncBudgetOnCreate', () => {
    it('does nothing without a positive price', () => {
      svc.syncBudgetOnCreate('5', 9, 'Hotel', 'lodging', undefined, 'sock');
      svc.syncBudgetOnCreate('5', 9, 'Hotel', 'lodging', { total_price: 0 }, 'sock');
      expect(budget.linkBudgetItemToReservation).not.toHaveBeenCalled();
    });

    it('links a budget item and broadcasts budget:created', () => {
      budget.linkBudgetItemToReservation.mockReturnValue({ id: 7 });
      svc.syncBudgetOnCreate('5', 9, 'Hotel', 'lodging', { total_price: 200, category: 'Lodging' }, 'sock');
      expect(budget.linkBudgetItemToReservation).toHaveBeenCalledWith('5', 9, { name: 'Hotel', category: 'Lodging', total_price: 200 });
      expect(broadcast).toHaveBeenCalledWith('5', 'budget:created', { item: { id: 7 } }, 'sock');
    });

    it('falls back to type then "Other" for the category and swallows errors', () => {
      budget.linkBudgetItemToReservation.mockImplementation(() => { throw new Error('boom'); });
      expect(() => svc.syncBudgetOnCreate('5', 9, 'Hotel', undefined, { total_price: 50 }, 'sock')).not.toThrow();
    });
  });

  describe('syncBudgetOnUpdate', () => {
    function linkedItem(overrides: Parameters<typeof createBudgetItem>[2] = {}) {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id);
      const item = createBudgetItem(testDb, trip.id, overrides);
      testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);
      return { trip, res, item };
    }

    it('deletes the linked item when the price is explicitly cleared (total_price 0)', () => {
      const { trip, res, item } = linkedItem();
      svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'Hotel', 'lodging', 'Hotel', 'lodging', { total_price: 0 }, 'sock');
      expect(budget.deleteBudgetItem).toHaveBeenCalledWith(item.id, String(trip.id));
      expect(broadcast).toHaveBeenCalledWith(String(trip.id), 'budget:deleted', { itemId: item.id }, 'sock');
    });

    it('leaves the linked item alone when no budget entry is on the payload (no wipe)', () => {
      const { trip, res } = linkedItem();
      svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'Hotel', 'lodging', 'Hotel', 'lodging', undefined, 'sock');
      expect(budget.deleteBudgetItem).not.toHaveBeenCalled();
      expect(budget.updateBudgetItem).not.toHaveBeenCalled();
      expect(budget.createBudgetItem).not.toHaveBeenCalled();
    });

    it('syncs the linked expense category when the booking type changes', () => {
      const { trip, res, item } = linkedItem({ category: 'other' });
      budget.updateBudgetItem.mockReturnValue({ id: item.id, category: 'flights' });
      svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'X', 'flight', 'X', 'other', undefined, 'sock');
      expect(budget.updateBudgetItem).toHaveBeenCalledWith(item.id, String(trip.id), { category: 'flights' });
      expect(broadcast).toHaveBeenCalledWith(String(trip.id), 'budget:updated', { item: { id: item.id, category: 'flights' } }, 'sock');
    });

    it('updates an existing linked item when a price is provided', () => {
      const { trip, res, item } = linkedItem();
      budget.updateBudgetItem.mockReturnValue({ id: item.id });
      svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'New', 'lodging', 'Old', 'lodging', { total_price: 80 }, 'sock');
      expect(budget.updateBudgetItem).toHaveBeenCalledWith(item.id, String(trip.id), { name: 'New', category: 'lodging', total_price: 80 });
      expect(broadcast).toHaveBeenCalledWith(String(trip.id), 'budget:updated', { item: { id: item.id } }, 'sock');
    });

    it('creates + links a new item when none exists, using the current title fallback', () => {
      const { trip } = ownerTrip();
      const res = createReservation(testDb, trip.id);
      const created = createBudgetItem(testDb, trip.id); // the row the mocked create "returns"
      budget.createBudgetItem.mockReturnValue({ id: created.id });
      svc.syncBudgetOnUpdate(String(trip.id), String(res.id), '', undefined, 'Old title', 'flight', { total_price: 120 }, 'sock');
      expect(budget.createBudgetItem).toHaveBeenCalledWith(String(trip.id), { name: 'Old title', category: 'flight', total_price: 120 });
      // The service back-links the created item to the reservation itself.
      expect(testDb.prepare('SELECT reservation_id FROM budget_items WHERE id = ?').get(created.id)).toEqual({ reservation_id: res.id });
      expect(broadcast).toHaveBeenCalledWith(String(trip.id), 'budget:created', { item: { id: created.id, reservation_id: res.id } }, 'sock');
    });
  });

  describe('notifyBookingChange', () => {
    it('sends the booking_change notification with the legacy payload (fire-and-forget)', async () => {
      const { user, trip } = ownerTrip();
      expect(() => svc.notifyBookingChange(String(trip.id), user.id, 'Hotel', 'lodging')).not.toThrow();
      await vi.waitFor(() => expect(notif.send).toHaveBeenCalled());
      expect(notif.send).toHaveBeenCalledWith({
        event: 'booking_change',
        actorId: user.id,
        scope: 'trip',
        targetId: trip.id,
        params: { trip: trip.title, actor: user.email, booking: 'Hotel', type: 'lodging', tripId: String(trip.id) },
      });
    });

    it('is a silent no-op when the actor does not exist', async () => {
      const { trip } = ownerTrip();
      svc.notifyBookingChange(String(trip.id), 999, 'Hotel', '');
      await new Promise(r => setTimeout(r, 10));
      expect(notif.send).not.toHaveBeenCalled();
    });
  });
});

describe('setReservationTravelers / loadTravelers (#1517)', () => {
  /** Create a named guest user (no credentials) and add it to the trip. */
  function addGuest(tripId: number, displayName: string) {
    const { user } = createUser(testDb);
    testDb.prepare('UPDATE users SET is_guest = 1, display_name = ? WHERE id = ?').run(displayName, user.id);
    addTripMember(testDb, tripId, user.id);
    return user;
  }

  it('RES-TRAV-001: assigns trip members and returns them via loadTravelers', () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    const res = createReservation(testDb, trip.id);

    svc.setReservationTravelers(res.id, trip.id, [member.id]);

    const travelers = svc.loadTravelers(res.id);
    expect(travelers).toHaveLength(1);
    expect(travelers[0]).toMatchObject({ user_id: member.id, username: member.username, is_guest: 0 });
  });

  it('RES-TRAV-002: silently drops a user id that is not on the trip (cross-trip guard)', () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    const res = createReservation(testDb, trip.id);

    // An outsider who belongs to a different trip only.
    const { user: outsider } = createUser(testDb);
    const otherTrip = createTrip(testDb, outsider.id);
    addTripMember(testDb, otherTrip.id, outsider.id);

    svc.setReservationTravelers(res.id, trip.id, [member.id, outsider.id]);

    const ids = svc.loadTravelers(res.id).map(t => t.user_id);
    expect(ids).toEqual([member.id]);
    expect(ids).not.toContain(outsider.id);
  });

  it('RES-TRAV-003: assigns a named guest (users.is_guest = 1) joined via trip_members', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guest = addGuest(trip.id, 'Grandma');
    const res = createReservation(testDb, trip.id);

    svc.setReservationTravelers(res.id, trip.id, [guest.id]);

    const travelers = svc.loadTravelers(res.id);
    expect(travelers).toHaveLength(1);
    expect(travelers[0]).toMatchObject({ user_id: guest.id, username: 'Grandma', is_guest: 1 });
  });

  it('RES-TRAV-004: re-setting replaces the previous set', () => {
    const { user: owner } = createUser(testDb);
    const { user: a } = createUser(testDb);
    const { user: b } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, a.id);
    addTripMember(testDb, trip.id, b.id);
    const res = createReservation(testDb, trip.id);

    svc.setReservationTravelers(res.id, trip.id, [a.id]);
    expect(svc.loadTravelers(res.id).map(t => t.user_id)).toEqual([a.id]);

    svc.setReservationTravelers(res.id, trip.id, [b.id]);
    const ids = svc.loadTravelers(res.id).map(t => t.user_id);
    expect(ids).toEqual([b.id]);
    expect(ids).not.toContain(a.id);

    // Clearing removes everyone.
    svc.setReservationTravelers(res.id, trip.id, []);
    expect(svc.loadTravelers(res.id)).toHaveLength(0);
  });

  it('RES-TRAV-005: list attaches travelers[] per reservation', () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    const withTravelers = createReservation(testDb, trip.id, { title: 'Flight' });
    const withoutTravelers = createReservation(testDb, trip.id, { title: 'Hotel' });

    svc.setReservationTravelers(withTravelers.id, trip.id, [member.id]);

    const list = svc.list(trip.id);
    const assigned = list.find(r => r.id === withTravelers.id)!;
    const empty = list.find(r => r.id === withoutTravelers.id)!;

    expect(assigned.travelers).toHaveLength(1);
    expect(assigned.travelers![0]).toMatchObject({ user_id: member.id, username: member.username });
    expect(empty.travelers).toEqual([]);
  });
});

describe('ReservationsService — the surface the deleted bridge exposed', () => {
  it('RESV-BRIDGE-001: listReservations delegates to ReservationsService.list', () => {
    const { trip } = ownerTrip();
    createReservation(testDb, trip.id, { title: 'A' });
    expect(bridge.listReservations(trip.id).map(r => r.title)).toEqual(['A']);
  });

  it('RESV-BRIDGE-002: loadEndpointsByTrip groups endpoints per reservation', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id);
    testDb.prepare('INSERT INTO reservation_endpoints (reservation_id, role, sequence, name, lat, lng) VALUES (?, ?, 0, ?, 1, 2)').run(res.id, 'from', 'A');
    const map = bridge.loadEndpointsByTrip(trip.id);
    expect(map.get(res.id)).toHaveLength(1);
  });

  it('RESV-BRIDGE-003: resyncReservationDays re-anchors through the bridge', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const res = createReservation(testDb, trip.id, { title: 'T', type: 'tour', day_id: days[0].id });
    testDb.prepare('UPDATE reservations SET reservation_time = ? WHERE id = ?').run('2030-05-02T09:00:00', res.id);
    bridge.resyncReservationDays(trip.id);
    expect(testDb.prepare('SELECT day_id FROM reservations WHERE id = ?').get(res.id)).toEqual({ day_id: days[1].id });
  });

  it('RESV-BRIDGE-004: createReservation creates through the bridge', () => {
    const { trip } = ownerTrip();
    const { reservation } = bridge.createReservation(trip.id, { title: 'Bridge' });
    expect(reservation).toMatchObject({ title: 'Bridge', type: 'other' });
  });

  it('RESV-BRIDGE-005: getReservation is trip-scoped', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id);
    expect(bridge.getReservation(res.id, trip.id)).toMatchObject({ id: res.id });
    expect(bridge.getReservation(res.id, trip.id + 1)).toBeUndefined();
  });

  it('RESV-BRIDGE-006: getReservationWithJoins attaches endpoints + travelers', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id);
    expect(bridge.getReservationWithJoins(res.id)).toMatchObject({ id: res.id, endpoints: [], travelers: [] });
  });

  it('RESV-BRIDGE-007: updateReservation updates through the bridge', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id, { title: 'Old' });
    const current = bridge.getReservation(res.id, trip.id)!;
    const { reservation } = bridge.updateReservation(res.id, trip.id, { title: 'New' }, current);
    expect(reservation.title).toBe('New');
  });

  it('RESV-BRIDGE-008: deleteReservation deletes through the bridge', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id);
    const { deleted } = bridge.deleteReservation(res.id, trip.id);
    expect(deleted).toMatchObject({ id: res.id });
    expect(bridge.getReservation(res.id, trip.id)).toBeUndefined();
  });

  it('RESV-BRIDGE-009: notifyBookingChange fires the notification through the bridge', async () => {
    const { user, trip } = ownerTrip();
    bridge.notifyBookingChange(trip.id, user.id, 'Bridge booking', 'other');
    await vi.waitFor(() => expect(notif.send).toHaveBeenCalled());
  });
});

describe('ReservationsService — legacy branch parity (coverage of the folded conditionals)', () => {
  it('RESV-SVC-019: create with a linked accommodation_id syncs metadata times + confirmation onto it', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const place = createPlace(testDb, trip.id);
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const acc = createDayAccommodation(testDb, trip.id, place.id, days[0].id, days[1].id);
    svc.create(String(trip.id), {
      title: 'Hotel', type: 'hotel', accommodation_id: acc.id,
      metadata: { check_in_time: '15:00', check_out_time: '11:00' },
      confirmation_number: 'CN-1',
    });
    const row = testDb.prepare('SELECT check_in, check_out, confirmation FROM day_accommodations WHERE id = ?').get(acc.id);
    expect(row).toEqual({ check_in: '15:00', check_out: '11:00', confirmation: 'CN-1' });
  });

  it('RESV-SVC-020: create with a malformed reservation_time derives no day', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const { reservation } = svc.create(String(trip.id), { title: 'X', type: 'tour', reservation_time: 'not-a-date' });
    expect(reservation.day_id).toBeNull();
  });

  it('RESV-SVC-021: hotel update with create_accommodation updates the linked accommodation in place', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
    const place = createPlace(testDb, trip.id);
    const place2 = createPlace(testDb, trip.id, { name: 'Other Hotel' });
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const acc = createDayAccommodation(testDb, trip.id, place.id, days[0].id, days[1].id);
    const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
    testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(String(acc.id), res.id);
    const current = svc.getReservation(String(res.id), String(trip.id))!;
    const { accommodationChanged } = svc.update(String(res.id), String(trip.id), {
      type: 'hotel',
      create_accommodation: { place_id: place2.id, start_day_id: days[1].id, end_day_id: days[2].id, check_in: '14:00' },
      confirmation_number: 'CN-2',
    }, current);
    expect(accommodationChanged).toBe(true);
    const row = testDb.prepare('SELECT place_id, start_day_id, end_day_id, check_in, confirmation FROM day_accommodations WHERE id = ?').get(acc.id);
    expect(row).toEqual({ place_id: place2.id, start_day_id: days[1].id, end_day_id: days[2].id, check_in: '14:00', confirmation: 'CN-2' });
  });

  it('RESV-SVC-022: hotel update inserts a new accommodation when none is linked and a place is given', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const place = createPlace(testDb, trip.id);
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
    const current = svc.getReservation(String(res.id), String(trip.id))!;
    const { reservation, accommodationChanged } = svc.update(String(res.id), String(trip.id), {
      type: 'hotel',
      create_accommodation: { place_id: place.id, start_day_id: days[0].id, end_day_id: days[1].id },
    }, current);
    expect(accommodationChanged).toBe(true);
    expect(reservation.accommodation_id).not.toBeNull();
    expect(testDb.prepare('SELECT COUNT(*) as c FROM day_accommodations WHERE trip_id = ?').get(trip.id)).toEqual({ c: 1 });
  });

  it('RESV-SVC-023: explicit update fields bind their values; empty strings null; absent fields keep current', () => {
    const { trip } = ownerTrip();
    const place = createPlace(testDb, trip.id);
    const res = createReservation(testDb, trip.id, { title: 'T', type: 'tour' });
    testDb.prepare("UPDATE reservations SET location = 'Loc', notes = 'N', url = 'U', confirmation_number = 'C' WHERE id = ?").run(res.id);
    let current = svc.getReservation(String(res.id), String(trip.id))!;
    let { reservation } = svc.update(String(res.id), String(trip.id), {
      location: 'NewLoc', notes: '', url: 'https://x', confirmation_number: 'NEW',
      status: 'confirmed', needs_review: true, metadata: { a: 1 }, place_id: place.id,
    }, current);
    expect(reservation).toMatchObject({
      location: 'NewLoc', notes: null, url: 'https://x', confirmation_number: 'NEW',
      status: 'confirmed', needs_review: 1, metadata: JSON.stringify({ a: 1 }), place_id: place.id,
    });
    current = svc.getReservation(String(res.id), String(trip.id))!;
    ({ reservation } = svc.update(String(res.id), String(trip.id), { title: 'T2' }, current));
    expect(reservation).toMatchObject({ title: 'T2', location: 'NewLoc', url: 'https://x', place_id: place.id });
  });

  it('RESV-SVC-024: explicit day_id / end_day_id updates win over derivation; explicit null end clears', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const res = createReservation(testDb, trip.id, { title: 'T', type: 'tour' });
    let current = svc.getReservation(String(res.id), String(trip.id))!;
    let { reservation } = svc.update(String(res.id), String(trip.id), { day_id: days[1].id, end_day_id: days[2].id }, current);
    expect(reservation).toMatchObject({ day_id: days[1].id, end_day_id: days[2].id });
    current = svc.getReservation(String(res.id), String(trip.id))!;
    ({ reservation } = svc.update(String(res.id), String(trip.id), { end_day_id: null, reservation_end_time: '2030-05-02T18:00:00' }, current));
    // explicit end_day_id null wins over the end-time derivation
    expect(reservation.end_day_id).toBeNull();
    current = svc.getReservation(String(res.id), String(trip.id))!;
    ({ reservation } = svc.update(String(res.id), String(trip.id), { reservation_end_time: '2030-05-02T18:00:00' }, current));
    // no explicit end day + an end time -> derived
    expect(reservation.end_day_id).toBe(days[1].id);
  });

  it('RESV-SVC-025: with metadata absent, the stored metadata JSON drives the accommodation sync (confirmation falls back to current)', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const place = createPlace(testDb, trip.id);
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const acc = createDayAccommodation(testDb, trip.id, place.id, days[0].id, days[1].id);
    const res = createReservation(testDb, trip.id, { title: 'Hotel', type: 'hotel' });
    testDb.prepare("UPDATE reservations SET accommodation_id = ?, metadata = ?, confirmation_number = 'KEEP' WHERE id = ?")
      .run(String(acc.id), JSON.stringify({ check_in_time: '16:00' }), res.id);
    const current = svc.getReservation(String(res.id), String(trip.id))!;
    svc.update(String(res.id), String(trip.id), { notes: 'touch' }, current);
    const row = testDb.prepare('SELECT check_in, confirmation FROM day_accommodations WHERE id = ?').get(acc.id);
    expect(row).toEqual({ check_in: '16:00', confirmation: 'KEEP' });
  });

  it('RESV-SVC-026: resync derives the end day too, keeping the stored one when the end time is out of range', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-03' });
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    const res = createReservation(testDb, trip.id, { title: 'T', type: 'tour', day_id: days[0].id });
    testDb.prepare('UPDATE reservations SET reservation_time = ?, reservation_end_time = ?, end_day_id = ? WHERE id = ?')
      .run('2030-05-02T09:00:00', '2031-01-01T09:00:00', days[0].id, res.id);
    svc.resyncReservationDays(String(trip.id));
    // start re-anchored to day 2; out-of-range end time keeps the stored end day
    expect(testDb.prepare('SELECT day_id, end_day_id FROM reservations WHERE id = ?').get(res.id))
      .toEqual({ day_id: days[1].id, end_day_id: days[0].id });
    // A booking already on the right day is left untouched (no-change skip).
    svc.resyncReservationDays(String(trip.id));
    expect(testDb.prepare('SELECT day_id FROM reservations WHERE id = ?').get(res.id)).toEqual({ day_id: days[1].id });
  });

  it('RESV-SVC-027: listUpcoming includes a timeless reservation whose day is in the future', () => {
    const { user, trip } = ownerTrip();
    const day = createDay(testDb, trip.id, { date: '2999-06-01' });
    createReservation(testDb, trip.id, { title: 'Timeless', day_id: day.id });
    const rows = svc.listUpcoming(user.id) as { title: string }[];
    expect(rows.map(r => r.title)).toContain('Timeless');
  });

  it('RESV-SVC-028: list merges multiple per-day positions for one reservation', () => {
    const { trip } = ownerTrip();
    const d1 = createDay(testDb, trip.id, { date: '2030-05-01' });
    const d2 = createDay(testDb, trip.id, { date: '2030-05-02' });
    const res = createReservation(testDb, trip.id);
    testDb.prepare('INSERT INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)').run(res.id, d1.id, 0);
    testDb.prepare('INSERT INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)').run(res.id, d2.id, 3);
    const [row] = svc.list(String(trip.id));
    expect(row.day_positions).toEqual({ [d1.id]: 0, [d2.id]: 3 });
  });

  it('RESV-SVC-029: notifyBookingChange falls back to "Untitled" and type "booking"', async () => {
    const { user } = createUser(testDb);
    svc.notifyBookingChange('424242', user.id, 'B', '');
    await vi.waitFor(() => expect(notif.send).toHaveBeenCalled());
    expect(notif.send).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ trip: 'Untitled', type: 'booking' }),
    }));
  });

  it('RESV-SVC-030: syncBudgetOnUpdate type-change sync is a no-op without a linked item or when the category was hand-picked', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id);
    // no linked item at all
    svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'X', 'flight', 'X', 'other', undefined, undefined);
    expect(budget.updateBudgetItem).not.toHaveBeenCalled();
    // linked item whose category no longer matches the auto-derived one
    const item = createBudgetItem(testDb, trip.id, { category: 'Hand picked' });
    testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(res.id, item.id);
    svc.syncBudgetOnUpdate(String(trip.id), String(res.id), 'X', 'flight', 'X', 'other', undefined, undefined);
    expect(budget.updateBudgetItem).not.toHaveBeenCalled();
    // explicit clear with no linked item deletes nothing
    svc.syncBudgetOnUpdate(String(trip.id), '999999', 'X', 'flight', 'X', 'flight', { total_price: 0 }, undefined);
    expect(budget.deleteBudgetItem).not.toHaveBeenCalled();
  });

  it('RESV-SVC-031: list returns staged bookings, the staging inbox has to see its own rows', () => {
    const { trip } = ownerTrip();
    createReservation(testDb, trip.id, { title: 'Live One' });
    const staged = createReservation(testDb, trip.id, { title: 'Parked One' });
    testDb.prepare("UPDATE reservations SET ingest_state = 'staged' WHERE id = ?").run(staged.id);

    // The visibility predicate belongs to the anonymous exports (ICS feed,
    // shared trip) and must never be pulled into the authenticated list, or
    // nobody can confirm what the ingest parked.
    expect(svc.list(String(trip.id)).map((r: any) => r.title).sort()).toEqual(['Live One', 'Parked One']);
  });
});

describe('ReservationsService — quirk fixes (post-fold)', () => {
  it('RESV-FIX-001: create is atomic — a failing endpoint save rolls back the reservation AND the auto-created accommodation', () => {
    const { trip } = ownerTrip({ start_date: '2030-05-01', end_date: '2030-05-02' });
    const place = createPlace(testDb, trip.id);
    const days = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id) as { id: number }[];
    // sequence is an unbindable object -> the endpoint INSERT throws mid-write.
    const badEndpoints = [{ role: 'from', name: 'A', code: null, lat: 1, lng: 2, timezone: null, local_time: null, local_date: null, sequence: {} }];
    expect(() => svc.create(String(trip.id), {
      title: 'Hotel', type: 'hotel',
      create_accommodation: { place_id: place.id, start_day_id: days[0].id, end_day_id: days[1].id },
      endpoints: badEndpoints,
    } as never)).toThrow();
    expect(testDb.prepare('SELECT COUNT(*) as c FROM reservations WHERE trip_id = ?').get(trip.id)).toEqual({ c: 0 });
    expect(testDb.prepare('SELECT COUNT(*) as c FROM day_accommodations WHERE trip_id = ?').get(trip.id)).toEqual({ c: 0 });
  });

  it('RESV-FIX-002: update is atomic — a failing endpoint save rolls back the field update', () => {
    const { trip } = ownerTrip();
    const res = createReservation(testDb, trip.id, { title: 'Old' });
    const current = svc.getReservation(String(res.id), String(trip.id))!;
    const badEndpoints = [{ role: 'from', name: 'A', code: null, lat: 1, lng: 2, timezone: null, local_time: null, local_date: null, sequence: {} }];
    expect(() => svc.update(String(res.id), String(trip.id), { title: 'New', endpoints: badEndpoints } as never, current)).toThrow();
    expect(testDb.prepare('SELECT title FROM reservations WHERE id = ?').get(res.id)).toEqual({ title: 'Old' });
  });
});

describe('ReservationsService — referenced ids stay inside the trip', () => {
  /** Attacker's trip and a victim trip they are not a member of. */
  function twoTrips() {
    const { user: attacker } = createUser(testDb);
    const { user: victim } = createUser(testDb, { email: 'victim@example.test' });
    const mine = createTrip(testDb, attacker.id, { start_date: '2030-05-01', end_date: '2030-05-03' });
    const theirs = createTrip(testDb, victim.id, { start_date: '2030-05-01', end_date: '2030-05-03' });
    return { mine, theirs };
  }

  it('RESV-SCOPE-001: names every foreign id in the body', () => {
    const { mine, theirs } = twoTrips();
    const foreignPlace = createPlace(testDb, theirs.id);
    const foreignDay = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').get(theirs.id) as { id: number };
    const foreignAcc = createDayAccommodation(testDb, theirs.id, foreignPlace.id, foreignDay.id, foreignDay.id);

    expect(svc.referencesOutsideTrip(String(mine.id), {
      title: 'x', day_id: foreignDay.id, place_id: foreignPlace.id, accommodation_id: foreignAcc.id,
    })).toEqual(['day_id', 'place_id', 'accommodation_id']);
  });

  it('RESV-SCOPE-005: a dangling id is not an offender, so the booking stays editable', () => {
    const { mine } = twoTrips();
    const place = createPlace(testDb, mine.id);
    const day = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').get(mine.id) as { id: number };
    const acc = createDayAccommodation(testDb, mine.id, place.id, day.id, day.id);
    const res = createReservation(testDb, mine.id, { title: 'Hotel', type: 'hotel' });
    testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(acc.id, res.id);
    // What shortening the trip's date range does: the day goes, the cascade
    // takes the accommodation with it, and the reservation keeps the id.
    testDb.prepare('DELETE FROM day_accommodations WHERE id = ?').run(acc.id);

    expect(svc.referencesOutsideTrip(String(mine.id), { title: 'x', accommodation_id: acc.id })).toEqual([]);

    const current = svc.getReservation(String(res.id), String(mine.id))!;
    svc.update(String(res.id), String(mine.id), { accommodation_id: acc.id, title: 'Hotel renamed' } as never, current);
    expect(testDb.prepare('SELECT title, accommodation_id FROM reservations WHERE id = ?').get(res.id))
      .toEqual({ title: 'Hotel renamed', accommodation_id: null });
  });

  it('RESV-SCOPE-002: passes a body whose ids all live in the trip', () => {
    const { mine } = twoTrips();
    const place = createPlace(testDb, mine.id);
    const day = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').get(mine.id) as { id: number };

    expect(svc.referencesOutsideTrip(String(mine.id), { title: 'x', day_id: day.id, place_id: place.id })).toEqual([]);
    expect(svc.referencesOutsideTrip(String(mine.id), { title: 'x' })).toEqual([]);
  });

  it('RESV-SCOPE-003: a stored foreign accommodation_id is not deleted with the reservation', () => {
    const { mine, theirs } = twoTrips();
    const foreignPlace = createPlace(testDb, theirs.id);
    const foreignDay = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').get(theirs.id) as { id: number };
    const foreignAcc = createDayAccommodation(testDb, theirs.id, foreignPlace.id, foreignDay.id, foreignDay.id);
    // A row from before the check existed: it already carries the foreign id.
    const res = createReservation(testDb, mine.id, { title: 'Hotel', type: 'hotel' });
    testDb.prepare('UPDATE reservations SET accommodation_id = ? WHERE id = ?').run(foreignAcc.id, res.id);

    const { accommodationDeleted } = svc.remove(String(res.id), String(mine.id));

    expect(accommodationDeleted).toBe(false);
    expect(testDb.prepare('SELECT id FROM day_accommodations WHERE id = ?').get(foreignAcc.id)).toBeTruthy();
  });

  it('RESV-SCOPE-004: an update carrying a foreign accommodation_id does not write through to it', () => {
    const { mine, theirs } = twoTrips();
    const foreignPlace = createPlace(testDb, theirs.id);
    const foreignDay = testDb.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').get(theirs.id) as { id: number };
    const foreignAcc = createDayAccommodation(testDb, theirs.id, foreignPlace.id, foreignDay.id, foreignDay.id, { check_in: '14:00' });
    const res = createReservation(testDb, mine.id, { title: 'Hotel', type: 'hotel' });
    const current = svc.getReservation(String(res.id), String(mine.id))!;

    svc.update(String(res.id), String(mine.id), {
      accommodation_id: foreignAcc.id, metadata: { check_in_time: '23:00' },
    } as never, current);

    expect(testDb.prepare('SELECT check_in FROM day_accommodations WHERE id = ?').get(foreignAcc.id)).toEqual({ check_in: '14:00' });
    expect(testDb.prepare('SELECT accommodation_id FROM reservations WHERE id = ?').get(res.id)).toEqual({ accommodation_id: null });
  });
});
