// FE-JRN-PUBWIRE-001 to FE-JRN-PUBWIRE-023
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../../tests/helpers/render';
import { useSettingsStore } from '../store/settingsStore';
import { groupByDate, type PublicEntry, type PublicGalleryPhoto } from './journeyPublic/journeyPublicModel';
import JourneyPublicPage from './JourneyPublicPage';

const mocks = vi.hoisted(() => ({
  pub: {} as Record<string, unknown>,
  captured: {} as Record<string, Record<string, unknown>>,
}));

vi.mock('./journeyPublic/useJourneyPublic', () => ({ useJourneyPublic: () => mocks.pub }));

function capture(name: string, testId: string) {
  return (props: Record<string, unknown>) => {
    mocks.captured[name] = props;
    return <div data-testid={testId} />;
  };
}

vi.mock('../components/Journey/JourneyMap', async () => {
  const React = await import('react');
  const Comp = React.forwardRef((props: Record<string, unknown>, _ref: React.Ref<unknown>) => {
    mocks.captured.map = props;
    return <div data-testid="public-map" data-height={String(props.height)} />;
  });
  Comp.displayName = 'MockJourneyMap';
  return { __esModule: true, default: Comp };
});

vi.mock('../components/Journey/MobileMapTimeline', () => ({ default: capture('mobileTimeline', 'mobile-timeline') }));
vi.mock('../components/Journey/MobileEntryView', () => ({ default: capture('mobileEntry', 'mobile-entry') }));
vi.mock('../components/Journey/PhotoLightbox', () => ({ default: capture('lightbox', 'lightbox') }));
vi.mock('../components/Journey/JournalBody', () => ({
  default: ({ text }: { text: string }) => <div data-testid="journal-body">{text}</div>,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function photo(id: number): PublicEntry['photos'][number] {
  return { id, entry_id: 1, photo_id: id * 10, caption: `caption ${id}`, provider: 'local' };
}

function buildEntry(over: Partial<PublicEntry> = {}): PublicEntry {
  return {
    id: 1, title: 'Arrival', story: null, entry_date: '2026-05-01', entry_time: '09:30',
    location_name: 'Tokyo, Japan', location_lat: 35.6, location_lng: 139.7,
    mood: null, weather: null, pros_cons: null, photos: [],
    ...over,
  };
}

const highlightMarker = vi.fn();

function buildHook(over: Record<string, unknown> = {}): Record<string, unknown> {
  const entries = (over.timelineEntries as PublicEntry[]) ?? [buildEntry()];
  const grouped = groupByDate(entries);
  return {
    token: 'tok-1',
    data: { journey: { title: 'Japan 2026' } },
    loading: false,
    error: false,
    isMobile: false,
    locale: 'en',
    view: 'timeline',
    setView: vi.fn(),
    lightbox: null,
    setLightbox: vi.fn(),
    showLangPicker: false,
    setShowLangPicker: vi.fn(),
    mapRef: { current: { highlightMarker } },
    activeEntryId: null,
    setActiveEntryId: vi.fn(),
    viewingEntry: null,
    setViewingEntry: vi.fn(),
    handleMarkerClick: vi.fn(),
    perms: { share_timeline: true, share_gallery: true, share_map: true },
    journey: { title: 'Japan 2026', subtitle: 'Tokyo & Kyoto', cover_image: null },
    stats: { entries: 2, photos: 4, places: 3 },
    timelineEntries: entries,
    groupedEntries: grouped,
    sortedDates: [...grouped.keys()].sort(),
    sidebarMapItems: [],
    stopNumberById: new Map<string, number>(),
    mapPhotos: [] as { id: string; lat: number; lng: number; photoId: number }[],
    displayDates: [...grouped.keys()].sort(),
    newestFirst: false,
    setNewestFirst: vi.fn(),
    allPhotos: [] as PublicGalleryPhoto[],
    desktopTwoColumn: true,
    ...over,
  };
}

function setup(over: Record<string, unknown> = {}) {
  mocks.pub = buildHook(over);
  const view = render(<JourneyPublicPage />);
  return { ...view, hook: mocks.pub };
}

const settingsInitial = useSettingsStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captured = {};
  useSettingsStore.setState(settingsInitial, true);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('JourneyPublicPage wiring', () => {
  it('FE-JRN-PUBWIRE-001: shows a spinner while the share is being fetched', () => {
    setup({ loading: true });
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-002: an unknown or revoked token shows the not-found screen', () => {
    setup({ error: true, data: null });
    expect(screen.getByRole('heading', { name: 'Not Found' })).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-003: renders the hero with title, subtitle and stats', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Japan 2026' })).toBeInTheDocument();
    expect(screen.getByText('Tokyo & Kyoto')).toBeInTheDocument();
    expect(screen.getByText(/2 Entries/)).toBeInTheDocument();
    expect(screen.getByText(/4 Photos/)).toBeInTheDocument();
    expect(screen.getByText(/3 Places/)).toBeInTheDocument();
    expect(screen.getByTestId('public-map')).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-004: the cover image is layered into the hero when present', () => {
    setup({ journey: { title: 'Japan 2026', cover_image: 'covers/j.jpg' } });
    expect(document.querySelector('[style*="/uploads/covers/j.jpg"]')).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-005: hovering an entry in two-column mode highlights its marker', () => {
    const { hook } = setup();
    fireEvent.mouseEnter(document.querySelector('[data-entry-id="1"]')!);
    expect(hook.setActiveEntryId).toHaveBeenCalledWith('1');
    expect(highlightMarker).toHaveBeenCalledWith('1');
  });

  it('FE-JRN-PUBWIRE-006: in single-column mode hovering does nothing', () => {
    const { hook } = setup({ desktopTwoColumn: false });
    fireEvent.mouseEnter(document.querySelector('[data-entry-id="1"]')!);
    expect(hook.setActiveEntryId).not.toHaveBeenCalled();
    expect(highlightMarker).not.toHaveBeenCalled();
  });

  it('FE-JRN-PUBWIRE-007: an active entry gets the day-colour outline', () => {
    setup({ activeEntryId: '1' });
    expect(document.querySelector('[data-entry-id="1"]')).toHaveStyle({ borderRadius: '16px' });
  });

  it('FE-JRN-PUBWIRE-008: a single-photo entry opens the lightbox and overlays its title', () => {
    const { hook } = setup({ timelineEntries: [buildEntry({ photos: [photo(1)] })] });
    expect(screen.getByText('Tokyo, Japan')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Arrival' })).toBeInTheDocument();

    // the hero photo of a single-photo entry is served at full size
    fireEvent.click(document.querySelector('img[src="/api/public/journey/tok-1/photos/10/original"]')!.parentElement!);
    expect(hook.setLightbox).toHaveBeenCalledWith({
      index: 0,
      photos: [expect.objectContaining({ id: '1', src: '/api/public/journey/tok-1/photos/10/original' })],
    });
  });

  it('FE-JRN-PUBWIRE-009: a two-photo entry opens the lightbox at the clicked index', () => {
    const { hook } = setup({ timelineEntries: [buildEntry({ photos: [photo(1), photo(2)] })] });
    fireEvent.click(document.querySelector('img[src="/api/public/journey/tok-1/photos/20/thumbnail"]')!);
    expect(hook.setLightbox).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });

  it('FE-JRN-PUBWIRE-010: a four-photo entry shows the +N overlay and three click targets', () => {
    const { hook } = setup({
      timelineEntries: [buildEntry({ photos: [photo(1), photo(2), photo(3), photo(4)] })],
    });
    expect(screen.getByText('+1')).toBeInTheDocument();

    for (const [photoId, index] of [[10, 0], [20, 1], [30, 2]] as const) {
      fireEvent.click(document.querySelector(`img[src="/api/public/journey/tok-1/photos/${photoId}/thumbnail"]`)!.parentElement!);
      expect(hook.setLightbox).toHaveBeenLastCalledWith(expect.objectContaining({ index }));
    }
  });

  it('FE-JRN-PUBWIRE-011: tapping the text body opens the entry detail view', () => {
    const { hook } = setup({ timelineEntries: [buildEntry({ story: 'A long day.' })] });
    expect(screen.getByTestId('journal-body')).toHaveTextContent('A long day.');
    expect(screen.getByText('09:30')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('journal-body'));
    expect(hook.setViewingEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('FE-JRN-PUBWIRE-012: pros, cons, mood and weather are rendered', () => {
    setup({
      timelineEntries: [buildEntry({
        mood: 'amazing',
        weather: 'rainy',
        pros_cons: { pros: ['Great food', 'Friendly'], cons: ['Crowded'] },
      })],
    });
    expect(screen.getByText('Great food')).toBeInTheDocument();
    expect(screen.getByText('Friendly')).toBeInTheDocument();
    expect(screen.getByText('Crowded')).toBeInTheDocument();
    expect(screen.getByText('Amazing')).toBeInTheDocument();
    expect(screen.getByText('Rainy')).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-013: a share without entries shows the empty state', () => {
    setup({ timelineEntries: [] });
    expect(screen.getByText('No entries yet')).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-014: the gallery opens the lightbox over all photos and flags videos', () => {
    const allPhotos = [
      { id: 1, journey_id: 7, photo_id: 100, caption: 'a' },
      { id: 2, journey_id: 7, photo_id: 101, caption: null, media_type: 'video' },
    ];
    const { hook } = setup({ view: 'gallery', allPhotos });

    const tiles = document.querySelectorAll('img[src^="/api/public/journey/tok-1/photos/"]');
    expect(tiles).toHaveLength(2);
    fireEvent.click(tiles[1].parentElement!);
    expect(hook.setLightbox).toHaveBeenCalledWith({
      index: 1,
      photos: [
        expect.objectContaining({ id: '1', src: '/api/public/journey/tok-1/photos/100/original' }),
        expect.objectContaining({ id: '2', mediaType: 'video' }),
      ],
    });
  });

  it('FE-JRN-PUBWIRE-015: the language picker switches the stored UI language', () => {
    const { hook } = setup({ showLangPicker: true });
    const german = screen.getByRole('button', { name: 'Deutsch' });
    fireEvent.mouseEnter(german);
    expect(german).toHaveStyle({ background: 'var(--bg-hover)' });
    fireEvent.mouseLeave(german);

    fireEvent.click(german);
    expect(useSettingsStore.getState().settings.language).toBe('de');
    expect(hook.setShowLangPicker).toHaveBeenCalledWith(false);
  });

  it('FE-JRN-PUBWIRE-016: the picker button toggles the dropdown', () => {
    const { hook } = setup();
    expect(screen.queryByRole('button', { name: 'Deutsch' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    const toggle = (hook.setShowLangPicker as ReturnType<typeof vi.fn>).mock.calls[0][0] as (v: boolean) => boolean;
    expect(toggle(false)).toBe(true);
  });

  it('FE-JRN-PUBWIRE-017: the tab bar switches between timeline and gallery', () => {
    const { hook } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Gallery/ }));
    expect(hook.setView).toHaveBeenCalledWith('gallery');
  });

  it('FE-JRN-PUBWIRE-018: single-column mode offers the standalone map tab', () => {
    setup({ desktopTwoColumn: false, view: 'map' });
    expect(screen.getByTestId('public-map')).toHaveAttribute('data-height', '500');
    expect(screen.getByRole('button', { name: /Map/ })).toBeInTheDocument();
  });

  it('FE-JRN-PUBWIRE-019: on mobile the combined map timeline takes over with public photo URLs', () => {
    const { hook } = setup({ isMobile: true, desktopTwoColumn: false });
    expect(screen.getByTestId('mobile-timeline')).toBeInTheDocument();

    const publicPhotoUrl = mocks.captured.mobileTimeline.publicPhotoUrl as (id: number) => string;
    expect(publicPhotoUrl(55)).toBe('/api/public/journey/tok-1/photos/55/original');

    (mocks.captured.mobileTimeline.onEntryClick as (e: PublicEntry) => void)(buildEntry({ id: 9 }));
    expect(hook.setViewingEntry).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
  });

  it('FE-JRN-PUBWIRE-020: the floating mobile toggle switches the view', () => {
    const { hook } = setup({ isMobile: true, desktopTwoColumn: false });
    const galleryButtons = screen.getAllByRole('button', { name: /Gallery/ });
    fireEvent.click(galleryButtons[0]);
    expect(hook.setView).toHaveBeenCalledWith('gallery');
  });

  it('FE-JRN-PUBWIRE-021: the mobile entry view maps its photos into the lightbox', () => {
    const viewingEntry = buildEntry({ id: 9 });
    const { hook } = setup({ isMobile: true, desktopTwoColumn: false, viewingEntry });
    expect(screen.getByTestId('mobile-entry')).toBeInTheDocument();

    const publicPhotoUrl = mocks.captured.mobileEntry.publicPhotoUrl as (id: number) => string;
    expect(publicPhotoUrl(77)).toBe('/api/public/journey/tok-1/photos/77/original');

    const onPhotoClick = mocks.captured.mobileEntry.onPhotoClick as (p: Record<string, unknown>[], i: number) => void;
    onPhotoClick([{ id: 3, photo_id: 30, caption: 'x', media_type: 'image' }], 0);
    expect(hook.setLightbox).toHaveBeenCalledWith({
      index: 0,
      photos: [expect.objectContaining({ id: '3', src: '/api/public/journey/tok-1/photos/30/original', caption: 'x' })],
    });

    (mocks.captured.mobileEntry.onClose as () => void)();
    expect(hook.setViewingEntry).toHaveBeenCalledWith(null);
  });

  it('FE-JRN-PUBWIRE-022: the lightbox closes back into the hook', () => {
    const { hook } = setup({ lightbox: { photos: [{ id: '1', src: '/x', caption: null }], index: 0 } });
    expect(screen.getByTestId('lightbox')).toBeInTheDocument();
    (mocks.captured.lightbox.onClose as () => void)();
    expect(hook.setLightbox).toHaveBeenCalledWith(null);
  });

  it('FE-JRN-PUBWIRE-023: a timeline-only share hides the tab bar entirely', () => {
    setup({ perms: { share_timeline: true, share_gallery: false, share_map: false }, desktopTwoColumn: false });
    expect(screen.queryByRole('button', { name: /Gallery/ })).not.toBeInTheDocument();
    expect(screen.getByText('Arrival')).toBeInTheDocument();
  });
});
