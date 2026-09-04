/**
 * Settlement-math and FX-freeze unit tests for BudgetService over a prepare-stub
 * DB mock. Moved 1:1 from the legacy tests/unit/services/budgetService.test.ts
 * (same cases, incl. the #1335/#1445/#1426 pins); the SUT is now the folded
 * BudgetService with a constructor-injected ExchangeRatesService stub (was a
 * path mock of the deleted exchange-rates.bridge), and the raw settlement
 * update is exercised as applySettlementUpdate (the no-freeze write the REST
 * updateSettlement wraps).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock setup ────────────────────────────────────────────────────────────

const mockDb = vi.hoisted(() => {
  return {
    db: {
      // Typed as the real prepare(sql) rather than inferred from this default
      // implementation: inferred, every later mockImplementation had to match
      // the exact three-member object literal below, so widening one of them
      // broke the other nine.
      prepare: vi.fn<(sql: string) => import('better-sqlite3').Statement>(
        () =>
          ({
            all: vi.fn(() => [] as unknown[]),
            get: vi.fn(() => undefined as unknown),
            run: vi.fn(),
          }) as unknown as import('better-sqlite3').Statement,
      ),
    },
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: () => null,
    canAccessTrip: vi.fn(() => true),
    isOwner: () => false,
  };
});

vi.mock('../../../src/db/database', () => mockDb);
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn() }));

const mockRates = { getRates: vi.fn() };

import { BudgetService } from '../../../src/nest/budget/budget.service';
import { DatabaseService } from '../../../src/nest/database/database.service';
import type { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import type { ExchangeRatesService } from '../../../src/nest/budget/exchange-rates.service';
import type { BudgetItem, BudgetItemMember, BudgetItemPayer } from '../../../src/types';
import type Database from 'better-sqlite3';
import { RealtimeService } from '../../../src/nest/realtime/realtime.service';

/**
 * A prepared-statement stub.
 *
 * better-sqlite3's Statement has a dozen members; these cases drive three of
 * them. Naming the widening once beats a cast at each of the sixteen returns,
 * and keeps `prepare`'s own signature honest so a genuinely wrong mock still
 * fails to compile.
 */
const stmt = (impl: Partial<Database.Statement>) => impl as Database.Statement;

const permissionsStub = { checkPermission: vi.fn(() => true) } as unknown as PermissionsService;

const budget = new BudgetService(
  new DatabaseService(mockDb.db as unknown as Database.Database),
  permissionsStub,
  mockRates as unknown as ExchangeRatesService,
  new RealtimeService(),
);

// ── Helpers ──────────────────────────────────────────────────────────────────
// Who actually paid is recorded as explicit payers (budget_item_payers); members
// are only the equal-split participants.

function makeItem(id: number, total_price: number, trip_id = 1): BudgetItem {
  return { id, trip_id, name: `Item ${id}`, total_price, category: 'other' } as BudgetItem;
}

function makeMember(budget_item_id: number, user_id: number, username: string): BudgetItemMember & { budget_item_id: number } {
  return { budget_item_id, user_id, paid: 0, username, avatar: null } as BudgetItemMember & { budget_item_id: number };
}

function makePayer(budget_item_id: number, user_id: number, amount: number, username: string): BudgetItemPayer & { budget_item_id: number } {
  return { budget_item_id, user_id, amount, username, avatar: null } as BudgetItemPayer & { budget_item_id: number };
}

// A raw budget_settlements row as listSettlements reads it (joined usernames/avatars).
function makeSettlementRow(
  id: number, from_user_id: number, to_user_id: number, amount: number,
  currency: string | null = null, exchange_rate = 1,
) {
  return {
    id, trip_id: 1, from_user_id, to_user_id, amount, currency, exchange_rate,
    created_at: '2026-01-01', created_by_user_id: from_user_id,
    from_username: `u${from_user_id}`, from_avatar: null,
    to_username: `u${to_user_id}`, to_avatar: null,
  };
}

/**
 * Add money the way the ledger does — in whole cents. Summing the returned
 * two-decimal figures with `+` reintroduces exactly the binary dust the fix is
 * about, so an "adds up to zero" assertion has to count cents to mean anything.
 */
const centSum = (values: number[]) => values.reduce((a, v) => a + Math.round(v * 100), 0);

