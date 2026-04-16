// FE-STORE-JOURNEY-001 to FE-STORE-JOURNEY-015
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { useJourneyStore } from './journeyStore';
import type { JourneyDetail, JourneyEntry, JourneyPhoto } from './journeyStore';

const initialState = useJourneyStore.getState();

// ── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 100;
function nextId(): number {
  return ++_seq;
}

function buildJourney(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as number) ?? nextId();
  return {
    id,
    user_id: 1,
    title: `Journey ${id}`,
    subtitle: null,
    cover_gradient: null,
    cover_image: null,
    status: 'draft' as const,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function buildJourneyDetail(overrides: Record<string, unknown> = {}): JourneyDetail {
  const base = buildJourney(overrides);
  return {
    ...base,
    entries: [],
    trips: [],
    contributors: [],
    stats: { entries: 0, photos: 0, cities: 0 },
    ...(overrides as any),
  };
}

function buildEntry(overrides: Record<string, unknown> = {}): JourneyEntry {
  const id = (overrides.id as number) ?? nextId();
  return {
    id,
    journey_id: 1,
    source_trip_id: null,
    source_place_id: null,
    source_trip_name: null,
    author_id: 1,
    type: 'entry',
    title: `Entry ${id}`,
    story: null,
    entry_date: '2026-04-01',
    entry_time: null,
    location_name: null,
    location_lat: null,
    location_lng: null,
    mood: null,
    weather: null,
    tags: [],
    pros_cons: null,
    visibility: 'private',
    sort_order: 0,
    photos: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as JourneyEntry;
}

function buildPhoto(overrides: Record<string, unknown> = {}): JourneyPhoto {
  const id = (overrides.id as number) ?? nextId();
  return {
    id,
    entry_id: 1,
    provider: 'local',
    asset_id: null,
    owner_id: null,
    file_path: `/uploads/photo_${id}.jpg`,
    thumbnail_path: null,
    caption: null,
    sort_order: 0,
    width: null,
    height: null,
    shared: 0,
    created_at: Date.now(),
    ...overrides,
  } as JourneyPhoto;
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  useJourneyStore.setState(initialState, true);
  server.resetHandlers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('journeyStore', () => {
  // ── loadJourneys ─────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-001: loadJourneys populates store', async () => {
    const j1 = buildJourney({ id: 1 });
    const j2 = buildJourney({ id: 2 });
    server.use(
      http.get('/api/journeys', () =>
        HttpResponse.json({ journeys: [j1, j2] })
      )
    );
    await useJourneyStore.getState().loadJourneys();
    expect(useJourneyStore.getState().journeys).toHaveLength(2);
    expect(useJourneyStore.getState().journeys[0].id).toBe(1);
  });

  it('FE-STORE-JOURNEY-002: loadJourneys sets loading false on error', async () => {
    server.use(
      http.get('/api/journeys', () =>
        HttpResponse.json({ error: 'server error' }, { status: 500 })
      )
    );
    await expect(useJourneyStore.getState().loadJourneys()).rejects.toThrow();
    expect(useJourneyStore.getState().loading).toBe(false);
  });

  // ── loadJourney ──────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-003: loadJourney sets current journey', async () => {
    const detail = buildJourneyDetail({ id: 5 });
    server.use(
      http.get('/api/journeys/5', () =>
        HttpResponse.json(detail)
      )
    );
    await useJourneyStore.getState().loadJourney(5);
    expect(useJourneyStore.getState().current?.id).toBe(5);
    expect(useJourneyStore.getState().loading).toBe(false);
  });

  it('FE-STORE-JOURNEY-004: loadJourney sets loading false on error', async () => {
    server.use(
      http.get('/api/journeys/999', () =>
        HttpResponse.json({ error: 'not found' }, { status: 404 })
      )
    );
    await expect(useJourneyStore.getState().loadJourney(999)).rejects.toThrow();
    expect(useJourneyStore.getState().loading).toBe(false);
    expect(useJourneyStore.getState().notFound).toBe(true);
  });

  // ── createJourney ────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-005: createJourney adds to store and returns journey', async () => {
    const created = buildJourney({ id: 10, title: 'My Trip' });
    server.use(
      http.post('/api/journeys', () =>
        HttpResponse.json(created)
      )
    );
    const result = await useJourneyStore.getState().createJourney({ title: 'My Trip' });
    expect(result.id).toBe(10);
    expect(useJourneyStore.getState().journeys).toContainEqual(created);
  });

  it('FE-STORE-JOURNEY-006: createJourney throws on API error', async () => {
    server.use(
      http.post('/api/journeys', () =>
        HttpResponse.json({ error: 'Validation failed' }, { status: 422 })
      )
    );
    await expect(useJourneyStore.getState().createJourney({ title: '' })).rejects.toThrow();
  });

  // ── updateJourney ────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-007: updateJourney updates in list and current', async () => {
    const existing = buildJourney({ id: 20, title: 'Old' });
    const detail = buildJourneyDetail({ id: 20, title: 'Old' });
    useJourneyStore.setState({ journeys: [existing], current: detail });

    server.use(
      http.patch('/api/journeys/20', () =>
        HttpResponse.json({ title: 'New' })
      )
    );
    await useJourneyStore.getState().updateJourney(20, { title: 'New' });
    expect(useJourneyStore.getState().journeys[0].title).toBe('New');
    expect(useJourneyStore.getState().current?.title).toBe('New');
  });

  // ── deleteJourney ────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-008: deleteJourney removes from list', async () => {
    const j1 = buildJourney({ id: 30 });
    const j2 = buildJourney({ id: 31 });
    useJourneyStore.setState({ journeys: [j1, j2] });

    server.use(
      http.delete('/api/journeys/30', () =>
        HttpResponse.json({})
      )
    );
    await useJourneyStore.getState().deleteJourney(30);
    expect(useJourneyStore.getState().journeys).toHaveLength(1);
    expect(useJourneyStore.getState().journeys[0].id).toBe(31);
  });

  it('FE-STORE-JOURNEY-009: deleteJourney clears current if matching', async () => {
    const detail = buildJourneyDetail({ id: 40 });
    useJourneyStore.setState({ journeys: [buildJourney({ id: 40 })], current: detail });

    server.use(
      http.delete('/api/journeys/40', () =>
        HttpResponse.json({})
      )
    );
    await useJourneyStore.getState().deleteJourney(40);
    expect(useJourneyStore.getState().current).toBeNull();
  });

  // ── createEntry ──────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-010: createEntry adds entry to current', async () => {
    const detail = buildJourneyDetail({ id: 50 });
    useJourneyStore.setState({ current: detail });

    const newEntry = buildEntry({ id: 60, journey_id: 50 });
    server.use(
      http.post('/api/journeys/50/entries', () =>
        HttpResponse.json(newEntry)
      )
    );
    const result = await useJourneyStore.getState().createEntry(50, { title: 'Day 1' });
    expect(result.id).toBe(60);
    expect(useJourneyStore.getState().current?.entries).toHaveLength(1);
    expect(useJourneyStore.getState().current?.entries[0].id).toBe(60);
  });

  // ── updateEntry ──────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-011: updateEntry updates entry in current', async () => {
    const entry = buildEntry({ id: 70, title: 'Old Title' });
    const detail = buildJourneyDetail({ id: 50, entries: [entry] });
    useJourneyStore.setState({ current: detail });

    server.use(
      http.patch('/api/journeys/entries/70', () =>
        HttpResponse.json({ title: 'New Title' })
      )
    );
    await useJourneyStore.getState().updateEntry(70, { title: 'New Title' });
    expect(useJourneyStore.getState().current?.entries[0].title).toBe('New Title');
  });

  // ── deleteEntry ──────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-012: deleteEntry removes entry from current', async () => {
    const entry1 = buildEntry({ id: 80 });
    const entry2 = buildEntry({ id: 81 });
    const detail = buildJourneyDetail({ id: 50, entries: [entry1, entry2] });
    useJourneyStore.setState({ current: detail });

    server.use(
      http.delete('/api/journeys/entries/80', () =>
        HttpResponse.json({})
      )
    );
    await useJourneyStore.getState().deleteEntry(80);
    expect(useJourneyStore.getState().current?.entries).toHaveLength(1);
    expect(useJourneyStore.getState().current?.entries[0].id).toBe(81);
  });

  // ── uploadPhotos ─────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-013: uploadPhotos appends photos to entry', async () => {
    const existingPhoto = buildPhoto({ id: 90, entry_id: 100 });
    const entry = buildEntry({ id: 100, photos: [existingPhoto] });
    const detail = buildJourneyDetail({ id: 50, entries: [entry] });
    useJourneyStore.setState({ current: detail });

    const newPhoto = buildPhoto({ id: 91, entry_id: 100 });
    server.use(
      http.post('/api/journeys/entries/100/photos', () =>
        HttpResponse.json({ photos: [newPhoto] })
      )
    );
    const result = await useJourneyStore.getState().uploadPhotos(100, new FormData());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(91);
    const storedEntry = useJourneyStore.getState().current?.entries.find(e => e.id === 100);
    expect(storedEntry?.photos).toHaveLength(2);
  });

  // ── deletePhoto ──────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-014: deletePhoto removes photo from entry', async () => {
    const photo1 = buildPhoto({ id: 200, entry_id: 100 });
    const photo2 = buildPhoto({ id: 201, entry_id: 100 });
    const entry = buildEntry({ id: 100, photos: [photo1, photo2] });
    const detail = buildJourneyDetail({ id: 50, entries: [entry] });
    useJourneyStore.setState({ current: detail });

    server.use(
      http.delete('/api/journeys/photos/200', () =>
        HttpResponse.json({})
      )
    );
    await useJourneyStore.getState().deletePhoto(200);
    const storedEntry = useJourneyStore.getState().current?.entries.find(e => e.id === 100);
    expect(storedEntry?.photos).toHaveLength(1);
    expect(storedEntry?.photos[0].id).toBe(201);
  });

  // ── loadJourney silent refresh ───────────────────────────────────────────

  it('FE-STORE-JOURNEY-016: loadJourney does not set loading when refreshing same journey', async () => {
    const existing = buildJourneyDetail({ id: 5, title: 'Old' });
    useJourneyStore.setState({ current: existing, loading: false });

    const loadingValues: boolean[] = [];
    const unsub = useJourneyStore.subscribe(s => loadingValues.push(s.loading));

    const refreshed = buildJourneyDetail({ id: 5, title: 'Refreshed' });
    server.use(
      http.get('/api/journeys/5', () => HttpResponse.json(refreshed))
    );

    await useJourneyStore.getState().loadJourney(5);
    unsub();

    expect(loadingValues.every(v => v === false)).toBe(true);
    expect(useJourneyStore.getState().current?.title).toBe('Refreshed');
  });

  it('FE-STORE-JOURNEY-017: loadJourney sets loading on cold load (different journey)', async () => {
    const existing = buildJourneyDetail({ id: 5 });
    useJourneyStore.setState({ current: existing, loading: false });

    const loadingValues: boolean[] = [];
    const unsub = useJourneyStore.subscribe(s => loadingValues.push(s.loading));

    const other = buildJourneyDetail({ id: 99 });
    server.use(
      http.get('/api/journeys/99', () => HttpResponse.json(other))
    );

    await useJourneyStore.getState().loadJourney(99);
    unsub();

    expect(loadingValues).toContain(true);
    expect(useJourneyStore.getState().current?.id).toBe(99);
    expect(useJourneyStore.getState().loading).toBe(false);
  });

  // ── clear ────────────────────────────────────────────────────────────────

  it('FE-STORE-JOURNEY-015: clear resets state', () => {
    useJourneyStore.setState({
      journeys: [buildJourney()],
      current: buildJourneyDetail(),
      loading: true,
    });
    useJourneyStore.getState().clear();
    expect(useJourneyStore.getState().journeys).toEqual([]);
    expect(useJourneyStore.getState().current).toBeNull();
    expect(useJourneyStore.getState().loading).toBe(false);
  });
});
