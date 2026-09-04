/**
 * DB-backed unit tests for BudgetService trip-scoping (BUDGET-SVC-DB-001+).
 * Uses a real in-memory SQLite DB so the SQL WHERE clauses are exercised.
 * BUDGET-SVC-DB-001 through 014 moved 1:1 from the legacy
 * tests/unit/services/budgetServiceDb.test.ts; 015–018 pinned the deleted
 * budget.bridge's delegation and now pin the same paths on the service;
 * 019–020 pin the post-fold quirk fixes (COALESCE(display_name) on
 * settlements, transactional multi-statement writes).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: () => null,
    isOwner: () => false,
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../../src/db/database', () => dbMock);
vi.mock('../../../src/config', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
}));
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));

// Frozen snapshot of the rates in play in #1543 (rates[X] = units of X per 1 base).
const { RATES } = vi.hoisted(() => ({
  RATES: {
    RUB: { RUB: 1, USD: 0.013042, EUR: 0.011412 },
    EUR: { EUR: 1, USD: 1.1429, RUB: 87.63 },
  } as Record<string, Record<string, number>>,
}));
// Constructor-injected since the fold; the class is mocked at the module path
// so every separately-constructed instance sees the same deterministic rates
// as the SUT.
vi.mock('../../../src/nest/budget/exchange-rates.service', () => ({
  ExchangeRatesService: class {
    async getRates(base: string) {
      return RATES[base.toUpperCase()] ?? null;
    }
  },
}));

import { createTables } from '../../../src/db/schema';
import { runMigrations } from '../../../src/db/migrations';
import { resetTestDb } from '../../helpers/test-db';
import { createUser, createTrip, addTripMember } from '../../helpers/factories';
import { BudgetService } from '../../../src/nest/budget/budget.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import { ExchangeRatesService } from '../../../src/nest/budget/exchange-rates.service';
import { UserCleanupService } from '../../../src/nest/auth/user-cleanup.service';
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import { TripMembersService } from '../../../src/nest/trip-members/trip-members.service';
import { TodoService } from '../../../src/nest/todo/todo.service';
import { PackingService } from '../../../src/nest/packing/packing.service';
import { FilesService } from '../../../src/nest/files/files.service';
import { ReservationsService } from '../../../src/nest/reservations/reservations.service';
import { DaysService } from '../../../src/nest/days/days.service';
import { CollabService } from '../../../src/nest/collab/collab.service';
import { VacayService } from '../../../src/nest/vacay/vacay.service';
import { QueryHelpersService } from '../../../src/nest/query-helpers/query-helpers.service';
import { notificationsStub } from '../../helpers/notifications';

const budget = new BudgetService(
  new DatabaseService(testDb),
  new PermissionsService(new DatabaseService(testDb)),
  new ExchangeRatesService(),
  new RealtimeService(),
);

// Guest fixtures come from TripMembersService since the trip split (they were on
// TripsService before, and on the deleted services/tripService before that);
// deleteGuest routes through the SAME BudgetService domain SQL
// (removeUserFromBudgetItems) under test.
const dbs = () => new DatabaseService(testDb);
const membersSvc = new TripMembersService(
  dbs(),
  budget,
  new UserCleanupService(dbs(), budget),
  new PermissionsService(dbs()),
  new RealtimeService(),
  notificationsStub(),
);
const createGuest = membersSvc.createGuest.bind(membersSvc);
const deleteGuest = membersSvc.deleteGuest.bind(membersSvc);

beforeAll(() => {
  createTables(testDb);
  runMigrations(testDb);
});

beforeEach(() => {
  resetTestDb(testDb);
});

afterAll(() => {
  testDb.close();
});

function paidFlag(itemId: number, memberId: number): number | undefined {
  const row = testDb
    .prepare('SELECT paid FROM budget_item_members WHERE budget_item_id = ? AND user_id = ?')
    .get(itemId, memberId) as { paid: number } | undefined;
  return row?.paid;
}

describe('deleting a member re-splits their expenses (#1553)', () => {
  function personsOf(itemId: number): number | null {
    return (testDb.prepare('SELECT persons FROM budget_items WHERE id = ?').get(itemId) as { persons: number | null }).persons;
  }
  function memberCount(itemId: number): number {
    return (testDb.prepare('SELECT COUNT(*) AS count FROM budget_item_members WHERE budget_item_id = ?')
      .get(itemId) as { count: number }).count;
  }

  it('BUDGET-SVC-DB-010: re-derives the persons divisor when a guest in the split is deleted', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guests = ['G1', 'G2', 'G3'].map(n => createGuest(trip.id, n, owner.id).member);
    const item = budget.createBudgetItem(trip.id, {
      name: 'Dinner', total_price: 400,
      member_ids: [owner.id, ...guests.map(g => g.id)],
    });
    expect(personsOf(item.id)).toBe(4);

    deleteGuest(trip.id, guests[0].id);
    deleteGuest(trip.id, guests[1].id);

    // The member rows cascade with the users row; `persons` is denormalized and has to
    // be re-derived, or the per-person column keeps dividing by the departed.
    expect(memberCount(item.id)).toBe(2);
    expect(personsOf(item.id)).toBe(2);
  });

  it('BUDGET-SVC-DB-011: leaves a manually entered persons count alone', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guest = createGuest(trip.id, 'G1', owner.id).member;
    // No member rows — `persons` is just a number someone typed.
    const item = budget.createBudgetItem(trip.id, { name: 'Rental', total_price: 300, persons: 6 });

    deleteGuest(trip.id, guest.id);

    expect(personsOf(item.id)).toBe(6);
  });

  it('BUDGET-SVC-DB-012: drops the last member to a null divisor rather than zero', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guest = createGuest(trip.id, 'G1', owner.id).member;
    const item = budget.createBudgetItem(trip.id, { name: 'Taxi', total_price: 50, member_ids: [guest.id] });

    deleteGuest(trip.id, guest.id);

    expect(memberCount(item.id)).toBe(0);
    expect(personsOf(item.id)).toBeNull();
  });

  it('BUDGET-SVC-DB-013: saves a split from a stale client instead of failing on the users FK', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guest = createGuest(trip.id, 'G1', owner.id).member;
    const item = budget.createBudgetItem(trip.id, { name: 'Dinner', total_price: 200, member_ids: [owner.id, guest.id] });

    deleteGuest(trip.id, guest.id);

    // A client that loaded before the deletion still sends the guest back (#1553).
    const updated = budget.updateBudgetItem(item.id, trip.id, { member_ids: [owner.id, guest.id] });

    expect(updated!.members.map(m => m.user_id)).toEqual([owner.id]);
    expect(personsOf(item.id)).toBe(1);
  });

  it('BUDGET-SVC-DB-014: ignores a deleted member arriving through updateMembers', () => {
    const { user: owner } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    const guest = createGuest(trip.id, 'G1', owner.id).member;
    const item = budget.createBudgetItem(trip.id, { name: 'Drinks', total_price: 60, member_ids: [owner.id, guest.id] });

    deleteGuest(trip.id, guest.id);
    const result = budget.updateMembers(item.id, trip.id, [owner.id, guest.id]);

    expect(result!.members.map(m => m.user_id)).toEqual([owner.id]);
    expect(personsOf(item.id)).toBe(1);
  });
});

describe('toggleMemberPaid trip-scoping', () => {
  it('BUDGET-SVC-DB-001: toggles paid for an item that belongs to the given trip', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip A' });
    const item = budget.createBudgetItem(trip.id, { name: 'Hotel', total_price: 100 });
    budget.updateMembers(item.id, trip.id, [user.id]);

    const member = budget.toggleMemberPaid(item.id, trip.id, user.id, true);

    expect(member).not.toBeNull();
    expect(paidFlag(item.id, user.id)).toBe(1);
  });

  it('BUDGET-SVC-DB-002: refuses to toggle an item from a different trip (cross-trip IDOR)', () => {
    const { user } = createUser(testDb);
    const tripA = createTrip(testDb, user.id, { title: 'Trip A' });
    const tripB = createTrip(testDb, user.id, { title: 'Trip B' });
    const itemB = budget.createBudgetItem(tripB.id, { name: 'Foreign expense', total_price: 50 });
    budget.updateMembers(itemB.id, tripB.id, [user.id]);

    // Caller passes a trip they can access (A) but the item lives in trip B.
    const member = budget.toggleMemberPaid(itemB.id, tripA.id, user.id, true);

    expect(member).toBeNull();
    expect(paidFlag(itemB.id, user.id)).toBe(0); // unchanged
  });
});

describe('calculateSettlement custom splits', () => {
  it('BUDGET-SVC-DB-003: settles by the custom per-member amounts, not the equal split (#1458)', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id, { title: 'Trip' });
    addTripMember(testDb, trip.id, bob.id);

    // 100 total, custom split: Alice owes 90, Bob owes 10. Alice paid the whole bill.
    budget.createBudgetItem(trip.id, {
      name: 'Dinner',
      payers: [{ user_id: alice.id, amount: 100 }],
      members: [
        { user_id: alice.id, amount: 90 },
        { user_id: bob.id, amount: 10 },
      ],
    });

    const result = budget.calculateSettlement(trip.id);

    // Alice paid 100 but owes 90 → net +10 (creditor); Bob owes 10 → net -10 (debtor).
    // With the equal-split bug both owe 50, so the flow would be 50 instead of 10.
    expect(result.flows).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ user_id: bob.id }),
        to: expect.objectContaining({ user_id: alice.id }),
        amount: 10,
      }),
    ]);
  });
});

describe('calculateSettlement squares up to the cent (#1382)', () => {
  it('BUDGET-SVC-DB-026: recording the offered flows clears the trip to exactly zero', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const { user: carol } = createUser(testDb, { username: 'carol' });
    const trip = createTrip(testDb, alice.id, { title: 'Trip' });
    addTripMember(testDb, trip.id, bob.id);
    addTripMember(testDb, trip.id, carol.id);
    const members = [{ user_id: alice.id }, { user_id: bob.id }, { user_id: carol.id }];

    // Totals that never divide by three, so every expense leaves a remainder cent
    // somewhere: 10.00, 100.01 and 0.01 (the smallest debt there is).
    budget.createBudgetItem(trip.id, { name: 'Coffee', payers: [{ user_id: alice.id, amount: 10 }], members });
    budget.createBudgetItem(trip.id, { name: 'Dinner', payers: [{ user_id: bob.id, amount: 100.01 }], members });
    budget.createBudgetItem(trip.id, { name: 'Stamp', payers: [{ user_id: carol.id, amount: 0.01 }], members });

    const before = budget.calculateSettlement(trip.id);
    expect(before.flows.length).toBeGreaterThan(0);
    for (const f of before.flows) {
      budget.insertSettlement(trip.id, { from_user_id: f.from.user_id, to_user_id: f.to.user_id, amount: f.amount }, f.from.user_id);
    }

    // Nothing left over, and nothing left to offer — the settle-up list and the
    // balances agree instead of the balances holding a cent nobody can pay.
    const after = budget.calculateSettlement(trip.id);
    expect(after.balances.map(b => b.balance)).toEqual([0, 0, 0]);
    expect(after.flows).toEqual([]);
  });

  it('BUDGET-SVC-DB-027: the balances hold still while the live rate moves under them', async () => {
    const { trip, me, danil, serega } = seedIssue1543Trip('RUB');

    // Nothing about the trip changes between the two reads; only the rate cache
    // turned over. That was enough to shuffle cents between people (#1382).
    const first = budget.calculateSettlement(trip.id, { base: 'RUB', tripCurrency: 'RUB', rates: RATES.RUB });
    const second = budget.calculateSettlement(trip.id, {
      base: 'RUB', tripCurrency: 'RUB',
      rates: { RUB: 1, USD: 0.013042 * 1.03, EUR: 0.011412 * 0.97 },
    });

    for (const uid of [me.id, danil.id, serega.id]) {
      expect(second.balances.find(b => b.user_id === uid)!.balance)
        .toBe(first.balances.find(b => b.user_id === uid)!.balance);
    }
  });
});

/** The exact trip from #1543: RUB base, three members, one expense booked in USD. */
function seedIssue1543Trip(tripCurrency: string) {
  const { user: me } = createUser(testDb, { username: 'me' });
  const { user: danil } = createUser(testDb, { username: 'danil' });
  const { user: serega } = createUser(testDb, { username: 'serega' });
  const trip = createTrip(testDb, me.id, { title: 'Trip' });
  addTripMember(testDb, trip.id, danil.id);
  addTripMember(testDb, trip.id, serega.id);
  testDb.prepare('UPDATE trips SET currency = ? WHERE id = ?').run(tripCurrency, trip.id);
  const members = [{ user_id: me.id }, { user_id: danil.id }, { user_id: serega.id }];

  // 9 000 ₽ nobody has paid yet (outstanding, settled by nobody, #2225), 9 000 ₽ paid
  // by me, and $100 paid by me. The USD row carries the rate frozen at entry time:
  // units of USD per 1 RUB.
  budget.createBudgetItem(trip.id, { name: 'Проезд обратно', total_price: 9000, currency: 'RUB', members });
  budget.createBudgetItem(trip.id, { name: 'Проезд туда', currency: 'RUB', payers: [{ user_id: me.id, amount: 9000 }], members });
  budget.createBudgetItem(trip.id, {
    name: 'test', currency: 'USD', exchange_rate: 0.013042,
    payers: [{ user_id: me.id, amount: 100 }], members,
  });
  return { trip, me, danil, serega };
}

