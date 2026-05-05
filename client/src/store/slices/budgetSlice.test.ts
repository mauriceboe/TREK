// FE-STORE-BUDGET-001 to FE-STORE-BUDGET-011
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildBudgetItem } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';
import { offlineDb } from '../../db/offlineDb';

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
  server.resetHandlers();
});

describe('budgetSlice', () => {
  it('FE-STORE-BUDGET-001: loadBudgetItems populates store', async () => {
    const item = buildBudgetItem({ trip_id: 1 });
    server.use(
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ items: [item] })
      )
    );
    await useTripStore.getState().loadBudgetItems(1);
    expect(useTripStore.getState().budgetItems).toHaveLength(1);
    expect(useTripStore.getState().budgetItems[0].id).toBe(item.id);
  });

  it('FE-STORE-BUDGET-002: loadBudgetItems swallows errors silently', async () => {
    server.use(
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ error: 'server error' }, { status: 500 })
      )
    );
    // Should NOT throw
    await expect(useTripStore.getState().loadBudgetItems(1)).resolves.toBeUndefined();
    expect(useTripStore.getState().budgetItems).toEqual([]);
  });

  it('FE-STORE-BUDGET-003: addBudgetItem appends to store optimistically', async () => {
    server.use(
      http.post('/api/trips/1/budget', () =>
        HttpResponse.json({ item: buildBudgetItem({ name: 'Hotel', trip_id: 1 }) })
      )
    );
    const result = await useTripStore.getState().addBudgetItem(1, { name: 'Hotel' });
    expect(result.name).toBe('Hotel');
    const items = useTripStore.getState().budgetItems;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Hotel');
  });

  it('FE-STORE-BUDGET-004: addBudgetItem adds item optimistically even on API error', async () => {
    server.use(
      http.post('/api/trips/1/budget', () =>
        HttpResponse.json({ error: 'Validation failed' }, { status: 422 })
      )
    );
    const result = await useTripStore.getState().addBudgetItem(1, { name: 'Item' });
    expect(result.name).toBe('Item');
    expect(useTripStore.getState().budgetItems).toHaveLength(1);
  });

  it('FE-STORE-BUDGET-005: updateBudgetItem replaces item in store', async () => {
    const existing = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old' });
    seedStore(useTripStore, { budgetItems: [existing] });

    const updated = { ...existing, name: 'New' };
    server.use(
      http.put('/api/trips/1/budget/10', () =>
        HttpResponse.json({ item: updated })
      )
    );
    await useTripStore.getState().updateBudgetItem(1, 10, { name: 'New' });
    const items = useTripStore.getState().budgetItems;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('New');
  });

  it('FE-STORE-BUDGET-006: updateBudgetItem resolves and updates store optimistically', async () => {
    const existing = buildBudgetItem({ id: 20, trip_id: 1, amount: 100 });
    seedStore(useTripStore, { budgetItems: [existing] });

    server.use(
      http.put('/api/trips/1/budget/20', () =>
        HttpResponse.json({ item: { ...existing, amount: 50 } })
      )
    );
    const result = await useTripStore.getState().updateBudgetItem(1, 20, { amount: 50 });
    expect(result.amount).toBe(50);
    expect(useTripStore.getState().budgetItems[0].amount).toBe(50);
  });

  it('FE-STORE-BUDGET-007: deleteBudgetItem removes item permanently even on API error', async () => {
    const item = buildBudgetItem({ id: 5, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [item] });

    server.use(
      http.delete('/api/trips/1/budget/5', () =>
        HttpResponse.json({ error: 'forbidden' }, { status: 403 })
      )
    );
    await useTripStore.getState().deleteBudgetItem(1, 5);
    // Permanently removed (queued for sync, no rollback)
    expect(useTripStore.getState().budgetItems).toHaveLength(0);
  });

  it('FE-STORE-BUDGET-008: setBudgetItemMembers updates members on matching item', async () => {
    const item = buildBudgetItem({ id: 7, trip_id: 1, members: [] });
    seedStore(useTripStore, { budgetItems: [item] });

    const members = [{ user_id: 1, paid: false }, { user_id: 2, paid: false }];
    const updatedItem = { ...item, persons: 2, members };
    server.use(
      http.put('/api/trips/1/budget/7/members', () =>
        HttpResponse.json({ members, item: updatedItem })
      )
    );
    await useTripStore.getState().setBudgetItemMembers(1, 7, [1, 2]);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 7);
    expect(stored?.members).toHaveLength(2);
    expect(stored?.persons).toBe(2);
  });

  it('FE-STORE-BUDGET-009: toggleBudgetMemberPaid updates paid flag on matching member', async () => {
    const item = buildBudgetItem({
      id: 8,
      trip_id: 1,
      members: [{ user_id: 3, paid: false }],
    });
    seedStore(useTripStore, { budgetItems: [item] });

    server.use(
      http.put('/api/trips/1/budget/8/members/3/paid', () =>
        HttpResponse.json({ success: true, paid: true })
      )
    );
    await useTripStore.getState().toggleBudgetMemberPaid(1, 8, 3, true);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 8);
    expect(stored?.members?.[0]?.paid).toBe(true);
  });

  it('FE-STORE-BUDGET-010: reorderBudgetItems reorders optimistically and reloads on error', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    // Reorder succeeds
    server.use(
      http.put('/api/trips/1/budget/reorder/items', () =>
        HttpResponse.json({ success: true })
      )
    );
    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    const items = useTripStore.getState().budgetItems;
    expect(items[0].id).toBe(2);
    expect(items[1].id).toBe(1);
  });

  it('FE-STORE-BUDGET-011: reorderBudgetItems reloads list on API error', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    const freshItem = buildBudgetItem({ id: 99, trip_id: 1 });
    server.use(
      http.put('/api/trips/1/budget/reorder/items', () =>
        HttpResponse.json({ error: 'error' }, { status: 500 })
      ),
      http.get('/api/trips/1/budget', () =>
        HttpResponse.json({ items: [freshItem] })
      )
    );
    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    // After failure, fresh list from server
    expect(useTripStore.getState().budgetItems[0].id).toBe(freshItem.id);
  });
});
