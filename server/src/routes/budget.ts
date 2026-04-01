import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { checkPermission } from '../services/permissions';
import { AuthRequest, BudgetItem, BudgetItemMember } from '../types';

const router = express.Router({ mergeParams: true });

function verifyTripOwnership(tripId: string | number, userId: number) {
  return canAccessTrip(tripId, userId);
}

function loadItemMembers(itemId: number | string) {
  return db.prepare(`
    SELECT bm.user_id, bm.paid, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ?
  `).all(itemId) as BudgetItemMember[];
}

function avatarUrl(user: { avatar?: string | null }): string | null {
  return user.avatar ? `/uploads/avatars/${user.avatar}` : null;
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const items = db.prepare(
    'SELECT * FROM budget_items WHERE trip_id = ? ORDER BY category ASC, created_at ASC'
  ).all(tripId) as BudgetItem[];

  const itemIds = items.map(i => i.id);
  const membersByItem: Record<number, (BudgetItemMember & { avatar_url: string | null })[]> = {};
  if (itemIds.length > 0) {
    const allMembers = db.prepare(`
      SELECT bm.budget_item_id, bm.user_id, bm.paid, u.username, u.avatar
      FROM budget_item_members bm
      JOIN users u ON bm.user_id = u.id
      WHERE bm.budget_item_id IN (${itemIds.map(() => '?').join(',')})
    `).all(...itemIds) as (BudgetItemMember & { budget_item_id: number })[];
    for (const m of allMembers) {
      if (!membersByItem[m.budget_item_id]) membersByItem[m.budget_item_id] = [];
      membersByItem[m.budget_item_id].push({
        user_id: m.user_id, paid: m.paid, username: m.username, avatar_url: avatarUrl(m)
      });
    }
  }
  items.forEach(item => { item.members = membersByItem[item.id] || []; });

  res.json({ items });
});

router.get('/summary/per-person', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(Number(tripId), authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const summary = db.prepare(`
    SELECT bm.user_id, u.username, u.avatar,
      SUM(bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id)) as total_assigned,
      SUM(CASE WHEN bm.paid = 1 THEN bi.total_price * 1.0 / (SELECT COUNT(*) FROM budget_item_members WHERE budget_item_id = bi.id) ELSE 0 END) as total_paid,
      COUNT(bi.id) as items_count
    FROM budget_item_members bm
    JOIN budget_items bi ON bm.budget_item_id = bi.id
    JOIN users u ON bm.user_id = u.id
    WHERE bi.trip_id = ?
    GROUP BY bm.user_id
  `).all(tripId) as { user_id: number; username: string; avatar: string | null; total_assigned: number; total_paid: number; items_count: number }[];

  res.json({ summary: summary.map(s => ({ ...s, avatar_url: avatarUrl(s) })) });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { category, name, total_price, persons, days, note, expense_date } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM budget_items WHERE trip_id = ?').get(tripId) as { max: number | null };
  const sortOrder = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    'INSERT INTO budget_items (trip_id, category, name, total_price, persons, days, note, sort_order, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    tripId,
    category || 'Other',
    name,
    total_price || 0,
    persons != null ? persons : null,
    days !== undefined && days !== null ? days : null,
    note || null,
    sortOrder,
    expense_date || null
  );

  const item = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(result.lastInsertRowid) as BudgetItem & { members?: BudgetItemMember[] };
  item.members = [];
  res.status(201).json({ item });
  broadcast(tripId, 'budget:created', { item }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { category, name, total_price, persons, days, note, sort_order, expense_date } = req.body;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return res.status(404).json({ error: 'Budget item not found' });

  db.prepare(`
    UPDATE budget_items SET
      category = COALESCE(?, category),
      name = COALESCE(?, name),
      total_price = CASE WHEN ? IS NOT NULL THEN ? ELSE total_price END,
      persons = CASE WHEN ? IS NOT NULL THEN ? ELSE persons END,
      days = CASE WHEN ? THEN ? ELSE days END,
      note = CASE WHEN ? THEN ? ELSE note END,
      sort_order = CASE WHEN ? IS NOT NULL THEN ? ELSE sort_order END,
      expense_date = CASE WHEN ? THEN ? ELSE expense_date END
    WHERE id = ?
  `).run(
    category || null,
    name || null,
    total_price !== undefined ? 1 : null, total_price !== undefined ? total_price : 0,
    persons !== undefined ? 1 : null, persons !== undefined ? persons : null,
    days !== undefined ? 1 : 0, days !== undefined ? days : null,
    note !== undefined ? 1 : 0, note !== undefined ? note : null,
    sort_order !== undefined ? 1 : null, sort_order !== undefined ? sort_order : 0,
    expense_date !== undefined ? 1 : 0, expense_date !== undefined ? (expense_date || null) : null,
    id
  );

  const updated = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id) as BudgetItem & { members?: BudgetItemMember[] };
  updated.members = loadItemMembers(id);
  res.json({ item: updated });
  broadcast(tripId, 'budget:updated', { item: updated }, req.headers['x-socket-id'] as string);
});

