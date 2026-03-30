import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';

const router = express.Router({ mergeParams: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

interface TripMemberRow { id: number; username: string; avatar: string | null }

function getTripMembers(tripId: string | number): TripMemberRow[] {
  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(tripId) as { user_id: number } | undefined;
  if (!trip) return [];
  const owner = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(trip.user_id) as TripMemberRow | undefined;
  const members = db.prepare(`
    SELECT u.id, u.username, u.avatar
    FROM trip_members tm JOIN users u ON tm.user_id = u.id
    WHERE tm.trip_id = ?
  `).all(tripId) as TripMemberRow[];
  const all = owner ? [owner, ...members] : members;
  const seen = new Set<number>();
  return all.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
}

interface ShareRow { user_id: number; share_value: number | null; username: string; avatar: string | null }

function loadExpenseShares(expenseId: number | string): ShareRow[] {
  return db.prepare(`
    SELECT ks.user_id, ks.share_value, u.username, u.avatar
    FROM kosten_shares ks JOIN users u ON ks.user_id = u.id
    WHERE ks.expense_id = ?
  `).all(expenseId) as ShareRow[];
}

function loadFullExpense(id: number | string) {
  const expense = db.prepare(`
    SELECT ke.*, COALESCE(ke.paid_by_name, u.username) as paid_by_username, u.avatar as paid_by_avatar
    FROM kosten_expenses ke LEFT JOIN users u ON ke.paid_by = u.id
    WHERE ke.id = ?
  `).get(id) as any;
  if (!expense) return undefined;
  expense.shares = loadExpenseShares(expense.id).map((s: ShareRow) => ({ ...s, avatar_url: avatarUrl(s) }));
  expense.paid_by_avatar_url = avatarUrl({ avatar: expense.paid_by_avatar });
  return expense;
}

// ── GET / — list all expenses ────────────────────────────────────────────────
router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const expenses = db.prepare(`
    SELECT ke.*, COALESCE(ke.paid_by_name, u.username) as paid_by_username, u.avatar as paid_by_avatar
    FROM kosten_expenses ke LEFT JOIN users u ON ke.paid_by = u.id
    WHERE ke.trip_id = ?
    ORDER BY CASE WHEN ke.expense_date IS NULL THEN 1 ELSE 0 END, ke.expense_date DESC, ke.created_at DESC
  `).all(tripId) as any[];

  const expenseIds = expenses.map((e: any) => e.id);
  if (expenseIds.length > 0) {
    const allShares = db.prepare(`
      SELECT ks.expense_id, ks.user_id, ks.share_value, u.username, u.avatar
      FROM kosten_shares ks JOIN users u ON ks.user_id = u.id
      WHERE ks.expense_id IN (${expenseIds.map(() => '?').join(',')})
    `).all(...expenseIds) as (ShareRow & { expense_id: number })[];

    const sharesByExpense: Record<number, any[]> = {};
    for (const s of allShares) {
      if (!sharesByExpense[s.expense_id]) sharesByExpense[s.expense_id] = [];
      sharesByExpense[s.expense_id].push({ ...s, avatar_url: avatarUrl(s) });
    }
    expenses.forEach((e: any) => {
      e.shares = sharesByExpense[e.id] || [];
      e.paid_by_avatar_url = avatarUrl({ avatar: e.paid_by_avatar });
    });
  } else {
    expenses.forEach((e: any) => { e.shares = []; e.paid_by_avatar_url = null; });
  }
  res.json({ expenses });
});