function setupDb(
  items: BudgetItem[],
  members: (BudgetItemMember & { budget_item_id: number })[],
  payers: (BudgetItemPayer & { budget_item_id: number })[] = [],
  settlements: ReturnType<typeof makeSettlementRow>[] = [],
) {
  mockDb.db.prepare.mockImplementation((sql: string) => {
    if (sql.includes('SELECT * FROM budget_items')) {
      return stmt({ all: vi.fn(() => items), get: vi.fn(), run: vi.fn() });
    }
    if (sql.includes('budget_item_members')) {
      return stmt({ all: vi.fn(() => members), get: vi.fn(), run: vi.fn() });
    }
    if (sql.includes('budget_item_payers')) {
      return stmt({ all: vi.fn(() => payers), get: vi.fn(), run: vi.fn() });
    }
    if (sql.includes('budget_settlements')) {
      return stmt({ all: vi.fn(() => settlements), get: vi.fn(), run: vi.fn() });
    }
    return stmt({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDb([], [], []);
});

// ── calculateSettlement ──────────────────────────────────────────────────────

describe('calculateSettlement', () => {
  it('returns empty balances and flows when trip has no items', () => {
    setupDb([], [], []);
    const result = budget.calculateSettlement(1);
    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });

  it('returns no flows when there are items but no members', () => {
    setupDb([makeItem(1, 100)], [], [makePayer(1, 1, 100, 'alice')]);
    const result = budget.calculateSettlement(1);
    expect(result.flows).toEqual([]);
  });

  it('returns no flows when no one has paid', () => {
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [],
    );
    const result = budget.calculateSettlement(1);
    expect(result.flows).toEqual([]);
    // "No flows" on its own said nothing about the balances behind them: they
    // were -50/-50 here until #2225, an offer of nothing next to money owed.
    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('2 members, 1 payer: payer is owed half, non-payer owes half', () => {
    // Item: $100. Alice paid all, [Alice, Bob] split. Each owes $50. Alice net: +$50. Bob: -$50.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 100, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    expect(alice.balance).toBe(50);
    expect(bob.balance).toBe(-50);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].from.user_id).toBe(2); // Bob owes
    expect(result.flows[0].to.user_id).toBe(1);   // Alice is owed
    expect(result.flows[0].amount).toBe(50);
  });

  it('3 members, 1 payer: correct 3-way split', () => {
    // Item: $90. Alice paid. Each of 3 owes $30. Alice net: +$60. Bob: -$30. Carol: -$30.
    setupDb(
      [makeItem(1, 90)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 90, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    const carol = result.balances.find(b => b.user_id === 3)!;
    expect(alice.balance).toBe(60);
    expect(bob.balance).toBe(-30);
    expect(carol.balance).toBe(-30);
    expect(result.flows).toHaveLength(2);
  });

  it('all paid equally: all balances are zero, no flows', () => {
    // Item: $60. 3 members, each paid $20 and owes $20. Net: 0 for everyone.
    setupDb(
      [makeItem(1, 60)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 20, 'alice'), makePayer(1, 2, 20, 'bob'), makePayer(1, 3, 20, 'carol')],
    );
    const result = budget.calculateSettlement(1);
    // Exactly zero, not "within a cent": a tolerance here is what let #1382's
    // stranded cents through unnoticed.
    for (const b of result.balances) {
      expect(b.balance).toBe(0);
    }
    expect(result.flows).toHaveLength(0);
  });

  it('flow direction: from is debtor (owes), to is creditor (is owed)', () => {
    // Alice paid $100 for 2 people. Bob owes Alice $50.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 100, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const flow = result.flows[0];
    expect(flow.from.username).toBe('bob');   // debtor
    expect(flow.to.username).toBe('alice');   // creditor
  });

  it('amounts are rounded to 2 decimal places', () => {
    // Item: $10. 3 members, 1 payer. Share = 3.333... Each rounded to 3.33.
    setupDb(
      [makeItem(1, 10)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 10, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    for (const b of result.balances) {
      const str = b.balance.toString();
      const decimals = str.includes('.') ? str.split('.')[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(2);
    }
    for (const flow of result.flows) {
      const str = flow.amount.toString();
      const decimals = str.includes('.') ? str.split('.')[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });

  it('2 items with different payers: aggregates balances correctly', () => {
    // Item 1: $100, Alice paid, [Alice, Bob] (Alice net: +50, Bob: -50)
    // Item 2: $60, Bob paid, [Alice, Bob] (Bob net: +30, Alice: -30)
    // Final: Alice: +50 - 30 = +20, Bob: -50 + 30 = -20
    setupDb(
      [makeItem(1, 100), makeItem(2, 60)],
      [
        makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'),
        makeMember(2, 1, 'alice'), makeMember(2, 2, 'bob'),
      ],
      [makePayer(1, 1, 100, 'alice'), makePayer(2, 2, 60, 'bob')],
    );
    const result = budget.calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    expect(alice.balance).toBe(20);
    expect(bob.balance).toBe(-20);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].amount).toBe(20);
  });

  it('counts a settlement with no matching expense as an amount still to square up', () => {
    // bob paid alice 30 but every expense behind it was deleted: alice now owes bob.
    mockDb.db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('FROM budget_settlements')) {
        return stmt({ all: vi.fn(() => [
          { id: 1, trip_id: 1, from_user_id: 2, to_user_id: 1, amount: 30, from_username: 'bob', to_username: 'alice', from_avatar: null, to_avatar: null },
        ]), get: vi.fn(), run: vi.fn() });
      }
      return stmt({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() });
    });
    const result = budget.calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    expect(bob.balance).toBe(30);
    expect(alice.balance).toBe(-30);
    expect(result.flows).toEqual([
      expect.objectContaining({ amount: 30, from: expect.objectContaining({ user_id: 1 }), to: expect.objectContaining({ user_id: 2 }) }),
    ]);
  });

  it('#1335 converts a foreign expense with the frozen exchange_rate, not live rates', () => {
    // $110 booked at a frozen rate of 1.1 (USD per 1 EUR) = 100 EUR. Live rates have since
    // drifted to 1.2, but the converted amount must stay on the frozen rate so an already
    // settled position isn't re-opened with a residual.
    setupDb(
      [{ ...makeItem(1, 110), currency: 'USD', exchange_rate: 1.1 } as BudgetItem],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 110, 'alice')],
    );
    const result = budget.calculateSettlement(1, { base: 'EUR', tripCurrency: 'EUR', rates: { EUR: 1, USD: 1.2 } });
    const bob = result.balances.find(b => b.user_id === 2)!;
    // 110 / 1.1 = 100 EUR; Bob owes half = 50 (frozen). With the live 1.2 it would be ~45.83.
    expect(bob.balance).toBeCloseTo(-50, 2);
  });

  it('#1335 a legacy row (exchange_rate = 1) still converts with live rates', () => {
    setupDb(
      [{ ...makeItem(1, 120), currency: 'USD', exchange_rate: 1 } as BudgetItem],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 120, 'alice')],
    );
    const result = budget.calculateSettlement(1, { base: 'EUR', tripCurrency: 'EUR', rates: { EUR: 1, USD: 1.2 } });
    const bob = result.balances.find(b => b.user_id === 2)!;
    // 120 / 1.2 (live) = 100 EUR; Bob owes 50 — unchanged behaviour for pre-#1335 rows.
    expect(bob.balance).toBeCloseTo(-50, 2);
  });

  it('#1445 a settle-up transfer with a frozen currency+rate keeps the position balanced when rates drift', () => {
    // Trip currency EUR; Bob viewed in USD (display) and owes Alice 50 EUR = 62.50 USD
    // at the settle-time rate of 1.25 USD/EUR. He records that 62.50 USD transfer, which
    // freezes currency=USD, exchange_rate=1.25. Live rates have since drifted (now the
    // recompute passes EUR=0.5 per 1 USD), but the frozen transfer still nets to -50+50=0.
    setupDb(
      [makeItem(1, 100)], // trip-currency expense (currency NULL)
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 100, 'alice')],
      [makeSettlementRow(1, 2, 1, 62.5, 'USD', 1.25)],
    );
    const result = budget.calculateSettlement(1, { base: 'USD', tripCurrency: 'EUR', rates: { USD: 1, EUR: 0.5 } });
    const bob = result.balances.find(b => b.user_id === 2)!;
    expect(bob.balance).toBeCloseTo(0, 2); // settled — no residual re-opens
  });

  it('#1445 a legacy settle-up transfer (currency NULL) still converts with live rates', () => {
    // Same shape, but the transfer predates the fix (currency NULL). It is re-converted
    // to trip currency with live rates, so a drift re-opens the position — unchanged
    // legacy behaviour that normalises once the row is re-edited.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 100, 'alice')],
      [makeSettlementRow(1, 2, 1, 62.5, null, 1)],
    );
    const result = budget.calculateSettlement(1, { base: 'USD', tripCurrency: 'EUR', rates: { USD: 1, EUR: 0.5 } });
    const bob = result.balances.find(b => b.user_id === 2)!;
    // settleToTrip(62.5) = 62.5 * 0.5 = 31.25 EUR; balance -50 + 31.25 = -18.75 EUR → reopens.
    expect(Math.abs(bob.balance)).toBeGreaterThan(1);
  });

  // ── Multi-payer (#1426 regression): several people front one bill ──────────
  // The UI could only send one payer between 3.2.0 and this fix, but the ledger
  // has credited each payer individually since 3.1.0. These pin that.

  it('2 payers, 3 members: each payer is credited what they actually paid', () => {
    // $90 bill split 3 ways ($30 each). Alice and Bob each fronted $45.
    // Alice: +45 - 30 = +15. Bob: +45 - 30 = +15. Carol: -30.
    setupDb(
      [makeItem(1, 90)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 45, 'alice'), makePayer(1, 2, 45, 'bob')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBeCloseTo(15, 2);
    expect(balance(2)).toBeCloseTo(15, 2);
    expect(balance(3)).toBeCloseTo(-30, 2);
  });

  it('2 payers with unequal amounts: credits follow the actual amounts paid', () => {
    // $100 bill split 2 ways ($50 each). Alice fronted $70, Bob fronted $30.
    // Alice: +70 - 50 = +20. Bob: +30 - 50 = -20. Bob owes Alice $20.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [makePayer(1, 1, 70, 'alice'), makePayer(1, 2, 30, 'bob')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBeCloseTo(20, 2);
    expect(balance(2)).toBeCloseTo(-20, 2);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].from.user_id).toBe(2);
    expect(result.flows[0].to.user_id).toBe(1);
    expect(result.flows[0].amount).toBeCloseTo(20, 2);
  });

  it('multi-payer balances sum to zero (no money invented or destroyed)', () => {
    // The invariant that makes settle-up trustworthy: credits == debits.
    setupDb(
      [makeItem(1, 90), makeItem(2, 55)],
      [
        makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol'),
        makeMember(2, 1, 'alice'), makeMember(2, 3, 'carol'),
      ],
      [
        makePayer(1, 1, 45, 'alice'), makePayer(1, 2, 45, 'bob'),
        makePayer(2, 2, 25, 'bob'), makePayer(2, 3, 30, 'carol'),
      ],
    );
    const result = budget.calculateSettlement(1);

    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('3 payers on one bill: an odd total still splits to the cent', () => {
    // $100.01 split 3 ways. splitEqualShares distributes the remainder cent,
    // so debits must still exactly cancel the $100.01 of credits.
    setupDb(
      [makeItem(1, 100.01)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 33.34, 'alice'), makePayer(1, 2, 33.34, 'bob'), makePayer(1, 3, 33.33, 'carol')],
    );
    const result = budget.calculateSettlement(1);

    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });
});