router.put('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = canAccessTrip(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const item = db.prepare('SELECT * FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return res.status(404).json({ error: 'Budget item not found' });

  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' });

  const existingPaid: Record<number, number> = {};
  const existing = db.prepare('SELECT user_id, paid FROM budget_item_members WHERE budget_item_id = ?').all(id) as { user_id: number; paid: number }[];
  for (const e of existing) existingPaid[e.user_id] = e.paid;

  db.prepare('DELETE FROM budget_item_members WHERE budget_item_id = ?').run(id);
  if (user_ids.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO budget_item_members (budget_item_id, user_id, paid) VALUES (?, ?, ?)');
    for (const userId of user_ids) insert.run(id, userId, existingPaid[userId] || 0);
    db.prepare('UPDATE budget_items SET persons = ? WHERE id = ?').run(user_ids.length, id);
  } else {
    db.prepare('UPDATE budget_items SET persons = NULL WHERE id = ?').run(id);
  }

  const members = loadItemMembers(id).map(m => ({ ...m, avatar_url: avatarUrl(m) }));
  const updated = db.prepare('SELECT * FROM budget_items WHERE id = ?').get(id);
  res.json({ members, item: updated });
  broadcast(Number(tripId), 'budget:members-updated', { itemId: Number(id), members, persons: (updated as BudgetItem).persons }, req.headers['x-socket-id'] as string);
});

router.put('/:id/members/:userId/paid', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, userId } = req.params;
  const access = canAccessTrip(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const { paid } = req.body;
  db.prepare('UPDATE budget_item_members SET paid = ? WHERE budget_item_id = ? AND user_id = ?')
    .run(paid ? 1 : 0, id, userId);

  const member = db.prepare(`
    SELECT bm.user_id, bm.paid, u.username, u.avatar
    FROM budget_item_members bm JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id = ? AND bm.user_id = ?
  `).get(id, userId) as BudgetItemMember | undefined;

  const result = member ? { ...member, avatar_url: avatarUrl(member) } : null;
  res.json({ member: result });
  broadcast(Number(tripId), 'budget:member-paid-updated', { itemId: Number(id), userId: Number(userId), paid: paid ? 1 : 0 }, req.headers['x-socket-id'] as string);
});

// Settlement calculation: who owes whom
router.get('/settlement', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(Number(tripId), authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const items = db.prepare('SELECT * FROM budget_items WHERE trip_id = ?').all(tripId) as BudgetItem[];
  const allMembers = db.prepare(`
    SELECT bm.budget_item_id, bm.user_id, bm.paid, u.username, u.avatar
    FROM budget_item_members bm
    JOIN users u ON bm.user_id = u.id
    WHERE bm.budget_item_id IN (SELECT id FROM budget_items WHERE trip_id = ?)
  `).all(tripId) as (BudgetItemMember & { budget_item_id: number })[];

  // Calculate net balance per user: positive = is owed money, negative = owes money
  const balances: Record<number, { user_id: number; username: string; avatar_url: string | null; balance: number }> = {};

  for (const item of items) {
    const members = allMembers.filter(m => m.budget_item_id === item.id);
    if (members.length === 0) continue;

    const payers = members.filter(m => m.paid);
    if (payers.length === 0) continue; // no one marked as paid

    const sharePerMember = item.total_price / members.length;
    const paidPerPayer = item.total_price / payers.length;

    for (const m of members) {
      if (!balances[m.user_id]) {
        balances[m.user_id] = { user_id: m.user_id, username: m.username, avatar_url: avatarUrl(m), balance: 0 };
      }
      // Everyone owes their share
      balances[m.user_id].balance -= sharePerMember;
      // Payers get credited what they paid
      if (m.paid) balances[m.user_id].balance += paidPerPayer;
    }
  }

  // Calculate optimized payment flows (greedy algorithm)
  const people = Object.values(balances).filter(b => Math.abs(b.balance) > 0.01);
  const debtors = people.filter(p => p.balance < -0.01).map(p => ({ ...p, amount: -p.balance }));
  const creditors = people.filter(p => p.balance > 0.01).map(p => ({ ...p, amount: p.balance }));

  // Sort by amount descending for efficient matching
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const flows: { from: { user_id: number; username: string; avatar_url: string | null }; to: { user_id: number; username: string; avatar_url: string | null }; amount: number }[] = [];

  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const transfer = Math.min(debtors[di].amount, creditors[ci].amount);
    if (transfer > 0.01) {
      flows.push({
        from: { user_id: debtors[di].user_id, username: debtors[di].username, avatar_url: debtors[di].avatar_url },
        to: { user_id: creditors[ci].user_id, username: creditors[ci].username, avatar_url: creditors[ci].avatar_url },
        amount: Math.round(transfer * 100) / 100,
      });
    }
    debtors[di].amount -= transfer;
    creditors[ci].amount -= transfer;
    if (debtors[di].amount < 0.01) di++;
    if (creditors[ci].amount < 0.01) ci++;
  }

  res.json({
    balances: Object.values(balances).map(b => ({ ...b, balance: Math.round(b.balance * 100) / 100 })),
    flows,
  });
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, authReq.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  if (!checkPermission('budget_edit', authReq.user.role, trip.user_id, authReq.user.id, trip.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const item = db.prepare('SELECT id FROM budget_items WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!item) return res.status(404).json({ error: 'Budget item not found' });

  db.prepare('DELETE FROM budget_items WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'budget:deleted', { itemId: Number(id) }, req.headers['x-socket-id'] as string);
});

export default router;
