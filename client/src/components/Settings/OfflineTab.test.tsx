// FE-COMP-OFFLINETAB-001 to FE-COMP-OFFLINETAB-028
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor, within } from '../../../tests/helpers/render';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildTrip, buildUser } from '../../../tests/helpers/factories';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { _resetNetworkMode } from '../../sync/networkMode';
import { _resetOfflinePrefs, getOfflinePrefs } from '../../sync/offlinePrefs';
import type { QueuedMutation, SyncMeta } from '../../db/offlineDb';
import type { PrepareProgress } from '../../sync/tripSyncManager';
import type { Trip } from '../../types';
import OfflineTab from './OfflineTab';

// Dexie, the sync manager, the mutation queue and the tile cache are the four
// side-effecting neighbours of this tab; network mode, offline prefs and the
// trips API run for real.
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

vi.mock('../../db/offlineDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/offlineDb')>();
  return { ...actual, offlineDb: h.fakeDb, clearAll: h.clearAll, clearTripData: h.clearTripData };
});

vi.mock('../../sync/tripSyncManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/tripSyncManager')>();
  return { ...actual, tripSyncManager: { prepareForOffline: h.prepareForOffline, syncAll: h.syncAll } };
});

vi.mock('../../sync/mutationQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/mutationQueue')>();
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

vi.mock('../../sync/tilePrefetcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/tilePrefetcher')>();
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

/** The Section wrapper card that carries the given heading. */
const card = (title: string) => screen.getByText(title).closest('div.rounded-xl') as HTMLElement;

/** The Stat tile that carries the given label. */
const stat = (label: string) => screen.getByText(label).parentElement as HTMLElement;

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
  vi.restoreAllMocks();
});

