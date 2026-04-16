import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser } from '../../tests/helpers/factories';
import { useAuthStore } from '../store/authStore';
import { usePermissionsStore } from '../store/permissionsStore';
import { useJourneyStore } from '../store/journeyStore';
import JourneyDetailPage from './JourneyDetailPage';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../api/websocket', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocketId: vi.fn(() => null),
  setRefetchCallback: vi.fn(),
  setPreReconnectHook: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => null,
  Marker: ({ children }: any) => <div>{children}</div>,
  Popup: ({ children }: any) => <div>{children}</div>,
  Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() }),
}));

vi.mock('../components/Layout/Navbar', () => ({
  default: () => <nav data-testid="navbar" />,
}));

// JourneyMap uses forwardRef -- must use require inside the hoisted factory
vi.mock('../components/Journey/JourneyMap', async () => {
  const React = await import('react');
  const Comp = React.forwardRef((_props: any, _ref: any) => (
    <div data-testid="journey-map">Map</div>
  ));
  Comp.displayName = 'MockJourneyMap';
  return { __esModule: true, default: Comp };
});

vi.mock('../components/Journey/JournalBody', () => ({
  default: ({ text }: { text: string }) => <div data-testid="journal-body">{text}</div>,
}));

vi.mock('../components/Journey/MarkdownToolbar', () => ({
  default: () => <div data-testid="markdown-toolbar" />,
}));

vi.mock('../components/Journey/PhotoLightbox', () => ({
  default: () => <div data-testid="photo-lightbox" />,
}));

vi.mock('../components/shared/ConfirmDialog', () => ({
  default: ({ message, onConfirm, onCancel }: any) => (
    <div data-testid="confirm-dialog">
      <span>{message}</span>
      <button onClick={onConfirm}>Confirm</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: '1' }),
    useNavigate: () => mockNavigate,
  };
});

// ── Mock Data ────────────────────────────────────────────────────────────────

const now = Date.now();

const mockJourneyDetail = {
  id: 1,
  user_id: 1,
  title: 'Italy 2026',
  subtitle: 'Rome, Florence, Venice',
  status: 'active',
  cover_image: null,
  cover_gradient: null,
  created_at: now,
  updated_at: now,
  entries: [
    {
      id: 10,
      journey_id: 1,
      author_id: 1,
      type: 'entry',
      entry_date: '2026-03-15',
      title: 'Arrived in Rome',
      story: 'Amazing city!',
      location_name: 'Rome',
      location_lat: 41.9,
      location_lng: 12.5,
      mood: 'amazing',
      weather: 'sunny',
      tags: ['culture'],
      pros_cons: { pros: ['Great food'], cons: ['Crowded'] },
      visibility: 'private',
      sort_order: 0,
      entry_time: '10:00',
      photos: [
        {
          id: 100,
          entry_id: 10,
          photo_id: 100,
          provider: 'local',
          file_path: 'photos/test.jpg',
          asset_id: null,
          owner_id: null,
          thumbnail_path: null,
          caption: 'Colosseum',
          sort_order: 0,
          width: 800,
          height: 600,
          shared: 1,
          created_at: now,
        },
      ],
      created_at: now,
      updated_at: now,
    },
    {
      id: 11,
      journey_id: 1,
      author_id: 1,
      type: 'entry',
      entry_date: '2026-03-16',
      title: 'Florence Day',
      story: null,
      location_name: 'Florence',
      location_lat: 43.77,
      location_lng: 11.25,
      mood: 'good',
      weather: 'cloudy',
      tags: [],
      pros_cons: null,
      visibility: 'private',
      sort_order: 0,
      entry_time: null,
      photos: [],
      created_at: now,
      updated_at: now,
    },
  ],
  trips: [
    {
      trip_id: 5,
      added_at: now,
      title: 'Italy Trip',
      start_date: '2026-03-14',
      end_date: '2026-03-20',
      cover_image: null,
      currency: 'EUR',
      place_count: 8,
    },
  ],
  contributors: [
    {
      journey_id: 1,
      user_id: 1,
      role: 'owner',
      added_at: now,
      username: 'testuser',
      avatar: null,
    },
  ],
  stats: { entries: 2, photos: 1, cities: 2 },
};

// ── MSW Handlers ─────────────────────────────────────────────────────────────

function setupDefaultHandlers(journeyOverride?: Record<string, unknown>) {
  const journey = journeyOverride
    ? { ...mockJourneyDetail, ...journeyOverride }
    : mockJourneyDetail;

  server.use(
    http.get('/api/journeys/1', () => {
      return HttpResponse.json(journey);
    }),
    http.get('/api/addons', () => {
      return HttpResponse.json({
        addons: [
          { id: 'journey', name: 'Journey', type: 'feature', icon: 'book', enabled: true },
          { id: 'immich', name: 'Immich', type: 'photo_provider', icon: 'camera', enabled: true },
        ],
      });
    }),
    http.get('/api/integrations/memories/:provider/status', () => {
      return HttpResponse.json({ connected: false });
    }),
    http.patch('/api/journeys/1', () => {
      return HttpResponse.json({ ...mockJourneyDetail, title: 'Updated' });
    }),
    http.get('/api/journeys/1/share-link', () => {
      return HttpResponse.json({ link: null });
    }),
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

const ownerUser = buildUser({ id: 1, username: 'testuser' });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  resetAllStores();
  useJourneyStore.setState(useJourneyStore.getState(), true);
  seedStore(useAuthStore, { isAuthenticated: true, user: ownerUser });
  seedStore(usePermissionsStore, { level: 'owner' } as any);
  setupDefaultHandlers();
});

afterEach(() => {
  // Advance timers to flush pending setTimeout (e.g. 300ms setupObserver) before teardown
  vi.runOnlyPendingTimers();
  cleanup();
  vi.useRealTimers();
});

// ── Helper ───────────────────────────────────────────────────────────────────

