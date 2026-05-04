import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildPlace, buildAssignment } from '../../helpers/factories';
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

describe('placesSlice', () => {
  describe('addPlace', () => {
    it('FE-PLACES-001: addPlace calls API and prepends place to places array', async () => {
      const existing = buildPlace({ trip_id: 1 });
      seedStore(useTripStore, { places: [existing] });

      const result = await useTripStore.getState().addPlace(1, { name: 'New Place' });

      expect(result.name).toBe('New Place');
      const places = useTripStore.getState().places;
      expect(places).toHaveLength(2);
      expect(places[0].name).toBe('New Place'); // prepended
    });

    it('FE-PLACES-002: addPlace on failure throws and places remain unchanged', async () => {
      const existing = buildPlace({ trip_id: 1 });
      seedStore(useTripStore, { places: [existing] });

      server.use(
        http.post('/api/trips/:id/places', () =>
          HttpResponse.json({ message: 'Server error' }, { status: 500 })
        ),
      );

      await expect(useTripStore.getState().addPlace(1, { name: 'Fail' })).rejects.toThrow();
      expect(useTripStore.getState().places).toEqual([existing]);
    });
  });

  describe('updatePlace', () => {
    it('FE-PLACES-003: updatePlace calls API and updates place in array', async () => {
      const place = buildPlace({ id: 10, trip_id: 1, name: 'Old Name' });
      seedStore(useTripStore, { places: [place] });

      server.use(
        http.put('/api/trips/:id/places/:placeId', async ({ params, request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ place: { ...place, ...body, id: Number(params.placeId) } });
        }),
      );

      const result = await useTripStore.getState().updatePlace(1, 10, { name: 'New Name' });

      expect(result.name).toBe('New Name');
      const updated = useTripStore.getState().places.find(p => p.id === 10);
      expect(updated?.name).toBe('New Name');
    });

    it('FE-PLACES-004: updatePlace cascades to assignments map — assignment place field updated', async () => {
      const place = buildPlace({ id: 10, trip_id: 1, name: 'Old Place' });
      const assignment = buildAssignment({ id: 100, day_id: 1, place });
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [assignment] },
      });

      server.use(
        http.put('/api/trips/1/places/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ place: { ...place, ...body } });
        }),
      );

      await useTripStore.getState().updatePlace(1, 10, { name: 'Updated Place' });

      const updatedAssignments = useTripStore.getState().assignments['1'];
      expect(updatedAssignments[0].place.name).toBe('Updated Place');
    });
  });

  describe('deletePlace', () => {
    it('FE-PLACES-005: deletePlace removes place from places array', async () => {
      const place1 = buildPlace({ id: 10, trip_id: 1 });
      const place2 = buildPlace({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { places: [place1, place2], assignments: {} });

      server.use(
        http.delete('/api/trips/1/places/10', () => HttpResponse.json({ success: true })),
      );

      await useTripStore.getState().deletePlace(1, 10);

      const places = useTripStore.getState().places;
      expect(places).toHaveLength(1);
      expect(places[0].id).toBe(20);
    });

    it('FE-PLACES-006: deletePlace cascades — assignments referencing the place are removed', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      const otherPlace = buildPlace({ id: 20, trip_id: 1 });
      const assignmentWithPlace = buildAssignment({ id: 100, day_id: 1, place });
      const assignmentOther = buildAssignment({ id: 200, day_id: 1, place: otherPlace });

      seedStore(useTripStore, {
        places: [place, otherPlace],
        assignments: { '1': [assignmentWithPlace, assignmentOther] },
      });

      server.use(
        http.delete('/api/trips/1/places/10', () => HttpResponse.json({ success: true })),
      );

      await useTripStore.getState().deletePlace(1, 10);

      const dayAssignments = useTripStore.getState().assignments['1'];
      expect(dayAssignments).toHaveLength(1);
      expect(dayAssignments[0].id).toBe(200);
    });
  });

  describe('refreshPlaces', () => {
    it('FE-PLACES-007: refreshPlaces re-fetches and replaces places array', async () => {
      const stale = buildPlace({ id: 99, trip_id: 1, name: 'Stale' });
      seedStore(useTripStore, { places: [stale] });

      const fresh = buildPlace({ trip_id: 1, name: 'Fresh' });
      server.use(
        http.get('/api/trips/1/places', () => HttpResponse.json({ places: [fresh] })),
      );

      await useTripStore.getState().refreshPlaces(1);

      const places = useTripStore.getState().places;
      expect(places).toHaveLength(1);
      expect(places[0].name).toBe('Fresh');
    });
  });
});
