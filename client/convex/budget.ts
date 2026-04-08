import { ConvexError, v } from 'convex/values';
import { query as rawQuery, mutation as rawMutation } from './_generated/server';
import { requireTripAccess, getViewerAuthKey } from './helpers';

export const list = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db
      .query('plannerBudgetItems')
      .withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId))
      .collect();
    const result = [];
    for (const item of items) {
      const members = await ctx.db
        .query('plannerBudgetMembers')
        .withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', item._id))
        .collect();
      const memberData = [];
      for (const m of members) {
        const user = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', m.userAuthKey)).unique();
        memberData.push({ user_id: m.userAuthKey, username: user?.username || 'Unknown', avatar_url: user?.avatarUrl || null, paid: m.paid });
      }
      result.push({
        id: item._id, _id: item._id, trip_id: args.tripId, name: item.name, amount: item.amount,
        total_price: item.totalPrice ?? null, currency: item.currency, category: item.category ?? null,
        paid_by: item.paidByAuthKey ?? null, persons: item.persons, days: item.days,
        expense_date: item.expenseDate ?? null, note: item.note ?? null, members: memberData,
        created_at: new Date(item.createdAt).toISOString(),
      });
    }
    return { items: result };
  },
});

export const create = rawMutation({
  args: { tripId: v.id('plannerTrips'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const now = Date.now();
    const id = await ctx.db.insert('plannerBudgetItems', {
      tripId: args.tripId, name: d.name || '', amount: Number(d.amount) || 0,
      totalPrice: d.total_price != null ? Number(d.total_price) : null,
      currency: d.currency || 'USD', category: d.category || null,
      paidByAuthKey: d.paid_by || null, persons: Number(d.persons) || 1,
      days: d.days ? Number(d.days) : undefined, expenseDate: d.expense_date || null,
      note: d.note || null, createdAt: now, updatedAt: now,
    });
    const item = await ctx.db.get(id);
    return { item: { id, _id: id, trip_id: args.tripId, name: item!.name, amount: item!.amount, total_price: item!.totalPrice, currency: item!.currency, category: item!.category, paid_by: item!.paidByAuthKey, persons: item!.persons, members: [], created_at: new Date(now).toISOString() } };
  },
});

export const update = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.id('plannerBudgetItems'), data: v.any() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const d = args.data as any;
    const patch: any = { updatedAt: Date.now() };
    if (d.name !== undefined) patch.name = d.name;
    if (d.amount !== undefined) patch.amount = Number(d.amount);
    if (d.total_price !== undefined) patch.totalPrice = d.total_price != null ? Number(d.total_price) : null;
    if (d.currency !== undefined) patch.currency = d.currency;
    if (d.category !== undefined) patch.category = d.category;
    if (d.paid_by !== undefined) patch.paidByAuthKey = d.paid_by;
    if (d.persons !== undefined) patch.persons = Number(d.persons);
    if (d.days !== undefined) patch.days = Number(d.days);
    if (d.expense_date !== undefined) patch.expenseDate = d.expense_date;
    if (d.note !== undefined) patch.note = d.note;
    await ctx.db.patch(args.itemId, patch);
    const item = await ctx.db.get(args.itemId);
    const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', args.itemId)).collect();
    const memberData = [];
    for (const m of members) {
      const user = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', m.userAuthKey)).unique();
      memberData.push({ user_id: m.userAuthKey, username: user?.username || 'Unknown', avatar_url: user?.avatarUrl || null, paid: m.paid });
    }
    return { item: { id: args.itemId, _id: args.itemId, trip_id: args.tripId, name: item!.name, amount: item!.amount, total_price: item!.totalPrice, currency: item!.currency, category: item!.category, paid_by: item!.paidByAuthKey, persons: item!.persons, members: memberData, created_at: new Date(item!.createdAt).toISOString() } };
  },
});

export const remove = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.id('plannerBudgetItems') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', args.itemId)).collect();
    for (const m of members) await ctx.db.delete(m._id);
    await ctx.db.delete(args.itemId);
    return { success: true };
  },
});

