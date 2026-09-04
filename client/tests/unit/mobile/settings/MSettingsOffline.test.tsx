// FE-MOB-OFFLINE-001 onwards
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor, within } from '../../../helpers/render';
import { resetAllStores, seedStore } from '../../../helpers/store';
import { buildTrip, buildUser } from '../../../helpers/factories';
import { server } from '../../../helpers/msw/server';
import { useAuthStore } from '../../../../src/store/authStore';
import { _resetNetworkMode } from '../../../../src/sync/networkMode';
import { _resetOfflinePrefs, getOfflinePrefs } from '../../../../src/sync/offlinePrefs';
import type { QueuedMutation, SyncMeta } from '../../../../src/db/offlineDb';
import type { PrepareProgress } from '../../../../src/sync/tripSyncManager';
import type { Trip } from '../../../../src/types';
import MSettingsOffline from '../../../../src/mobile/screens/settings/MSettingsOffline';

// Dexie, the sync manager, the mutation queue and the tile cache are the four
// side-effecting neighbours of this screen; everything else (network mode,
// offline prefs, the trips API) runs for real.
const h = vi.hoisted(() => {
  const syncMetaToArray = vi.fn();
  const tripsGet = vi.fn();
  const tripsToArray = vi.fn();
  const tripsCount = vi.fn();
  const placeCount = vi.fn();
  const fileCount = vi.fn();
  const counted = (fn: (id: number) => Promise<number>) => ({
    where: () => ({ equals: (id: number) => ({ count: () => fn(id) }) }),
  });
  return {
    syncMetaToArray, tripsGet, tripsToArray, tripsCount, placeCount, fileCount,
    fakeDb: {
      syncMeta: { toArray: syncMetaToArray },
      trips: { get: tripsGet, toArray: tripsToArray, count: tripsCount },
      places: counted(placeCount),
      tripFiles: counted(fileCount),
    },
    clearAll: vi.fn(),
    clearTripData: vi.fn(),
    prepareForOffline: vi.fn(),
    syncAll: vi.fn(),
    pendingCount: vi.fn(),
    failedCount: vi.fn(),
    conflicts: vi.fn(),
    resolveKeepMine: vi.fn(),
    resolveKeepServer: vi.fn(),
    clearTileCache: vi.fn(),
  };
});

vi.mock('../../../../src/db/offlineDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/db/offlineDb')>();
  return { ...actual, offlineDb: h.fakeDb, clearAll: h.clearAll, clearTripData: h.clearTripData };
});

vi.mock('../../../../src/sync/tripSyncManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/sync/tripSyncManager')>();
  return { ...actual, tripSyncManager: { prepareForOffline: h.prepareForOffline, syncAll: h.syncAll } };
});

vi.mock('../../../../src/sync/mutationQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/sync/mutationQueue')>();
  return {
    ...actual,
    mutationQueue: {
      pendingCount: h.pendingCount,
      failedCount: h.failedCount,
      conflicts: h.conflicts,
      resolveKeepMine: h.resolveKeepMine,
      resolveKeepServer: h.resolveKeepServer,
    },
  };
});

vi.mock('../../../../src/sync/tilePrefetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/sync/tilePrefetcher')>();
  return { ...actual, clearTileCache: h.clearTileCache };
});

const paris = buildTrip({ id: 1, title: 'Paris', start_date: '2025-06-01', end_date: '2025-06-05' });
const tokyo = buildTrip({ id: 2, title: 'Tokyo', start_date: '2025-09-01', end_date: '2025-09-15' });

const meta = (tripId: number, over: Partial<SyncMeta> = {}): SyncMeta => ({
  tripId,
  lastSyncedAt: null,
  status: 'idle',
  tilesBbox: null,
  filesCachedCount: 0,
  ...over,
});

const conflict = (over: Partial<QueuedMutation> = {}): QueuedMutation => ({
  id: 'c1',
  tripId: 1,
  method: 'PUT',
  url: '/trips/1/places/9',
  body: { name: 'Louvre' },
  createdAt: 0,
  status: 'conflict',
  attempts: 1,
  lastError: null,
  ...over,
});