describe('calculateSettlement with a foreign-currency expense (#1543)', () => {
  it('BUDGET-SVC-DB-004: nets in the trip currency instead of inflating the foreign share ~27x', () => {
    const { trip, me, danil, serega } = seedIssue1543Trip('RUB');

    const result = budget.calculateSettlement(trip.id, { base: 'RUB', tripCurrency: 'RUB', rates: RATES.RUB });
    const balanceOf = (id: number) => result.balances.find(b => b.user_id === id)!.balance;

    // What actually settles is 9 000 ₽ + $100 (≈7 668 ₽): the third expense is the
    // 9 000 ₽ nobody has paid, which is outstanding rather than owed (#2225). Each of
    // the three owes a third of that, and I am owed back everything I fronted beyond my
    // own share. The bug divided the RUB shares by the USD rate and reported +451 092 /
    // −230 080 / −230 012 instead. Tolerance is a rouble: the cent-rotation in
    // splitEqualShares moves the odd cent of the $100 between members, which the USD
    // rate magnifies ~77x.
    const settledSpend = 9000 + 100 / RATES.RUB.USD;
    const share = settledSpend / 3;
    expect(balanceOf(me.id)).toBeCloseTo(settledSpend - share, -1);
    expect(balanceOf(danil.id)).toBeCloseTo(-share, -1);
    expect(balanceOf(serega.id)).toBeCloseTo(-share, -1);
    // Nothing is left over: every rouble owed is a rouble somebody is owed.
    expect(result.balances.reduce((a, b) => a + Math.round(b.balance * 100), 0)).toBe(0);
  });

  it('BUDGET-SVC-DB-005: reports the same balances when the display currency differs from the trip currency', () => {
    const { trip, danil } = seedIssue1543Trip('RUB');

    // Same trip, viewed in EUR: every balance is the RUB one converted once, at the end.
    const inEur = budget.calculateSettlement(trip.id, { base: 'EUR', tripCurrency: 'RUB', rates: RATES.EUR });
    const danilEur = inEur.balances.find(b => b.user_id === danil.id)!.balance;

    const shareRub = (9000 + 100 / RATES.RUB.USD) / 3;
    expect(danilEur).toBeCloseTo(-shareRub / RATES.EUR.RUB, 0);
  });
});

