import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildTodoItem } from '../../helpers/factories';
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

describe('todoSlice', () => {
  describe('addTodoItem', () => {
    it('FE-TODO-001: addTodoItem calls API and appends item to todoItems', async () => {
      const existing = buildTodoItem({ trip_id: 1 });
      seedStore(useTripStore, { todoItems: [existing] });

      const result = await useTripStore.getState().addTodoItem(1, { name: 'Buy sunscreen', priority: 1 });

      expect(result.name).toBe('Buy sunscreen');
      const items = useTripStore.getState().todoItems;
      expect(items).toHaveLength(2);
    });

    it('FE-TODO-002: addTodoItem always adds item optimistically (no throw on API error)', async () => {
      server.use(
        http.post('/api/trips/1/todo', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      const result = await useTripStore.getState().addTodoItem(1, { name: 'Fail' });

      expect(result.name).toBe('Fail');
      expect(useTripStore.getState().todoItems).toHaveLength(1);
      expect(useTripStore.getState().todoItems[0].name).toBe('Fail');
    });
  });

  describe('updateTodoItem', () => {
    it('FE-TODO-003: updateTodoItem replaces item and preserves priority field', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, name: 'Old', priority: 2, sort_order: 5 });
      seedStore(useTripStore, { todoItems: [item] });

      server.use(
        http.put('/api/trips/1/todo/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ item: { ...item, ...body } });
        }),
      );

      const result = await useTripStore.getState().updateTodoItem(1, 10, { name: 'Updated', priority: 2 });

      expect(result.name).toBe('Updated');
      expect(result.priority).toBe(2);
      expect(useTripStore.getState().todoItems[0].name).toBe('Updated');
      expect(useTripStore.getState().todoItems[0].priority).toBe(2);
    });
  });

  describe('deleteTodoItem', () => {
    it('FE-TODO-004: deleteTodoItem removes item permanently even on API error', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { todoItems: [item] });

      server.use(
        http.delete('/api/trips/1/todo/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().deleteTodoItem(1, 10);

      expect(useTripStore.getState().todoItems).toHaveLength(0);
    });

    it('FE-TODO-004b: deleteTodoItem success removes item from array', async () => {
      const item1 = buildTodoItem({ id: 10, trip_id: 1 });
      const item2 = buildTodoItem({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { todoItems: [item1, item2] });

      await useTripStore.getState().deleteTodoItem(1, 10);

      const items = useTripStore.getState().todoItems;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(20);
    });
  });

  describe('toggleTodoItem', () => {
    it('FE-TODO-005: toggleTodoItem sets checked optimistically to 1', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { todoItems: [item] });

      server.use(
        http.put('/api/trips/1/todo/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ item: { ...item, ...body } });
        }),
      );

      await useTripStore.getState().toggleTodoItem(1, 10, true);

      expect(useTripStore.getState().todoItems[0].checked).toBe(1);
    });

    it('FE-TODO-006: toggleTodoItem preserves optimistic checked state even on API failure', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { todoItems: [item] });

      server.use(
        http.put('/api/trips/1/todo/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().toggleTodoItem(1, 10, true);

      // Optimistic state preserved — no rollback (queued for sync)
      expect(useTripStore.getState().todoItems[0].checked).toBe(1);
    });

    it('FE-TODO-007: toggleTodoItem preserves sort_order field', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0, sort_order: 3 });
      seedStore(useTripStore, { todoItems: [item] });

      server.use(
        http.put('/api/trips/1/todo/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ item: { ...item, ...body } });
        }),
      );

      await useTripStore.getState().toggleTodoItem(1, 10, true);

      expect(useTripStore.getState().todoItems[0].sort_order).toBe(3);
    });
  });
});