/** Seed the Dexie cache with the given (trip, meta) pairs. */
function cache(rows: { trip: Trip; meta?: Partial<SyncMeta>; places?: number; files?: number }[]): void {
  h.syncMetaToArray.mockResolvedValue(rows.map(r => meta(r.trip.id, r.meta)));
  h.tripsCount.mockResolvedValue(rows.length);
  h.tripsGet.mockImplementation(async (id: number) => rows.find(r => r.trip.id === id)?.trip);
  h.placeCount.mockImplementation(async (id: number) => rows.find(r => r.trip.id === id)?.places ?? 0);
  h.fileCount.mockImplementation(async (id: number) => rows.find(r => r.trip.id === id)?.files ?? 0);
}

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

const card = (title: string) => screen.getByText(title).closest('section') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  _resetNetworkMode();
  _resetOfflinePrefs();
  setOnLine(true);
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });

  h.syncMetaToArray.mockResolvedValue([]);
  h.tripsGet.mockResolvedValue(undefined);
  h.tripsToArray.mockResolvedValue([]);
  h.tripsCount.mockResolvedValue(0);
  h.placeCount.mockResolvedValue(0);
  h.fileCount.mockResolvedValue(0);
  h.pendingCount.mockResolvedValue(0);
  h.failedCount.mockResolvedValue(0);
  h.conflicts.mockResolvedValue([]);
  h.clearAll.mockResolvedValue(undefined);
  h.clearTripData.mockResolvedValue(undefined);
  h.clearTileCache.mockResolvedValue(undefined);
  h.prepareForOffline.mockResolvedValue({ status: 'done', trips: 1 });
  h.syncAll.mockResolvedValue({ status: 'done', trips: 1 });
  h.resolveKeepMine.mockResolvedValue(undefined);
  h.resolveKeepServer.mockResolvedValue(undefined);

  server.use(http.get('/api/trips', () => HttpResponse.json({ trips: [paris, tokyo] })));
});

afterEach(() => {
  setOnLine(true);
});