describe('rebaseTripCurrency', () => {
  const itemRow = (id: number) =>
    testDb.prepare('SELECT currency, exchange_rate FROM budget_items WHERE id = ?')
      .get(id) as { currency: string | null; exchange_rate: number };

  it('BUDGET-SVC-DB-006: pins currency-less expenses to the outgoing currency and re-freezes the rest', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    testDb.prepare("UPDATE trips SET currency = 'EUR' WHERE id = ?").run(trip.id);
    const members = [{ user_id: user.id }];

    // An expense that inherits the trip's base (currency NULL), one booked in USD, and
    // one already in the incoming currency.
    const implicit = budget.createBudgetItem(trip.id, { name: 'Implicit', total_price: 100, members }) as { id: number };
    const usd = budget.createBudgetItem(trip.id, { name: 'USD', total_price: 100, currency: 'USD', exchange_rate: 1.1429, members }) as { id: number };
    const rub = budget.createBudgetItem(trip.id, { name: 'RUB', total_price: 9000, currency: 'RUB', exchange_rate: 87.63, members }) as { id: number };

    await budget.rebaseTripCurrency(trip.id, 'RUB');

    // The implicit row really held euros, so it is stamped EUR rather than silently
    // becoming 100 ₽, and every rate is re-anchored to the new base.
    expect(itemRow(implicit.id)).toEqual({ currency: 'EUR', exchange_rate: RATES.RUB.EUR });
    expect(itemRow(usd.id)).toEqual({ currency: 'USD', exchange_rate: RATES.RUB.USD });
    // Already in the trip's new currency → no conversion left to freeze.
    expect(itemRow(rub.id)).toEqual({ currency: 'RUB', exchange_rate: 1 });
  });

  it('BUDGET-SVC-DB-007: keeps every balance at the same real-world value across the switch', async () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id, { title: 'Trip' });
    addTripMember(testDb, trip.id, bob.id);
    testDb.prepare("UPDATE trips SET currency = 'EUR' WHERE id = ?").run(trip.id);
    const members = [{ user_id: alice.id }, { user_id: bob.id }];

    budget.createBudgetItem(trip.id, { name: 'Hotel', payers: [{ user_id: alice.id, amount: 100 }], members });
    budget.createBudgetItem(trip.id, { name: 'Dinner', currency: 'USD', exchange_rate: 1.1429, payers: [{ user_id: bob.id, amount: 60 }], members });

    const before = budget.calculateSettlement(trip.id, { base: 'EUR', tripCurrency: 'EUR', rates: RATES.EUR });

    await budget.rebaseTripCurrency(trip.id, 'RUB');
    testDb.prepare("UPDATE trips SET currency = 'RUB' WHERE id = ?").run(trip.id);

    const after = budget.calculateSettlement(trip.id, { base: 'RUB', tripCurrency: 'RUB', rates: RATES.RUB });

    for (const b of before.balances) {
      const rub = after.balances.find(x => x.user_id === b.user_id)!.balance;
      expect(rub).toBeCloseTo(b.balance * 87.63, 0); // same money, different unit
    }
  });

  it('BUDGET-SVC-DB-009: pins currency-less place prices to the outgoing currency', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    testDb.prepare("UPDATE trips SET currency = 'EUR' WHERE id = ?").run(trip.id);

    const priced = (price: number | null, currency: string | null) => {
      const r = testDb.prepare('INSERT INTO places (trip_id, name, price, currency) VALUES (?, ?, ?, ?)')
        .run(trip.id, 'Place', price, currency);
      return Number(r.lastInsertRowid);
    };
    // A place that inherits the trip's base (currency NULL), one priced in its own
    // currency, and one with no price at all.
    const implicit = priced(15, null);
    const jpy = priced(1500, 'JPY');
    const free = priced(null, null);

    await budget.rebaseTripCurrency(trip.id, 'JPY');

    const placeRow = (id: number) =>
      testDb.prepare('SELECT price, currency FROM places WHERE id = ?')
        .get(id) as { price: number | null; currency: string | null };

    // The implicit place really held euros, so it is stamped EUR rather than silently
    // becoming ¥15 — the amount the user typed is never rewritten.
    expect(placeRow(implicit)).toEqual({ price: 15, currency: 'EUR' });
    expect(placeRow(jpy)).toEqual({ price: 1500, currency: 'JPY' });
    // Nothing to denominate without a price: leave it inheriting the trip's currency.
    expect(placeRow(free)).toEqual({ price: null, currency: null });
  });

  it('BUDGET-SVC-DB-008: is a no-op when the currency is unchanged', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    testDb.prepare("UPDATE trips SET currency = 'EUR' WHERE id = ?").run(trip.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Implicit', total_price: 100, members: [{ user_id: user.id }] }) as { id: number };

    await budget.rebaseTripCurrency(trip.id, 'EUR');

    expect(itemRow(item.id)).toEqual({ currency: null, exchange_rate: 1 });
  });
});