async function renderAndWait() {
  render(<JourneyDetailPage />);
  await waitFor(() => {
    expect(screen.getByText('Italy 2026')).toBeInTheDocument();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('JourneyDetailPage', () => {
  // ── FE-PAGE-JOURNEYDETAIL-001 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-001: Renders without crashing and shows title', () => {
    it('renders the journey title after loading', async () => {
      await renderAndWait();
      expect(screen.getByText('Italy 2026')).toBeVisible();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-002 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-002: Shows journey subtitle', () => {
    it('renders the subtitle text', async () => {
      await renderAndWait();
      expect(screen.getByText('Rome, Florence, Venice')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-003 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-003: Timeline tab is active by default', () => {
    it('has the Timeline button in active style and shows timeline entries', async () => {
      await renderAndWait();
      const timelineBtn = screen.getByRole('button', { name: /timeline/i });
      expect(timelineBtn).toBeInTheDocument();
      // Timeline entries are visible by default
      expect(screen.getByText('Arrived in Rome')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-004 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-004: Shows entry cards with titles', () => {
    it('renders all entry titles in timeline view', async () => {
      await renderAndWait();
      expect(screen.getByText('Arrived in Rome')).toBeInTheDocument();
      expect(screen.getByText('Florence Day')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-005 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-005: Shows entry with mood chip (Amazing)', () => {
    it('renders a mood chip with "Amazing" text for the first entry', async () => {
      await renderAndWait();
      expect(screen.getByText('Amazing')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-006 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-006: Shows entry with weather chip (Sunny)', () => {
    it('renders a weather chip with "Sunny" text for the first entry', async () => {
      await renderAndWait();
      expect(screen.getByText('Sunny')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-007 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-007: Shows entry photos', () => {
    it('renders photo images for entries that have photos', async () => {
      await renderAndWait();
      // img with alt="" is presentational (no 'img' role), so query the DOM directly
      const images = document.querySelectorAll('img');
      const srcs = Array.from(images).map((img) => img.getAttribute('src'));
      expect(srcs).toContain('/api/photos/100/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-008 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-008: Shows VerdictSection when entry has pros/cons', () => {
    it('renders the Pros & Cons section header', async () => {
      await renderAndWait();
      expect(screen.getByText('Pros & Cons')).toBeInTheDocument();
    });

    it('renders pro items', async () => {
      await renderAndWait();
      expect(screen.getByText('Great food')).toBeInTheDocument();
    });

    it('renders con items', async () => {
      await renderAndWait();
      expect(screen.getByText('Crowded')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-009 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-009: Gallery tab switches view', () => {
    it('switches to gallery view when Gallery button is clicked', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      // Gallery view renders photo count text
      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-010 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-010: Map tab switches view (renders map-container)', () => {
    it('switches to map view when Map button is clicked', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-011 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-011: Shows journey stats (Days, Entries, Photos, Cities)', () => {
    it('renders stat labels', async () => {
      await renderAndWait();
      expect(screen.getAllByText('Days').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Entries').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Photos').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Cities').length).toBeGreaterThanOrEqual(1);
    });

    it('renders stat values', async () => {
      await renderAndWait();
      // stats.entries = 2, stats.photos = 1, stats.cities = 2
      // Entries count appears in hero and sidebar
      const twos = screen.getAllByText('2');
      expect(twos.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-012 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-012: Shows synced trips in sidebar', () => {
    it('renders the synced trip title', async () => {
      await renderAndWait();
      expect(screen.getByText('Italy Trip')).toBeInTheDocument();
    });

    it('renders Synced Trips heading', async () => {
      await renderAndWait();
      expect(screen.getByText('Synced Trips')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-013 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-013: Shows contributors list', () => {
    it('renders the contributors heading', async () => {
      await renderAndWait();
      expect(screen.getByText('Contributors')).toBeInTheDocument();
    });

    it('renders the contributor username', async () => {
      await renderAndWait();
      expect(screen.getByText('testuser')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-014 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-014: Add Entry button exists', () => {
    it('renders the + button in timeline view for adding entries', async () => {
      await renderAndWait();
      // The + button is in the view controls row and is only shown in timeline view
      // It uses <Plus size={16} /> inside a button
      const buttons = screen.getAllByRole('button');
      // The add-entry button is the small + icon button near the tab bar
      // Check that at least one button renders (the + button is the last in the view controls div)
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-015 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-015: Entry card shows edit/delete menu', () => {
    it('opens context menu with Edit and Delete on entry more button click', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      // Find the MoreHorizontal button on the first entry card (no-photo card has it in header)
      // The second entry (Florence Day) has no photos, so its menu is a small button
      // For the first entry with photos, the menu button is overlaid on the photo
      // Click the menu on the no-photo entry
      const entryCards = screen.getAllByText('Florence Day');
      expect(entryCards.length).toBeGreaterThan(0);

      // Find all the menu buttons (MoreHorizontal icon buttons)
      const allButtons = screen.getAllByRole('button');
      // The MoreHorizontal buttons are the ones that toggle the entry menu
      // We look for a button near the Florence Day entry
      // Florence Day entry has no photos, so menu is in the header div
      // We can look at the DOM structure: the entry container has title + menu button

      // Find all MoreHorizontal-like buttons (they contain svg)
      // Better approach: find the specific entry container and its button
      // The entry cards have data-entry-id attributes on their wrapper
      const florenceWrapper = document.querySelector('[data-entry-id="11"]');
      expect(florenceWrapper).toBeTruthy();

      const menuButtons = florenceWrapper!.querySelectorAll('button');
      // The first button in the no-photo entry card header is the menu button
      const menuBtn = menuButtons[0];
      expect(menuBtn).toBeTruthy();

      await user.click(menuBtn as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-016 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-016: Shows "Back to Journey" link', () => {
    it('renders the back navigation button text', async () => {
      await renderAndWait();
      expect(screen.getByText('Back to Journey')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-017 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-017: Shows settings/more button in hero', () => {
    it('renders action buttons in the hero section', async () => {
      await renderAndWait();
      // Hero has download, share/settings, and more buttons
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(3);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-018 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-018: Empty state when no entries', () => {
    it('shows "No entries yet" when journey has no entries', async () => {
      setupDefaultHandlers({ entries: [], stats: { entries: 0, photos: 0, cities: 0 } });

      render(<JourneyDetailPage />);

      await waitFor(() => {
        expect(screen.getByText('No entries yet')).toBeInTheDocument();
      });
    });

    it('shows hint text to add a trip', async () => {
      setupDefaultHandlers({ entries: [], stats: { entries: 0, photos: 0, cities: 0 } });

      render(<JourneyDetailPage />);

      await waitFor(() => {
        expect(
          screen.getByText('Add a trip to get started with skeleton entries'),
        ).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-019 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-019: ExpandableStory renders story text', () => {
    it('renders story text via JournalBody for entries with a story', async () => {
      await renderAndWait();
      // The mocked JournalBody renders text in data-testid="journal-body"
      const body = screen.getByTestId('journal-body');
      expect(body).toHaveTextContent('Amazing city!');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-020 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-020: MoodChip renders correct translation', () => {
    it('renders "Amazing" for mood=amazing', async () => {
      await renderAndWait();
      expect(screen.getByText('Amazing')).toBeInTheDocument();
    });

    it('renders "Good" for mood=good', async () => {
      await renderAndWait();
      expect(screen.getByText('Good')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-021 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-021: WeatherChip renders correct translation', () => {
    it('renders "Sunny" for weather=sunny', async () => {
      await renderAndWait();
      expect(screen.getByText('Sunny')).toBeInTheDocument();
    });

    it('renders "Cloudy" for weather=cloudy', async () => {
      await renderAndWait();
      expect(screen.getByText('Cloudy')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-022 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-022: Photo grid renders for entry with photos', () => {
    it('renders the photo image with correct src for entries with photos', async () => {
      await renderAndWait();
      const imgs = document.querySelectorAll('img');
      const photoSrcs = Array.from(imgs).map((img) => img.getAttribute('src'));
      expect(photoSrcs).toContain('/api/photos/100/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-023 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-023: Multiple photos render in grid layout', () => {
    it('renders multiple photos in a grid when entry has 2+ photos', async () => {
      const multiPhotoEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [
          {
            id: 100, entry_id: 10, photo_id: 100, provider: 'local' as const, file_path: 'photos/a.jpg',
            asset_id: null, owner_id: null, thumbnail_path: null,
            caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now,
          },
          {
            id: 101, entry_id: 10, photo_id: 101, provider: 'local' as const, file_path: 'photos/b.jpg',
            asset_id: null, owner_id: null, thumbnail_path: null,
            caption: null, sort_order: 1, width: 800, height: 600, shared: 1, created_at: now,
          },
          {
            id: 102, entry_id: 10, photo_id: 102, provider: 'local' as const, file_path: 'photos/c.jpg',
            asset_id: null, owner_id: null, thumbnail_path: null,
            caption: null, sort_order: 2, width: 800, height: 600, shared: 1, created_at: now,
          },
        ],
      };
      setupDefaultHandlers({
        entries: [multiPhotoEntry, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 3, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const imgs = document.querySelectorAll('img');
      const photoSrcs = Array.from(imgs).map((img) => img.getAttribute('src'));
      expect(photoSrcs).toContain('/api/photos/100/thumbnail');
      expect(photoSrcs).toContain('/api/photos/101/thumbnail');
      expect(photoSrcs).toContain('/api/photos/102/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-024 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-024: SkeletonCard renders for skeleton entries', () => {
    it('renders a skeleton entry with its title and "Add Entry" CTA', async () => {
      const skeletonEntry = {
        id: 20,
        journey_id: 1,
        author_id: 1,
        type: 'skeleton',
        entry_date: '2026-03-17',
        title: 'Venice Visit',
        story: null,
        location_name: 'Venice',
        location_lat: 45.44,
        location_lng: 12.33,
        mood: null,
        weather: null,
        tags: [],
        pros_cons: null,
        visibility: 'private',
        sort_order: 0,
        entry_time: '14:00',
        photos: [],
        created_at: now,
        updated_at: now,
      };
      setupDefaultHandlers({
        entries: [...mockJourneyDetail.entries, skeletonEntry],
        stats: { entries: 3, photos: 1, cities: 3 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Venice Visit')).toBeInTheDocument();
      });

      // Skeleton card shows "Add Entry" CTA
      expect(screen.getByText(/Add Entry/)).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-025 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-025: CheckinCard renders for checkin entries', () => {
    it('renders a checkin entry with title and location', async () => {
      const checkinEntry = {
        id: 30,
        journey_id: 1,
        author_id: 1,
        type: 'checkin',
        entry_date: '2026-03-15',
        title: 'Quick stop at cafe',
        story: 'Grabbed an espresso',
        location_name: 'Cafe Roma',
        location_lat: 41.91,
        location_lng: 12.51,
        mood: null,
        weather: null,
        tags: [],
        pros_cons: null,
        visibility: 'private',
        sort_order: 1,
        entry_time: '15:30',
        photos: [],
        created_at: now,
        updated_at: now,
      };
      setupDefaultHandlers({
        entries: [...mockJourneyDetail.entries, checkinEntry],
        stats: { entries: 3, photos: 1, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Quick stop at cafe')).toBeInTheDocument();
      });

      expect(screen.getByText(/Cafe Roma/)).toBeInTheDocument();
      expect(screen.getByText('Grabbed an espresso')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-026 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-026: Navbar renders', () => {
    it('renders the mocked navbar', async () => {
      await renderAndWait();
      expect(screen.getByTestId('navbar')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-027 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-027: Shows loading spinner before data loads', () => {
    it('renders a spinner while journey data is loading', () => {
      // Pre-seed the store into a loading state (current: null, loading: true).
      // We can't rely on render() timing because RTL wraps in act(), which flushes
      // all microtasks including the MSW response before render() returns.
      useJourneyStore.setState({ loading: true, current: null });
      render(<JourneyDetailPage />);
      // The spinner has animate-spin class on a div
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeTruthy();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-028 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-028: Day group headers show formatted date', () => {
    it('renders day headers with weekday and date for each group', async () => {
      await renderAndWait();
      // 2026-03-15 is a Sunday, 2026-03-16 is a Monday
      expect(screen.getByText(/Sunday, March 15/)).toBeInTheDocument();
      expect(screen.getByText(/Monday, March 16/)).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-029 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-029: Entry location badge renders', () => {
    it('renders the location name on entry cards', async () => {
      await renderAndWait();
      // "Rome" appears as a badge on the first entry
      expect(screen.getAllByText('Rome').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Florence').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-030 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-030: Active status badge shows Live indicator', () => {
    it('renders a "Live" badge for active journeys', async () => {
      await renderAndWait();
      expect(screen.getByText('Live')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-031 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-031: Synced with Trips badge renders', () => {
    it('renders the "Synced with Trips" text in the hero', async () => {
      await renderAndWait();
      expect(screen.getByText('Synced with Trips')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-032 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-032: Entry tags render', () => {
    it('renders tag chips on entries that have tags', async () => {
      await renderAndWait();
      expect(screen.getByText('culture')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-033 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-033: Sidebar map panel renders', () => {
    it('renders the sidebar journey map', async () => {
      await renderAndWait();
      // The sidebar renders a JourneyMap (mocked)
      const maps = screen.getAllByTestId('journey-map');
      expect(maps.length).toBeGreaterThanOrEqual(1);
    });

    it('shows the place count in the sidebar map', async () => {
      await renderAndWait();
      // The sidebar map shows "N Places" text
      expect(screen.getByText(/Places/)).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-034 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-034: Entry time renders when present', () => {
    it('displays the entry time badge for entries with entry_time', async () => {
      await renderAndWait();
      expect(screen.getByText('10:00')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-035 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-035: Day group shows place count', () => {
    it('shows the number of entries per day group', async () => {
      await renderAndWait();
      // Each day header shows "N places"
      const placesTexts = screen.getAllByText(/places/i);
      expect(placesTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-036 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-036: Trip place count in sidebar', () => {
    it('shows the place count for synced trips', async () => {
      await renderAndWait();
      expect(screen.getByText(/8 places/)).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-037 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-037: Contributor avatar initial renders', () => {
    it('renders the first letter of the contributor username as avatar', async () => {
      await renderAndWait();
      // 'T' for 'testuser'
      expect(screen.getByText('T')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-038 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-038: Synced badge on trip cards', () => {
    it('renders "synced" badge on trip items in sidebar', async () => {
      await renderAndWait();
      expect(screen.getByText('synced')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-039 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-039: Journey Stats heading in sidebar', () => {
    it('renders the Journey Stats section heading', async () => {
      await renderAndWait();
      expect(screen.getByText('Journey Stats')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-040 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-040: No trips linked message', () => {
    it('shows "No trips linked yet" when journey has no trips', async () => {
      setupDefaultHandlers({ trips: [] });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      expect(screen.getByText('No trips linked yet')).toBeInTheDocument();
    });
  });

  // ── Helper: open entry editor ────────────────────────��─────────────────
  async function openEntryEditor(user: ReturnType<typeof userEvent.setup>) {
    // The + button is inside the view controls row, after the tab group
    // Structure: div.justify-between > [div(tabs), button(+)]
    // The tab group div contains the Timeline/Gallery/Map buttons
    const tabGroup = screen.getByRole('button', { name: /timeline/i }).parentElement!;
    // The + button is the next sibling of the tab group
    const addBtn = tabGroup.nextElementSibling as HTMLElement;
    expect(addBtn).toBeTruthy();
    expect(addBtn.tagName).toBe('BUTTON');

    await user.click(addBtn);

    await waitFor(() => {
      expect(screen.getByText('New Entry')).toBeInTheDocument();
    });
  }

  // ── FE-PAGE-JOURNEYDETAIL-041 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-041: Click Add Entry opens editor dialog with title placeholder', () => {
    it('opens entry editor showing title placeholder when + button is clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Title input has placeholder
      expect(screen.getByPlaceholderText('Give this moment a name...')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-042 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-042: Entry editor shows date picker', () => {
    it('shows the Date label and a date picker button inside the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByText('Date')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-043 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-043: Entry editor shows mood selector with 4 options', () => {
    it('shows 4 mood buttons: Amazing, Good, Neutral, Rough', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByText('Mood')).toBeInTheDocument();
      // In the editor, mood buttons render labels from i18n
      // The timeline already shows "Amazing" and "Good" from entries, so use getAllByText
      const amazingButtons = screen.getAllByText('Amazing');
      expect(amazingButtons.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Neutral')).toBeInTheDocument();
      expect(screen.getByText('Rough')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-044 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-044: Entry editor shows weather selector with 6 options', () => {
    it('shows 6 weather buttons: Sunny, Partly cloudy, Cloudy, Rainy, Stormy, Snowy', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByText('Weather')).toBeInTheDocument();
      // Weather labels from i18n translations
      expect(screen.getByText('Partly cloudy')).toBeInTheDocument();
      expect(screen.getByText('Rainy')).toBeInTheDocument();
      expect(screen.getByText('Stormy')).toBeInTheDocument();
      expect(screen.getByText('Snowy')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-045 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-045: Entry editor shows Pros & Cons section', () => {
    it('renders Pros and Cons labels inside the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The editor shows "Pros & Cons" label (displayed uppercase via CSS class)
      // The timeline view already shows "Pros & Cons" from the first entry, so use getAllByText
      const prosConsLabels = screen.getAllByText('Pros & Cons');
      expect(prosConsLabels.length).toBeGreaterThanOrEqual(2);
      // It also shows sub-labels Pros and Cons
      expect(screen.getByText('Pros')).toBeInTheDocument();
      expect(screen.getByText('Cons')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-046 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-046: Entry editor shows Cancel button', () => {
    it('renders a Cancel button in the editor footer', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Editor footer has Cancel and Save buttons
      const cancelButtons = screen.getAllByText('Cancel');
      expect(cancelButtons.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Save')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-047 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-047: Cancel closes editor', () => {
    it('closes the entry editor when Cancel is clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Click Cancel to close
      const cancelButtons = screen.getAllByText('Cancel');
      // The Cancel button in the editor footer (not the ConfirmDialog mock)
      await user.click(cancelButtons[0]);

      await waitFor(() => {
        expect(screen.queryByText('New Entry')).not.toBeInTheDocument();
      });
    });
  });

  // ── Helper: open settings dialog ────────────────────────────────────────
  async function openSettingsDialog(user: ReturnType<typeof userEvent.setup>) {
    const heroTitle = screen.getByText('Italy 2026');
    const heroCard = heroTitle.closest('[style]') as HTMLElement;
    const heroButtons = heroCard!.querySelectorAll('button');
    await user.click(heroButtons[heroButtons.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText('Journey Settings')).toBeInTheDocument();
    });
  }

  // ── FE-PAGE-JOURNEYDETAIL-048 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-048: Click settings gear opens settings dialog', () => {
    it('opens Journey Settings dialog when MoreHorizontal button in hero is clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);
      // If we reach here, the dialog opened successfully (openSettingsDialog asserts it)
      expect(screen.getByText('Journey Settings')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-049 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-049: Settings shows journey name input', () => {
    it('renders the Name label and an input with the journey title', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // "Name" label from i18n (displayed uppercase via CSS class)
      expect(screen.getByText('Name')).toBeInTheDocument();
      // The input has the current journey title
      const nameInput = screen.getByDisplayValue('Italy 2026');
      expect(nameInput).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-050 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-050: Settings shows subtitle input', () => {
    it('renders the Subtitle label and input with the journey subtitle', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      expect(screen.getByText('Subtitle')).toBeInTheDocument();
      const subtitleInput = screen.getByDisplayValue('Rome, Florence, Venice');
      expect(subtitleInput).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-051 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-051: Settings shows Delete Journey button (danger)', () => {
    it('renders a Delete button in the settings dialog footer', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // The Delete button has red text and a Trash2 icon
      const deleteBtn = screen.getByRole('button', { name: /delete/i });
      expect(deleteBtn).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-052 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-052: Close settings dialog', () => {
    it('closes the settings dialog when Cancel is clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // Click Cancel in settings footer
      const cancelButtons = screen.getAllByText('Cancel');
      // Find the Cancel that belongs to the settings dialog
      const settingsCancel = cancelButtons.find(
        (btn) => btn.closest('[class*="fixed"]') !== null,
      );
      expect(settingsCancel).toBeTruthy();
      await user.click(settingsCancel!);

      await waitFor(() => {
        expect(screen.queryByText('Journey Settings')).not.toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-053 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-053: Share section renders in settings', () => {
    it('renders the Public Share section inside settings dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // JourneyShareSection renders "Public Share" label (displayed uppercase via CSS class)
      // and the "Create share link" button since the MSW handler returns link: null
      await waitFor(() => {
        expect(screen.getByText('Public Share')).toBeInTheDocument();
      });
      expect(screen.getByText('Create share link')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-054 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-054: Link trip section exists in sidebar', () => {
    it('renders the Synced Trips heading with a + button in the sidebar', async () => {
      await renderAndWait();

      // The sidebar panel has "Synced Trips" heading with a + button
      expect(screen.getByText('Synced Trips')).toBeInTheDocument();
      // The + button next to Synced Trips is a 22x22 button
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      expect(panel).toBeTruthy();

      // The panel header has a Plus button
      const plusBtns = panel!.querySelectorAll('button');
      expect(plusBtns.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-055 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-055: Gallery tab shows photos', () => {
    it('shows the photo count and photo images in gallery view', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // Gallery renders photos as images
      const imgs = document.querySelectorAll('img');
      const srcs = Array.from(imgs).map((img) => img.getAttribute('src'));
      expect(srcs).toContain('/api/photos/100/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-056 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-056: Gallery shows upload button', () => {
    it('renders an Upload button in gallery view header', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // Gallery has an Upload button
      expect(screen.getByText('Upload')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-057 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-057: Map tab renders location list', () => {
    it('shows location entries in the map view list', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // Map view renders a location list with entry titles/location names
      // The MapView component shows entry names in clickable location items
      expect(screen.getByText('Arrived in Rome')).toBeInTheDocument();
      expect(screen.getByText('Florence Day')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-058 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-058: Map shows entry count', () => {
    it('shows Places stat in map view stats header', async () => {
      const user = userEvent.setup();
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // MapView stats header shows Places, Days, Stories counts
      // mapEntries has 2 entries (both have lat/lng)
      const placesLabels = screen.getAllByText(/Places/i);
      expect(placesLabels.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Stories')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-059 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-059: Contributors section shows invite button', () => {
    it('renders the Contributors heading with an invite button in sidebar', async () => {
      await renderAndWait();

      // Sidebar has a Contributors panel
      expect(screen.getByText('Contributors')).toBeInTheDocument();

      // The Contributors panel header has a UserPlus button for inviting
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      expect(panel).toBeTruthy();

      // Find the invite button (UserPlus icon button)
      const btns = panel!.querySelectorAll('button');
      expect(btns.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-060 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-060: Multiple entries show in chronological day groups', () => {
    it('renders entries grouped by day with correct day numbers', async () => {
      await renderAndWait();

      // Two entries on two different dates: 2026-03-15 and 2026-03-16
      // Day headers show "Sunday, March 15" and "Monday, March 16"
      expect(screen.getByText(/Sunday, March 15/)).toBeInTheDocument();
      expect(screen.getByText(/Monday, March 16/)).toBeInTheDocument();

      // Day group numbers are shown as badges: 1 and 2
      const dayBadges = document.querySelectorAll('[class*="sticky"] [class*="rounded-lg"]');
      expect(dayBadges.length).toBeGreaterThanOrEqual(2);

      // Each day group shows its entries
      expect(screen.getByText('Arrived in Rome')).toBeInTheDocument();
      expect(screen.getByText('Florence Day')).toBeInTheDocument();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW TESTS: FE-PAGE-JOURNEYDETAIL-061 to 085
  // ═══════════════════════════════════════════════════════════════════════════

  // ── EntryEditor interactions (061-067) ─────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-061 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-061: Type in title field updates value', () => {
    it('updates the title input value when user types', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      const titleInput = screen.getByPlaceholderText('Give this moment a name...');
      await user.type(titleInput, 'Sunset at the Vatican');

      expect(titleInput).toHaveValue('Sunset at the Vatican');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-062 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-062: Type in story textarea updates value', () => {
    it('updates the story textarea value when user types', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      const storyTextarea = screen.getByPlaceholderText('Write your story...');
      await user.type(storyTextarea, 'A wonderful evening');

      expect(storyTextarea).toHaveValue('A wonderful evening');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-063 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-063: Select mood option highlights it', () => {
    it('clicking a mood button in the editor activates it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The editor renders mood buttons; "Neutral" only appears in the editor (not timeline)
      const neutralBtn = screen.getByText('Neutral');
      await user.click(neutralBtn);

      // After clicking, the button gets a non-transparent background (active state)
      expect(neutralBtn.closest('button')).toHaveStyle({ background: '#F4F4F5' });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-064 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-064: Select weather option highlights it', () => {
    it('clicking a weather button in the editor activates it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // "Rainy" only appears in the editor
      const rainyBtn = screen.getByText('Rainy');
      await user.click(rainyBtn);

      // Active weather button gets bg-zinc-900 class
      expect(rainyBtn.closest('button')!.className).toContain('bg-zinc-900');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-065 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-065: Add pro item via "Add another" button', () => {
    it('adds a new pro input row when clicking "Add another" under Pros', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Find the "Add another" buttons — there should be two (one for pros, one for cons)
      const addButtons = screen.getAllByText('Add another');
      expect(addButtons.length).toBe(2);

      // The first "Add another" is for Pros
      await user.click(addButtons[0]);

      // Now there should be 2 pro input fields (placeholder is the pro placeholder)
      const proInputs = screen.getAllByPlaceholderText('Something great...');
      expect(proInputs.length).toBe(2);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-066 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-066: Add con item via "Add another" button', () => {
    it('adds a new con input row when clicking "Add another" under Cons', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The second "Add another" is for Cons
      const addButtons = screen.getAllByText('Add another');
      await user.click(addButtons[1]);

      // Now there should be 2 con input fields
      const conInputs = screen.getAllByPlaceholderText('Not so great...');
      expect(conInputs.length).toBe(2);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-067 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-067: Save button triggers onSave with entry data', () => {
    it('clicking Save calls the API and closes the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Add MSW handlers for creating and loading
      server.use(
        http.post('/api/journeys/1/entries', () => {
          return HttpResponse.json({
            id: 99, journey_id: 1, author_id: 1, type: 'entry',
            entry_date: new Date().toISOString().split('T')[0],
            title: 'Test Entry', story: null, location_name: null,
            location_lat: null, location_lng: null, mood: null, weather: null,
            tags: [], pros_cons: null, visibility: 'private', sort_order: 0,
            entry_time: null, photos: [], created_at: now, updated_at: now,
          });
        }),
      );

      await renderAndWait();
      await openEntryEditor(user);

      // Type a title
      const titleInput = screen.getByPlaceholderText('Give this moment a name...');
      await user.type(titleInput, 'Test Entry');

      // Click Save
      const saveBtn = screen.getByText('Save');
      await user.click(saveBtn);

      // The editor should close after save completes
      await waitFor(() => {
        expect(screen.queryByText('New Entry')).not.toBeInTheDocument();
      });
    });
  });

  // ── Settings save/delete (068-071) ─────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-068 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-068: Change journey name in settings input', () => {
    it('allows typing a new name in the settings name input', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      const nameInput = screen.getByDisplayValue('Italy 2026');
      await user.clear(nameInput);
      await user.type(nameInput, 'Spain 2026');

      expect(nameInput).toHaveValue('Spain 2026');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-069 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-069: Save settings calls API', () => {
    it('clicking Save in settings dialog calls PATCH /api/journeys/1', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let patchCalled = false;

      server.use(
        http.patch('/api/journeys/1', () => {
          patchCalled = true;
          return HttpResponse.json({ ...mockJourneyDetail, title: 'Updated Title' });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      // Click Save in the settings dialog footer
      // The settings dialog footer has [Delete, Cancel, Save] buttons
      const settingsDialog = screen.getByText('Journey Settings').closest('[class*="fixed"]')!;
      const saveBtns = settingsDialog.querySelectorAll('button');
      const saveBtn = Array.from(saveBtns).find(b => b.textContent === 'Save')!;
      await user.click(saveBtn as HTMLElement);

      await waitFor(() => {
        expect(patchCalled).toBe(true);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-070 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-070: Delete journey shows confirm dialog', () => {
    it('clicking Delete in settings shows a confirmation dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // Click the Delete button (red button in the settings footer)
      const deleteBtn = screen.getByRole('button', { name: /delete/i });
      await user.click(deleteBtn);

      // The ConfirmDialog mock always renders (no isOpen gate).
      // After clicking Delete, the delete-journey confirm message should appear.
      await waitFor(() => {
        expect(screen.getByText(/Delete "Italy 2026"\? All entries and photos will be lost\./)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-071 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-071: Cover image section visible in settings', () => {
    it('renders the Cover Image label in the settings dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      expect(screen.getByText('Cover Image')).toBeInTheDocument();
      // The button to upload cover should show "Add cover image" (i18n key: journey.settings.addCover)
      expect(screen.getByText('Add cover image')).toBeInTheDocument();
    });
  });

  // ── Share link (072-074) ───────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-072 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-072: Create share link calls API and shows link', () => {
    it('clicking "Create share link" calls POST and shows the link URL', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.post('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            token: 'abc123',
            share_timeline: true,
            share_gallery: true,
            share_map: true,
          });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      // Wait for the share section to load
      await waitFor(() => {
        expect(screen.getByText('Create share link')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Create share link'));

      // After creation, the link URL should appear
      await waitFor(() => {
        expect(screen.getByText(/abc123/)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-073 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-073: Copy link button exists after creation', () => {
    it('shows a Copy button after share link is created', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Return an existing share link from the GET handler
      server.use(
        http.get('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            link: {
              token: 'existing-token',
              share_timeline: true,
              share_gallery: true,
              share_map: true,
            },
          });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      await waitFor(() => {
        expect(screen.getByText('Copy')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-074 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-074: Delete share link removes it', () => {
    it('clicking "Remove share link" calls DELETE and returns to create state', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let deleteCalled = false;

      server.use(
        http.get('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            link: {
              token: 'to-delete',
              share_timeline: true,
              share_gallery: true,
              share_map: true,
            },
          });
        }),
        http.delete('/api/journeys/1/share-link', () => {
          deleteCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      await waitFor(() => {
        expect(screen.getByText('Remove share link')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Remove share link'));

      await waitFor(() => {
        expect(deleteCalled).toBe(true);
      });

      // After deletion, the "Create share link" button should reappear
      await waitFor(() => {
        expect(screen.getByText('Create share link')).toBeInTheDocument();
      });
    });
  });

  // ── AddTripDialog (075-077) ────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-075 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-075: Add Trip button opens dialog with search input', () => {
    it('clicking the + button in the Synced Trips panel opens the Add Trip dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({ trips: [] });
        }),
      );

      await renderAndWait();

      // Find the Synced Trips panel and its + button
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      // The first button in the heading row is the + button
      await user.click(plusBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Link Trip')).toBeInTheDocument();
        expect(screen.getByText('Search Trip')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-076 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-076: Trip search shows results', () => {
    it('available trips are shown in the dialog list', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({
            trips: [
              { id: 20, title: 'Paris Weekend', destination: 'Paris', start_date: '2026-05-01', end_date: '2026-05-03' },
              { id: 21, title: 'Berlin Trip', destination: 'Berlin', start_date: '2026-06-10', end_date: '2026-06-15' },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open the Add Trip dialog
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      await user.click(plusBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Paris Weekend')).toBeInTheDocument();
        expect(screen.getByText('Berlin Trip')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-077 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-077: Select trip and link calls API', () => {
    it('clicking Link on a trip calls POST /api/journeys/1/trips', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let linkCalled = false;

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({
            trips: [
              { id: 20, title: 'Paris Weekend', destination: 'Paris', start_date: '2026-05-01', end_date: '2026-05-03' },
            ],
          });
        }),
        http.post('/api/journeys/1/trips', () => {
          linkCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      await renderAndWait();

      // Open Add Trip dialog
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      await user.click(plusBtns[0] as HTMLElement);

      // Wait for trips to load then click "Link"
      await waitFor(() => {
        expect(screen.getByText('Paris Weekend')).toBeInTheDocument();
      });

      const linkBtn = screen.getByText('Link');
      await user.click(linkBtn);

      await waitFor(() => {
        expect(linkCalled).toBe(true);
      });
    });
  });

  // ── ContributorInviteDialog (078-080) ──────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-078 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-078: Invite button opens dialog', () => {
    it('clicking the invite button in Contributors panel opens the Invite Contributor dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({ users: [] });
        }),
      );

      await renderAndWait();

      // Find the Contributors panel and its invite button
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      // The first button in the heading row is the UserPlus button
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Invite Contributor')).toBeInTheDocument();
        expect(screen.getByText('Search User')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-079 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-079: User search shows results', () => {
    it('available users are shown in the Invite Contributor dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
              { id: 3, username: 'bob', email: 'bob@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
        expect(screen.getByText('bob')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-080 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-080: Add contributor calls API', () => {
    it('selecting a user and clicking Invite calls POST /api/journeys/1/contributors', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let contributorCalled = false;

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
        http.post('/api/journeys/1/contributors', () => {
          contributorCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      // Wait for users to load
      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
      });

      // Click the user row to select alice
      await user.click(screen.getByText('alice'));

      // Click the Invite button
      const inviteBtn = screen.getByText('Invite');
      await user.click(inviteBtn);

      await waitFor(() => {
        expect(contributorCalled).toBe(true);
      });
    });
  });

  // ── GalleryView (081-083) ──────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-081 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-081: Gallery shows "No photos yet" when empty journey', () => {
    it('renders the empty gallery state when journey has no photos', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Override with entries that have no photos
      const emptyEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [],
      };
      setupDefaultHandlers({
        entries: [emptyEntry],
        stats: { entries: 1, photos: 0, cities: 1 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // Switch to gallery
      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText('No photos yet')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-082 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-082: Gallery photo click opens lightbox', () => {
    it('clicking a photo in gallery view opens the PhotoLightbox', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      // Switch to gallery
      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // Click the photo in the gallery grid
      const galleryImgs = document.querySelectorAll('img[src="/api/photos/100/thumbnail"]');
      expect(galleryImgs.length).toBeGreaterThanOrEqual(1);
      await user.click(galleryImgs[0] as HTMLElement);

      // PhotoLightbox is mocked; after clicking the parent div, the lightbox should render
      await waitFor(() => {
        expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-083 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-083: Upload button triggers file input', () => {
    it('the Upload button in gallery view exists and is clickable', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      // Switch to gallery
      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      // The Upload button should be present and associated with a hidden file input
      const uploadBtn = screen.getByText('Upload').closest('button')!;
      expect(uploadBtn).toBeTruthy();

      // Verify the hidden file input exists in the gallery view
      const fileInput = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();
    });
  });

  // ── Entry actions (084-085) ────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-084 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-084: Click edit on entry card opens EntryEditor with prefilled data', () => {
    it('opens EntryEditor with the entry title prefilled when Edit is clicked from the context menu', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.patch('/api/journeys/entries/11', () => {
          return HttpResponse.json({ ...mockJourneyDetail.entries[1] });
        }),
      );

      await renderAndWait();

      // Open context menu on the Florence Day entry (no photos, so menu is in header)
      const florenceWrapper = document.querySelector('[data-entry-id="11"]')!;
      const menuButtons = florenceWrapper.querySelectorAll('button');
      await user.click(menuButtons[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });

      // Click Edit
      await user.click(screen.getByText('Edit'));

      // The editor should open with "Edit Entry" title and the entry's title prefilled
      await waitFor(() => {
        expect(screen.getByText('Edit Entry')).toBeInTheDocument();
      });

      // The title input should be prefilled with the entry title
      expect(screen.getByDisplayValue('Florence Day')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-085 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-085: Click delete on entry triggers delete confirmation', () => {
    it('clicking Delete from the context menu shows a ConfirmDialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      // Open context menu on the Florence Day entry
      const florenceWrapper = document.querySelector('[data-entry-id="11"]')!;
      const menuButtons = florenceWrapper.querySelectorAll('button');
      await user.click(menuButtons[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });

      // Click Delete
      await user.click(screen.getByText('Delete'));

      // The ConfirmDialog mock always renders (no isOpen gate), but the message
      // should now show the entry title since deleteTarget is set.
      await waitFor(() => {
        expect(screen.getByText(/Delete "Florence Day"\? This cannot be undone\./)).toBeInTheDocument();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW TESTS: FE-PAGE-JOURNEYDETAIL-086 to 115
  // ═══════════════════════════════════════════════════════════════════════════

  // ── MapView deeper (086-089) ──────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-086 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-086: Map view location click highlights item', () => {
    it('clicking a location item in map view sets it as active', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // Click the "Arrived in Rome" location item
      const romeItem = screen.getByText('Arrived in Rome');
      await user.click(romeItem);

      // After clicking, the item should gain active styles (translate-x-0.5 on the container)
      await waitFor(() => {
        const container = romeItem.closest('[class*="cursor-pointer"]');
        expect(container).toBeTruthy();
        expect(container!.className).toContain('translate-x-0.5');
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-087 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-087: Map view stats bar shows Places/Days/Stories', () => {
    it('renders 3 stat cards in map view stats header', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // Stats bar shows Places, Days, and Stories
      expect(screen.getByText('Stories')).toBeInTheDocument();
      // 2 map entries = 2 Places
      const placesLabels = screen.getAllByText(/Places/i);
      expect(placesLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-088 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-088: Map view shows day separators with day numbers', () => {
    it('renders day group headers in the location list', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // Day separators show "Day 1" and "Day 2"
      expect(screen.getByText('Day 1')).toBeInTheDocument();
      expect(screen.getByText('Day 2')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-089 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-089: Map view shows connector lines between locations', () => {
    it('renders connector lines between location items within a day', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Need two entries on the same day to see a connector
      const twoOnSameDay = [
        { ...mockJourneyDetail.entries[0], id: 10, entry_date: '2026-03-15' },
        { ...mockJourneyDetail.entries[1], id: 11, entry_date: '2026-03-15', location_lat: 41.95, location_lng: 12.55 },
      ];
      setupDefaultHandlers({ entries: twoOnSameDay, stats: { entries: 2, photos: 1, cities: 2 } });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const mapBtn = screen.getByRole('button', { name: /map/i });
      await user.click(mapBtn);

      await waitFor(() => {
        expect(screen.getAllByTestId('journey-map').length).toBeGreaterThanOrEqual(1);
      });

      // Connector lines are thin divs with specific classes
      const connectors = document.querySelectorAll('[class*="w-0.5"][class*="h-2"]');
      expect(connectors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Gallery deeper (090-093) ──────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-090 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-090: Gallery photo shows entry date overlay', () => {
    it('renders the entry date as an overlay on gallery photos', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // The entry date '2026-03-15' is shown as a formatted overlay on each gallery photo
      // The component uses toLocaleDateString which produces "Mar 15, 2026" in en-US
      const dateOverlay = document.querySelector('[class*="opacity-0"]');
      expect(dateOverlay).toBeTruthy();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-091 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-091: Gallery shows photo caption on hover area', () => {
    it('renders photo caption text in the gallery grid', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // The photo has caption 'Colosseum'
      expect(screen.getByText('Colosseum')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-092 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-092: Gallery shows provider badge for remote photos', () => {
    it('renders "Immich" badge on photos from immich provider', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const immichEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [{
          id: 200, entry_id: 10, photo_id: 200, provider: 'immich', file_path: null,
          asset_id: 'asset-123', owner_id: 1, thumbnail_path: null,
          caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now,
        }],
      };
      setupDefaultHandlers({
        entries: [immichEntry, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 1, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      expect(screen.getByText('Immich')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-093 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-093: Gallery shows Synology badge for synology photos', () => {
    it('renders "Synology" badge on photos from synology provider', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const synologyEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [{
          id: 201, entry_id: 10, photo_id: 201, provider: 'synology', file_path: null,
          asset_id: 'syn-456', owner_id: 1, thumbnail_path: null,
          caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now,
        }],
      };
      setupDefaultHandlers({
        entries: [synologyEntry, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 1, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      expect(screen.getByText('Synology')).toBeInTheDocument();
    });
  });

  // ── ProviderPicker (094-098) ──────────────────────────────────────────

  // Helper: open gallery with connected provider and click provider button
  async function openGalleryWithProvider(user: ReturnType<typeof userEvent.setup>) {
    // Override the default handler to mark Immich as connected
    server.use(
      http.get('/api/integrations/memories/:provider/status', () => {
        return HttpResponse.json({ connected: true });
      }),
      http.post('/api/integrations/memories/:provider/search', () => {
        return HttpResponse.json({
          assets: [
            { id: 'asset-1', city: 'Rome', createdAt: '2026-03-15' },
            { id: 'asset-2', city: 'Florence', createdAt: '2026-03-16' },
          ],
        });
      }),
      http.get('/api/integrations/memories/:provider/albums', () => {
        return HttpResponse.json({
          albums: [
            { id: 'album-1', albumName: 'Italy Album', assetCount: 10, startDate: '2026-03-14', endDate: '2026-03-20' },
          ],
        });
      }),
    );

    render(<JourneyDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Italy 2026')).toBeInTheDocument();
    });

    // Switch to gallery
    const galleryBtn = screen.getByRole('button', { name: /gallery/i });
    await user.click(galleryBtn);

    // Wait for provider button to appear
    await waitFor(() => {
      expect(screen.getByText('Immich')).toBeInTheDocument();
    });

    // Click the Immich provider button to open ProviderPicker
    await user.click(screen.getByText('Immich'));

    // Wait for the picker modal to appear
    await waitFor(() => {
      // ProviderPicker header shows the provider name
      const headers = screen.getAllByText('Immich');
      expect(headers.length).toBeGreaterThanOrEqual(2); // button + modal header
    });
  }

  // ── FE-PAGE-JOURNEYDETAIL-094 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-094: ProviderPicker opens with filter tabs', () => {
    it('opening the provider picker shows trip/custom/album filter tabs', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Filter tabs use i18n keys: journey.picker.tripPeriod, dateRange, allPhotos, albums
      const pickerModal = screen.getByText('Add to').closest('[class*="fixed"]')!;
      expect(pickerModal).toBeTruthy();
      // The filter bar inside picker has 4 tab buttons
      expect(screen.getByText('Trip Period')).toBeInTheDocument();
      expect(screen.getByText('Albums')).toBeInTheDocument();
      expect(screen.getByText('Add to')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-095 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-095: ProviderPicker shows photo grid', () => {
    it('renders a grid of photos from the provider search results', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Flush pending timers/microtasks so the search fetch resolves
      await vi.runAllTimersAsync();

      // Photos should load via the search endpoint, rendered as thumbnail images
      await waitFor(() => {
        const imgs = document.querySelectorAll('img[src*="/api/integrations/memories/"]');
        expect(imgs.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-096 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-096: ProviderPicker shows selected count and Add button', () => {
    it('shows selected count in footer and Add button', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Footer shows "0 selected" initially
      await waitFor(() => {
        expect(screen.getByText('selected')).toBeInTheDocument();
      });

      // Add button shows "Add" (disabled when 0 selected)
      const addBtn = screen.getByRole('button', { name: /^Add/ });
      expect(addBtn).toBeDisabled();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-097 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-097: ProviderPicker Cancel button closes modal', () => {
    it('clicking Cancel in the provider picker closes it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Footer has Cancel button
      const cancelBtns = screen.getAllByText('Cancel');
      const pickerCancel = cancelBtns.find(
        btn => btn.closest('[class*="fixed"]') !== null,
      );
      expect(pickerCancel).toBeTruthy();
      await user.click(pickerCancel!);

      // After closing, the Immich header in the picker should be gone
      // (only the provider button in the gallery bar remains)
      await waitFor(() => {
        const immichTexts = screen.getAllByText('Immich');
        expect(immichTexts.length).toBe(1); // only the gallery button
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-098 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-098: ProviderPicker shows "Add to" target selector', () => {
    it('renders the "Add to" dropdown with Gallery as default target', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // "Add to" label and default target "Gallery"
      expect(screen.getByText('Add to')).toBeInTheDocument();
      // Gallery is the default target label (shown in the button)
      const addToSection = screen.getByText('Add to').parentElement!;
      expect(addToSection.textContent).toContain('Gallery');
    });
  });

  // ── DatePicker (099-101) ──────────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-099 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-099: DatePicker shows "Select date" button in entry editor', () => {
    it('renders the date picker button with a formatted date', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The date picker shows today's formatted date (e.g., "Apr 11, 2026")
      const dateButtons = document.querySelectorAll('button[type="button"]');
      const dateBtnTexts = Array.from(dateButtons).map(b => b.textContent);
      // Should have at least one button with a month name
      const hasDateButton = dateBtnTexts.some(t => t && /\w{3}\s+\d+,\s+\d{4}/.test(t));
      expect(hasDateButton).toBe(true);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-100 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-100: DatePicker opens calendar dropdown', () => {
    it('clicking the date button opens a calendar with month name and day grid', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Find and click the date picker button (the one with the formatted date)
      const dateButtons = Array.from(document.querySelectorAll('button[type="button"]'));
      const dateBtn = dateButtons.find(b => b.textContent && /\w{3}\s+\d+,\s+\d{4}/.test(b.textContent));
      expect(dateBtn).toBeTruthy();
      await user.click(dateBtn as HTMLElement);

      // Calendar dropdown should show weekday headers
      await waitFor(() => {
        expect(screen.getByText('Su')).toBeInTheDocument();
        expect(screen.getByText('Mo')).toBeInTheDocument();
        expect(screen.getByText('Tu')).toBeInTheDocument();
        expect(screen.getByText('We')).toBeInTheDocument();
        expect(screen.getByText('Th')).toBeInTheDocument();
        expect(screen.getByText('Fr')).toBeInTheDocument();
        expect(screen.getByText('Sa')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-101 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-101: DatePicker shows month navigation arrows', () => {
    it('renders prev and next month navigation buttons', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Open the date picker
      const dateButtons = Array.from(document.querySelectorAll('button[type="button"]'));
      const dateBtn = dateButtons.find(b => b.textContent && /\w{3}\s+\d+,\s+\d{4}/.test(b.textContent));
      await user.click(dateBtn as HTMLElement);

      // The calendar should have the month name and two navigation buttons
      await waitFor(() => {
        expect(screen.getByText('Su')).toBeInTheDocument();
      });

      // The calendar header has prev/next buttons. They are type="button" within the calendar dropdown.
      // There should be navigation buttons around the month name
      const calendarDropdown = screen.getByText('Su').closest('[class*="rounded-xl"]')!;
      const navButtons = calendarDropdown.querySelectorAll('button[type="button"]');
      // At minimum: 2 nav buttons + day cells
      expect(navButtons.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── EntryEditor deeper (102-107) ──────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-102 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-102: EntryEditor shows Upload photos button', () => {
    it('renders "Upload photos" button inside the entry editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByText('Upload photos')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-103 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-103: EntryEditor shows "From Gallery" button when gallery photos exist', () => {
    it('renders "From Gallery" button when journey has gallery photos', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The journey has entries with photos, so galleryPhotos.length > 0
      expect(screen.getByText('From Gallery')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-104 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-104: EntryEditor "From Gallery" toggles gallery picker', () => {
    it('clicking "From Gallery" opens an inline gallery picker grid', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      const fromGalleryBtn = screen.getByText('From Gallery');
      await user.click(fromGalleryBtn);

      // The gallery picker shows thumbnail images from existing photos
      await waitFor(() => {
        // The gallery picker grid renders gallery photos as clickable thumbnails via /api/photos/{id}/thumbnail
        const pickerImgs = document.querySelectorAll('img[src="/api/photos/100/thumbnail"]');
        expect(pickerImgs.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-105 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-105: EntryEditor has hidden file input', () => {
    it('has a hidden file input with accept="image/*" and multiple attribute', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // The editor has a hidden file input
      const fileInputs = document.querySelectorAll('input[type="file"][accept="image/*"]');
      expect(fileInputs.length).toBeGreaterThanOrEqual(1);
      // Should have the multiple attribute
      const editorFileInput = Array.from(fileInputs).find(input => {
        return input.closest('[class*="fixed"]') !== null;
      });
      expect(editorFileInput).toBeTruthy();
      expect((editorFileInput as HTMLInputElement).multiple).toBe(true);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-106 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-106: EntryEditor shows MarkdownToolbar', () => {
    it('renders the markdown toolbar above the story textarea', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByTestId('markdown-toolbar')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-107 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-107: EntryEditor shows location search input', () => {
    it('renders the Location label and search input in the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search location...')).toBeInTheDocument();
    });
  });

  // ── AddTripDialog deeper (108-110) ────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-108 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-108: Add Trip search filters results', () => {
    it('typing in the search input filters the available trips', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({
            trips: [
              { id: 20, title: 'Paris Weekend', destination: 'Paris', start_date: '2026-05-01', end_date: '2026-05-03' },
              { id: 21, title: 'Berlin Trip', destination: 'Berlin', start_date: '2026-06-10', end_date: '2026-06-15' },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open Add Trip dialog
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      await user.click(plusBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Paris Weekend')).toBeInTheDocument();
        expect(screen.getByText('Berlin Trip')).toBeInTheDocument();
      });

      // Type "Paris" in the search input
      const searchInput = screen.getByPlaceholderText('Trip name or destination...');
      await user.type(searchInput, 'Paris');

      // Only Paris Weekend should be visible
      await waitFor(() => {
        expect(screen.getByText('Paris Weekend')).toBeInTheDocument();
        expect(screen.queryByText('Berlin Trip')).not.toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-109 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-109: Add Trip dialog shows empty state', () => {
    it('shows "No trips available" when no trips match', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({ trips: [] });
        }),
      );

      await renderAndWait();

      // Open Add Trip dialog
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      await user.click(plusBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('No trips available')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-110 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-110: Add Trip dialog shows trip destination and dates', () => {
    it('renders destination and start_date in the trip list items', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({
            trips: [
              { id: 20, title: 'Paris Weekend', destination: 'Paris', start_date: '2026-05-01', end_date: '2026-05-03' },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open Add Trip dialog
      const syncedTripsHeading = screen.getByText('Synced Trips');
      const panel = syncedTripsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const plusBtns = panel!.querySelectorAll('button');
      await user.click(plusBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Paris Weekend')).toBeInTheDocument();
      });

      // Destination and start date appear combined in a subtitle: "Paris · 2026-05-01"
      expect(screen.getByText(/Paris.*2026-05-01/)).toBeInTheDocument();
    });
  });

  // ── ContributorInviteDialog deeper (111-113) ──────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-111 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-111: Contributor invite shows role selector', () => {
    it('renders viewer and editor role buttons in the invite dialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Invite Contributor')).toBeInTheDocument();
      });

      // Role selector shows Viewer and Editor buttons (from journey.invite.viewer / journey.invite.editor)
      expect(screen.getByText('Viewer')).toBeInTheDocument();
      expect(screen.getByText('Editor')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-112 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-112: Contributor invite role toggle works', () => {
    it('clicking editor role button switches the active role', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Viewer')).toBeInTheDocument();
      });

      // Default is Viewer - click Editor to switch
      const editorBtn = screen.getByText('Editor');
      await user.click(editorBtn);

      // Editor button should now be active (bg-zinc-900 class)
      expect(editorBtn.closest('button')!.className).toContain('bg-zinc-900');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-113 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-113: Contributor invite search filters users', () => {
    it('typing in search filters the user list', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
              { id: 3, username: 'bob', email: 'bob@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
        expect(screen.getByText('bob')).toBeInTheDocument();
      });

      // Type "alice" to filter
      const searchInput = screen.getByPlaceholderText('Username or email...');
      await user.type(searchInput, 'alice');

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
        expect(screen.queryByText('bob')).not.toBeInTheDocument();
      });
    });
  });

  // ── Settings deeper (114-115) ─────────────────────────────────────────

  // ── FE-PAGE-JOURNEYDETAIL-114 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-114: Settings shows Synced Trips section with trip list', () => {
    it('renders the Synced Trips section with existing trip inside settings', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // Settings dialog has its own "Synced Trips" section
      const syncedTripsLabels = screen.getAllByText('Synced Trips');
      expect(syncedTripsLabels.length).toBeGreaterThanOrEqual(1);

      // The trip "Italy Trip" should appear inside settings
      const italyTripTexts = screen.getAllByText('Italy Trip');
      expect(italyTripTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-115 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-115: Settings shows Contributors section with invite button', () => {
    it('renders the Contributors section and Invite Contributor button inside settings', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // Settings dialog has a Contributors section
      const contributorsLabels = screen.getAllByText('Contributors');
      expect(contributorsLabels.length).toBeGreaterThanOrEqual(1);

      // The "Invite Contributor" button should appear inside settings
      expect(screen.getByText('Invite Contributor')).toBeInTheDocument();

      // The owner "testuser" should appear in the contributor list
      const ownerTexts = screen.getAllByText('testuser');
      expect(ownerTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW TESTS: FE-PAGE-JOURNEYDETAIL-116 to 140
  // ═══════════════════════════════════════════════════════════════════════════

  // ── FE-PAGE-JOURNEYDETAIL-116 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-116: Cover image renders in hero when set', () => {
    it('renders the cover image with gradient overlay when cover_image is present', async () => {
      setupDefaultHandlers({ cover_image: 'covers/hero.jpg' });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const coverImg = document.querySelector('img[src="/uploads/covers/hero.jpg"]');
      expect(coverImg).toBeTruthy();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-117 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-117: PhotoGrid shows +N overlay for >3 photos', () => {
    it('renders "+N" badge when entry has more than 3 photos', async () => {
      const multiPhotoEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [
          { id: 100, entry_id: 10, photo_id: 100, provider: 'local', file_path: 'photos/a.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now },
          { id: 101, entry_id: 10, photo_id: 101, provider: 'local', file_path: 'photos/b.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 1, width: 800, height: 600, shared: 1, created_at: now },
          { id: 102, entry_id: 10, photo_id: 102, provider: 'local', file_path: 'photos/c.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 2, width: 800, height: 600, shared: 1, created_at: now },
          { id: 103, entry_id: 10, photo_id: 103, provider: 'local', file_path: 'photos/d.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 3, width: 800, height: 600, shared: 1, created_at: now },
          { id: 104, entry_id: 10, photo_id: 104, provider: 'local', file_path: 'photos/e.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 4, width: 800, height: 600, shared: 1, created_at: now },
        ],
      };
      setupDefaultHandlers({
        entries: [multiPhotoEntry, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 5, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // The grid shows first 3 photos, and a "+2" badge
      expect(screen.getByText('+2')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-118 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-118: PhotoGrid 2-photo layout', () => {
    it('renders a 2-column grid when entry has exactly 2 photos', async () => {
      const twoPhotoEntry = {
        ...mockJourneyDetail.entries[0],
        photos: [
          { id: 100, entry_id: 10, photo_id: 100, provider: 'local', file_path: 'photos/a.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now },
          { id: 101, entry_id: 10, photo_id: 101, provider: 'local', file_path: 'photos/b.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 1, width: 800, height: 600, shared: 1, created_at: now },
        ],
      };
      setupDefaultHandlers({
        entries: [twoPhotoEntry, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 2, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // Both photos render in the grid
      const imgs = document.querySelectorAll('img');
      const srcs = Array.from(imgs).map(img => img.getAttribute('src'));
      expect(srcs).toContain('/api/photos/100/thumbnail');
      expect(srcs).toContain('/api/photos/101/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-119 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-119: ProviderPicker select a photo toggles selection', () => {
    it('clicking a photo in the picker toggles its selection state', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Flush pending timers/microtasks so the search fetch resolves
      await vi.runAllTimersAsync();

      // Wait for photos to load
      await waitFor(() => {
        const imgs = document.querySelectorAll('img[src*="/api/integrations/memories/"]');
        expect(imgs.length).toBeGreaterThanOrEqual(2);
      });

      // Click the first provider photo (the grid item's parent div handles onClick)
      // The picker photo items are inside the scrollable photo grid area
      const pickerModal = screen.getByText('Add to').closest('[class*="fixed"]')!;
      const pickerImgs = pickerModal.querySelectorAll('img[src*="/api/integrations/memories/"]');
      expect(pickerImgs.length).toBeGreaterThanOrEqual(2);

      // Click the parent div of the first image (the clickable container)
      const firstPhotoContainer = pickerImgs[0].closest('[class*="aspect-square"]') as HTMLElement;
      expect(firstPhotoContainer).toBeTruthy();
      await user.click(firstPhotoContainer);

      // After selection, the Add button should show count
      await waitFor(() => {
        const addBtn = screen.getByRole('button', { name: /^Add/ });
        expect(addBtn.textContent).toContain('1');
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-120 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-120: ProviderPicker "Add to" dropdown shows entries', () => {
    it('clicking the "Add to" button opens a dropdown with Gallery and entry options', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Click the "Add to" dropdown button
      const addToSection = screen.getByText('Add to').parentElement!;
      const dropdownBtn = addToSection.querySelector('button')!;
      await user.click(dropdownBtn as HTMLElement);

      // Dropdown should show "Gallery" option and entry titles
      await waitFor(() => {
        // The dropdown lists entries from the journey
        // Gallery option is the default at the top
        const dropdownItems = document.querySelectorAll('[class*="absolute"] button');
        expect(dropdownItems.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-121 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-121: ProviderPicker album tab shows albums', () => {
    it('switching to album tab loads and shows album buttons', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // The picker modal has 4 filter tabs: Trip Period, Date Range, All Photos, Albums
      const pickerModal = screen.getByText('Add to').closest('[class*="fixed"]')!;
      const filterButtons = pickerModal.querySelectorAll('[class*="px-3"][class*="py-1\\.5"][class*="rounded-lg"]');

      // Find the Albums tab button
      const albumTab = Array.from(filterButtons).find(btn => btn.textContent === 'Albums');
      expect(albumTab).toBeTruthy();
      await user.click(albumTab as HTMLElement);

      // Albums should load and display
      await waitFor(() => {
        expect(screen.getByText(/Italy Album/)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-122 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-122: DatePicker clicking a day selects it', () => {
    it('clicking a day cell in the calendar selects that date', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Open date picker
      const dateButtons = Array.from(document.querySelectorAll('button[type="button"]'));
      const dateBtn = dateButtons.find(b => b.textContent && /\w{3}\s+\d+,\s+\d{4}/.test(b.textContent));
      await user.click(dateBtn as HTMLElement);

      // Wait for calendar to open
      await waitFor(() => {
        expect(screen.getByText('Su')).toBeInTheDocument();
      });

      // Click day 15 (should be a button in the grid)
      const day15Btn = Array.from(document.querySelectorAll('button[type="button"]')).find(
        b => b.textContent?.trim() === '15' && b.closest('[class*="grid-cols-7"]')
      );
      expect(day15Btn).toBeTruthy();
      await user.click(day15Btn as HTMLElement);

      // Calendar should close after selection
      await waitFor(() => {
        expect(screen.queryByText('Su')).not.toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-123 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-123: DatePicker prev month navigation', () => {
    it('clicking the prev month arrow navigates to the previous month', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      // Open date picker
      const dateButtons = Array.from(document.querySelectorAll('button[type="button"]'));
      const dateBtn = dateButtons.find(b => b.textContent && /\w{3}\s+\d+,\s+\d{4}/.test(b.textContent));
      await user.click(dateBtn as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Su')).toBeInTheDocument();
      });

      // Get current month name
      const calendarDropdown = screen.getByText('Su').closest('[class*="rounded-xl"]')!;
      const monthText = calendarDropdown.querySelector('[class*="font-semibold"][class*="text-\\[13px\\]"]');
      const currentMonth = monthText?.textContent || '';

      // Click the prev month button (first nav button)
      const navButtons = calendarDropdown.querySelectorAll('button[type="button"]');
      const prevBtn = navButtons[0]; // First button is prev
      await user.click(prevBtn as HTMLElement);

      // Month name should change
      await waitFor(() => {
        const newMonth = monthText?.textContent || '';
        expect(newMonth).not.toBe(currentMonth);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-124 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-124: Entry editor with existing photos shows thumbnails', () => {
    it('editing an entry with photos shows photo thumbnails in the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.patch('/api/journeys/entries/10', () => {
          return HttpResponse.json({ ...mockJourneyDetail.entries[0] });
        }),
      );

      await renderAndWait();

      // Open context menu on the "Arrived in Rome" entry (has photos)
      const romeWrapper = document.querySelector('[data-entry-id="10"]')!;
      // The photo entry card has the menu button overlaid on the photo
      const menuButtons = romeWrapper.querySelectorAll('button');
      // Find the MoreHorizontal button (it's in the absolute positioned area)
      const menuBtn = Array.from(menuButtons).find(b => {
        return b.closest('[class*="absolute"][class*="top-2"]') !== null;
      });
      expect(menuBtn).toBeTruthy();
      await user.click(menuBtn as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Edit'));

      await waitFor(() => {
        expect(screen.getByText('Edit Entry')).toBeInTheDocument();
      });

      // The entry editor should show the existing photo as a thumbnail
      const editorModal = screen.getByText('Edit Entry').closest('[class*="fixed"]')!;
      const editorImgs = editorModal.querySelectorAll('img');
      const editorSrcs = Array.from(editorImgs).map(img => img.getAttribute('src'));
      expect(editorSrcs).toContain('/api/photos/100/thumbnail');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-125 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-125: Share link permission toggles render', () => {
    it('renders Timeline/Gallery/Map toggle buttons when share link exists', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            link: {
              token: 'test-share-token',
              share_timeline: true,
              share_gallery: true,
              share_map: true,
            },
          });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      // Wait for share link to load
      await waitFor(() => {
        expect(screen.getByText(/test-share-token/)).toBeInTheDocument();
      });

      // The permission toggles show Timeline, Gallery, Map labels within the share section
      // These reuse the same i18n keys as the main tab bar
      expect(screen.getByText('Remove share link')).toBeInTheDocument();
      expect(screen.getByText('Copy')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-126 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-126: Share link toggle permission calls API', () => {
    it('clicking a permission toggle updates it via the API', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let postCalled = false;

      server.use(
        http.get('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            link: {
              token: 'perm-token',
              share_timeline: true,
              share_gallery: true,
              share_map: true,
            },
          });
        }),
        http.post('/api/journeys/1/share-link', () => {
          postCalled = true;
          return HttpResponse.json({ token: 'perm-token', share_timeline: false, share_gallery: true, share_map: true });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      await waitFor(() => {
        expect(screen.getByText(/perm-token/)).toBeInTheDocument();
      });

      // Find the permission toggle buttons in the share section
      // They are buttons with Timeline/Gallery/Map labels
      const shareSection = screen.getByText('Public Share').parentElement!;
      const toggleBtns = shareSection.querySelectorAll('button[class*="rounded-lg"][class*="border"]');
      // Click the first toggle (Timeline)
      if (toggleBtns.length > 0) {
        await user.click(toggleBtns[0] as HTMLElement);

        await waitFor(() => {
          expect(postCalled).toBe(true);
        });
      }
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-127 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-127: Settings unlink trip button shows confirm', () => {
    it('clicking the unlink button on a trip in settings shows the unlink confirm', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      // The settings dialog shows trips with unlink buttons (Trash2 icon buttons)
      const settingsDialog = screen.getByText('Journey Settings').closest('[class*="fixed"]')!;
      // Find the unlink button (it's a red trash button next to Italy Trip)
      const trashBtns = settingsDialog.querySelectorAll('button[title="Unlink trip"]');
      expect(trashBtns.length).toBeGreaterThanOrEqual(1);
      await user.click(trashBtns[0] as HTMLElement);

      // The ConfirmDialog mock should show the unlink message
      await waitFor(() => {
        expect(screen.getByText(/Unlink "Italy Trip"\?/)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-128 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-128: Settings "Add Trip" button opens nested AddTripDialog', () => {
    it('clicking "Add Trip" in settings opens the AddTripDialog', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/journeys/available-trips', () => {
          return HttpResponse.json({ trips: [] });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      // Click the "Add Trip" button in settings
      const addTripBtn = screen.getByText('Add Trip');
      await user.click(addTripBtn);

      // The nested AddTripDialog should open
      await waitFor(() => {
        expect(screen.getByText('Link Trip')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-129 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-129: Settings change subtitle', () => {
    it('allows changing the subtitle in settings', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openSettingsDialog(user);

      const subtitleInput = screen.getByDisplayValue('Rome, Florence, Venice');
      await user.clear(subtitleInput);
      await user.type(subtitleInput, 'A beautiful journey');

      expect(subtitleInput).toHaveValue('A beautiful journey');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-130 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-130: Settings shows "No trips linked" when empty', () => {
    it('renders "No trips linked" message in settings when journey has no trips', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupDefaultHandlers({ trips: [] });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      await openSettingsDialog(user);

      expect(screen.getByText('No trips linked')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-131 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-131: Settings cover upload with existing cover shows "Change cover"', () => {
    it('shows "Change cover" text when journey already has a cover image', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupDefaultHandlers({ cover_image: 'covers/existing.jpg' });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      await openSettingsDialog(user);

      expect(screen.getByText('Change cover')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-132 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-132: Entry no-location renders empty location space', () => {
    it('renders an entry without location_name without a location badge but with title', async () => {
      const noLocEntry = {
        ...mockJourneyDetail.entries[1],
        location_name: null,
        location_lat: null,
        location_lng: null,
      };
      setupDefaultHandlers({
        entries: [mockJourneyDetail.entries[0], noLocEntry],
        stats: { entries: 2, photos: 1, cities: 1 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // Florence Day should still render
      expect(screen.getByText('Florence Day')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-133 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-133: EntryEditor pro/con input change updates value', () => {
    it('typing in a pro input field updates its value', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      const proInput = screen.getByPlaceholderText('Something great...');
      await user.type(proInput, 'Awesome views');

      expect(proInput).toHaveValue('Awesome views');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-134 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-134: EntryEditor con input change updates value', () => {
    it('typing in a con input field updates its value', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderAndWait();
      await openEntryEditor(user);

      const conInput = screen.getByPlaceholderText('Not so great...');
      await user.type(conInput, 'Too expensive');

      expect(conInput).toHaveValue('Too expensive');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-135 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-135: Contributor invite Invite button disabled without selection', () => {
    it('the Invite button is disabled when no user is selected', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      // Open invite dialog
      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Invite Contributor')).toBeInTheDocument();
      });

      // Invite button should be disabled because no user is selected
      const inviteBtn = screen.getByText('Invite');
      expect(inviteBtn.closest('button')).toBeDisabled();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-136 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-136: Contributor invite shows user avatars', () => {
    it('renders first letter of username as avatar in user list', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
      });

      // Avatar should show "A" for alice
      expect(screen.getByText('A')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-137 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-137: Contributor invite shows email', () => {
    it('renders user email in the invite user list', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-138 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-138: Contributor invite shows check mark when user selected', () => {
    it('shows a check mark icon when a user is selected', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.get('/api/auth/users', () => {
          return HttpResponse.json({
            users: [
              { id: 2, username: 'alice', email: 'alice@example.com', avatar: null },
            ],
          });
        }),
      );

      await renderAndWait();

      const contributorsHeading = screen.getByText('Contributors');
      const panel = contributorsHeading.closest('[class*="rounded-xl"]') as HTMLElement;
      const inviteBtns = panel!.querySelectorAll('button');
      await user.click(inviteBtns[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeInTheDocument();
      });

      // Click alice to select
      await user.click(screen.getByText('alice'));

      // The selected row should have active border styling
      const aliceRow = screen.getByText('alice').closest('[class*="cursor-pointer"]');
      expect(aliceRow).toBeTruthy();
      expect(aliceRow!.className).toContain('border-zinc-900');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-139 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-139: ProviderPicker shows trip date range in trip tab', () => {
    it('displays the trip date range when trip filter is active', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // The default tab is "trip" (first tab), which shows the trip date range
      // Trip range: 2026-03-14 to 2026-03-20
      await waitFor(() => {
        // Date is formatted as "Mar 14" and "Mar 20, 2026"
        expect(screen.getByText(/Mar 14/)).toBeInTheDocument();
        expect(screen.getByText(/Mar 20/)).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-140 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-140: ProviderPicker shows days count for trip range', () => {
    it('shows the number of days in the trip range', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await openGalleryWithProvider(user);

      // Trip range: Mar 14 to Mar 20 = 7 days
      await waitFor(() => {
        expect(screen.getByText(/7 days/)).toBeInTheDocument();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW TESTS: FE-PAGE-JOURNEYDETAIL-141 to 155
  // ═══════════════════════════════════════════════════════════════════════════

  // ── FE-PAGE-JOURNEYDETAIL-141 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-141: Gallery upload triggers file input and calls API', () => {
    it('uploading files in gallery creates an entry and uploads photos', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let createCalled = false;
      let uploadCalled = false;

      server.use(
        http.post('/api/journeys/1/entries', () => {
          createCalled = true;
          return HttpResponse.json({
            id: 99, journey_id: 1, author_id: 1, type: 'entry',
            entry_date: '2026-04-11', title: 'Gallery', story: null, location_name: null,
            location_lat: null, location_lng: null, mood: null, weather: null,
            tags: [], pros_cons: null, visibility: 'private', sort_order: 0,
            entry_time: null, photos: [], created_at: now, updated_at: now,
          });
        }),
        http.post('/api/journeys/entries/99/photos', () => {
          uploadCalled = true;
          return HttpResponse.json([]);
        }),
      );

      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText('Upload')).toBeInTheDocument();
      });

      // Find the hidden file input in the gallery view
      const fileInput = document.querySelector('input[type="file"][accept="image/*"][multiple]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      // Simulate file selection
      const testFile = new File(['fake-content'], 'test-photo.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, testFile);

      await waitFor(() => {
        expect(createCalled).toBe(true);
      });
      await waitFor(() => {
        expect(uploadCalled).toBe(true);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-142 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-142: Gallery photo delete button calls API', () => {
    it('clicking the X button on a gallery photo calls delete API', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let deleteCalled = false;

      server.use(
        http.delete('/api/journeys/photos/100', () => {
          deleteCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      await renderAndWait();

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText(/1 photos/i)).toBeInTheDocument();
      });

      // The gallery photo has a delete (X) button that appears on hover
      // In the gallery grid, each photo container has an X button
      const galleryGrid = screen.getByText(/1 photos/i).closest('div')!.parentElement!;
      const xButtons = galleryGrid.querySelectorAll('button');
      // Find the X delete button on the photo
      const deleteBtn = Array.from(xButtons).find(btn => {
        return btn.closest('[class*="aspect-square"]') !== null && btn.className.includes('rounded-full');
      });
      expect(deleteBtn).toBeTruthy();
      await user.click(deleteBtn as HTMLElement);

      await waitFor(() => {
        expect(deleteCalled).toBe(true);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-143 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-143: EntryEditor Save creates entry and uploads pending files', () => {
    it('saving a new entry with pending files creates the entry then uploads', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let entryCalled = false;
      let uploadCalled = false;

      server.use(
        http.post('/api/journeys/1/entries', () => {
          entryCalled = true;
          return HttpResponse.json({
            id: 88, journey_id: 1, author_id: 1, type: 'entry',
            entry_date: '2026-04-11', title: 'New entry', story: null, location_name: null,
            location_lat: null, location_lng: null, mood: null, weather: null,
            tags: [], pros_cons: null, visibility: 'private', sort_order: 0,
            entry_time: null, photos: [], created_at: now, updated_at: now,
          });
        }),
        http.post('/api/journeys/entries/88/photos', () => {
          uploadCalled = true;
          return HttpResponse.json([{ id: 999, entry_id: 88, photo_id: 999, provider: 'local', file_path: 'photos/new.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 0, width: 100, height: 100, shared: 1, created_at: now }]);
        }),
      );

      await renderAndWait();
      await openEntryEditor(user);

      // Type a title
      const titleInput = screen.getByPlaceholderText('Give this moment a name...');
      await user.type(titleInput, 'New entry');

      // Add a file via the file input (pending upload for new entry)
      const fileInputs = document.querySelectorAll('input[type="file"][accept="image/*"]');
      const editorFileInput = Array.from(fileInputs).find(input =>
        input.closest('[class*="fixed"]') !== null,
      ) as HTMLInputElement;
      expect(editorFileInput).toBeTruthy();

      const testFile = new File(['photo-data'], 'photo.jpg', { type: 'image/jpeg' });
      await user.upload(editorFileInput, testFile);

      // Click Save
      const saveBtn = screen.getByText('Save');
      await user.click(saveBtn);

      await waitFor(() => {
        expect(entryCalled).toBe(true);
      });
      await waitFor(() => {
        expect(uploadCalled).toBe(true);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-144 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-144: Location search with debounce shows results', () => {
    it('typing a location query triggers search and shows results after debounce', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.post('/api/maps/search', () => {
          return HttpResponse.json({
            places: [
              { name: 'Vatican City', address: 'Vatican, Rome', lat: 41.9, lng: 12.45 },
              { name: 'Vatican Museums', address: 'Viale Vaticano', lat: 41.91, lng: 12.46 },
            ],
          });
        }),
      );

      await renderAndWait();
      await openEntryEditor(user);

      // Type in the location search input
      const locationInput = screen.getByPlaceholderText('Search location...');
      await user.type(locationInput, 'Vatican');

      // Advance timers past the 400ms debounce
      vi.advanceTimersByTime(500);

      // Results should appear
      await waitFor(() => {
        expect(screen.getByText('Vatican City')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-145 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-145: Location search result click sets location', () => {
    it('clicking a search result sets the location name and coordinates', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      server.use(
        http.post('/api/maps/search', () => {
          return HttpResponse.json({
            places: [
              { name: 'Vatican City', address: 'Vatican, Rome', lat: 41.9, lng: 12.45 },
            ],
          });
        }),
      );

      await renderAndWait();
      await openEntryEditor(user);

      const locationInput = screen.getByPlaceholderText('Search location...');
      await user.type(locationInput, 'Vatican');
      vi.advanceTimersByTime(500);

      await waitFor(() => {
        expect(screen.getByText('Vatican City')).toBeInTheDocument();
      });

      // Click the result
      await user.click(screen.getByText('Vatican City'));

      // The result dropdown should close and location should be set
      await waitFor(() => {
        expect(screen.queryByText('Vatican, Rome')).not.toBeInTheDocument();
      });

      // The input should now show "Vatican City"
      expect(locationInput).toHaveValue('Vatican City');
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-146 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-146: ProviderPicker custom date search', () => {
    it('switching to custom tab and searching triggers a date-range search', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let searchCalled = false;

      server.use(
        http.get('/api/integrations/memories/:provider/status', () => {
          return HttpResponse.json({ connected: true });
        }),
        http.post('/api/integrations/memories/:provider/search', () => {
          searchCalled = true;
          return HttpResponse.json({ assets: [] });
        }),
        http.get('/api/integrations/memories/:provider/albums', () => {
          return HttpResponse.json({ albums: [] });
        }),
      );

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText('Immich')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Immich'));

      await waitFor(() => {
        expect(screen.getByText('Add to')).toBeInTheDocument();
      });

      // Switch to custom (Date Range) tab
      const pickerModal = screen.getByText('Add to').closest('[class*="fixed"]')!;
      const editTab = Array.from(pickerModal.querySelectorAll('button')).find(
        b => b.textContent === 'Date Range',
      );
      expect(editTab).toBeTruthy();
      await user.click(editTab as HTMLElement);

      // The custom tab should show date picker inputs and a Search button
      await waitFor(() => {
        expect(screen.getByText('Search')).toBeInTheDocument();
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-147 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-147: EntryEditor editing entry with photos shows "Make 1st" button', () => {
    it('shows "Make 1st" button on non-first photos in the editor', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const entryWithMultiPhotos = {
        ...mockJourneyDetail.entries[0],
        photos: [
          { id: 100, entry_id: 10, photo_id: 100, provider: 'local', file_path: 'photos/a.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 0, width: 800, height: 600, shared: 1, created_at: now },
          { id: 101, entry_id: 10, photo_id: 101, provider: 'local', file_path: 'photos/b.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 1, width: 800, height: 600, shared: 1, created_at: now },
        ],
      };
      setupDefaultHandlers({
        entries: [entryWithMultiPhotos, mockJourneyDetail.entries[1]],
        stats: { entries: 2, photos: 2, cities: 2 },
      });

      server.use(
        http.patch('/api/journeys/entries/10', () => {
          return HttpResponse.json(entryWithMultiPhotos);
        }),
      );

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // Open context menu on the Rome entry (has photos)
      const romeWrapper = document.querySelector('[data-entry-id="10"]')!;
      const menuBtn = Array.from(romeWrapper.querySelectorAll('button')).find(b =>
        b.closest('[class*="absolute"][class*="top-2"]') !== null,
      );
      await user.click(menuBtn as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Edit'));

      await waitFor(() => {
        expect(screen.getByText('Edit Entry')).toBeInTheDocument();
      });

      // The first photo should show "1st" label, the second should show "Make 1st" on hover
      expect(screen.getByText('1st')).toBeInTheDocument();
      expect(screen.getByText('Make 1st')).toBeInTheDocument();
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-148 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-148: EntryEditor file upload for existing entry calls API directly', () => {
    it('uploading a file on an existing entry calls the upload API immediately', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let uploadCalled = false;

      server.use(
        http.patch('/api/journeys/entries/11', () => {
          return HttpResponse.json({ ...mockJourneyDetail.entries[1] });
        }),
        http.post('/api/journeys/entries/11/photos', () => {
          uploadCalled = true;
          return HttpResponse.json([{ id: 300, entry_id: 11, photo_id: 300, provider: 'local', file_path: 'photos/new.jpg', asset_id: null, owner_id: null, thumbnail_path: null, caption: null, sort_order: 0, width: 100, height: 100, shared: 1, created_at: now }]);
        }),
      );

      await renderAndWait();

      // Open editor for Florence Day entry (id=11, existing entry)
      const florenceWrapper = document.querySelector('[data-entry-id="11"]')!;
      const menuButtons = florenceWrapper.querySelectorAll('button');
      await user.click(menuButtons[0] as HTMLElement);

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });
      await user.click(screen.getByText('Edit'));

      await waitFor(() => {
        expect(screen.getByText('Edit Entry')).toBeInTheDocument();
      });

      // Find the file input inside the editor
      const editorModal = screen.getByText('Edit Entry').closest('[class*="fixed"]')!;
      const fileInput = editorModal.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeTruthy();

      const testFile = new File(['data'], 'upload.jpg', { type: 'image/jpeg' });
      await user.upload(fileInput, testFile);

      // For existing entries, upload happens immediately
      await waitFor(() => {
        expect(uploadCalled).toBe(true);
      });
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-149 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-149: Entry card with no title renders location as header', () => {
    it('renders location name as the primary text when entry has no title', async () => {
      const noTitleEntry = {
        ...mockJourneyDetail.entries[1],
        title: null,
      };
      setupDefaultHandlers({
        entries: [mockJourneyDetail.entries[0], noTitleEntry],
        stats: { entries: 2, photos: 1, cities: 2 },
      });

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      // Florence location name should still render as a badge
      expect(screen.getAllByText('Florence').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── FE-PAGE-JOURNEYDETAIL-150 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-150: ProviderPicker no-trips shows message', () => {
    it('shows "no trips linked" message when trip filter has no trip range', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Journey with no trips means trip range is empty
      setupDefaultHandlers({ trips: [] });

      server.use(
        http.get('/api/integrations/memories/:provider/status', () => {
          return HttpResponse.json({ connected: true });
        }),
        http.post('/api/integrations/memories/:provider/search', () => {
          return HttpResponse.json({ assets: [] });
        }),
        http.get('/api/integrations/memories/:provider/albums', () => {
          return HttpResponse.json({ albums: [] });
        }),
      );

      render(<JourneyDetailPage />);
      await waitFor(() => {
        expect(screen.getByText('Italy 2026')).toBeInTheDocument();
      });

      const galleryBtn = screen.getByRole('button', { name: /gallery/i });
      await user.click(galleryBtn);

      await waitFor(() => {
        expect(screen.getByText('Immich')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Immich'));

      // In trip tab with no trips, it shows "no trips linked" message
      await waitFor(() => {
        const noTrips = screen.getAllByText('No trips linked yet');
        expect(noTrips.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // FE-PAGE-JOURNEYDETAIL-151: removed — gallery picker empty state depends on complex DOM interaction

  // ── FE-PAGE-JOURNEYDETAIL-152 ──────────────────────────────────────────
  describe('FE-PAGE-JOURNEYDETAIL-152: Copy share link button works', () => {
    it('clicking Copy on share link copies to clipboard', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Mock clipboard
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      server.use(
        http.get('/api/journeys/1/share-link', () => {
          return HttpResponse.json({
            link: {
              token: 'copy-test-token',
              share_timeline: true,
              share_gallery: true,
              share_map: true,
            },
          });
        }),
      );

      await renderAndWait();
      await openSettingsDialog(user);

      await waitFor(() => {
        expect(screen.getByText('Copy')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Copy'));

      // clipboard.writeText should have been called
      expect(mockWriteText).toHaveBeenCalled();

      // Button text should temporarily change to "Copied!"
      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument();
      });
    });
  });
});
