import { Injectable } from '@nestjs/common';
import { DatabaseService, type TripAccess } from '../database/database.service';
import type { TrekWsPayload, TrekWsTripEventName } from '@trek/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { PermissionsService } from '../permissions/permissions.service';
import { avatarUrl } from '../common/avatarUrl';
import type { User, BudgetItem, BudgetItemMember, BudgetItemPayer } from '../../types';
import { ExchangeRatesService } from './exchange-rates.service';

type Trip = TripAccess;

type SettlementRow = {
  id: number; trip_id: string; from_user_id: number; to_user_id: number;
  amount: number; currency: string | null; exchange_rate: number | null;
  created_at: string; created_by_user_id: number | null;
  from_username: string; from_avatar: string | null;
  to_username: string; to_avatar: string | null;
};

/** How the costs UI used to smuggle an itemized receipt through the note field. */
const LEGACY_TICKET_PREFIX = 'TICKETJSON:';

/**
 * Keep a written note and an itemized receipt out of each other's way (#1658).
 *
 * The receipt has its own column since migration 186, but a client that predates
 * it still sends the blob as `note`. Such a payload says nothing about the note
 * the user typed, so the note is reported as untouched (`undefined`) rather than
 * overwritten — an old tab left open must not erase a note written elsewhere.
 *
 * `undefined` means "caller did not speak about this field"; `null` means "clear it".
 */
export function splitLegacyTicketNote(
  note: string | null | undefined,
  ticket: string | null | undefined,
): { note: string | null | undefined; ticket: string | null | undefined } {
  if (typeof note === 'string' && note.startsWith(LEGACY_TICKET_PREFIX)) {
    return { note: undefined, ticket: note.slice(LEGACY_TICKET_PREFIX.length) };
  }
  return { note, ticket };
}

/**
 * Re-denominate whole trip-currency cents into whole display-currency cents
 * without losing or inventing one (#1382).
 *
 * Rounding every balance on its own lets the rounded set drift away from the sum
 * it came from: a squared-up trip viewed in another currency then shows a cent
 * that no payment flow can ever clear, and the drift moves whenever the live rate
 * does — money appearing without a single expense being touched. Rounding down
 * and handing the leftover to the largest fractions keeps Σ(converted) equal to
 * converted(Σ). `factor === 1` (the display currency IS the trip currency, the
 * common case) is the identity and never touches a float.
 */
/**
 * Add money in whole cents, not in floats (#1964).
 *
 * A total that does not divide evenly is split into parts that are each exact
 * to the cent — 163.21 across two people is 81.61 and 81.60 — but adding those
 * two doubles gives 163.20999999999998, and that is what got written back over
 * the clean total the client sent. It then surfaced anywhere the number is
 * printed without Intl doing the rounding: the expense form when reopened, the
 * mobile cost sheet, and the price stamped onto a linked booking.
 *
 * This is the same rule the settlement maths in this file already follows
 * (toTripCents), applied to the one arithmetic that had been left in euros.
 */
function sumMoney(amounts: number[]): number {
  return amounts.reduce((a, v) => a + Math.round(v * 100), 0) / 100;
}

function allocateDisplayCents(cents: number[], factor: number): number[] {
  if (factor === 1) return [...cents];
  const exact = cents.map(c => c * factor);
  const out = exact.map(v => Math.floor(v));
  const drift = Math.round(cents.reduce((a, c) => a + c, 0) * factor) - out.reduce((a, v) => a + v, 0);
  const byFraction = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < drift && k < byFraction.length; k++) out[byFraction[k].i] += 1;
  return out;
}