describe('composite service paths (ex budget.bridge delegation)', () => {
  // budget.bridge is deleted — UserCleanupService injects BudgetService now
  // that BudgetModule no longer imports AuthModule. 015-018 kept their IDs and
  // pin the same behavior directly on the service.
  it('BUDGET-SVC-DB-015: listBudgetItems returns the hydrated list', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Hotel', total_price: 100, member_ids: [user.id] });

    const items = budget.listBudgetItems(trip.id);

    expect(items.map(i => i.id)).toEqual([item.id]);
    expect(items[0].members.map(m => m.user_id)).toEqual([user.id]);
  });

  it('BUDGET-SVC-DB-016: removeUserFromBudgetItems re-derives persons', () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb, { username: 'other' });
    const trip = createTrip(testDb, owner.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Dinner', total_price: 80, member_ids: [owner.id, other.id] });

    budget.removeUserFromBudgetItems(other.id);

    const row = testDb.prepare('SELECT persons FROM budget_items WHERE id = ?').get(item.id) as { persons: number | null };
    expect(row.persons).toBe(1);
  });

  it('BUDGET-SVC-DB-017: rebaseTripCurrency pins the implicit currency', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare("UPDATE trips SET currency = 'EUR' WHERE id = ?").run(trip.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Implicit', total_price: 100, members: [{ user_id: user.id }] });

    await budget.rebaseTripCurrency(trip.id, 'RUB');

    const row = testDb.prepare('SELECT currency, exchange_rate FROM budget_items WHERE id = ?').get(item.id) as { currency: string | null; exchange_rate: number };
    expect(row).toEqual({ currency: 'EUR', exchange_rate: RATES.RUB.EUR });
  });

  it('BUDGET-SVC-DB-018: linkBudgetItemToReservation stamps the reservation id', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const reservationId = Number(testDb
      .prepare("INSERT INTO reservations (trip_id, title, type) VALUES (?, 'Flight', 'flight')")
      .run(trip.id).lastInsertRowid);

    const item = budget.linkBudgetItemToReservation(trip.id, reservationId, { name: 'Flight', total_price: 200 });

    expect(item.reservation_id).toBe(reservationId);
    const row = testDb.prepare('SELECT reservation_id FROM budget_items WHERE id = ?').get(item.id) as { reservation_id: number | null };
    expect(row.reservation_id).toBe(reservationId);
  });

  it('BUDGET-SVC-DB-018b: an expense can be created against a place (#1298)', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const placeId = Number(testDb
      .prepare("INSERT INTO places (trip_id, name) VALUES (?, 'Louvre')")
      .run(trip.id).lastInsertRowid);

    const item = budget.createBudgetItem(trip.id, { name: 'Louvre tickets', total_price: 34, place_id: placeId });

    expect(item.place_id).toBe(placeId);
    expect(item.reservation_id).toBeNull();
    const row = testDb.prepare('SELECT place_id FROM budget_items WHERE id = ?').get(item.id) as { place_id: number | null };
    expect(row.place_id).toBe(placeId);
  });

  it('BUDGET-SVC-DB-018c: an expense without a link stores neither id', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const item = budget.createBudgetItem(trip.id, { name: 'Coffee', total_price: 3 });

    expect(item.place_id).toBeNull();
    expect(item.reservation_id).toBeNull();
  });
});