describe('OfflineTab', () => {
  it('FE-COMP-OFFLINETAB-001: shows the loading line while the cache is being read', () => {
    h.syncMetaToArray.mockReturnValue(new Promise(() => {}));
    render(<OfflineTab />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Offline mode')).toBeInTheDocument();
    expect(screen.queryByText('No trips cached yet. Connect to the internet to sync.')).not.toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-002: an empty cache reports zero stats and disables Clear cache', async () => {
    render(<OfflineTab />);

    expect(await screen.findByText('No trips cached yet. Connect to the internet to sync.')).toBeInTheDocument();
    expect(within(stat('Cached trips')).getByText('0')).toBeInTheDocument();
    expect(within(stat('Pending changes')).getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear cache' })).toBeDisabled();
    expect(screen.queryByText('Failed changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Conflicts')).not.toBeInTheDocument();
    expect(screen.queryByText('Sync conflicts')).not.toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-003: cached trips are listed oldest first with their place and file counts', async () => {
    cache([
      { trip: tokyo, places: 3, files: 1 },
      { trip: paris, places: 7, files: 2 },
    ]);
    render(<OfflineTab />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    const titles = within(cacheCard).getAllByText(/^(Paris|Tokyo)$/).map(el => el.textContent);
    expect(titles).toEqual(['Paris', 'Tokyo']);
    expect(within(cacheCard).getByText(/Jun 1, 2025 – Jun 5, 2025/)).toHaveTextContent('7');
    expect(within(cacheCard).getByText(/Sep 1, 2025 – Sep 15, 2025/)).toHaveTextContent('3');
    expect(within(stat('Cached trips')).getByText('2')).toBeInTheDocument();
    // Never synced → the time column shows a dash.
    expect(within(cacheCard).getAllByText('—')).toHaveLength(2);
  });

  it('FE-COMP-OFFLINETAB-004: a trip without dates renders dashes instead of a range', async () => {
    cache([{ trip: buildTrip({ id: 3, title: 'Someday', start_date: null, end_date: null }) }]);
    render(<OfflineTab />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Someday')).toBeInTheDocument());
    expect(within(cacheCard).getByText(/— – —/)).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-005: a sync-meta row without its trip in Dexie is dropped', async () => {
    h.syncMetaToArray.mockResolvedValue([meta(1), meta(99)]);
    h.tripsGet.mockImplementation(async (id: number) => (id === 1 ? paris : undefined));
    render(<OfflineTab />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    expect(within(stat('Cached trips')).getByText('1')).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-006: a synced trip shows its last sync time instead of a dash', async () => {
    const at = new Date('2025-06-02T09:30:00Z').getTime();
    cache([{ trip: paris, meta: { lastSyncedAt: at } }]);
    render(<OfflineTab />);

    const cacheCard = card('Offline cache');
    await waitFor(() => expect(within(cacheCard).getByText('Paris')).toBeInTheDocument());
    const expected = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(within(cacheCard).getByText(expected)).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-007: pending, failed and conflict counters only appear when they are non-zero', async () => {
    h.pendingCount.mockResolvedValue(4);
    h.failedCount.mockResolvedValue(2);
    h.conflicts.mockResolvedValue([conflict()]);
    render(<OfflineTab />);

    await waitFor(() => expect(screen.getByText('Failed changes')).toBeInTheDocument());
    expect(within(stat('Pending changes')).getByText('4')).toBeInTheDocument();
    expect(within(stat('Failed changes')).getByText('2')).toBeInTheDocument();
    expect(within(stat('Conflicts')).getByText('1')).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-008: conflicts are named from the queued body, the server copy or the entity id', async () => {
    h.conflicts.mockResolvedValue([
      conflict({ id: 'a', body: { name: 'Louvre' } }),
      conflict({ id: 'b', body: {}, conflictServer: { name: 'Server name' } }),
      conflict({ id: 'c', body: {}, entityId: 42 }),
    ]);
    render(<OfflineTab />);

    await screen.findByText('Sync conflicts');
    expect(screen.getByText(/Louvre/)).toBeInTheDocument();
    expect(screen.getByText(/Server name/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-009: keep-mine and keep-theirs resolve the right conflict and reload', async () => {
    const user = userEvent.setup();
    h.conflicts.mockResolvedValue([conflict({ id: 'a' }), conflict({ id: 'b', body: { name: 'Eiffel' } })]);
    render(<OfflineTab />);

    const row = (await screen.findByText(/Eiffel/)).parentElement as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Keep mine' }));
    expect(h.resolveKeepMine).toHaveBeenCalledWith('b');
    expect(h.resolveKeepServer).not.toHaveBeenCalled();

    await user.click(within(row).getByRole('button', { name: 'Keep theirs' }));
    expect(h.resolveKeepServer).toHaveBeenCalledWith('b');
    // Both resolutions re-read the cache (once on mount + once per resolution).
    await waitFor(() => expect(h.conflicts).toHaveBeenCalledTimes(3));
  });

  it('FE-COMP-OFFLINETAB-010: the conflict strategy select persists the choice', async () => {
    const user = userEvent.setup();
    h.conflicts.mockResolvedValue([conflict()]);
    render(<OfflineTab />);

    await screen.findByText('When a conflict happens');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('ask');

    await user.selectOptions(select, 'server');
    expect(getOfflinePrefs().conflictStrategy).toBe('server');
    await waitFor(() => expect(select.value).toBe('server'));
  });

  it('FE-COMP-OFFLINETAB-011: Prepare renders live progress and the done marker', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.prepareForOffline.mockImplementation(async (cb: (p: PrepareProgress) => void) => {
      cb({ phase: 'files', current: 1, total: 4, label: 'Paris' });
      await new Promise<void>(resolve => { release = resolve; });
      cb({ phase: 'done', current: 4, total: 4 });
      return { status: 'done', trips: 4 };
    });
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    expect(await screen.findByText('Documents · 1/4 · Paris')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled();

    await act(async () => { release(); });
    expect(await screen.findByText('Stored 4 trip(s) on this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeEnabled();
  });

  it('FE-COMP-OFFLINETAB-012: a progress report without a total renders a full bar', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.prepareForOffline.mockImplementation(async (cb: (p: PrepareProgress) => void) => {
      cb({ phase: 'tiles', current: 0, total: 0 });
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'done', trips: 1 };
    });
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    const label = await screen.findByText('Map tiles · 0/0');
    const bar = label.previousElementSibling?.firstElementChild as HTMLElement;
    expect(bar).toHaveStyle({ width: '100%' });
    await act(async () => { release(); });
  });

  it('FE-COMP-OFFLINETAB-013: a half-finished trips phase renders a proportional bar', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.prepareForOffline.mockImplementation(async (cb: (p: PrepareProgress) => void) => {
      cb({ phase: 'trips', current: 1, total: 4 });
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'done', trips: 4 };
    });
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    const label = await screen.findByText('Trip data · 1/4');
    const bar = label.previousElementSibling?.firstElementChild as HTMLElement;
    expect(bar).toHaveStyle({ width: '25%' });
    await act(async () => { release(); });
  });

  it('FE-COMP-OFFLINETAB-014: forcing offline downloads first, then engages and locks the actions', async () => {
    const user = userEvent.setup();
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Force offline mode' }));

    expect(h.prepareForOffline).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Offline mode is on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-sync now' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Force offline mode' }));
    await waitFor(() => expect(screen.queryByText(/Offline mode is on/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Re-sync now' })).toBeEnabled();
  });

  it('FE-COMP-OFFLINETAB-015: forcing offline while already disconnected skips the download', async () => {
    const user = userEvent.setup();
    setOnLine(false);
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Force offline mode' }));

    expect(h.prepareForOffline).not.toHaveBeenCalled();
    expect(await screen.findByText(/Offline mode is on/)).toBeInTheDocument();
    // Offline, the trip list comes out of Dexie instead of the API.
    expect(h.tripsToArray).toHaveBeenCalled();
  });

  it('FE-COMP-OFFLINETAB-016: Re-sync runs syncAll and re-reads the cache', async () => {
    const user = userEvent.setup();
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Re-sync now' }));

    expect(h.syncAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.syncMetaToArray).toHaveBeenCalledTimes(2));
  });

  it('FE-COMP-OFFLINETAB-017: Re-sync shows the syncing label while it runs', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    h.syncAll.mockImplementation(() => new Promise(resolve => { release = () => resolve({ status: 'done', trips: 1 }); }));
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Re-sync now' }));

    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    await act(async () => { release(); });
    expect(await screen.findByRole('button', { name: 'Re-sync now' })).toBeEnabled();
  });

  it('FE-COMP-OFFLINETAB-018: turning map tiles off drops the tile cache, turning them back on does not', async () => {
    const user = userEvent.setup();
    render(<OfflineTab />);

    const toggle = await screen.findByRole('button', { name: 'Store map tiles offline' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(toggle);
    expect(getOfflinePrefs().cacheTiles).toBe(false);
    expect(h.clearTileCache).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'false'));

    await user.click(toggle);
    expect(getOfflinePrefs().cacheTiles).toBe(true);
    expect(h.clearTileCache).toHaveBeenCalledTimes(1);
  });

  it('FE-COMP-OFFLINETAB-019: switching a finished trip on pins and re-syncs it, switching it off evicts it', async () => {
    const user = userEvent.setup();
    render(<OfflineTab />);

    // Both fixture trips ended in 2025, so the date rule would skip them: the
    // switch has to read "off" rather than promising storage that never happens.
    const toggle = await screen.findByRole('button', { name: 'Tokyo' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByText(/Not stored · Finished/)).toHaveLength(2);

    await user.click(toggle);
    await waitFor(() => expect(h.syncAll).toHaveBeenCalledTimes(1));
    expect(getOfflinePrefs().pinnedTripIds).toEqual([2]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tokyo' })).toHaveAttribute('aria-pressed', 'true'));

    await user.click(screen.getByRole('button', { name: 'Tokyo' }));
    expect(h.clearTripData).toHaveBeenCalledWith(2);
    // Turning it off releases the pin, so "off then on" cannot leave it pinned.
    expect(getOfflinePrefs().pinnedTripIds).toEqual([]);
  });

  it('FE-COMP-OFFLINETAB-025: an ongoing trip is stored without needing a pin', async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const ongoing = buildTrip({ id: 7, title: 'Lisbon', start_date: '2025-01-01', end_date: soon });
    server.use(http.get('/api/trips', () => HttpResponse.json({ trips: [ongoing] })));
    render(<OfflineTab />);

    const toggle = await screen.findByRole('button', { name: 'Lisbon' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Stored offline')).toBeInTheDocument();
    expect(getOfflinePrefs().pinnedTripIds).toEqual([]);
  });

  it('FE-COMP-OFFLINETAB-026: a sync that never ran says so instead of reporting success', async () => {
    const user = userEvent.setup();
    h.prepareForOffline.mockResolvedValue({ status: 'skipped', reason: 'busy' });
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    expect(await screen.findByText('A sync is already running. Try again in a moment.')).toBeInTheDocument();
    expect(screen.queryByText(/Stored .* trip/)).not.toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-028: a download that throws is reported instead of leaving the last frame up', async () => {
    const user = userEvent.setup();
    h.prepareForOffline.mockRejectedValue(new Error('network went away'));
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await user.click(screen.getByRole('button', { name: 'Download for offline use' }));

    expect(await screen.findByText('The download could not finish. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download for offline use' })).toBeEnabled();
  });

  it('FE-COMP-OFFLINETAB-027: an unreadable offline database is reported, not shown as empty', async () => {
    h.syncMetaToArray.mockRejectedValue(new Error('DatabaseClosedError'));
    render(<OfflineTab />);

    expect(await screen.findByText(/Could not read this device’s offline storage/)).toBeInTheDocument();
    expect(screen.queryByText('No trips cached yet. Connect to the internet to sync.')).not.toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-020: the per-trip section disappears when there are no trips at all', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ trips: [] })));
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    expect(screen.queryByText('Trips')).not.toBeInTheDocument();
    expect(screen.getByText('Store map tiles offline')).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-021: a failing trips API falls back to the Dexie copy', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
    h.tripsToArray.mockResolvedValue([tokyo, paris]);
    render(<OfflineTab />);

    await screen.findByRole('button', { name: 'Paris' });
    // Dexie rows are sorted by start date too.
    const labels = screen.getAllByRole('button')
      .map(el => el.getAttribute('aria-label'))
      .filter((l): l is string => l !== null);
    expect(labels).toEqual(['Force offline mode', 'Store map tiles offline', 'Paris', 'Tokyo']);
  });

  it('FE-COMP-OFFLINETAB-022: when both the API and Dexie fail the trip list is simply empty', async () => {
    server.use(http.get('/api/trips', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
    h.tripsToArray.mockRejectedValue(new Error('dexie is gone'));
    render(<OfflineTab />);

    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    expect(screen.queryByText('Trips')).not.toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-023: Clear cache asks first and a declined confirm keeps the data', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    cache([{ trip: paris }]);
    render(<OfflineTab />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear cache' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Clear cache' }));

    expect(confirmSpy).toHaveBeenCalledWith('Clear all offline trip data? You can re-sync anytime while online.');
    expect(h.clearAll).not.toHaveBeenCalled();
    expect(within(card('Offline cache')).getByText('Paris')).toBeInTheDocument();
  });

  it('FE-COMP-OFFLINETAB-024: confirming Clear cache wipes the database and reloads', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    cache([{ trip: paris }]);
    render(<OfflineTab />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear cache' })).toBeEnabled());
    h.syncMetaToArray.mockResolvedValue([]);
    h.tripsCount.mockResolvedValue(0);
    await user.click(screen.getByRole('button', { name: 'Clear cache' }));

    expect(h.clearAll).toHaveBeenCalledTimes(1);
    await screen.findByText('No trips cached yet. Connect to the internet to sync.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear cache' })).toBeDisabled());
  });
});