// ── POST / — create expense ──────────────────────────────────────────────────
router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const { title, amount, currency, exchange_rate = 1, paid_by, paid_by_name, category = 'Sonstiges', expense_date, note, split_type = 'equal', participant_ids } = req.body;
  if (!title || amount === undefined || amount === null || (!paid_by && !paid_by_name)) {
    return res.status(400).json({ error: 'title, amount and (paid_by or paid_by_name) are required' });
  }

  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const tripCurrency = trip?.currency || 'EUR';

  const result = db.prepare(`
    INSERT INTO kosten_expenses (trip_id, title, amount, currency, exchange_rate, paid_by, paid_by_name, category, expense_date, note, split_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, title, Number(amount), currency || tripCurrency, Number(exchange_rate), paid_by ? Number(paid_by) : null, paid_by_name || null, category, expense_date || null, note || null, split_type);

  const expenseId = result.lastInsertRowid as number;

  // Participants: use provided list or all trip members
  let participants: number[];
  if (participant_ids && Array.isArray(participant_ids) && participant_ids.length > 0) {
    participants = participant_ids.map(Number);
  } else {
    participants = getTripMembers(tripId).map(m => m.id);
  }

  const insertShare = db.prepare('INSERT OR IGNORE INTO kosten_shares (expense_id, user_id, share_value) VALUES (?, ?, ?)');
  for (const uid of participants) {
    insertShare.run(expenseId, uid, null);
  }

  const expense = loadFullExpense(expenseId);
  broadcast(Number(tripId), 'kosten:created', { expense }, req.headers['x-socket-id'] as string);
  res.status(201).json({ expense });
});

// ── PUT /:id — update expense ────────────────────────────────────────────────
router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT id FROM kosten_expenses WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const numberFields = new Set(['amount', 'exchange_rate', 'paid_by']);
  const nullableFields = new Set(['expense_date', 'note', 'paid_by', 'paid_by_name']);
  const allowed = ['title', 'amount', 'currency', 'exchange_rate', 'paid_by', 'paid_by_name', 'category', 'expense_date', 'note', 'split_type'] as const;

  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      const val = req.body[key];
      if (numberFields.has(key)) values.push(val === null ? null : Number(val));
      else if (nullableFields.has(key)) values.push(val || null);
      else values.push(val);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  db.prepare(`UPDATE kosten_expenses SET ${fields.join(', ')} WHERE id = ? AND trip_id = ?`).run(...values, id, tripId);
  const expense = loadFullExpense(Number(id));
  broadcast(Number(tripId), 'kosten:updated', { expense }, req.headers['x-socket-id'] as string);
  res.json({ expense });
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT id FROM kosten_expenses WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  db.prepare('DELETE FROM kosten_expenses WHERE id = ? AND trip_id = ?').run(id, tripId);
  broadcast(Number(tripId), 'kosten:deleted', { id: Number(id) }, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ── PUT /:id/shares — update participants + share values ─────────────────────
router.put('/:id/shares', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT id FROM kosten_expenses WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const { shares } = req.body;
  if (!Array.isArray(shares)) return res.status(400).json({ error: 'shares must be an array' });

  db.prepare('DELETE FROM kosten_shares WHERE expense_id = ?').run(id);
  const insertShare = db.prepare('INSERT INTO kosten_shares (expense_id, user_id, share_value) VALUES (?, ?, ?)');
  for (const s of shares) {
    if (!s.user_id) continue;
    insertShare.run(id, Number(s.user_id), s.share_value != null ? Number(s.share_value) : null);
  }

  const expense = loadFullExpense(Number(id));
  broadcast(Number(tripId), 'kosten:updated', { expense }, req.headers['x-socket-id'] as string);
  res.json({ expense });
});

// ── GET /balances — compute net balances + simplified debts ──────────────────
router.get('/balances', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const expenses = db.prepare(`
    SELECT id, amount, exchange_rate, paid_by, split_type
    FROM kosten_expenses WHERE trip_id = ? AND paid_by IS NOT NULL
  `).all(tripId) as { id: number; amount: number; exchange_rate: number; paid_by: number; split_type: string }[];

  const allShareRows = db.prepare(`
    SELECT ks.expense_id, ks.user_id, ks.share_value
    FROM kosten_shares ks JOIN kosten_expenses ke ON ks.expense_id = ke.id
    WHERE ke.trip_id = ?
  `).all(tripId) as { expense_id: number; user_id: number; share_value: number | null }[];

  const sharesByExpense: Record<number, { user_id: number; share_value: number | null }[]> = {};
  for (const s of allShareRows) {
    if (!sharesByExpense[s.expense_id]) sharesByExpense[s.expense_id] = [];
    sharesByExpense[s.expense_id].push(s);
  }

  const settlements = db.prepare(`
    SELECT from_user_id, to_user_id, amount, exchange_rate
    FROM kosten_settlements WHERE trip_id = ?
  `).all(tripId) as { from_user_id: number; to_user_id: number; amount: number; exchange_rate: number }[];

  // Compute net balances in trip base currency
  const balances: Record<number, number> = {};

  for (const expense of expenses) {
    const amtInTripCurrency = expense.amount * (expense.exchange_rate || 1);
    const shares = sharesByExpense[expense.id] || [];
    const n = shares.length;
    if (n === 0) continue;

    // Credit the payer
    balances[expense.paid_by] = (balances[expense.paid_by] || 0) + amtInTripCurrency;

    // Debit each participant
    for (const share of shares) {
      let owe = 0;
      if (expense.split_type === 'equal') {
        owe = amtInTripCurrency / n;
      } else if (expense.split_type === 'unequal_amount') {
        owe = (share.share_value || 0) * (expense.exchange_rate || 1);
      } else if (expense.split_type === 'unequal_percent') {
        owe = amtInTripCurrency * (share.share_value || 0) / 100;
      }
      balances[share.user_id] = (balances[share.user_id] || 0) - owe;
    }
  }

  // Apply settlements
  for (const s of settlements) {
    const amt = s.amount * (s.exchange_rate || 1);
    balances[s.from_user_id] = (balances[s.from_user_id] || 0) - amt;
    balances[s.to_user_id] = (balances[s.to_user_id] || 0) + amt;
  }

  // Fetch user info for all relevant users
  const allUserIds = [...new Set(Object.keys(balances).map(Number))];
  const usersMap: Record<number, { username: string; avatar: string | null }> = {};
  if (allUserIds.length > 0) {
    const users = db.prepare(
      `SELECT id, username, avatar FROM users WHERE id IN (${allUserIds.map(() => '?').join(',')})`
    ).all(...allUserIds) as { id: number; username: string; avatar: string | null }[];
    for (const u of users) usersMap[u.id] = u;
  }

  const balanceList = Object.entries(balances)
    .map(([uid, bal]) => ({
      user_id: Number(uid),
      username: usersMap[Number(uid)]?.username || `User ${uid}`,
      avatar_url: usersMap[Number(uid)]?.avatar ? `/uploads/avatars/${usersMap[Number(uid)].avatar}` : null,
      balance: Math.round(bal * 100) / 100,
    }))
    .filter(b => Math.abs(b.balance) > 0.005);

  // Simplified debts: greedy min-transactions algorithm
  const cred = balanceList.filter(b => b.balance > 0).map(b => ({ ...b })).sort((a, b) => b.balance - a.balance);
  const debt = balanceList.filter(b => b.balance < 0).map(b => ({ ...b })).sort((a, b) => a.balance - b.balance);

  const debts: {
    from_user_id: number; from_username: string; from_avatar_url: string | null;
    to_user_id: number; to_username: string; to_avatar_url: string | null;
    amount: number;
  }[] = [];

  let ci = 0, di = 0;
  while (ci < cred.length && di < debt.length) {
    const c = cred[ci], d = debt[di];
    const transfer = Math.min(c.balance, Math.abs(d.balance));
    if (transfer > 0.005) {
      debts.push({
        from_user_id: d.user_id, from_username: d.username, from_avatar_url: d.avatar_url,
        to_user_id: c.user_id, to_username: c.username, to_avatar_url: c.avatar_url,
        amount: Math.round(transfer * 100) / 100,
      });
    }
    c.balance -= transfer;
    d.balance += transfer;
    if (Math.abs(c.balance) < 0.005) ci++;
    if (Math.abs(d.balance) < 0.005) di++;
  }

  res.json({ balances: balanceList, debts });
});

// ── GET /settlements ─────────────────────────────────────────────────────────
router.get('/settlements', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const settlements = db.prepare(`
    SELECT ks.*, uf.username as from_username, uf.avatar as from_avatar,
      ut.username as to_username, ut.avatar as to_avatar
    FROM kosten_settlements ks
    JOIN users uf ON ks.from_user_id = uf.id
    JOIN users ut ON ks.to_user_id = ut.id
    WHERE ks.trip_id = ? ORDER BY ks.settled_at DESC
  `).all(tripId) as any[];

  res.json({
    settlements: settlements.map((s: any) => ({
      ...s,
      from_avatar_url: s.from_avatar ? `/uploads/avatars/${s.from_avatar}` : null,
      to_avatar_url: s.to_avatar ? `/uploads/avatars/${s.to_avatar}` : null,
    })),
  });
});

// ── POST /settlements ────────────────────────────────────────────────────────
router.post('/settlements', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const { from_user_id, to_user_id, amount, currency, exchange_rate = 1, note } = req.body;
  if (!from_user_id || !to_user_id || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'from_user_id, to_user_id, and amount are required' });
  }

  const trip = db.prepare('SELECT currency FROM trips WHERE id = ?').get(tripId) as { currency: string } | undefined;
  const tripCurrency = trip?.currency || 'EUR';

  const result = db.prepare(`
    INSERT INTO kosten_settlements (trip_id, from_user_id, to_user_id, amount, currency, exchange_rate, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tripId, Number(from_user_id), Number(to_user_id), Number(amount), currency || tripCurrency, Number(exchange_rate), note || null);

  const settlement = db.prepare(`
    SELECT ks.*, uf.username as from_username, uf.avatar as from_avatar,
      ut.username as to_username, ut.avatar as to_avatar
    FROM kosten_settlements ks
    JOIN users uf ON ks.from_user_id = uf.id
    JOIN users ut ON ks.to_user_id = ut.id
    WHERE ks.id = ?
  `).get(result.lastInsertRowid) as any;

  const s = {
    ...settlement,
    from_avatar_url: settlement.from_avatar ? `/uploads/avatars/${settlement.from_avatar}` : null,
    to_avatar_url: settlement.to_avatar ? `/uploads/avatars/${settlement.to_avatar}` : null,
  };
  broadcast(Number(tripId), 'kosten:settlement_created', { settlement: s }, req.headers['x-socket-id'] as string);
  res.status(201).json({ settlement: s });
});