/**
 * Budget domain service — owns the budget SQL (moved from the legacy
 * services/budgetService.ts: identical statements, the `||` falsy-coercion
 * defaults, the COALESCE / CASE WHEN sentinel conventions on update and the
 * post-write re-selects). Trip access, the 'budget_edit' permission and the
 * WebSocket broadcast keep their legacy call paths. (budget.bridge.ts, the
 * former non-Nest entry point, is deleted — its last consumer,
 * UserCleanupService, injects this class now.)
 *
 * Quirk fixes on top of the relocated legacy behavior: every multi-statement
 * write now runs in db.transaction() ("transactions are not optional"),
 * linkBudgetItemToReservation passes reservation_id through the insert instead
 * of a redundant second UPDATE, settlement re-selects are targeted single-row
 * queries instead of a full listSettlements() scan, settlement usernames use
 * COALESCE(display_name, username) like every item query, and updateMembers no
 * longer double-applies avatarUrl.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly realtime: RealtimeService,
  ) {}

  verifyTripAccess(tripId: string | number, userId: number) {
    return this.db.canAccessTrip(tripId, userId);
  }

  canEdit(trip: Trip, user: User): boolean {
    return this.permissions.checkPermission('budget_edit', user.role, trip.user_id, user.id, trip.user_id !== user.id);
  }

  broadcast<E extends TrekWsTripEventName>(tripId: string, event: E, payload: TrekWsPayload<E>, socketId: string | undefined): void {
    this.realtime.broadcast(tripId, event, payload, socketId);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private loadItemMembers(itemId: number | string) {
    const rows = this.db.all<BudgetItemMember>(`
    SELECT bm.user_id, bm.paid, bm.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ?
  `, itemId);
    return rows.map(m => ({ ...m, avatar_url: avatarUrl(m) }));
  }

  private loadItemPayers(itemId: number | string) {
    const rows = this.db.all<BudgetItemPayer>(`
    SELECT bp.user_id, bp.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
    FROM budget_item_payers bp
    JOIN users u ON bp.user_id = u.id
    WHERE bp.budget_item_id = ?
  `, itemId);
    return rows.map(p => ({ ...p, avatar_url: avatarUrl(p) }));
  }

  /**
   * The subset of `userIds` that is actually on this trip. Used to be a plain
   * existence check against `users`, which let any id on the instance become a
   * payer or a split member and come back out through the read-back join with a
   * name and an avatar attached. Off-roster ids drop silently, the way the
   * packing and reservations assignee paths handle them.
   */
  private rosterMemberIds(tripId: string | number, userIds: number[]): Set<number> {
    const unique = new Set(userIds);
    if (unique.size === 0) return new Set();
    const roster = this.db.rosterUserIds(tripId);
    return new Set([...unique].filter(id => roster.has(id)));
  }

  /**
   * Replace the payer rows of an item and keep total_price = sum of payer amounts.
   * A negative amount is a real payer — the recipient of a refund (#2176) — and
   * is stored as such; only a zero (or NaN) amount says nothing and is dropped.
   */
  private writeItemPayers(itemId: number | string, tripId: string | number, payers: { user_id: number; amount: number }[]) {
    this.db.run('DELETE FROM budget_item_payers WHERE budget_item_id = ?', itemId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_payers (budget_item_id, user_id, amount) VALUES (?, ?, ?)');
    const known = this.rosterMemberIds(tripId, payers.map(p => p.user_id));
    const accepted: number[] = [];
    for (const p of payers) {
      if (!p.amount || !known.has(p.user_id)) continue;
      insert.run(itemId, p.user_id, p.amount);
      accepted.push(p.amount);
    }
    const total = sumMoney(accepted);
    this.db.run('UPDATE budget_items SET total_price = ? WHERE id = ?', total, itemId);
    return total;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  listBudgetItems(tripId: string | number) {
    const items = this.db.all<BudgetItem>(`
    SELECT bi.* FROM budget_items bi
    LEFT JOIN budget_category_order bco ON bco.trip_id = bi.trip_id AND bco.category = bi.category
    WHERE bi.trip_id = ?
    ORDER BY COALESCE(bco.sort_order, 999999) ASC, bi.sort_order ASC
  `, tripId);

    const itemIds = items.map(i => i.id);
    const membersByItem: Record<number, (BudgetItemMember & { avatar_url: string | null })[]> = {};

    if (itemIds.length > 0) {
      const allMembers = this.db.all<BudgetItemMember & { budget_item_id: number }>(`
      SELECT bm.budget_item_id, bm.user_id, bm.paid, bm.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
      FROM budget_item_members bm
      JOIN users u ON bm.user_id = u.id
      WHERE bm.budget_item_id IN (${itemIds.map(() => '?').join(',')})
    `, ...itemIds);

      for (const m of allMembers) {
        if (!membersByItem[m.budget_item_id]) membersByItem[m.budget_item_id] = [];
        membersByItem[m.budget_item_id].push({
          user_id: m.user_id, paid: m.paid, username: m.username, avatar_url: avatarUrl(m), amount: m.amount,
        });
      }
    }

    const payersByItem: Record<number, (BudgetItemPayer & { avatar_url: string | null })[]> = {};
    if (itemIds.length > 0) {
      const allPayers = this.db.all<BudgetItemPayer & { budget_item_id: number }>(`
      SELECT bp.budget_item_id, bp.user_id, bp.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
      FROM budget_item_payers bp
      JOIN users u ON bp.user_id = u.id
      WHERE bp.budget_item_id IN (${itemIds.map(() => '?').join(',')})
    `, ...itemIds);

      for (const p of allPayers) {
        if (!payersByItem[p.budget_item_id]) payersByItem[p.budget_item_id] = [];
        payersByItem[p.budget_item_id].push({
          user_id: p.user_id, amount: p.amount, username: p.username, avatar_url: avatarUrl(p),
        });
      }
    }

    items.forEach(item => {
      item.members = membersByItem[item.id] || [];
      item.payers = payersByItem[item.id] || [];
    });
    return items;
  }

  /**
   * Freeze the live FX rate at entry time into `exchange_rate` so a settled position
   * isn't re-opened when live rates drift later (#1335 / #1445). The stored rate is
   * "units of the item/display currency per 1 trip currency" — the settlement
   * converts with it via `amount / rate`.
   *
   * Only freezes for a foreign currency with no explicit rate; degrades to live
   * rates if the fetch fails. On update it (re)freezes only when the currency
   * changes (checked against `budget_items`), so an unrelated edit never moves
   * money. Callers must invoke this *before* the (synchronous) DB write — the raw
   * create/update stay sync because better-sqlite3 transactions can't await.
   */
  async freezeForeignRate(
    tripId: string | number,
    data: { currency?: string | null; exchange_rate?: number },
    existingItemId?: string | number,
    existingCurrency?: string | null,
  ): Promise<void> {
    if (data.exchange_rate != null) return; // an explicit rate from the caller wins
    const cur = (data.currency || '').toUpperCase();
    if (!cur) return; // currency not being set in this request
    // Skip the re-freeze when the currency isn't actually changing, so an unrelated
    // edit never moves money. Items resolve the prior currency from budget_items; a
    // settlement lives in a different table, so its caller passes it in directly.
    let prior: string | undefined;
    if (existingCurrency !== undefined) {
      prior = (existingCurrency || '').toUpperCase();
    } else if (existingItemId != null) {
      const existing = this.db.get<{ currency?: string }>('SELECT currency FROM budget_items WHERE id = ?', existingItemId);
      if (existing) prior = (existing.currency || '').toUpperCase();
    }
    if (prior !== undefined && prior === cur) return; // currency unchanged
    const trip = this.db.get<{ currency?: string }>('SELECT currency FROM trips WHERE id = ?', tripId);
    const tripCur = (trip?.currency || 'EUR').toUpperCase();
    if (cur === tripCur) return; // same as the trip currency → no conversion to freeze
    const rates = await this.exchangeRates.getRates(tripCur);
    const r = rates?.[cur];
    if (r && r > 0) data.exchange_rate = r;
  }

  /**
   * Re-anchor a trip's money when its base currency changes (#1543).
   *
   * Every frozen `exchange_rate` is "units of the row's currency per 1 *trip*
   * currency", and `currency = NULL` means "the trip's own currency" — both are
   * relative to the trip currency, so swapping it out from under them silently
   * corrupts the settlement: NULL rows redenominate (9 000 RUB becomes 9 000 EUR)
   * and frozen rates keep pointing at the old base, which is exactly the mismatch
   * that inflated #1543 by ~27x.
   *
   * So, before the switch: pin the implicit rows to the outgoing currency (their
   * amounts really were in it) and re-freeze every row against the incoming one.
   * No stored amount is rewritten — each expense keeps the figure the user typed,
   * in the currency they typed it in, and its real-world value is preserved.
   *
   * Place prices follow the same NULL = "the trip's own currency" convention (that
   * is how the PDF export and the place chips read them), so they are pinned too —
   * otherwise a €15 museum on a trip switched to JPY starts reading as ¥15. They
   * carry no frozen rate, so pinning the currency is all they need.
   *
   * Must run *before* the (synchronous) trip update, while the old currency is
   * still in `trips`, and is a no-op when the currency isn't actually changing.
   */
  async rebaseTripCurrency(
    tripId: string | number,
    newCurrency: string | null | undefined,
  ): Promise<void> {
    const next = (newCurrency || '').toUpperCase();
    if (!next) return;
    const trip = this.db.get<{ currency?: string }>('SELECT currency FROM trips WHERE id = ?', tripId);
    if (!trip) return;
    const prev = (trip.currency || 'EUR').toUpperCase();
    if (prev === next) return;

    const rates = await this.exchangeRates.getRates(next);
    // A row already denominated in the new base needs no conversion (rate 1). When no
    // live rate is available we also store 1 rather than a stale one: rate 1 means "not
    // frozen", so the settlement falls back to live rates instead of trusting a figure
    // anchored to a currency this trip no longer uses.
    const rateFor = (cur: string): number => {
      if (cur === next) return 1;
      const r = rates?.[cur];
      return r && r > 0 ? r : 1;
    };

    const rebase = (table: 'budget_items' | 'budget_settlements') => {
      this.db.run(`UPDATE ${table} SET currency = ? WHERE trip_id = ? AND (currency IS NULL OR currency = '')`, prev, tripId);
      const rows = this.db.all<{ cur: string }>(
        `SELECT DISTINCT currency AS cur FROM ${table} WHERE trip_id = ? AND currency IS NOT NULL`,
        tripId,
      );
      for (const { cur } of rows) {
        this.db.run(`UPDATE ${table} SET exchange_rate = ? WHERE trip_id = ? AND currency = ?`, rateFor(cur.toUpperCase()), tripId, cur);
      }
    };

    // Only priced places have anything to denominate; a currency on a free place would
    // just be noise. `updated_at` doubles as the optimistic-concurrency token (#1135),
    // so bumping it stops a client holding the pre-switch row from writing the pin away.
    const pinPlaces = () => {
      this.db.run(`
      UPDATE places SET currency = ?, updated_at = CURRENT_TIMESTAMP
      WHERE trip_id = ? AND price IS NOT NULL AND (currency IS NULL OR currency = '')
    `, prev, tripId);
    };

    this.db.transaction(() => { rebase('budget_items'); rebase('budget_settlements'); pinPlaces(); });
  }

  createBudgetItem(
    tripId: string | number,
    data: {
      category?: string; name: string; total_price?: number;
      currency?: string | null; exchange_rate?: number;
      payers?: { user_id: number; amount: number }[]; member_ids?: number[];
      members?: { user_id: number; amount?: number | null }[];
      persons?: number | null; days?: number | null; note?: string | null; expense_date?: string | null;
      ticket_json?: string | null;
      reservation_id?: number | null;
      place_id?: number | null;
    },
  ) {
    return this.db.transaction(() => {
      const maxOrder = this.db.get<{ max: number | null }>('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?', tripId)!;
      const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

      const cat = data.category || 'other';

      // Ensure category has a sort_order entry
      const catExists = this.db.get('SELECT 1 FROM budget_category_order WHERE trip_id = ? AND category = ?', tripId, cat);
      if (!catExists) {
        const maxCatOrder = this.db.get<{ max: number | null }>('SELECT MAX(sort_order) as max FROM budget_category_order WHERE trip_id = ?', tripId);
        const catOrder = (maxCatOrder?.max !== null && maxCatOrder?.max !== undefined ? maxCatOrder.max : -1) + 1;
        this.db.run('INSERT OR IGNORE INTO budget_category_order (trip_id, category, sort_order) VALUES (?, ?, ?)', tripId, cat, catOrder);
      }

      // total_price is derived from explicit payers when given; otherwise the caller
      // value (planning entries, or a bill no one has paid yet). Negative payer
      // amounts (a refund's recipient, #2176) count like any other.
      const payerTotal = sumMoney((data.payers || []).filter(p => p.amount !== 0).map(p => p.amount));
      const total = data.payers && data.payers.length > 0 ? payerTotal : (data.total_price || 0);

      const knownMembers = data.members ? this.rosterMemberIds(tripId, data.members.map(m => m.user_id)) : null;
      const members = data.members && knownMembers ? data.members.filter(m => knownMembers.has(m.user_id)) : undefined;
      const knownIds = data.member_ids ? this.rosterMemberIds(tripId, data.member_ids) : null;
      const memberIds = data.member_ids && knownIds ? data.member_ids.filter(uid => knownIds.has(uid)) : undefined;

      const { note, ticket } = splitLegacyTicketNote(data.note, data.ticket_json);

      const result = this.db.run(
        'INSERT INTO budget_items (trip_id, category, name, total_price, currency, exchange_rate, persons, days, note, ticket_json, sort_order, expense_date, reservation_id, place_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tripId,
        cat,
        data.name,
        total,
        data.currency || null,
        data.exchange_rate != null ? data.exchange_rate : 1,
        memberIds ? memberIds.length : (data.persons != null ? data.persons : null),
        data.days !== undefined && data.days !== null ? data.days : null,
        note || null,
        ticket || null,
        sortOrder,
        data.expense_date || null,
        data.reservation_id != null ? data.reservation_id : null,
        data.place_id != null ? data.place_id : null,
      );

      const itemId = result.lastInsertRowid as number;
      if (data.payers && data.payers.length > 0) this.writeItemPayers(itemId, tripId, data.payers);
      if (members && members.length > 0) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid, amount) VALUES (?, ?, 0, ?)');
        for (const m of members) insert.run(itemId, m.user_id, m.amount !== undefined && m.amount !== null ? m.amount : null);
      } else if (memberIds && memberIds.length > 0) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid, amount) VALUES (?, ?, 0, NULL)');
        for (const uid of memberIds) insert.run(itemId, uid);
      }

      const item = this.db.get<BudgetItem>('SELECT * FROM budget_items WHERE id = ?', itemId)!;
      item.members = this.loadItemMembers(itemId);
      item.payers = this.loadItemPayers(itemId);
      return item;
    });
  }

  /** Fetch a single budget item hydrated with its members and payers, scoped to the trip. */
  getBudgetItem(id: string | number, tripId: string | number): BudgetItem | null {
    const item = this.db.get<BudgetItem>('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId);
    if (!item) return null;
    item.members = this.loadItemMembers(id);
    item.payers = this.loadItemPayers(id);
    return item;
  }

  linkBudgetItemToReservation(
    tripId: string | number,
    reservationId: number,
    data: { name: string; category?: string; total_price: number },
  ) {
    // createBudgetItem accepts reservation_id directly — the legacy separate
    // UPDATE after the insert was redundant (and non-atomic).
    return this.createBudgetItem(tripId, { ...data, reservation_id: reservationId });
  }

  updateBudgetItem(
    id: string | number,
    tripId: string | number,
    data: {
      category?: string; name?: string; total_price?: number;
      currency?: string | null; exchange_rate?: number;
      payers?: { user_id: number; amount: number }[]; member_ids?: number[];
      members?: { user_id: number; amount?: number | null }[];
      persons?: number | null; days?: number | null; note?: string | null; sort_order?: number; expense_date?: string | null;
      ticket_json?: string | null;
    },
  ) {
    return this.db.transaction(() => {
      const item = this.db.get('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId);
      if (!item) return null;

      // An old client sending a receipt in `note` still lands in ticket_json, and
      // its note is left untouched rather than clobbered with the receipt blob.
      const { note, ticket } = splitLegacyTicketNote(data.note, data.ticket_json);
      const noteTouched = data.note !== undefined && note !== undefined;
      const ticketTouched = data.ticket_json !== undefined || ticket !== undefined;

      this.db.run(`
    UPDATE budget_items SET
      category = COALESCE(?, category),
      name = COALESCE(?, name),
      total_price = CASE WHEN ? IS NOT NULL THEN ? ELSE total_price END,
      currency = CASE WHEN ? THEN ? ELSE currency END,
      exchange_rate = CASE WHEN ? IS NOT NULL THEN ? ELSE exchange_rate END,
      persons = CASE WHEN ? IS NOT NULL THEN ? ELSE persons END,
      days = CASE WHEN ? THEN ? ELSE days END,
      note = CASE WHEN ? THEN ? ELSE note END,
      ticket_json = CASE WHEN ? THEN ? ELSE ticket_json END,
      sort_order = CASE WHEN ? IS NOT NULL THEN ? ELSE sort_order END,
      expense_date = CASE WHEN ? THEN ? ELSE expense_date END
    WHERE id = ?
  `,
        data.category || null,
        data.name || null,
        data.total_price !== undefined ? 1 : null, data.total_price !== undefined ? data.total_price : 0,
        data.currency !== undefined ? 1 : 0, data.currency !== undefined ? (data.currency || null) : null,
        data.exchange_rate !== undefined ? 1 : null, data.exchange_rate !== undefined ? data.exchange_rate : 1,
        data.persons !== undefined ? 1 : null, data.persons !== undefined ? data.persons : null,
        data.days !== undefined ? 1 : 0, data.days !== undefined ? data.days : null,
        noteTouched ? 1 : 0, noteTouched ? note : null,
        ticketTouched ? 1 : 0, ticketTouched ? ticket : null,
        data.sort_order !== undefined ? 1 : null, data.sort_order !== undefined ? data.sort_order : 0,
        data.expense_date !== undefined ? 1 : 0, data.expense_date !== undefined ? (data.expense_date || null) : null,
        id,
      );

      // Optional inline payer/member replacement (the edit modal saves all at once).
      if (data.payers !== undefined) {
        this.writeItemPayers(id, tripId, data.payers);
        // writeItemPayers derives total_price from the payer sum (0 for no payers).
        // A "recorded total, nobody assigned" expense clears payers but still carries
        // an explicit total_price — re-apply it so it isn't clobbered to 0.
        if (data.payers.length === 0 && data.total_price !== undefined) {
          this.db.run('UPDATE budget_items SET total_price = ? WHERE id = ?', data.total_price, id);
        }
      }
      if (data.members !== undefined) {
        const known = this.rosterMemberIds(tripId, data.members.map(m => m.user_id));
        const members = data.members.filter(m => known.has(m.user_id));
        this.db.run('DELETE FROM budget_item_members WHERE budget_item_id = ?', id);
        const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid, amount) VALUES (?, ?, 0, ?)');
        for (const m of members) insert.run(id, m.user_id, m.amount !== undefined && m.amount !== null ? m.amount : null);
        this.db.run('UPDATE budget_items SET persons = ? WHERE id = ?', members.length || null, id);
      } else if (data.member_ids !== undefined) {
        const known = this.rosterMemberIds(tripId, data.member_ids);
        const memberIds = data.member_ids.filter(uid => known.has(uid));
        this.db.run('DELETE FROM budget_item_members WHERE budget_item_id = ?', id);
        const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid, amount) VALUES (?, ?, 0, NULL)');
        for (const uid of memberIds) insert.run(id, uid);
        this.db.run('UPDATE budget_items SET persons = ? WHERE id = ?', memberIds.length || null, id);
      }

      // If category changed, update category order table
      if (data.category) {
        const catExists = this.db.get('SELECT 1 FROM budget_category_order WHERE trip_id = ? AND category = ?', tripId, data.category);
        if (!catExists) {
          const maxCatOrder = this.db.get<{ max: number | null }>('SELECT MAX(sort_order) as max FROM budget_category_order WHERE trip_id = ?', tripId);
          const catOrder = (maxCatOrder?.max !== null && maxCatOrder?.max !== undefined ? maxCatOrder.max : -1) + 1;
          this.db.run('INSERT OR IGNORE INTO budget_category_order (trip_id, category, sort_order) VALUES (?, ?, ?)', tripId, data.category, catOrder);
        }
      }

      const updated = this.db.get<BudgetItem>('SELECT * FROM budget_items WHERE id = ?', id)!;
      updated.members = this.loadItemMembers(id);
      updated.payers = this.loadItemPayers(id);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Payers
  // -------------------------------------------------------------------------

  setItemPayers(id: string | number, tripId: string | number, payers: { user_id: number; amount: number }[]) {
    return this.db.transaction(() => {
      const item = this.db.get('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId);
      if (!item) return null;
      this.writeItemPayers(id, tripId, payers);
      const updated = this.db.get<BudgetItem>('SELECT * FROM budget_items WHERE id = ?', id)!;
      updated.members = this.loadItemMembers(id);
      updated.payers = this.loadItemPayers(id);
      return updated;
    });
  }

  deleteBudgetItem(id: string | number, tripId: string | number): boolean {
    const item = this.db.get<{ id: number; reservation_id: number | null }>(
      'SELECT id, reservation_id FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId,
    );
    if (!item) return false;
    return this.db.transaction(() => {
      this.db.run('DELETE FROM budget_items WHERE id = ?', id);
      // The booking keeps a copy of this expense's total in its metadata, and
      // the reservation update path preserves that copy across edits. With the
      // expense gone there is nothing left to mirror, so drop it here rather
      // than leave a price on the card that no longer has anything behind it.
      if (item.reservation_id) this.clearReservationPrice(tripId, item.reservation_id);
      return true;
    });
  }

  /**
   * The counterpart to syncReservationPrice: take the mirrored total back off
   * the booking. Non-fatal, exactly like the writer.
   */
  private clearReservationPrice(tripId: string | number, reservationId: number): void {
    try {
      const reservation = this.db.get<{ id: number; metadata: string | null }>(
        'SELECT id, metadata FROM reservations WHERE id = ? AND trip_id = ?',
        reservationId, tripId,
      );
      if (!reservation?.metadata) return;
      const meta = JSON.parse(reservation.metadata);
      if (!meta || typeof meta !== 'object' || meta.price === undefined) return;
      delete meta.price;
      delete meta.priceCurrency;
      this.db.run('UPDATE reservations SET metadata = ? WHERE id = ?', JSON.stringify(meta), reservation.id);
      const updatedRes = this.db.get('SELECT * FROM reservations WHERE id = ?', reservation.id);
      this.realtime.broadcast(String(tripId), 'reservation:updated', { reservation: updatedRes }, undefined);
    } catch (err) {
      console.error('[budget] Failed to clear the mirrored price from the reservation:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  updateMembers(id: string | number, tripId: string | number, userIds: number[]) {
    return this.db.transaction(() => {
      const item = this.db.get('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId);
      if (!item) return null;

      const existingPaid: Record<number, number> = {};
      const existing = this.db.all<{ user_id: number; paid: number }>('SELECT user_id, paid FROM budget_item_members WHERE budget_item_id = ?', id);
      for (const e of existing) existingPaid[e.user_id] = e.paid;

      this.db.run('DELETE FROM budget_item_members WHERE budget_item_id = ?', id);

      const known = this.rosterMemberIds(tripId, userIds);
      const memberIds = userIds.filter(uid => known.has(uid));
      if (memberIds.length > 0) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, ?)');
        for (const userId of memberIds) insert.run(id, userId, existingPaid[userId] || 0);
        this.db.run('UPDATE budget_items SET persons = ? WHERE id = ?', memberIds.length, id);
      } else {
        this.db.run('UPDATE budget_items SET persons = NULL WHERE id = ?', id);
      }

      // loadItemMembers already applies avatar_url — the legacy second .map was redundant.
      const members = this.loadItemMembers(id);
      const updated = this.db.get<BudgetItem>('SELECT * FROM budget_items WHERE id = ?', id)!;
      return { members, item: updated };
    });
  }

  removeUserFromBudgetItems(userId: number): void {
    this.db.transaction(() => {
      const itemIds = this.db.all<{ budget_item_id: number }>(
        'SELECT DISTINCT budget_item_id FROM budget_item_members WHERE user_id = ?',
        userId,
      ).map(r => r.budget_item_id);
      if (itemIds.length === 0) {
        return;
      }

      this.db.run('DELETE FROM budget_item_members WHERE user_id = ?', userId);

      const remaining = this.db.prepare('SELECT COUNT(*) AS count FROM budget_item_members WHERE budget_item_id = ?');
      const setPersons = this.db.prepare('UPDATE budget_items SET persons = ? WHERE id = ?');
      for (const itemId of itemIds) {
        const { count } = remaining.get(itemId) as { count: number };
        setPersons.run(count || null, itemId);
      }
    });
  }

  toggleMemberPaid(id: string | number, tripId: string | number, userId: string | number, paid: boolean) {
    // Resolve the item within the caller's trip before updating.
    const item = this.db.get('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?', id, tripId);
    if (!item) return null;

    this.db.run('UPDATE budget_item_members SET paid = ? WHERE budget_item_id = ? AND user_id = ?', paid ? 1 : 0, id, userId);

    const member = this.db.get<BudgetItemMember>(`
    SELECT bm.user_id, bm.paid, COALESCE(u.display_name, u.username) AS username, u.avatar
    FROM budget_item_members bm JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ? AND bm.user_id = ?
  `, id, userId);

    return member ? { ...member, avatar_url: avatarUrl(member) } : null;
  }

  // -------------------------------------------------------------------------
  // Per-person summary
  // -------------------------------------------------------------------------

  getPerPersonSummary(tripId: string | number) {
    const summary = this.db.all<{ user_id: number; username: string; avatar: string | null; total_assigned: number; total_paid: number; items_count: number }>(`
    SELECT bm.user_id, COALESCE(u.display_name, u.username) AS username, u.avatar,
      SUM(COALESCE(bm.amount, bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id))) as total_assigned,
      SUM(CASE WHEN bm.paid = 1 THEN COALESCE(bm.amount, bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id)) ELSE 0 END) as total_paid,
      COUNT(bi.id) as items_count
    FROM budget_item_members bm
    JOIN budget_items bi ON bm.budget_item_id = bi.id
    JOIN users u ON bm.user_id = u.id
    WHERE bi.trip_id = ?
    GROUP BY bm.user_id
  `, tripId);

    return summary.map(s => ({ ...s, avatar_url: avatarUrl(s) }));
  }

  /**
   * Largest-remainder split of an expense across its participants. Takes and
   * returns **whole cents**, so the shares add back up to the input exactly —
   * the settlement ledger is netted in integer cents (#1382).
   *
   * The remainder cent rotates with the item id rather than always landing on the
   * first member, so across several expenses the rounding evens out instead of
   * always favouring the same person.
   *
   * Floor-based (`totalCents - baseCents * n`, never `%`), so a negative total —
   * a refund split across its beneficiaries (#2176) — still yields a remainder
   * in [0, n) and shares that sum back to the total exactly. The client mirror
   * (CostsPanel.helpers.splitEqualShares) must stay share-for-share identical;
   * the parity fixture in budget.service.calc.test.ts pins both sides.
   */
  private splitEqualShares(totalCents: number, members: { user_id: number }[], itemId: number): Record<number, number> {
    const n = members.length;
    if (n === 0) return {};

    const baseCents = Math.floor(totalCents / n);
    const remainder = totalCents - baseCents * n;

    const shares: Record<number, number> = {};
    const sortedMembers = [...members].sort((a, b) => a.user_id - b.user_id);
    const startIndex = itemId % n;

    for (let i = 0; i < n; i++) {
      const member = sortedMembers[i];
      const hasExtraCent = ((i - startIndex + n) % n) < remainder;
      shares[member.user_id] = baseCents + (hasExtraCent ? 1 : 0);
    }

    return shares;
  }

  calculateSettlement(
    tripId: string | number,
    opts: { base?: string; rates?: Record<string, number> | null; tripCurrency?: string } = {},
  ) {
    const base = (opts.base || opts.tripCurrency || 'EUR').toUpperCase();
    const tripCurrency = (opts.tripCurrency || base).toUpperCase();
    const rates = opts.rates ?? null;
    // Net the whole settlement in the trip's canonical currency and convert the final
    // totals to the display currency once, instead of netting in the (moving) display
    // currency. Otherwise per-expense rounding shifts as live FX drifts and the greedy
    // debt-simplifier reshuffles it into phantom third-party micro-flows (#1382). When
    // the display currency IS the trip currency (the common case) every conversion below
    // is the identity, so behaviour is unchanged.
    // rates[X] = units of X per 1 base; the frozen exchange_rate is units of item-currency
    // per 1 trip-currency. Pre-rework rows store currency = NULL = "the trip's own currency".
    const toTrip = (amount: number, itemCurrency: string | null | undefined, itemRate?: number | null): number => {
      const cur = (itemCurrency || tripCurrency).toUpperCase();
      if (cur === tripCurrency) return amount;
      // Prefer the FX rate frozen at entry time (#1335): a settled expense keeps the rate
      // it was booked at, so a later live-rate drift doesn't re-open it with a residual.
      if (itemRate != null && itemRate > 0 && itemRate !== 1) return amount / itemRate;
      // Legacy rows without a frozen rate: convert via base with live rates.
      if (!rates) return amount;
      const rCur = rates[cur];
      const rTrip = rates[tripCurrency];
      if (rCur && rCur > 0 && rTrip && rTrip > 0) return (amount / rCur) * rTrip;
      return amount;
    };
    // trip-currency → display currency, applied once to the final netted totals.
    // Held as a plain factor so it is exactly linear: the balances are converted as
    // one set (allocateDisplayCents) rather than one at a time, which is what keeps
    // them adding up to zero in whatever currency the viewer picked (#1382).
    const displayFactor = base === tripCurrency
      ? 1
      : (rates && rates[tripCurrency] > 0 ? 1 / rates[tripCurrency] : 1);
    // A recorded settle-up amount is entered in whatever display currency the payer
    // was viewing. New rows capture that currency and the rate frozen at settle time
    // (#1445), so a settled position stays balanced when live rates drift — mirroring
    // toTrip for expenses. Legacy rows (currency = NULL) have no frozen rate, so fall
    // back to the old behaviour: assume they were entered in the current display base
    // and convert with live rates.
    const settleToTrip = (amount: number, sCurrency?: string | null, sRate?: number | null): number => {
      if (sCurrency) {
        const cur = sCurrency.toUpperCase();
        if (cur === tripCurrency) return amount;
        if (sRate != null && sRate > 0 && sRate !== 1) return amount / sRate;
        // Frozen currency but no usable rate (fetch failed at settle time): live fallback.
        if (rates) {
          const rCur = rates[cur];
          const rTrip = rates[tripCurrency];
          if (rCur && rCur > 0 && rTrip && rTrip > 0) return (amount / rCur) * rTrip;
        }
        return amount;
      }
      return base === tripCurrency ? amount : (rates && rates[tripCurrency] > 0 ? amount * rates[tripCurrency] : amount);
    };

    const items = this.db.all<BudgetItem>('SELECT * FROM budget_items WHERE trip_id = ?', tripId);
    const allMembers = this.db.all<BudgetItemMember & { budget_item_id: number }>(`
    SELECT bm.budget_item_id, bm.user_id, bm.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ?)
  `, tripId);
    const allPayers = this.db.all<BudgetItemPayer & { budget_item_id: number }>(`
    SELECT bp.budget_item_id, bp.user_id, bp.amount, COALESCE(u.display_name, u.username) AS username, u.avatar
    FROM budget_item_payers bp
    JOIN users u ON bp.user_id = u.id
    WHERE bp.budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ?)
  `, tripId);

    // Net balance per user, in whole cents of the TRIP currency: positive = is owed
    // money, negative = owes money. Every amount is converted out of its own currency
    // and rounded to a cent once, at the boundary — from there on the ledger is
    // integer arithmetic, so Σ(balances) is exactly 0 and no sub-cent residual can
    // build up behind the two-decimal figures the user sees (#1382).
    const toTripCents = (amount: number, itemCurrency: string | null | undefined, itemRate?: number | null): number =>
      Math.round(toTrip(amount, itemCurrency, itemRate) * 100);
    const balances: Record<number, { user_id: number; username: string; avatar_url: string | null; cents: number }> = {};
    const ensure = (id: number, src: { username?: string; avatar?: string | null }) => {
      if (!balances[id]) balances[id] = { user_id: id, username: src.username || '', avatar_url: avatarUrl(src), cents: 0 };
      return balances[id];
    };

    for (const item of items) {
      const members = allMembers.filter(m => m.budget_item_id === item.id);
      const payers = allPayers.filter(p => p.budget_item_id === item.id);
      if (members.length === 0) continue; // planning-only entry → doesn't affect balances

      // An expense nobody has paid stays out of the ledger (#2225), which is what
      // both cost panels already promise by flagging the row "Unfinished" (the
      // hint beside it reads: total only, not settled yet) and counting it into
      // the Outstanding card instead (CostsPanel/costsModel.isUnfinished). The
      // panels additionally require a non-zero total to paint that label; the
      // ledger deliberately does not, or PUT /budget/:id/payers with an empty
      // array (which zeroes total_price and does not re-apply it) would leave a
      // custom split debiting its members against no credit at all.
      // Charging its split members regardless, as #1382/#2176/#1543 left in
      // place below, debits a share with no credit behind it: Σ(balances) drifts
      // off zero by the unpaid total, and the greedy simplifier at the end of this
      // method has no memory of which expense made which debt, so it pairs the
      // inflated debtor with a creditor from some unrelated expense and offers a
      // payment between two people who never shared a bill. Booking every flow it
      // offered then left someone short: "everyone square" beside a balance that
      // is not zero.
      if (!payers.some(p => p.amount !== 0)) continue;

      // Payers are credited what they actually paid (converted to trip currency with
      // the item's stored exchange rate). A negative payer — the recipient of a
      // refund (#2176) — is debited by the same arithmetic: their credit is negative.
      let creditCents = 0;
      for (const p of payers) {
        const paid = toTripCents(p.amount, item.currency, item.exchange_rate);
        ensure(p.user_id, p).cents += paid;
        creditCents += paid;
      }
      // …and each split participant owes their share — a custom per-member amount
      // when one is set, otherwise an equal share of the expense.
      //
      // The equal split divides what the payers were actually credited, not
      // total_price: the two are the same figure (the write path derives the total
      // from the payer sum), but converting the total separately would round to a
      // different cent on a foreign-currency expense and leave the item off by one.
      // Negative credits (a refund, #2176) divide the same way. Nothing falls back
      // to total_price any more: an item with no payer behind it never reaches
      // here since #2225. An item whose payers net to exactly zero still does, and
      // divides zero, which is what it is worth.
      const hasCustomSplit = members.some(m => m.amount !== null && m.amount !== undefined);
      const equalShares = !hasCustomSplit ? this.splitEqualShares(creditCents, members, item.id) : {};
      for (const m of members) {
        const memberShare = hasCustomSplit && m.amount !== null && m.amount !== undefined
          ? toTripCents(m.amount, item.currency, item.exchange_rate)
          : (equalShares[m.user_id] || 0);
        ensure(m.user_id, m).cents -= memberShare;
      }
    }

    // Persisted settle-up transfers already moved money: the payer's debt shrinks,
    // the receiver's credit shrinks, so the corresponding flow disappears. A transfer
    // counts even when neither user has an expense-derived balance yet — a manual
    // payment, or one left behind after its expense was deleted, then correctly
    // surfaces as an amount still to square up instead of silently vanishing.
    const settlements = this.listSettlements(tripId);
    const ensureSettled = (id: number, username: string | undefined, avatar_url: string | null | undefined) => {
      if (!balances[id]) balances[id] = { user_id: id, username: username || '', avatar_url: avatar_url ?? null, cents: 0 };
      return balances[id];
    };
    for (const s of settlements) {
      // Rounded to a trip cent per transfer, so recording one in a display currency
      // can't leave a sliver of a cent behind to accumulate over a trip's lifetime.
      const inTrip = Math.round(settleToTrip(s.amount, s.currency, s.exchange_rate) * 100);
      ensureSettled(s.from_user_id, s.from_username, s.from_avatar_url).cents += inTrip;
      ensureSettled(s.to_user_id, s.to_username, s.to_avatar_url).cents -= inTrip;
    }

    // Into the display currency as one set, then simplify — balances and flows are
    // derived from the same integers, so what the balances say is owed is exactly
    // what "Settle up" offers to move, down to the last cent (#1382).
    const ledger = Object.values(balances);
    const displayCents = allocateDisplayCents(ledger.map(b => b.cents), displayFactor);

    // Calculate optimized payment flows (greedy algorithm)
    const people = ledger
      .map((b, i) => ({ user_id: b.user_id, username: b.username, avatar_url: b.avatar_url, cents: displayCents[i] }))
      .filter(b => b.cents !== 0);
    const debtors = people.filter(p => p.cents < 0).map(p => ({ ...p, amount: -p.cents }));
    const creditors = people.filter(p => p.cents > 0).map(p => ({ ...p, amount: p.cents }));

    // Sort by amount descending for efficient matching
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    const flows: { from: { user_id: number; username: string; avatar_url: string | null }; to: { user_id: number; username: string; avatar_url: string | null }; amount: number }[] = [];

    let di = 0, ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const transfer = Math.min(debtors[di].amount, creditors[ci].amount);
      flows.push({
        from: { user_id: debtors[di].user_id, username: debtors[di].username, avatar_url: debtors[di].avatar_url },
        to: { user_id: creditors[ci].user_id, username: creditors[ci].username, avatar_url: creditors[ci].avatar_url },
        amount: transfer / 100,
      });
      debtors[di].amount -= transfer;
      creditors[ci].amount -= transfer;
      if (debtors[di].amount === 0) di++;
      if (creditors[ci].amount === 0) ci++;
    }

    return {
      balances: ledger.map((b, i) => ({
        user_id: b.user_id, username: b.username, avatar_url: b.avatar_url,
        balance: displayCents[i] / 100,
      })),
      flows,
      settlements,
    };
  }

  // -------------------------------------------------------------------------
  // Settlements (persisted settle-up transfers — history + undo)
  // -------------------------------------------------------------------------

  // Settlement usernames use COALESCE(display_name, username) like every item
  // query (the legacy raw fu.username was the odd one out).
  private static readonly SETTLEMENT_SELECT = `
    SELECT s.id, s.trip_id, s.from_user_id, s.to_user_id, s.amount, s.currency, s.exchange_rate, s.created_at, s.created_by_user_id,
           COALESCE(fu.display_name, fu.username) AS from_username, fu.avatar AS from_avatar,
           COALESCE(tu.display_name, tu.username) AS to_username,   tu.avatar AS to_avatar
    FROM budget_settlements s
    JOIN users fu ON s.from_user_id = fu.id
    JOIN users tu ON s.to_user_id = tu.id
  `;

  private mapSettlementRow(r: SettlementRow) {
    return {
      id: r.id, trip_id: r.trip_id,
      from_user_id: r.from_user_id, to_user_id: r.to_user_id,
      amount: r.amount, currency: r.currency ?? null, exchange_rate: r.exchange_rate ?? 1,
      created_at: r.created_at, created_by_user_id: r.created_by_user_id,
      from_username: r.from_username, from_avatar_url: avatarUrl({ avatar: r.from_avatar }),
      to_username: r.to_username, to_avatar_url: avatarUrl({ avatar: r.to_avatar }),
    };
  }

  listSettlements(tripId: string | number) {
    const rows = this.db.all<SettlementRow>(
      `${BudgetService.SETTLEMENT_SELECT}
    WHERE s.trip_id = ?
    ORDER BY s.created_at DESC, s.id DESC
  `, tripId);
    return rows.map(r => this.mapSettlementRow(r));
  }

  /** Targeted single-row read (the legacy re-select was a full listSettlements scan). */
  getSettlement(id: string | number, tripId: string | number) {
    const row = this.db.get<SettlementRow>(
      `${BudgetService.SETTLEMENT_SELECT}
    WHERE s.trip_id = ? AND s.id = ?
  `, tripId, id);
    return row ? this.mapSettlementRow(row) : null;
  }

  /** Raw settlement insert (no FX freeze) — the REST path wraps it in createSettlement. */
  insertSettlement(
    tripId: string | number,
    data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null; exchange_rate?: number },
    createdByUserId?: number,
  ) {
    const result = this.db.run(
      'INSERT INTO budget_settlements (trip_id, from_user_id, to_user_id, amount, currency, exchange_rate, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      tripId, data.from_user_id, data.to_user_id, Math.round(data.amount * 100) / 100,
      data.currency ? data.currency.toUpperCase() : null,
      data.exchange_rate != null ? data.exchange_rate : 1,
      createdByUserId ?? null,
    );
    return this.getSettlement(Number(result.lastInsertRowid), tripId);
  }

  /** Raw settlement update (no FX freeze) — the REST path wraps it in updateSettlement. */
  applySettlementUpdate(
    id: string | number,
    tripId: string | number,
    data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null; exchange_rate?: number },
  ) {
    const row = this.db.get('SELECT id FROM budget_settlements WHERE id = ? AND trip_id = ?', id, tripId);
    if (!row) return null;
    this.db.run(`
    UPDATE budget_settlements SET
      from_user_id = ?, to_user_id = ?, amount = ?,
      currency = CASE WHEN ? THEN ? ELSE currency END,
      exchange_rate = CASE WHEN ? IS NOT NULL THEN ? ELSE exchange_rate END
    WHERE id = ?
  `,
      data.from_user_id, data.to_user_id, Math.round(data.amount * 100) / 100,
      data.currency !== undefined ? 1 : 0, data.currency ? data.currency.toUpperCase() : null,
      data.exchange_rate !== undefined ? 1 : null, data.exchange_rate !== undefined ? data.exchange_rate : 1,
      id,
    );
    return this.getSettlement(id, tripId);
  }

  deleteSettlement(id: string | number, tripId: string | number): boolean {
    const row = this.db.get('SELECT id FROM budget_settlements WHERE id = ? AND trip_id = ?', id, tripId);
    if (!row) return false;
    this.db.run('DELETE FROM budget_settlements WHERE id = ?', id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Controller-facing surface (unchanged from the pre-fold wrapper)
  // -------------------------------------------------------------------------

  list(tripId: string) {
    return this.listBudgetItems(tripId);
  }

  perPersonSummary(tripId: string) {
    return this.getPerPersonSummary(tripId);
  }

  async settlement(tripId: string, base: string | undefined, tripCurrency: string) {
    const effectiveBase = (base || tripCurrency || 'EUR').toUpperCase();
    const rates = await this.exchangeRates.getRates(effectiveBase);
    return this.calculateSettlement(tripId, { base: effectiveBase, rates, tripCurrency });
  }

  async create(tripId: string, data: Parameters<BudgetService['createBudgetItem']>[1]) {
    await this.freezeForeignRate(tripId, data);
    return this.createBudgetItem(tripId, data);
  }

  async update(id: string | number, tripId: string | number, data: Parameters<BudgetService['updateBudgetItem']>[2]) {
    await this.freezeForeignRate(tripId, data, id);
    return this.updateBudgetItem(id, tripId, data);
  }

  remove(id: string, tripId: string): boolean {
    return this.deleteBudgetItem(id, tripId);
  }

  setPayers(id: string, tripId: string, payers: { user_id: number; amount: number }[]) {
    return this.setItemPayers(id, tripId, payers);
  }

  /**
   * Unlike a split member, a settlement cannot drop an off-roster id: it has
   * exactly two named parties and both columns are NOT NULL, so a stranger in
   * either slot makes the row meaningless rather than merely wider. Refuse the
   * whole write. Returning null lands on the caller's existing "Settlement not
   * found" 404, which is also what keeps the endpoint from confirming whether
   * an id it rejected exists at all.
   */
  private settlementPartiesOnTrip(tripId: string | number, data: { from_user_id: number; to_user_id: number }): boolean {
    const roster = this.db.rosterUserIds(tripId);
    return roster.has(data.from_user_id) && roster.has(data.to_user_id);
  }

  async createSettlement(tripId: string | number, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null }, userId: number) {
    if (!this.settlementPartiesOnTrip(tripId, data)) return null;
    // Freeze the FX rate for the display currency the amount was entered in so the
    // transfer keeps cancelling its expense when live rates drift (#1445).
    await this.freezeForeignRate(tripId, data);
    return this.insertSettlement(tripId, data, userId);
  }

  async updateSettlement(id: string | number, tripId: string | number, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null }) {
    // Pass the settlement's stored currency so an edit that doesn't change it keeps
    // the already-frozen rate (#1445) — otherwise a live-rate drift would re-open a
    // settled position on an unrelated edit.
    if (!this.settlementPartiesOnTrip(tripId, data)) return null;
    const existing = this.getSettlement(id, tripId);
    await this.freezeForeignRate(tripId, data, undefined, existing?.currency ?? null);
    return this.applySettlementUpdate(id, tripId, data);
  }

  reorderItems(tripId: string, orderedIds: number[]): void {
    const update = this.db.prepare('UPDATE budget_items SET sort_order = ? WHERE id = ? AND trip_id = ?');
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index, id, tripId));
    });
  }

  reorderCategories(tripId: string, orderedCategories: string[]): void {
    const upsert = this.db.prepare(
      'INSERT INTO budget_category_order (trip_id, category, sort_order) VALUES (?, ?, ?) ON CONFLICT(trip_id, category) DO UPDATE SET sort_order = excluded.sort_order'
    );
    this.db.transaction(() => {
      orderedCategories.forEach((cat, index) => upsert.run(tripId, cat, index));
    });
  }

  /**
   * Mirrors the legacy PUT /:id side effect: when a price-linked budget item's
   * total_price changes, write it into the reservation's metadata and broadcast
   * reservation:updated. Non-fatal — a failure here never breaks the budget update.
   */
  syncReservationPrice(tripId: string, reservationId: number, totalPrice: number, socketId: string | undefined): void {
    try {
      const reservation = this.db.get<{ id: number; metadata: string | null }>(
        'SELECT id, metadata FROM reservations WHERE id = ? AND trip_id = ?',
        reservationId, tripId,
      );
      if (!reservation) return;
      const meta = reservation.metadata ? JSON.parse(reservation.metadata) : {};
      // Cent-clean, so a booking never inherits float noise from the expense
      // it is linked to — and so a row stamped before #1964 heals on the next
      // edit. The panels print this string as it stands.
      meta.price = String(Math.round(totalPrice * 100) / 100);
      this.db.run('UPDATE reservations SET metadata = ? WHERE id = ?', JSON.stringify(meta), reservation.id);
      const updatedRes = this.db.get('SELECT * FROM reservations WHERE id = ?', reservation.id);
      this.realtime.broadcast(tripId, 'reservation:updated', { reservation: updatedRes }, socketId);
    } catch (err) {
      console.error('[budget] Failed to sync price to reservation:', err);
    }
  }
}