// ── Refunds: negative amounts are first-class expenses (#2176) ───────────────

describe('calculateSettlement — negative amounts (#2176)', () => {
  it('a refund credits the members and debits its recipient', () => {
    // A 30 € refund lands with Alice; all three had shared the original cost.
    // Alice received 30 but only 10 of it was hers, so she owes 20.
    setupDb(
      [makeItem(1, -30)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, -30, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBe(-20);
    expect(balance(2)).toBe(10);
    expect(balance(3)).toBe(10);
    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('a refund reduces the debt its expense created', () => {
    // 90 € dinner fronted by Alice, then a 30 € partial reimbursement she keeps —
    // both split three ways. Bob's debt drops from 30 to 20.
    setupDb(
      [makeItem(1, 90), makeItem(2, -30)],
      [
        makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol'),
        makeMember(2, 1, 'alice'), makeMember(2, 2, 'bob'), makeMember(2, 3, 'carol'),
      ],
      [makePayer(1, 1, 90, 'alice'), makePayer(2, 1, -30, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBe(40);
    expect(balance(2)).toBe(-20);
    expect(balance(3)).toBe(-20);
    expect(result.flows).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 20, from: expect.objectContaining({ user_id: 2 }), to: expect.objectContaining({ user_id: 1 }) }),
    ]));
  });

  it('an odd negative total still nets to exactly zero', () => {
    setupDb(
      [makeItem(1, -100.01)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, -100.01, 'alice')],
    );
    const result = budget.calculateSettlement(1);

    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('a negative custom split settles by the custom amounts', () => {
    // 100 € refund to Alice; by agreement Bob is owed 70 of it, Carol 30.
    setupDb(
      [makeItem(1, -100)],
      [
        { ...makeMember(1, 2, 'bob'), amount: -70 },
        { ...makeMember(1, 3, 'carol'), amount: -30 },
      ],
      [makePayer(1, 1, -100, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBe(-100);
    expect(balance(2)).toBe(70);
    expect(balance(3)).toBe(30);
    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('a payer-less refund owes nobody anything until its recipient is named (#2225)', () => {
    // Nobody is recorded as having received the refund, so there is no credit to
    // hand back: the row is outstanding, not a debt the trip owes its members.
    // It used to credit all three 30 € out of thin air.
    setupDb(
      [makeItem(1, -90)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [],
    );
    const result = budget.calculateSettlement(1);

    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });
});

// ── Client/server share parity (#2176) ───────────────────────────────────────
//
// splitEqualShares exists twice: here (netting the settlement in cents) and on
// the client (previewing the split in euros — CostsPanel.helpers.ts). This
// fixture is duplicated verbatim in
// client/src/components/Budget/CostsPanel.helpers.test.ts; if either
// implementation drifts — sign handling included — its copy of the table fails.
const SHARE_PARITY_FIXTURE: { totalCents: number; users: number[]; itemId: number; expected: Record<number, number> }[] = [
  { totalCents: 10000, users: [1, 2, 3], itemId: 0, expected: { 1: 3334, 2: 3333, 3: 3333 } },
  { totalCents: 10000, users: [1, 2, 3], itemId: 1, expected: { 1: 3333, 2: 3334, 3: 3333 } },
  { totalCents: -10000, users: [1, 2, 3], itemId: 0, expected: { 1: -3333, 2: -3333, 3: -3334 } },
  { totalCents: -10000, users: [1, 2, 3], itemId: 1, expected: { 1: -3334, 2: -3333, 3: -3333 } },
  { totalCents: -101, users: [1, 2], itemId: 0, expected: { 1: -50, 2: -51 } },
  { totalCents: -101, users: [1, 2], itemId: 1, expected: { 1: -51, 2: -50 } },
  { totalCents: -1, users: [1, 2, 3], itemId: 0, expected: { 1: 0, 2: 0, 3: -1 } },
];

describe('splitEqualShares — client parity (#2176)', () => {
  // Private on purpose (only the settlement calls it); the parity pin reaches
  // through so the fixture exercises the real implementation, not a re-model.
  const split = (
    budget as unknown as {
      splitEqualShares(totalCents: number, members: { user_id: number }[], itemId: number): Record<number, number>;
    }
  ).splitEqualShares.bind(budget);

  it.each(SHARE_PARITY_FIXTURE)(
    'splits $totalCents cents across $users.length members (item $itemId) exactly like the client',
    ({ totalCents, users, itemId, expected }) => {
      const shares = split(totalCents, users.map(user_id => ({ user_id })), itemId);
      expect(shares).toEqual(expected);
      expect((Object.values(shares) as number[]).reduce((a, b) => a + b, 0)).toBe(totalCents);
    },
  );
});

// ── #1382: balances and flows have to tell the same story ────────────────────
// The ledger is netted in whole cents of the trip currency, so a balance is only
// ever a whole number of cents and every one of them can be settled. What used to
// be smoothed over with a 0.01 tolerance is now exact.

describe('calculateSettlement — cent-exact settle-up (#1382)', () => {
  it('#1382 offers the last cent as a flow instead of stranding it', () => {
    // 30.00 fronted by Alice, split three ways. Bob transfers 9.99 instead of his
    // 10.00 and Carol pays exactly, so one cent is still open. The reporter's
    // symptom was that the balances showed that cent while "Settle up" offered
    // nothing to clear it: below 0.01 the old filter dropped the person entirely.
    setupDb(
      [makeItem(1, 30)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 30, 'alice')],
      [makeSettlementRow(1, 2, 1, 9.99), makeSettlementRow(2, 3, 1, 10)],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBe(0.01);
    expect(balance(2)).toBe(-0.01);
    expect(balance(3)).toBe(0);
    expect(result.flows).toEqual([
      expect.objectContaining({ amount: 0.01, from: expect.objectContaining({ user_id: 2 }), to: expect.objectContaining({ user_id: 1 }) }),
    ]);
  });

  it('#1382 booking every offered flow leaves all balances at exactly zero', () => {
    // 10.00 three ways is 3.34/3.33/3.33 — the case where the old greedy walked
    // away from the rounding remainder. Recording the flows it offers must square
    // the trip up completely, or the leftover cent is there forever.
    const items = [makeItem(1, 10)];
    const members = [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')];
    const payers = [makePayer(1, 1, 10, 'alice')];
    setupDb(items, members, payers);

    const first = budget.calculateSettlement(1);
    expect(first.flows.length).toBeGreaterThan(0);

    const booked = first.flows.map((f, i) => makeSettlementRow(i + 1, f.from.user_id, f.to.user_id, f.amount));
    setupDb(items, members, payers, booked);

    const after = budget.calculateSettlement(1);
    expect(after.balances.map(b => b.balance)).toEqual([0, 0, 0]);
    expect(after.flows).toEqual([]);
  });

  it('#1382 a foreign-currency expense nets to exactly zero, not to a sub-cent residual', () => {
    // 100 USD frozen at 1.1 is 90.909090… EUR: no split of it lands on whole cents.
    // The equal split divides the credited cents rather than the foreign total, so
    // the debits cancel the credits exactly instead of leaving dust behind.
    setupDb(
      [{ ...makeItem(1, 100), currency: 'USD', exchange_rate: 1.1 } as BudgetItem],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 100, 'alice')],
    );
    const result = budget.calculateSettlement(1, { base: 'EUR', tripCurrency: 'EUR', rates: { EUR: 1, USD: 1.1 } });

    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
    expect(centSum(result.flows.map(f => f.amount)))
      .toBe(Math.round(result.balances.find(b => b.user_id === 1)!.balance * 100));
  });

  it('#1382 a display currency of its own neither invents nor loses a cent', () => {
    // Nothing here is foreign: an all-EUR trip, but the viewer's preferred currency
    // is USD. Rounding each balance into that currency on its own used to leave the
    // set adding up to a cent that no flow could ever clear, and the drift moved
    // with the live rate — money appearing without a single expense being touched.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [makePayer(1, 1, 100, 'alice')],
    );
    for (const eurPerUsd of [0.855, 0.9312, 0.94]) {
      const result = budget.calculateSettlement(1, { base: 'USD', tripCurrency: 'EUR', rates: { USD: 1, EUR: eurPerUsd } });

      expect(centSum(result.balances.map(b => b.balance))).toBe(0);
      for (const b of result.balances) {
        // What settle-up would move for this person has to be their balance exactly.
        const moved = centSum(result.flows.filter(f => f.to.user_id === b.user_id).map(f => f.amount))
          - centSum(result.flows.filter(f => f.from.user_id === b.user_id).map(f => f.amount));
        expect(moved).toBe(Math.round(b.balance * 100));
      }
    }
  });

  it('#2225 an unpaid bill owes nobody anything', () => {
    // Nobody is down as a payer, so nobody is out of pocket and there is nothing
    // to pay back. It used to debit all three 30 € against no credit at all,
    // leaving Σ(balances) at -90 with no flow able to clear it.
    setupDb(
      [makeItem(1, 90)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol')],
      [],
    );
    const result = budget.calculateSettlement(1);

    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });
});

// ── Unpaid expenses stay out of the ledger (#2225) ────────────────────────

describe('calculateSettlement: unpaid expenses (#2225)', () => {
  it('an unpaid expense does not turn its members into debtors of an unrelated payer', () => {
    // The shape from the issue: a 300 € bill Alice fronted for all four, plus a
    // 60 € row nobody has paid that only Bob and Carol are on. The 60 € used to
    // be debited with no credit behind it, and the simplifier (which knows
    // nothing about which expense made which debt) handed the extra 60 € to
    // Alice, who was never owed it.
    setupDb(
      [makeItem(1, 300), makeItem(2, 60)],
      [
        makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol'), makeMember(1, 4, 'dave'),
        makeMember(2, 2, 'bob'), makeMember(2, 3, 'carol'),
      ],
      [makePayer(1, 1, 300, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
    // Being on the unpaid row costs Bob and Carol nothing over Dave, who is not.
    expect(balance(2)).toBe(balance(4));
    expect(balance(3)).toBe(balance(4));
    expect(balance(1)).toBe(225);
    expect(centSum(result.flows.map(f => f.amount))).toBe(Math.round(balance(1) * 100));
    for (const f of result.flows) expect(f.to.user_id).toBe(1);
  });

  it('an unpaid expense with a custom split is skipped too', () => {
    // The custom branch had the same hole and no coverage: 100 € split 70/30 by
    // agreement, with nobody recorded as having paid it.
    setupDb(
      [makeItem(1, 90), makeItem(2, 100)],
      [
        makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob'), makeMember(1, 3, 'carol'),
        { ...makeMember(2, 2, 'bob'), amount: 70 },
        { ...makeMember(2, 3, 'carol'), amount: 30 },
      ],
      [makePayer(1, 1, 90, 'alice')],
    );
    const result = budget.calculateSettlement(1);
    const balance = (uid: number) => result.balances.find(b => b.user_id === uid)!.balance;

    expect(balance(1)).toBe(60);
    expect(balance(2)).toBe(-30);
    expect(balance(3)).toBe(-30);
    expect(centSum(result.balances.map(b => b.balance))).toBe(0);
  });

  it('a zero-total item with no payer contributes nothing and no rows', () => {
    // Payer-less is payer-less regardless of the total: it contributes 0 either
    // way, and both panels synthesise a missing member's 0.00 row from the trip
    // roster (CostsPanel.tsx:853, MCostsTab.tsx:273), so dropping the row costs
    // the UI nothing.
    setupDb(
      [makeItem(1, 0)],
      [makeMember(1, 1, 'alice'), makeMember(1, 2, 'bob')],
      [],
    );
    const result = budget.calculateSettlement(1);

    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });

  it('a custom split left with no payer and a zeroed total creates no debt', () => {
    // PUT /budget/:id/payers with an empty array zeroes total_price via
    // writeItemPayers and, unlike updateBudgetItem, never re-applies it, so the
    // row survives as custom per-member amounts with no credit behind them. A
    // guard that also required a non-zero total would let exactly this shape
    // through and rebuild the #2225 phantom debt from a first-party endpoint.
    setupDb(
      [makeItem(1, 0)],
      [
        { ...makeMember(1, 2, 'bob'), amount: 40 },
        { ...makeMember(1, 3, 'cara'), amount: 60 },
      ],
      [],
    );
    const result = budget.calculateSettlement(1);

    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });
});

// ── freezeForeignRate (write-path FX freeze, #1445) ───────────────────────────

describe('freezeForeignRate', () => {
  const tripRow = (currency: string) =>
    stmt({ get: vi.fn(() => ({ currency })), all: vi.fn(), run: vi.fn() });

  it('freezes the live rate for a foreign currency into exchange_rate', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('FROM trips')) return tripRow('EUR');
      return stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() });
    });
    mockRates.getRates.mockResolvedValue({ EUR: 1, USD: 1.25 });
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'usd' };
    await budget.freezeForeignRate(1, data);
    expect(mockRates.getRates).toHaveBeenCalledWith('EUR');
    expect(data.exchange_rate).toBe(1.25);
  });

  it('leaves the rate unset when the currency equals the trip currency', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM trips') ? tripRow('EUR') : stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }));
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'EUR' };
    await budget.freezeForeignRate(1, data);
    expect(mockRates.getRates).not.toHaveBeenCalled();
    expect(data.exchange_rate).toBeUndefined();
  });

  it('respects an explicit exchange_rate from the caller', async () => {
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'USD', exchange_rate: 2 };
    await budget.freezeForeignRate(1, data);
    expect(mockRates.getRates).not.toHaveBeenCalled();
    expect(data.exchange_rate).toBe(2);
  });

  it('degrades to live rates (no freeze) when the rate fetch fails', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM trips') ? tripRow('EUR') : stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }));
    mockRates.getRates.mockResolvedValue(null);
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'USD' };
    await budget.freezeForeignRate(1, data);
    expect(data.exchange_rate).toBeUndefined();
  });

  it('does not re-freeze on update when the currency is unchanged', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('FROM budget_items')) return stmt({ get: vi.fn(() => ({ currency: 'USD' })), all: vi.fn(), run: vi.fn() });
      if (sql.includes('FROM trips')) return tripRow('EUR');
      return stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() });
    });
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'USD' };
    await budget.freezeForeignRate(1, data, 9);
    expect(mockRates.getRates).not.toHaveBeenCalled();
    expect(data.exchange_rate).toBeUndefined();
  });

  it('does not re-freeze a settlement edit when its stored currency is unchanged (#1445)', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM trips') ? tripRow('EUR') : stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }));
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'USD' };
    // the settlement already holds USD — pass it as existingCurrency → keep the frozen rate
    await budget.freezeForeignRate(1, data, undefined, 'USD');
    expect(mockRates.getRates).not.toHaveBeenCalled();
    expect(data.exchange_rate).toBeUndefined();
  });

  it('re-freezes a settlement edit when its currency actually changes', async () => {
    mockDb.db.prepare.mockImplementation((sql: string) =>
      sql.includes('FROM trips') ? tripRow('EUR') : stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }));
    mockRates.getRates.mockResolvedValue({ EUR: 1, USD: 1.25 });
    const data: { currency?: string | null; exchange_rate?: number } = { currency: 'USD' };
    await budget.freezeForeignRate(1, data, undefined, 'GBP'); // was GBP → now USD → re-freeze
    expect(data.exchange_rate).toBe(1.25);
  });
});

