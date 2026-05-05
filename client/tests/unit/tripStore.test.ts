import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../src/store/tripStore';
import { resetAllStores } from '../helpers/store';
import { buildTrip, buildDay, buildPlace, buildPackingItem, buildTodoItem, buildTag, buildCategory, buildAssignment, buildDayNote } from '../helpers/factories';
import { server } from '../helpers/msw/server';
import { offlineDb } from '../../src/db/offlineDb';

vi.mock('../../src/api/websocket', () => ({
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
  // Flush pending macro tasks so any in-flight repo IIFEs from the previous test
  // finish writing to IDB before we wipe it (prevents stale IDB data in next test).
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
});

describe('tripStore', () => {
  describe('loadTrip', () => {
    it('FE-TRIP-001: fires parallel API calls for trips, days, places, packing, todo, tags, categories', async () => {
      const calledUrls: string[] = [];
      server.use(
        http.get('/api/trips/:id', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}`);
          return HttpResponse.json({ trip: buildTrip({ id: Number(params.id) }) });
        }),
        http.get('/api/trips/:id/days', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/days`);
          return HttpResponse.json({ days: [] });
        }),
        http.get('/api/trips/:id/places', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/places`);
          return HttpResponse.json({ places: [] });
        }),
        http.get('/api/trips/:id/packing', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/packing`);
          return HttpResponse.json({ items: [] });
        }),
        http.get('/api/trips/:id/todo', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/todo`);
          return HttpResponse.json({ items: [] });
        }),
        http.get('/api/tags', () => {
          calledUrls.push('/api/tags');
          return HttpResponse.json({ tags: [] });
        }),
        http.get('/api/categories', () => {
          calledUrls.push('/api/categories');
          return HttpResponse.json({ categories: [] });
        }),
      );

      await useTripStore.getState().loadTrip(1);

      expect(calledUrls).toContain('/api/trips/1');
      expect(calledUrls).toContain('/api/trips/1/days');
      expect(calledUrls).toContain('/api/trips/1/places');
      expect(calledUrls).toContain('/api/trips/1/packing');
      expect(calledUrls).toContain('/api/trips/1/todo');
      expect(calledUrls).toContain('/api/tags');
      expect(calledUrls).toContain('/api/categories');
    });

    it('FE-TRIP-002: after loadTrip, all store fields are populated', async () => {
      const trip = buildTrip({ id: 1 });
      const place = buildPlace({ trip_id: 1 });
      const packingItem = buildPackingItem({ trip_id: 1 });
      const todoItem = buildTodoItem({ trip_id: 1 });
      const tag = buildTag();
      const category = buildCategory();

      // Seed IDB so tags/categories are available for the immediate IDB read in loadTrip
      await offlineDb.tags.put(tag);
      await offlineDb.categories.put(category);

      server.use(
        http.get('/api/trips/1', () => HttpResponse.json({ trip })),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [] })),
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [place] })),
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [packingItem] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [todoItem] })),
        http.get('/api/tags', () => HttpResponse.json({ tags: [tag] })),
        http.get('/api/categories', () => HttpResponse.json({ categories: [category] })),
      );

      await useTripStore.getState().loadTrip(1);
      const state = useTripStore.getState();

      expect(state.trip).toEqual(trip);
      expect(state.places).toEqual([place]);
      expect(state.packingItems).toEqual([packingItem]);
      expect(state.todoItems).toEqual([todoItem]);
      expect(state.tags).toEqual([tag]);
      expect(state.categories).toEqual([category]);
    });

    it('FE-TRIP-003: loadTrip extracts assignments map from days response', async () => {
      const assignment = buildAssignment({ day_id: 10, order_index: 0 });
      const day = buildDay({ id: 10, assignments: [assignment], notes_items: [] });

      server.use(
        http.get('/api/trips/1', () => HttpResponse.json({ trip: buildTrip({ id: 1 }) })),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [day] })),
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [] })),
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
        http.get('/api/tags', () => HttpResponse.json({ tags: [] })),
        http.get('/api/categories', () => HttpResponse.json({ categories: [] })),
      );

      await useTripStore.getState().loadTrip(1);
      const { assignments } = useTripStore.getState();

      expect(assignments['10']).toBeDefined();
      expect(assignments['10']).toEqual([assignment]);
    });

    it('FE-TRIP-004: loadTrip extracts dayNotes map from days response', async () => {
      const note = buildDayNote({ day_id: 10 });
      const day = buildDay({ id: 10, assignments: [], notes_items: [note] });

      server.use(
        http.get('/api/trips/1', () => HttpResponse.json({ trip: buildTrip({ id: 1 }) })),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [day] })),
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [] })),
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
        http.get('/api/tags', () => HttpResponse.json({ tags: [] })),
        http.get('/api/categories', () => HttpResponse.json({ categories: [] })),
      );

      await useTripStore.getState().loadTrip(1);
      const { dayNotes } = useTripStore.getState();

      expect(dayNotes['10']).toBeDefined();
      expect(dayNotes['10']).toEqual([note]);
    });

    it('FE-TRIP-005: loadTrip sets isLoading true during, false after', async () => {
      let wasLoadingDuringFetch = false;

      server.use(
        http.get('/api/trips/1', () => {
          wasLoadingDuringFetch = useTripStore.getState().isLoading;
          return HttpResponse.json({ trip: buildTrip({ id: 1 }) });
        }),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [] })),
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [] })),
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
        http.get('/api/tags', () => HttpResponse.json({ tags: [] })),
        http.get('/api/categories', () => HttpResponse.json({ categories: [] })),
      );

      const promise = useTripStore.getState().loadTrip(1);
      expect(useTripStore.getState().isLoading).toBe(true);
      await promise;
      expect(wasLoadingDuringFetch).toBe(true);
      expect(useTripStore.getState().isLoading).toBe(false);
    });

    it('FE-TRIP-006: loadTrip on API failure sets error and isLoading: false', async () => {
      server.use(
        http.get('/api/trips/1', () => HttpResponse.json({ message: 'Not found' }, { status: 404 })),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [] })),
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [] })),
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
        http.get('/api/tags', () => HttpResponse.json({ tags: [] })),
        http.get('/api/categories', () => HttpResponse.json({ categories: [] })),
      );

      await expect(useTripStore.getState().loadTrip(1)).rejects.toThrow();

      const state = useTripStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).not.toBeNull();
    });
  });

  describe('refreshDays', () => {
    it('FE-TRIP-007: refreshDays re-fetches days and rebuilds assignments/dayNotes maps', async () => {
      const assignment = buildAssignment({ day_id: 20, order_index: 0 });
      const note = buildDayNote({ day_id: 20 });
      const day = buildDay({ id: 20, assignments: [assignment], notes_items: [note] });

      server.use(
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [day] })),
      );

      await useTripStore.getState().refreshDays(1);
      const state = useTripStore.getState();

      expect(state.days).toHaveLength(1);
      expect(state.assignments['20']).toEqual([assignment]);
      expect(state.dayNotes['20']).toEqual([note]);
    });
  });

  describe('updateTrip', () => {
    it('FE-TRIP-008: updateTrip persists and refreshes trip + days', async () => {
      const updatedTrip = buildTrip({ id: 1, name: 'Updated Trip' });

      server.use(
        http.put('/api/trips/1', () => HttpResponse.json({ trip: updatedTrip })),
        http.get('/api/trips/1/days', () => HttpResponse.json({ days: [] })),
      );

      const result = await useTripStore.getState().updateTrip(1, { name: 'Updated Trip' });

      expect(result.name).toBe('Updated Trip');
      expect(useTripStore.getState().trip?.name).toBe('Updated Trip');
    });
  });

  describe('setSelectedDay', () => {
    it('FE-TRIP-009: setSelectedDay updates selectedDayId', () => {
      useTripStore.getState().setSelectedDay(42);
      expect(useTripStore.getState().selectedDayId).toBe(42);

      useTripStore.getState().setSelectedDay(null);
      expect(useTripStore.getState().selectedDayId).toBeNull();
    });
  });

  describe('addTag', () => {
    it('FE-TRIP-010: addTag creates tag and appends to tags', async () => {
      const existingTag = buildTag();
      useTripStore.setState({ tags: [existingTag] });

      const newTagData = { name: 'New Tag', color: '#00ff00' };

      const result = await useTripStore.getState().addTag(newTagData);

      expect(result.name).toBe('New Tag');
      const tags = useTripStore.getState().tags;
      expect(tags).toHaveLength(2);
      expect(tags[tags.length - 1].name).toBe('New Tag');
    });
  });

  describe('addCategory', () => {
    it('FE-TRIP-011: addCategory creates category and appends to categories', async () => {
      const existingCategory = buildCategory();
      useTripStore.setState({ categories: [existingCategory] });

      const newCategoryData = { name: 'New Category', icon: 'hotel' };

      const result = await useTripStore.getState().addCategory(newCategoryData);

      expect(result.name).toBe('New Category');
      const categories = useTripStore.getState().categories;
      expect(categories).toHaveLength(2);
      expect(categories[categories.length - 1].name).toBe('New Category');
    });
  });
});