describe('MSettingsOffline', () => {
  it('FE-MOB-OFFLINE-001: shows the loading line while the cache is being read', async () => {
    h.syncMetaToArray.mockReturnValue(new Promise(() => {}));
    render(<MSettingsOffline />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Offline mode')).toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-002: an empty cache reports zero stats and disables Clear cache', async () => {
    render(<MSettingsOffline />);

    expect(await screen.findByText('No trips cached yet. Connect to the internet to sync.')).toBeInTheDocument();
    const stats = card('Offline cache');
    expect(within(screen.getByText('Cached trips').parentElement as HTMLElement).getByText('0')).toBeInTheDocument();
    expect(within(stats).getByRole('button', { name: 'Clear cache' })).toBeDisabled();
    expect(screen.queryByText('Failed changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Conflicts')).not.toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-003: cached trips are listed oldest first with their place and file counts', async () => {
    cache([
      { trip: tokyo, places: 3, files: 1 },
      { trip: paris, places: 7, files: 2 },
    ]);
    render(<MSettingsOffline />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    const titles = within(cacheCard).getAllByText(/^(Paris|Tokyo)$/).map(el => el.textContent);
    expect(titles).toEqual(['Paris', 'Tokyo']);
    expect(within(cacheCard).getByText(/Jun 1, 2025 – Jun 5, 2025/)).toHaveTextContent('7');
    expect(within(screen.getByText('Cached trips').parentElement as HTMLElement).getByText('2')).toBeInTheDocument();
    // Never synced → the time column shows a dash.
    expect(within(cacheCard).getAllByText('—').length).toBe(2);
  });

  it('FE-MOB-OFFLINE-004: a sync-meta row without its trip in Dexie is dropped', async () => {
    h.syncMetaToArray.mockResolvedValue([meta(1), meta(99)]);
    h.tripsGet.mockImplementation(async (id: number) => (id === 1 ? paris : undefined));
    render(<MSettingsOffline />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    expect(within(screen.getByText('Cached trips').parentElement as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-005: pending, failed and conflict counters only appear when they are non-zero', async () => {
    h.pendingCount.mockResolvedValue(4);
    h.failedCount.mockResolvedValue(2);
    h.conflicts.mockResolvedValue([conflict()]);
    render(<MSettingsOffline />);

    await waitFor(() => expect(screen.getByText('Failed changes')).toBeInTheDocument());
    expect(within(screen.getByText('Pending changes').parentElement as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByText('Failed changes').parentElement as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByText('Conflicts').parentElement as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-006: conflicts are named from the queued body, the server copy or the entity id', async () => {
    h.conflicts.mockResolvedValue([
      conflict({ id: 'a', body: { name: 'Louvre' } }),
      conflict({ id: 'b', body: {}, conflictServer: { name: 'Server name' } }),
      conflict({ id: 'c', body: {}, entityId: 42 }),
    ]);
    render(<MSettingsOffline />);

    await screen.findByText('Sync conflicts');
    expect(screen.getByText(/Louvre/)).toBeInTheDocument();
    expect(screen.getByText(/Server name/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-007: keep-mine and keep-theirs resolve the right conflict and reload', async () => {
    const user = userEvent.setup();
    h.conflicts.mockResolvedValue([conflict({ id: 'a' }), conflict({ id: 'b', body: { name: 'Eiffel' } })]);
    render(<MSettingsOffline />);

    const row = (await screen.findByText(/Eiffel/)).parentElement as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Keep mine' }));
    expect(h.resolveKeepMine).toHaveBeenCalledWith('b');

    await user.click(within(row).getByRole('button', { name: 'Keep theirs' }));
    expect(h.resolveKeepServer).toHaveBeenCalledWith('b');
    // Both resolutions re-read the cache (once on mount + once per resolution).
    await waitFor(() => expect(h.conflicts).toHaveBeenCalledTimes(3));
  });

  it('FE-MOB-OFFLINE-008: the conflict strategy segments persist the choice', async () => {
    const user = userEvent.setup();
    h.conflicts.mockResolvedValue([conflict()]);
    render(<MSettingsOffline />);

    await screen.findByText('When a conflict happens');
    expect(screen.getByRole('button', { name: 'Ask me each time' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Always keep my version' }));
    expect(getOfflinePrefs().conflictStrategy).toBe('mine');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Always keep my version' })).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('FE-MOB-OFFLINE-009: Prepare renders live progress and the done marker', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.prepareForOffline.mockImplementation(async (cb: (p: PrepareProgress) => void) => {
      cb({ phase: 'files', current: 1, total: 4, label: 'Paris' });
      await new Promise<void>(resolve => { release = resolve; });
      cb({ phase: 'done', current: 4, total: 4 });
      return { status: 'done', trips: 4 };
    });
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    expect(await screen.findByText('Documents · 1/4 · Paris')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();

    await act(async () => { release(); });
    expect(await screen.findByText('Stored 4 trip(s) on this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeEnabled();
  });

  it('FE-MOB-OFFLINE-010: a progress report without a total renders a full bar', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.prepareForOffline.mockImplementation(async (cb: (p: PrepareProgress) => void) => {
      cb({ phase: 'tiles', current: 0, total: 0 });
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'done', trips: 1 };
    });
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    const label = await screen.findByText('Map tiles · 0/0');
    const bar = label.previousElementSibling?.firstElementChild as HTMLElement;
    expect(bar).toHaveStyle({ width: '100%' });
    await act(async () => { release(); });
  });

  it('FE-MOB-OFFLINE-011: forcing offline downloads first, then engages and locks the actions', async () => {
    const user = userEvent.setup();
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('switch', { name: 'Force offline mode' }));

    expect(h.prepareForOffline).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Offline mode is on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-sync now' })).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'Force offline mode' }));
    await waitFor(() => expect(screen.queryByText(/Offline mode is on/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Re-sync now' })).toBeEnabled();
  });

  it('FE-MOB-OFFLINE-012: forcing offline while already disconnected skips the download', async () => {
    const user = userEvent.setup();
    setOnLine(false);
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    // Already offline: prepare/resync are dead, and flipping the switch cannot download.
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Force offline mode' }));

    expect(h.prepareForOffline).not.toHaveBeenCalled();
    expect(await screen.findByText(/Offline mode is on/)).toBeInTheDocument();
    // Offline, the trip list comes out of Dexie instead of the API.
    expect(h.tripsToArray).toHaveBeenCalled();
  });

  it('FE-MOB-OFFLINE-013: Re-sync runs syncAll and re-reads the cache', async () => {
    const user = userEvent.setup();
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Re-sync now' }));

    expect(h.syncAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.syncMetaToArray).toHaveBeenCalledTimes(2));
  });

  it('FE-MOB-OFFLINE-014: turning map tiles off drops the tile cache, turning them back on does not', async () => {
    const user = userEvent.setup();
    render(<MSettingsOffline />);

    const toggle = await screen.findByRole('switch', { name: 'Store map tiles offline' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(getOfflinePrefs().cacheTiles).toBe(false);
    expect(h.clearTileCache).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

    await user.click(toggle);
    expect(getOfflinePrefs().cacheTiles).toBe(true);
    expect(h.clearTileCache).toHaveBeenCalledTimes(1);
  });

  it('FE-MOB-OFFLINE-015: switching a finished trip on pins and re-syncs it, switching it off evicts it', async () => {
    const user = userEvent.setup();
    render(<MSettingsOffline />);

    // Both fixture trips ended in 2025, so the date rule would skip them and the
    // switch has to say so rather than promising storage that never happens.
    const toggle = await screen.findByRole('switch', { name: 'Tokyo' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText(/Not stored · Finished/)).toHaveLength(2);

    await user.click(toggle);
    await waitFor(() => expect(h.syncAll).toHaveBeenCalledTimes(1));
    expect(getOfflinePrefs().pinnedTripIds).toEqual([2]);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Tokyo' })).toHaveAttribute('aria-checked', 'true'));

    await user.click(screen.getByRole('switch', { name: 'Tokyo' }));
    expect(h.clearTripData).toHaveBeenCalledWith(2);
    expect(getOfflinePrefs().pinnedTripIds).toEqual([]);
  });

  it('FE-MOB-OFFLINE-022: a sync that never ran says so instead of reporting success', async () => {
    const user = userEvent.setup();
    h.prepareForOffline.mockResolvedValue({ status: 'skipped', reason: 'offline' });
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    expect(await screen.findByText('No connection. Connect to store trips for offline use.')).toBeInTheDocument();
    expect(screen.queryByText(/Stored .* trip/)).not.toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-016: the per-trip section disappears when there are no trips at all', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ trips: [] })));
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    expect(screen.queryByText('Trips')).not.toBeInTheDocument();
    expect(screen.getByText('Store map tiles offline')).toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-017: a failing trips API falls back to the Dexie copy', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
    h.tripsToArray.mockResolvedValue([tokyo, paris]);
    render(<MSettingsOffline />);

    await screen.findByRole('switch', { name: 'Paris' });
    // Dexie rows are sorted by start date too.
    const rows = screen.getAllByRole('switch').map(el => el.getAttribute('aria-label'));
    expect(rows).toEqual(['Force offline mode', 'Store map tiles offline', 'Paris', 'Tokyo']);
  });

  it('FE-MOB-OFFLINE-018: when both the API and Dexie fail the trip list is simply empty', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
    h.tripsToArray.mockRejectedValue(new Error('dexie is gone'));
    render(<MSettingsOffline />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    expect(screen.queryByText('Trips')).not.toBeInTheDocument();
  });

  it('FE-MOB-OFFLINE-019: Clear cache asks first and can be cancelled', async () => {
    const user = userEvent.setup();
    cache([{ trip: paris }]);
    render(<MSettingsOffline />);

    await waitFor(() => expect(within(card('Offline cache')).getByRole('button', { name: 'Clear cache' })).toBeEnabled());
    await user.click(within(card('Offline cache')).getByRole('button', { name: 'Clear cache' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Clear all offline trip data/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(h.clearAll).not.toHaveBeenCalled();
  });

  it('FE-MOB-OFFLINE-020: confirming Clear cache wipes the database and reloads', async () => {
    const user = userEvent.setup();
    cache([{ trip: paris }]);
    render(<MSettingsOffline />);

    await waitFor(() => expect(within(card('Offline cache')).getByRole('button', { name: 'Clear cache' })).toBeEnabled());
    await user.click(within(card('Offline cache')).getByRole('button', { name: 'Clear cache' }));

    const dialog = await screen.findByRole('dialog');
    h.syncMetaToArray.mockResolvedValue([]);
    await user.click(within(dialog).getByRole('button', { name: 'Clear cache' }));

    expect(h.clearAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('No trips cached yet. Connect to the internet to sync.')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('FE-MOB-OFFLINE-021: a synced trip shows its last sync time instead of a dash', async () => {
    const at = new Date('2025-06-02T09:30:00Z').getTime();
    cache([{ trip: paris, meta: { lastSyncedAt: at } }]);
    render(<MSettingsOffline />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    const expected = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(within(cacheCard).getByText(expected)).toBeInTheDocument();
  });
});