// ── DELETE /settlements/:id ──────────────────────────────────────────────────
router.delete('/settlements/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const existing = db.prepare('SELECT id FROM kosten_settlements WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existing) return res.status(404).json({ error: 'Settlement not found' });

  db.prepare('DELETE FROM kosten_settlements WHERE id = ? AND trip_id = ?').run(id, tripId);
  broadcast(Number(tripId), 'kosten:settlement_deleted', { id: Number(id) }, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

// ── GET /exchange-rate — proxy Frankfurter API ────────────────────────────────
router.get('/exchange-rate', authenticate, async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const fromUpper = String(from).toUpperCase();
  const toUpper = String(to).toUpperCase();
  if (fromUpper === toUpper) return res.json({ rate: 1, from: fromUpper, to: toUpper });

  try {
    const resp = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(fromUpper)}&to=${encodeURIComponent(toUpper)}`);
    if (!resp.ok) return res.status(502).json({ error: 'Exchange rate service unavailable' });
    const data = await resp.json() as any;
    const rate = data?.rates?.[toUpper];
    if (!rate) return res.status(404).json({ error: 'Rate not found' });
    res.json({ rate, from: fromUpper, to: toUpper, date: data.date });
  } catch {
    res.status(500).json({ error: 'Failed to fetch exchange rate' });
  }
});

export default router;