// A settlement names two parties and both columns are NOT NULL, so an id that is
// not on the trip cannot simply be dropped the way a split member can — the whole
// write is refused. Refusing also means the endpoint stops answering "does this
// user id exist", which it used to do by 500ing on the foreign key.
describe('settlement parties are confined to the trip', () => {
  it('BUDGET-SVC-DB-028: refuses a payer who is not on the trip', async () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: outsider } = createUser(testDb, { username: 'outsider' });
    const trip = createTrip(testDb, alice.id);

    const created = await budget.createSettlement(trip.id, { from_user_id: outsider.id, to_user_id: alice.id, amount: 10 }, alice.id);

    expect(created).toBeNull();
    expect(budget.listSettlements(trip.id)).toEqual([]);
  });

  it('BUDGET-SVC-DB-029: answers a nonexistent user the same way, without throwing', async () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const trip = createTrip(testDb, alice.id);

    await expect(budget.createSettlement(trip.id, { from_user_id: 999999, to_user_id: alice.id, amount: 10 }, alice.id))
      .resolves.toBeNull();
  });

  it('BUDGET-SVC-DB-030: still records a settlement between the owner and a member', async () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const created = await budget.createSettlement(trip.id, { from_user_id: bob.id, to_user_id: alice.id, amount: 10 }, alice.id);

    expect(created).toMatchObject({ from_user_id: bob.id, to_user_id: alice.id });
  });

  it('BUDGET-SVC-DB-031: drops an off-trip payer from an item instead of refusing it', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: outsider } = createUser(testDb, { username: 'outsider' });
    const trip = createTrip(testDb, alice.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Dinner',
      payers: [{ user_id: alice.id, amount: 40 }, { user_id: outsider.id, amount: 60 }],
    }) as { payers: { user_id: number }[]; total_price: number };

    expect(item.payers.map(p => p.user_id)).toEqual([alice.id]);
    // total_price is the sum of the payers that actually landed.
    expect(item.total_price).toBe(40);
  });
});

