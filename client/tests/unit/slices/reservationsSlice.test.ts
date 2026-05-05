import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildReservation } from '../../helpers/factories';
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

describe('reservationsSlice', () => {
  describe('loadReservations', () => {
    it('FE-RESERV-001: loadReservations fetches and replaces reservations', async () => {
      seedStore(useTripStore, { reservations: [] });

      const reservation = buildReservation({ trip_id: 1 });
      server.use(
        http.get('/api/trips/1/reservations', () =>
          HttpResponse.json({ reservations: [reservation] })
        ),
      );

      await useTripStore.getState().loadReservations(1);

      expect(useTripStore.getState().reservations).toHaveLength(1);
      expect(useTripStore.getState().reservations[0].id).toBe(reservation.id);
    });
  });

  describe('addReservation', () => {
    it('FE-RESERV-002: addReservation prepends to reservations array', async () => {
      const existing = buildReservation({ trip_id: 1, name: 'Existing' });
      seedStore(useTripStore, { reservations: [existing] });

      const result = await useTripStore.getState().addReservation(1, {
        name: 'New Hotel',
        type: 'hotel',
        status: 'pending',
      });

      expect(result.name).toBe('New Hotel');
      const reservations = useTripStore.getState().reservations;
      expect(reservations).toHaveLength(2);
      // addReservation prepends
      expect(reservations[0].name).toBe('New Hotel');
    });

    it('FE-RESERV-003: addReservation always adds optimistically (no throw on API error)', async () => {
      server.use(
        http.post('/api/trips/1/reservations', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      const result = await useTripStore.getState().addReservation(1, { name: 'Fail' });

      expect(result.name).toBe('Fail');
      expect(useTripStore.getState().reservations).toHaveLength(1);
      expect(useTripStore.getState().reservations[0].name).toBe('Fail');
    });
  });

  describe('updateReservation', () => {
    it('FE-RESERV-004: updateReservation replaces item in array by id', async () => {
      const reservation = buildReservation({ id: 10, trip_id: 1, name: 'Old', status: 'pending' });
      seedStore(useTripStore, { reservations: [reservation] });

      server.use(
        http.put('/api/trips/1/reservations/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ reservation: { ...reservation, ...body } });
        }),
      );

      const result = await useTripStore.getState().updateReservation(1, 10, { name: 'Updated Hotel' });

      expect(result.name).toBe('Updated Hotel');
      expect(useTripStore.getState().reservations[0].name).toBe('Updated Hotel');
    });
  });

  describe('toggleReservationStatus', () => {
    it('FE-RESERV-005: toggleReservationStatus flips confirmed to pending optimistically', async () => {
      const reservation = buildReservation({ id: 10, trip_id: 1, status: 'confirmed' });
      seedStore(useTripStore, { reservations: [reservation] });

      server.use(
        http.put('/api/trips/1/reservations/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ reservation: { ...reservation, ...body } });
        }),
      );

      await useTripStore.getState().toggleReservationStatus(1, 10);

      expect(useTripStore.getState().reservations[0].status).toBe('pending');
    });

    it('FE-RESERV-006: toggleReservationStatus flips pending to confirmed optimistically', async () => {
      const reservation = buildReservation({ id: 10, trip_id: 1, status: 'pending' });
      seedStore(useTripStore, { reservations: [reservation] });

      server.use(
        http.put('/api/trips/1/reservations/10', async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ reservation: { ...reservation, ...body } });
        }),
      );

      await useTripStore.getState().toggleReservationStatus(1, 10);

      expect(useTripStore.getState().reservations[0].status).toBe('confirmed');
    });

    it('FE-RESERV-007: toggleReservationStatus preserves optimistic status even on API failure', async () => {
      const reservation = buildReservation({ id: 10, trip_id: 1, status: 'confirmed' });
      seedStore(useTripStore, { reservations: [reservation] });

      server.use(
        http.put('/api/trips/1/reservations/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().toggleReservationStatus(1, 10);

      // Optimistic state preserved — no rollback (queued for sync)
      expect(useTripStore.getState().reservations[0].status).toBe('pending');
    });

    it('FE-RESERV-008: toggleReservationStatus does nothing if reservation not found', async () => {
      seedStore(useTripStore, { reservations: [] });

      // Should not throw
      await useTripStore.getState().toggleReservationStatus(1, 999);

      expect(useTripStore.getState().reservations).toHaveLength(0);
    });
  });

  describe('deleteReservation', () => {
    it('FE-RESERV-009: deleteReservation removes from reservations after API success', async () => {
      const r1 = buildReservation({ id: 10, trip_id: 1 });
      const r2 = buildReservation({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { reservations: [r1, r2] });

      await useTripStore.getState().deleteReservation(1, 10);

      const reservations = useTripStore.getState().reservations;
      expect(reservations).toHaveLength(1);
      expect(reservations[0].id).toBe(20);
    });

    it('FE-RESERV-010: deleteReservation removes permanently even on API error', async () => {
      const reservation = buildReservation({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { reservations: [reservation] });

      server.use(
        http.delete('/api/trips/1/reservations/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().deleteReservation(1, 10);

      // Permanently removed (queued for sync, no rollback)
      expect(useTripStore.getState().reservations).toHaveLength(0);
    });
  });
});