// ── applySettlementUpdate (the raw no-freeze write behind updateSettlement) ──

describe('applySettlementUpdate', () => {
  it('returns null when the settlement is not in the trip', () => {
    mockDb.db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM budget_settlements')) {
        return stmt({ get: vi.fn(() => undefined), all: vi.fn(), run: vi.fn() });
      }
      return stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() });
    });
    expect(budget.applySettlementUpdate(7, 1, { from_user_id: 2, to_user_id: 1, amount: 10 })).toBeNull();
  });

  it('updates the row (rounded to cents) and returns the refreshed settlement', () => {
    const run = vi.fn();
    mockDb.db.prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM budget_settlements')) {
        return stmt({ get: vi.fn(() => ({ id: 7 })), all: vi.fn(), run: vi.fn() });
      }
      if (sql.includes('UPDATE budget_settlements')) {
        return stmt({ get: vi.fn(), all: vi.fn(), run });
      }
      if (sql.includes('FROM budget_settlements')) {
        // Quirk fix: the re-select is a targeted single-row get, not a full
        // listSettlements scan.
        return stmt({ get: vi.fn(() => (
          { id: 7, trip_id: 1, from_user_id: 2, to_user_id: 1, amount: 10.13, from_username: 'bob', to_username: 'alice', from_avatar: null, to_avatar: null }
        )), all: vi.fn(() => []), run: vi.fn() });
      }
      return stmt({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn() });
    });

    const res = budget.applySettlementUpdate(7, 1, { from_user_id: 2, to_user_id: 1, amount: 10.126 });
    // from, to, rounded amount, currency-flag(0)/value(null), rate-flag(null)/value(1), id.
    // No currency/exchange_rate passed → both CASE guards keep the existing columns.
    expect(run).toHaveBeenCalledWith(2, 1, 10.13, 0, null, null, 1, 7);
    expect(res).toMatchObject({ id: 7, from_user_id: 2, to_user_id: 1, amount: 10.13 });
  });
});