// ── Refunds persist as negative expenses (#2176) ─────────────────────────────
// The write path used to filter payers on amount > 0 and re-derive total_price
// from the survivors, silently turning a negative entry into a 0 € one with no
// payer row.

describe('negative amounts persist end-to-end (#2176)', () => {
  it('BUDGET-SVC-DB-032: stores a negative payer row and the negative total', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const trip = createTrip(testDb, alice.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Hotel partial refund',
      total_price: -100,
      payers: [{ user_id: alice.id, amount: -100 }],
    }) as { id: number; payers: { user_id: number; amount: number }[]; total_price: number };

    expect(item.total_price).toBe(-100);
    expect(item.payers).toEqual([expect.objectContaining({ user_id: alice.id, amount: -100 })]);
    const row = testDb.prepare('SELECT total_price FROM budget_items WHERE id = ?').get(item.id) as { total_price: number };
    expect(row.total_price).toBe(-100);
  });

  it('BUDGET-SVC-DB-033: an update keeps a negative payer instead of nulling the entry', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);
    const item = budget.createBudgetItem(trip.id, {
      name: 'Refund', total_price: -60, payers: [{ user_id: alice.id, amount: -60 }],
    }) as { id: number };

    const updated = budget.updateBudgetItem(item.id, trip.id, {
      payers: [{ user_id: alice.id, amount: -40 }, { user_id: bob.id, amount: -20 }],
    }) as { payers: { user_id: number; amount: number }[]; total_price: number };

    expect(updated.total_price).toBe(-60);
    expect(updated.payers).toHaveLength(2);
    expect(updated.payers.map(p => p.amount).sort((a, b) => a - b)).toEqual([-40, -20]);
  });

  it('BUDGET-SVC-DB-034: mixed-sign payers derive the netted total', () => {
    // Alice fronted 100 but bob pocketed a 30 refund on the same receipt.
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Tickets', payers: [{ user_id: alice.id, amount: 100 }, { user_id: bob.id, amount: -30 }],
    }) as { payers: { user_id: number }[]; total_price: number };

    expect(item.payers).toHaveLength(2);
    expect(item.total_price).toBe(70);
  });

  it('BUDGET-SVC-DB-035: a zero-amount payer is still dropped', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Dinner', payers: [{ user_id: alice.id, amount: 90 }, { user_id: bob.id, amount: 0 }],
    }) as { payers: { user_id: number }[]; total_price: number };

    expect(item.payers.map(p => p.user_id)).toEqual([alice.id]);
    expect(item.total_price).toBe(90);
  });

  it('BUDGET-SVC-DB-036: a negative expense settles against real rows — Σ balances = 0', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);
    budget.createBudgetItem(trip.id, {
      name: 'Dinner', payers: [{ user_id: alice.id, amount: 90 }],
      member_ids: [alice.id, bob.id],
    });
    budget.createBudgetItem(trip.id, {
      name: 'Refund', payers: [{ user_id: alice.id, amount: -30 }],
      member_ids: [alice.id, bob.id],
    });

    const result = budget.calculateSettlement(trip.id);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    // 90 out, 30 back, both split evenly: bob nets 45 - 15 = 30 owed to alice.
    expect(balance(alice.id)).toBe(30);
    expect(balance(bob.id)).toBe(-30);
    expect(result.balances.reduce((a, b) => a + Math.round(b.balance * 100), 0)).toBe(0);
    expect(result.flows).toEqual([
      expect.objectContaining({ amount: 30, from: expect.objectContaining({ user_id: bob.id }), to: expect.objectContaining({ user_id: alice.id }) }),
    ]);
  });
});

