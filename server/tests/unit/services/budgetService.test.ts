import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock setup ────────────────────────────────────────────────────────────

interface MockPrepared {
  all: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

const preparedMap: Record<string, MockPrepared> = {};
let defaultAll: ReturnType<typeof vi.fn>;
let defaultGet: ReturnType<typeof vi.fn>;

const mockDb = vi.hoisted(() => {
  return {
    db: {
      prepare: vi.fn((sql: string) => {
        return {
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
          run: vi.fn(),
        };
      }),
    },
    canAccessTrip: vi.fn(() => true),
  };
});

vi.mock('../../../src/db/database', () => mockDb);

import { calculateSettlement, avatarUrl } from '../../../src/services/budgetService';
import type { BudgetItem, BudgetItemMember } from '../../../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(id: number, total_price: number, trip_id = 1): BudgetItem {
  return { id, trip_id, name: `Item ${id}`, total_price, category: 'Other' } as BudgetItem;
}

function makeMember(budget_item_id: number, user_id: number, paid: boolean | 0 | 1, username: string): BudgetItemMember & { budget_item_id: number } {
  return {
    budget_item_id,
    user_id,
    paid: paid ? 1 : 0,
    username,
    avatar: null,
  } as BudgetItemMember & { budget_item_id: number };
}

function setupDb(items: BudgetItem[], members: (BudgetItemMember & { budget_item_id: number })[]) {
  mockDb.db.prepare.mockImplementation((sql: string) => {
    if (sql.includes('SELECT * FROM budget_items')) {
      return { all: vi.fn(() => items), get: vi.fn(), run: vi.fn() };
    }
    if (sql.includes('budget_item_members')) {
      return { all: vi.fn(() => members), get: vi.fn(), run: vi.fn() };
    }
    return { all: vi.fn(() => []), get: vi.fn(), run: vi.fn() };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDb([], []);
});

// ── avatarUrl ────────────────────────────────────────────────────────────────

describe('avatarUrl', () => {
  it('returns /uploads/avatars/<filename> when avatar is set', () => {
    expect(avatarUrl({ avatar: 'photo.jpg' })).toBe('/uploads/avatars/photo.jpg');
  });

  it('returns null when avatar is null', () => {
    expect(avatarUrl({ avatar: null })).toBeNull();
  });

  it('returns null when avatar is undefined', () => {
    expect(avatarUrl({})).toBeNull();
  });
});

// ── calculateSettlement ──────────────────────────────────────────────────────

describe('calculateSettlement', () => {
  it('returns empty balances and flows when trip has no items', () => {
    setupDb([], []);
    const result = calculateSettlement(1);
    expect(result.balances).toEqual([]);
    expect(result.flows).toEqual([]);
  });

  it('returns no flows when there are items but no members', () => {
    setupDb([makeItem(1, 100)], []);
    const result = calculateSettlement(1);
    expect(result.flows).toEqual([]);
  });

  it('returns no flows when no one is marked as paid', () => {
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 0, 'alice'), makeMember(1, 2, 0, 'bob')],
    );
    const result = calculateSettlement(1);
    expect(result.flows).toEqual([]);
  });

  it('2 members, 1 payer: payer is owed half, non-payer owes half', () => {
    // Item: $100. Alice paid, Bob did not. Each owes $50. Alice net: +$50. Bob net: -$50.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 0, 'bob')],
    );
    const result = calculateSettlement(1);
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
      [makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 0, 'bob'), makeMember(1, 3, 0, 'carol')],
    );
    const result = calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    const carol = result.balances.find(b => b.user_id === 3)!;
    expect(alice.balance).toBe(60);
    expect(bob.balance).toBe(-30);
    expect(carol.balance).toBe(-30);
    expect(result.flows).toHaveLength(2);
  });

  it('all paid equally: all balances are zero, no flows', () => {
    // Item: $60. 3 members, all paid equally (each paid $20, each owes $20). Net: 0.
    // Actually with "paid" flag it means: paidPerPayer = item.total / numPayers.
    // If all 3 paid: each gets +20 credit, each owes -20 = net 0 for everyone.
    setupDb(
      [makeItem(1, 60)],
      [makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 1, 'bob'), makeMember(1, 3, 1, 'carol')],
    );
    const result = calculateSettlement(1);
    for (const b of result.balances) {
      expect(Math.abs(b.balance)).toBeLessThanOrEqual(0.01);
    }
    expect(result.flows).toHaveLength(0);
  });

  it('flow direction: from is debtor (owes), to is creditor (is owed)', () => {
    // Alice paid $100 for 2 people. Bob owes Alice $50.
    setupDb(
      [makeItem(1, 100)],
      [makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 0, 'bob')],
    );
    const result = calculateSettlement(1);
    const flow = result.flows[0];
    expect(flow.from.username).toBe('bob');   // debtor
    expect(flow.to.username).toBe('alice');   // creditor
  });

  it('amounts are rounded to 2 decimal places', () => {
    // Item: $10. 3 members, 1 payer. Share = 3.333... Each rounded to 3.33.
    setupDb(
      [makeItem(1, 10)],
      [makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 0, 'bob'), makeMember(1, 3, 0, 'carol')],
    );
    const result = calculateSettlement(1);
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
        makeMember(1, 1, 1, 'alice'), makeMember(1, 2, 0, 'bob'),
        makeMember(2, 1, 0, 'alice'), makeMember(2, 2, 1, 'bob'),
      ],
    );
    const result = calculateSettlement(1);
    const alice = result.balances.find(b => b.user_id === 1)!;
    const bob = result.balances.find(b => b.user_id === 2)!;
    expect(alice.balance).toBe(20);
    expect(bob.balance).toBe(-20);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0].amount).toBe(20);
  });
});
