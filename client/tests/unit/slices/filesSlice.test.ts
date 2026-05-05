import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../../src/store/tripStore';
import { filesApi } from '../../../src/api/client';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildTripFile } from '../../helpers/factories';
import { server } from '../../helpers/msw/server';

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

beforeEach(() => {
  resetAllStores();
});

describe('filesSlice', () => {
  describe('loadFiles', () => {
    it('FE-FILES-001: loadFiles fetches and replaces files array', async () => {
      const staleFile = buildTripFile({ trip_id: 1, filename: 'stale.pdf' });
      seedStore(useTripStore, { files: [staleFile] });

      const freshFile = buildTripFile({ trip_id: 1, filename: 'fresh.pdf' });
      server.use(
        http.get('/api/trips/1/files', () => HttpResponse.json({ files: [freshFile] })),
      );

      await useTripStore.getState().loadFiles(1);

      const files = useTripStore.getState().files;
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('fresh.pdf');
    });

    it('FE-FILES-002: loadFiles silently catches errors', async () => {
      server.use(
        http.get('/api/trips/1/files', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      // Should not throw
      await useTripStore.getState().loadFiles(1);
    });
  });

  describe('addFile', () => {
    it('FE-FILES-003: addFile uploads and prepends file to files array', async () => {
      const existing = buildTripFile({ trip_id: 1, filename: 'existing.pdf' });
      seedStore(useTripStore, { files: [existing] });

      const uploaded = buildTripFile({ trip_id: 1, filename: 'new-upload.pdf' });
      // FormData POST hangs on CI — mock at the API boundary instead of MSW.
      const uploadSpy = vi.spyOn(filesApi, 'upload').mockResolvedValueOnce({ file: uploaded });

      const formData = new FormData();
      formData.append('file', new Blob(['content'], { type: 'application/pdf' }), 'new-upload.pdf');

      const result = await useTripStore.getState().addFile(1, formData);
      uploadSpy.mockRestore();

      expect(result.filename).toBe('new-upload.pdf');
      const files = useTripStore.getState().files;
      expect(files).toHaveLength(2);
      // prepends
      expect(files[0].filename).toBe('new-upload.pdf');
    });

    it('FE-FILES-004: addFile on failure throws', async () => {
      server.use(
        http.post('/api/trips/1/files', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      const formData = new FormData();

      await expect(useTripStore.getState().addFile(1, formData)).rejects.toThrow();
    });
  });

  describe('deleteFile', () => {
    it('FE-FILES-005: deleteFile removes file from array after API success', async () => {
      const file1 = buildTripFile({ id: 10, trip_id: 1 });
      const file2 = buildTripFile({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { files: [file1, file2] });

      await useTripStore.getState().deleteFile(1, 10);

      const files = useTripStore.getState().files;
      expect(files).toHaveLength(1);
      expect(files[0].id).toBe(20);
    });

    it('FE-FILES-006: deleteFile removes file permanently even on API error', async () => {
      const file = buildTripFile({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { files: [file] });

      server.use(
        http.delete('/api/trips/1/files/10', () =>
          HttpResponse.json({ message: 'Error' }, { status: 500 })
        ),
      );

      await useTripStore.getState().deleteFile(1, 10);

      // Permanently removed (queued for sync, no rollback)
      expect(useTripStore.getState().files).toHaveLength(0);
    });
  });
});