describe('deleting an expense takes its price off the booking (#2233)', () => {
  it('BUDGET-SVC-DB-040: the mirrored price and currency are cleared, the rest of the metadata stays', () => {
    // The reservation update path keeps metadata.price across booking edits, so
    // the expense side has to remove it when the expense itself goes away.
    // Without this the card would show a price with nothing behind it, for good.
    const { user } = createUser(testDb, { username: 'owner' });
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    const res = testDb.prepare(
      "INSERT INTO reservations (trip_id, title, type, metadata) VALUES (?, 'Flight', 'flight', ?)",
    ).run(trip.id, JSON.stringify({ airline: 'CZ', seat: '12A', price: '2040', priceCurrency: 'CNY' }));
    const reservationId = Number(res.lastInsertRowid);

    const item = budget.createBudgetItem(trip.id, { name: 'Flight', total_price: 2040 });
    testDb.prepare('UPDATE budget_items SET reservation_id = ? WHERE id = ?').run(reservationId, item.id);

    expect(budget.deleteBudgetItem(item.id, trip.id)).toBe(true);

    const after = testDb.prepare('SELECT metadata FROM reservations WHERE id = ?').get(reservationId) as { metadata: string };
    expect(JSON.parse(after.metadata)).toEqual({ airline: 'CZ', seat: '12A' });
  });

  it('BUDGET-SVC-DB-041: an expense that was never linked to a booking deletes as before', () => {
    const { user } = createUser(testDb, { username: 'owner' });
    const trip = createTrip(testDb, user.id, { title: 'Trip' });
    const item = budget.createBudgetItem(trip.id, { name: 'Coffee', total_price: 4 });

    expect(budget.deleteBudgetItem(item.id, trip.id)).toBe(true);
    expect(testDb.prepare('SELECT id FROM budget_items WHERE id = ?').get(item.id)).toBeUndefined();
  });
});

describe('an expense nobody paid stays out of the ledger (#2225)', () => {
  it('BUDGET-SVC-DB-037: an unpaid expense moves neither the balances nor the offered flows', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    const { user: carol } = createUser(testDb, { username: 'carol' });
    const trip = createTrip(testDb, alice.id, { title: 'Trip' });
    addTripMember(testDb, trip.id, bob.id);
    addTripMember(testDb, trip.id, carol.id);

    budget.createBudgetItem(trip.id, {
      name: 'Dinner', payers: [{ user_id: alice.id, amount: 120 }],
      member_ids: [alice.id, bob.id, carol.id],
    });
    const before = budget.calculateSettlement(trip.id);

    // The row from the issue: a recorded total left on "No one paid yet", split
    // between the two people who were actually there.
    const unpaid = budget.createBudgetItem(trip.id, {
      name: 'Taxi', total_price: 161.57, payers: [], member_ids: [bob.id, carol.id],
    }) as { id: number; payers: unknown[]; total_price: number };
    expect(unpaid.payers).toEqual([]);
    expect(unpaid.total_price).toBe(161.57);

    // Re-saving it from the edit modal (payers cleared, total re-sent) must not
    // let writeItemPayers derive the total back down to 0.
    const resaved = budget.updateBudgetItem(unpaid.id, trip.id, {
      total_price: 161.57, payers: [], member_ids: [bob.id, carol.id],
    }) as { payers: unknown[]; total_price: number };
    expect(resaved.payers).toEqual([]);
    expect(resaved.total_price).toBe(161.57);
    const payerRows = testDb
      .prepare('SELECT count(*) AS cnt FROM budget_item_payers WHERE budget_item_id = ?')
      .get(unpaid.id) as { cnt: number };
    expect(payerRows.cnt).toBe(0);

    // 161.57 with no credit behind it used to push bob and carol 80.79/80.78 further
    // into the red and hand the whole of it to alice, who never fronted a rouble of it.
    const after = budget.calculateSettlement(trip.id);
    expect(after.balances).toEqual(before.balances);
    expect(after.flows).toEqual(before.flows);
    expect(after.balances.reduce((a, b) => a + Math.round(b.balance * 100), 0)).toBe(0);
  });
});

