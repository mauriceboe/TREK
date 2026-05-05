import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildBudgetItem } from '../../helpers/factories';
import { server } from '../../helpers/msw/server';
import { offlineDb } from '../../../src/db/offlineDb';

vi.mock('../../../src/api/websocket', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocketId: vi.fn(() => null),
  joinTrip: vi.fn(),
  leaveTrip: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  setRefetchCallback: vi.fn(),
  setPreReconnectHook: vi.fn(),
}));

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
});

describe('budgetSlice', () => {
  describe('loadBudgetItems', () => {
    it('FE-BUDGET-001: loadBudgetItems fetches and replaces budgetItems', async () => {
      seedStore(useTripStore, { budgetItems: [] });

      const item = buildBudgetItem({ trip_id: 1 });
      server.use(
        http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      );

      await useTripStore.getState().loadBudgetItems(1);

      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].id).toBe(item.id);
    });
  });

  describe('addBudgetItem', () => {
    it('FE-BUDGET-002: addBudgetItem appends to budgetItems', async () => {
      const existing = buildBudgetItem({ trip_id: 1 });
      seedStore(useTripStore, { budgetItems: [existing] });

      const result = await useTripStore.getState().addBudgetItem(1, { name: 'Hotel', amount: 200 });

      expect(result.name).toBe('Hotel');
      expect(useTripStore.getState().budgetItems).toHaveLength(2);
    });

    it('FE-BUDGET-003: addBudgetItem always adds item optimistically (no throw on API error)', async () => {
      server.use(
        http.post('/api/trips/1/budget', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      const result = await useTripStore.getState().addBudgetItem(1, { name: 'Fail' });

      expect(result.name).toBe('Fail');
      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].name).toBe('Fail');
    });
  });

  describe('updateBudgetItem', () => {
    it('FE-BUDGET-004: updateBudgetItem replaces item in array', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old', amount: 100 });
      seedStore(useTripStore, { budgetItems: [item] });

      server.use(
        http.put('/api/trips/1/budget/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ item: { ...item, ...body } });
        }),
      );

      const result = await useTripStore.getState().updateBudgetItem(1, 10, { name: 'Updated', amount: 150 });

      expect(result.name).toBe('Updated');
      expect(useTripStore.getState().budgetItems[0].name).toBe('Updated');
    });

    it('FE-BUDGET-005: updateBudgetItem resolves and updates store optimistically', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old', amount: 100 });
      seedStore(useTripStore, { budgetItems: [item] });

      server.use(
        http.put('/api/trips/1/budget/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ item: { ...item, ...body, reservation_id: 42 } });
        }),
      );

      const result = await useTripStore.getState().updateBudgetItem(1, 10, { amount: 200 } as Record<string, unknown>);

      expect(result.amount).toBe(200);
      expect(useTripStore.getState().budgetItems[0].amount).toBe(200);
    });
  });

  describe('deleteBudgetItem', () => {
    it('FE-BUDGET-006: deleteBudgetItem removes item permanently even on API error', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { budgetItems: [item] });

      server.use(
        http.delete('/api/trips/1/budget/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().deleteBudgetItem(1, 10);

      // Permanently removed (queued for sync, no rollback)
      expect(useTripStore.getState().budgetItems).toHaveLength(0);
    });

    it('FE-BUDGET-006b: deleteBudgetItem success removes item', async () => {
      const item1 = buildBudgetItem({ id: 10, trip_id: 1 });
      const item2 = buildBudgetItem({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { budgetItems: [item1, item2] });

      await useTripStore.getState().deleteBudgetItem(1, 10);

      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].id).toBe(20);
    });
  });

  describe('setBudgetItemMembers', () => {
    it('FE-BUDGET-007: setBudgetItemMembers updates members array on item', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1, members: [] });
      seedStore(useTripStore, { budgetItems: [item] });

      const members = [{ user_id: 1, paid: false }, { user_id: 2, paid: false }];
      server.use(
        http.put('/api/trips/1/budget/10/members', () =>
          HttpResponse.json({ members, item: { ...item, persons: 2, members } })
        ),
      );

      const result = await useTripStore.getState().setBudgetItemMembers(1, 10, [1, 2]);

      expect(result.members).toHaveLength(2);
      const updatedItem = useTripStore.getState().budgetItems.find(i => i.id === 10);
      expect(updatedItem?.members).toHaveLength(2);
      expect(updatedItem?.persons).toBe(2);
    });
  });

  describe('toggleBudgetMemberPaid', () => {
    it('FE-BUDGET-008: toggleBudgetMemberPaid updates paid status after API success', async () => {
      const member = { user_id: 5, paid: false };
      const item = buildBudgetItem({ id: 10, trip_id: 1, members: [member] });
      seedStore(useTripStore, { budgetItems: [item] });

      await useTripStore.getState().toggleBudgetMemberPaid(1, 10, 5, true);

      const updatedItem = useTripStore.getState().budgetItems.find(i => i.id === 10);
      const updatedMember = updatedItem?.members.find(m => m.user_id === 5);
      expect(updatedMember?.paid).toBe(true);
    });
  });
});