export const setMembers = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.id('plannerBudgetItems'), userAuthKeys: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const existing = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', args.itemId)).collect();
    for (const m of existing) await ctx.db.delete(m._id);
    for (const key of args.userAuthKeys) {
      await ctx.db.insert('plannerBudgetMembers', { budgetItemId: args.itemId, userAuthKey: key, paid: false });
    }
    await ctx.db.patch(args.itemId, { persons: args.userAuthKeys.length || 1, updatedAt: Date.now() });
    const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', args.itemId)).collect();
    const item = await ctx.db.get(args.itemId);
    const memberData = [];
    for (const m of members) {
      const user = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', m.userAuthKey)).unique();
      memberData.push({ user_id: m.userAuthKey, username: user?.username || 'Unknown', avatar_url: user?.avatarUrl || null, paid: m.paid });
    }
    return { members: memberData, item: { ...item, id: args.itemId, persons: args.userAuthKeys.length || 1 } };
  },
});

export const perPersonSummary = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db.query('plannerBudgetItems').withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId)).collect();
    const totals: Record<string, { authKey: string; username: string; paid: number; owed: number }> = {};
    for (const item of items) {
      const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', item._id)).collect();
      const perPerson = members.length > 0 ? item.amount / members.length : item.amount;
      if (item.paidByAuthKey) {
        if (!totals[item.paidByAuthKey]) {
          const user = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', item.paidByAuthKey)).unique();
          totals[item.paidByAuthKey] = { authKey: item.paidByAuthKey, username: (user as any)?.username || 'Unknown', paid: 0, owed: 0 };
        }
        totals[item.paidByAuthKey].paid += item.amount;
      }
      for (const m of members) {
        if (!totals[m.userAuthKey]) {
          const user = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', m.userAuthKey)).unique();
          totals[m.userAuthKey] = { authKey: m.userAuthKey, username: (user as any)?.username || 'Unknown', paid: 0, owed: 0 };
        }
        totals[m.userAuthKey].owed += perPerson;
      }
    }
    return { summary: Object.values(totals) };
  },
});

export const settlement = rawQuery({
  args: { tripId: v.id('plannerTrips') },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const items = await ctx.db.query('plannerBudgetItems').withIndex('by_tripId', (q: any) => q.eq('tripId', args.tripId)).collect();
    const balances: Record<string, number> = {};
    for (const item of items) {
      const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', item._id)).collect();
      const perPerson = members.length > 0 ? item.amount / members.length : 0;
      if (item.paidByAuthKey) {
        balances[item.paidByAuthKey] = (balances[item.paidByAuthKey] || 0) + item.amount;
      }
      for (const m of members) {
        balances[m.userAuthKey] = (balances[m.userAuthKey] || 0) - perPerson;
      }
    }
    // Compute settlements
    const debtors = Object.entries(balances).filter(([, b]) => b < -0.01).map(([k, b]) => ({ key: k, amount: -b }));
    const creditors = Object.entries(balances).filter(([, b]) => b > 0.01).map(([k, b]) => ({ key: k, amount: b }));
    const settlements: { from: string; to: string; amount: number }[] = [];
    let di = 0, ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const transfer = Math.min(debtors[di].amount, creditors[ci].amount);
      if (transfer > 0.01) settlements.push({ from: debtors[di].key, to: creditors[ci].key, amount: Math.round(transfer * 100) / 100 });
      debtors[di].amount -= transfer;
      creditors[ci].amount -= transfer;
      if (debtors[di].amount < 0.01) di++;
      if (creditors[ci].amount < 0.01) ci++;
    }
    // Resolve names
    const result = [];
    for (const s of settlements) {
      const fromUser = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', s.from)).unique();
      const toUser = await ctx.db.query('plannerUsers').withIndex('by_authUserKey', (q: any) => q.eq('authUserKey', s.to)).unique();
      result.push({ from: (fromUser as any)?.username || s.from, to: (toUser as any)?.username || s.to, amount: s.amount });
    }
    return { settlements: result };
  },
});

export const togglePaid = rawMutation({
  args: { tripId: v.id('plannerTrips'), itemId: v.id('plannerBudgetItems'), userAuthKey: v.string(), paid: v.boolean() },
  handler: async (ctx, args) => {
    await requireTripAccess(ctx, args.tripId);
    const members = await ctx.db.query('plannerBudgetMembers').withIndex('by_budgetItemId', (q: any) => q.eq('budgetItemId', args.itemId)).collect();
    const member = members.find(m => m.userAuthKey === args.userAuthKey);
    if (member) await ctx.db.patch(member._id, { paid: args.paid });
    return { success: true };
  },
});