describe('post-fold quirk fixes', () => {
  it('BUDGET-SVC-DB-019: settlements prefer display_name over username (quirk fix)', () => {
    const { user: alice } = createUser(testDb, { username: 'alice' });
    const { user: bob } = createUser(testDb, { username: 'bob' });
    testDb.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Alice Displayed', alice.id);
    const trip = createTrip(testDb, alice.id);

    const created = budget.insertSettlement(trip.id, { from_user_id: alice.id, to_user_id: bob.id, amount: 10 }, alice.id);

    expect(created!.from_username).toBe('Alice Displayed');
    expect(created!.to_username).toBe('bob');
    expect(budget.listSettlements(trip.id)[0].from_username).toBe('Alice Displayed');
  });

  // ── Notes vs. itemized receipts (#1658) ────────────────────────────────────

  it('BUDGET-SVC-DB-021: a note and a receipt are stored in their own columns', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Groceries',
      total_price: 40,
      note: 'Lisa pays half of this back',
      ticket_json: '{"items":[{"name":"Bread","price":"3","parts":[1]}]}',
    });

    const row = testDb.prepare('SELECT note, ticket_json FROM budget_items WHERE id = ?').get(item!.id) as {
      note: string | null; ticket_json: string | null;
    };
    expect(row.note).toBe('Lisa pays half of this back');
    expect(JSON.parse(row.ticket_json!).items).toHaveLength(1);
  });

  it('BUDGET-SVC-DB-022: an update that omits note leaves the stored one alone', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Dinner', total_price: 20, note: 'split with Ben' });

    // What the mobile sheet sends: notes are written on desktop, so it never
    // speaks about the field.
    budget.updateBudgetItem(item!.id, trip.id, { total_price: 25 });

    const row = testDb.prepare('SELECT note FROM budget_items WHERE id = ?').get(item!.id) as { note: string | null };
    expect(row.note).toBe('split with Ben');
  });

  it('BUDGET-SVC-DB-023: an explicit null clears the note', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Taxi', total_price: 12, note: 'airport run' });

    budget.updateBudgetItem(item!.id, trip.id, { note: null });

    const row = testDb.prepare('SELECT note FROM budget_items WHERE id = ?').get(item!.id) as { note: string | null };
    expect(row.note).toBeNull();
  });

  it('BUDGET-SVC-DB-024: a pre-#1658 client sending the receipt as a note cannot erase the note', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const item = budget.createBudgetItem(trip.id, { name: 'Supermarket', total_price: 30, note: 'reimburse from the kitty' });

    // An old tab, still encoding the receipt into `note`.
    budget.updateBudgetItem(item!.id, trip.id, {
      note: 'TICKETJSON:{"items":[{"name":"Milk","price":"2","parts":[1]}]}',
    });

    const row = testDb.prepare('SELECT note, ticket_json FROM budget_items WHERE id = ?').get(item!.id) as {
      note: string | null; ticket_json: string | null;
    };
    expect(row.note).toBe('reimburse from the kitty');
    expect(JSON.parse(row.ticket_json!).items[0].name).toBe('Milk');
  });

  it('BUDGET-SVC-DB-025: the same legacy payload on create lands in the receipt column', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Market',
      total_price: 9,
      note: 'TICKETJSON:{"items":[{"name":"Cheese","price":"9","parts":[1]}]}',
    });

    const row = testDb.prepare('SELECT note, ticket_json FROM budget_items WHERE id = ?').get(item!.id) as {
      note: string | null; ticket_json: string | null;
    };
    expect(row.note).toBeNull();
    expect(JSON.parse(row.ticket_json!).items[0].name).toBe('Cheese');
  });

  it('BUDGET-SVC-DB-020: a failing item insert rolls back the category-order side write (quirk fix)', () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    // NOT NULL violation on name fires after the category-order upsert — the
    // legacy non-transactional create leaked the budget_category_order row.
    expect(() => budget.createBudgetItem(trip.id, { name: null as unknown as string, category: 'atomic-test' })).toThrow();

    const cat = testDb.prepare("SELECT 1 FROM budget_category_order WHERE trip_id = ? AND category = 'atomic-test'").get(trip.id);
    expect(cat).toBeUndefined();
  });
});

/**
 * The total an uneven split writes back (#1964).
 *
 * The client splits in whole cents, which is right — 163.21 across two people
 * is 81.61 and 81.60. The server then discarded the total it was sent and
 * re-derived it by adding those two as doubles, which lands on
 * 163.20999999999998, and that is what went into the row.
 *
 * Everything that reaches Intl was fine, which is why it looked like a display
 * quirk in only some places. It was not: the stored number was wrong, and the
 * expense form showed it back the moment the item was reopened.
 */
describe('an expense whose split leaves a remainder', () => {
  const totalOf = (itemId: number) =>
    (testDb.prepare('SELECT total_price FROM budget_items WHERE id = ?').get(itemId) as { total_price: number }).total_price;

  it('stores the total the parts add up to, not the float they land on', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Flight',
      payers: [{ user_id: alice.id, amount: 81.61 }, { user_id: bob.id, amount: 81.60 }],
      members: [{ user_id: alice.id }, { user_id: bob.id }],
    });

    // The assertion that fails on the old code, with exactly the reported number.
    expect(totalOf(item.id)).toBe(163.21);
    expect(String(totalOf(item.id))).toBe('163.21');
  });

  it('does the same when the payers are replaced on an update', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const item = budget.createBudgetItem(trip.id, { name: 'Hotel', total_price: 10, members: [{ user_id: alice.id }] });
    budget.updateBudgetItem(item.id, trip.id, {
      payers: [{ user_id: alice.id, amount: 81.61 }, { user_id: bob.id, amount: 81.60 }],
    });

    expect(totalOf(item.id)).toBe(163.21);
  });

  /*
   * Three ways is the harder case: 100.00 becomes 33.34 + 33.33 + 33.33, and
   * two of those additions drift.
   */
  it('holds across a three-way split too', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const { user: carol } = createUser(testDb);
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);
    addTripMember(testDb, trip.id, carol.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Dinner',
      payers: [
        { user_id: alice.id, amount: 33.34 },
        { user_id: bob.id, amount: 33.33 },
        { user_id: carol.id, amount: 33.33 },
      ],
      members: [{ user_id: alice.id }, { user_id: bob.id }, { user_id: carol.id }],
    });

    expect(totalOf(item.id)).toBe(100);
  });

  it('leaves a total that needs no cleaning exactly as it was', () => {
    const { user: alice } = createUser(testDb);
    const { user: bob } = createUser(testDb);
    const trip = createTrip(testDb, alice.id);
    addTripMember(testDb, trip.id, bob.id);

    const item = budget.createBudgetItem(trip.id, {
      name: 'Taxi',
      payers: [{ user_id: alice.id, amount: 12.5 }, { user_id: bob.id, amount: 12.5 }],
      members: [{ user_id: alice.id }, { user_id: bob.id }],
    });

    expect(totalOf(item.id)).toBe(25);
  });
})
