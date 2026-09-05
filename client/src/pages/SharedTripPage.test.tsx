import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../tests/helpers/render';
import { Routes, Route } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildSettings } from '../../tests/helpers/factories';
import { useSettingsStore } from '../store/settingsStore';
import SharedTripPage from './SharedTripPage';
import L from 'leaflet';

// Mock react-leaflet (SharedTripPage renders a map)
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="map-container">{children}</div>
  ),
  TileLayer: ({ url }: { url: string }) => <div data-testid="raster-tiles" data-url={url} />,
  Marker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Polyline: () => <div data-testid="route-line" />,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useMap: () => ({
    fitBounds: vi.fn(),
    getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
  }),
}));

// The basemap is a MapLibre style now, and the real component reaches for
// maplibre-gl through a dynamic import. The page test only cares that it is the
// thing being rendered.
vi.mock('../components/Map/VectorBasemap', () => ({
  default: ({ style }: { style: string }) => <div data-testid="vector-basemap" data-style={style} />,
}));

vi.mock('leaflet', () => {
  const L = {
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({
      extend: vi.fn(),
      isValid: vi.fn(() => true),
    })),
    icon: vi.fn(() => ({})),
  };
  return { default: L, ...L };
});

// Helper: render SharedTripPage under the correct route so useParams works
function renderSharedTrip(token: string) {
  return render(
    <Routes>
      <Route path="/shared/:token" element={<SharedTripPage />} />
    </Routes>,
    { initialEntries: [`/shared/${token}`] },
  );
}

beforeEach(() => {
  // SharedTripPage does NOT require authentication — do NOT seed auth store
  resetAllStores();
  vi.clearAllMocks();
});

describe('SharedTripPage', () => {
  describe('FE-PAGE-SHARED-001: Renders without authentication', () => {
    it('renders loading spinner without any auth state', async () => {
      // Use a token that will delay or we just check initial state before response
      server.use(
        http.get('/api/shared/:token', async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return HttpResponse.json({ trips: [] });
        }),
      );

      renderSharedTrip('test-token');

      // While data is loading, shows a spinner (the loading div)
      // The page shows a spinning div before data arrives
      expect(document.body.textContent).toBeDefined();
    });
  });

  describe('FE-PAGE-SHARED-002: Trip data loads from share token API', () => {
    it('fetches shared trip from GET /api/shared/:token', async () => {
      renderSharedTrip('test-token');

      // After data loads, trip name appears
      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-003: Trip details displayed', () => {
    it('shows trip name after data loads', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-004: Invalid token shows error', () => {
    it('displays error message when token is invalid or expired', async () => {
      renderSharedTrip('invalid-token');

      await waitFor(() => {
        expect(screen.getByText(/link expired or invalid/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-005: No edit controls shown (read-only)', () => {
    it('shows the read-only indicator after data loads', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        // The shared page renders "Read-only shared view" text
        expect(screen.getByText(/read-only/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-006: Expired token hint is shown', () => {
    it('shows hint text below the lock icon on error', async () => {
      renderSharedTrip('expired-token');

      await waitFor(() => {
        expect(screen.getByText(/no longer active/i)).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-007: Map is rendered', () => {
    it('renders the map container for the shared trip', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      // Map container should be rendered
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-008: Bookings tab is visible when share_bookings is true', () => {
    it('shows bookings tab button with default test-token permissions', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      const bookingsTab = screen.getByRole('button', { name: /bookings/i });
      expect(bookingsTab).toBeInTheDocument();

      // Clicking should not crash
      fireEvent.click(bookingsTab);
      expect(bookingsTab).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-009: Packing tab hidden when share_packing is false', () => {
    it('does not show packing tab with default test-token (share_packing: false)', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /packing/i })).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-010: Packing tab visible when share_packing is true', () => {
    it('shows packing tab and packing items when share_packing is true', async () => {
      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'packing-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
            days: [],
            assignments: {},
            dayNotes: {},
            places: [],
            reservations: [],
            accommodations: [],
            packing: [{ id: 1, name: 'Sunscreen', category: 'Health', checked: false }],
            budget: [],
            categories: [],
            permissions: { share_bookings: false, share_packing: true, share_budget: false, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('packing-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      const packingTab = screen.getByRole('button', { name: /packing/i });
      expect(packingTab).toBeInTheDocument();

      fireEvent.click(packingTab);

      await waitFor(() => {
        expect(screen.getByText('Sunscreen')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-011: Budget tab visible when share_budget is true', () => {
    it('shows budget tab and budget items when share_budget is true', async () => {
      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'budget-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05', currency: 'EUR' },
            days: [],
            assignments: {},
            dayNotes: {},
            places: [],
            reservations: [],
            accommodations: [],
            packing: [],
            budget: [{ id: 1, name: 'Hotel', total_price: '200', category: 'Accommodation' }],
            categories: [],
            permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('budget-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      const budgetTab = screen.getByRole('button', { name: /costs/i });
      expect(budgetTab).toBeInTheDocument();

      fireEvent.click(budgetTab);

      await waitFor(() => {
        expect(screen.getByText('Hotel')).toBeInTheDocument();
      });
      expect(screen.getAllByText(/200/).length).toBeGreaterThan(0);
    });
  });

  describe('FE-PAGE-SHARED-012: Collab tab renders messages when share_collab is true', () => {
    it('shows collab messages when share_collab is true', async () => {
      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'collab-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
            days: [],
            assignments: {},
            dayNotes: {},
            places: [],
            reservations: [],
            accommodations: [],
            packing: [],
            budget: [],
            categories: [],
            permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: true },
            collab: [{ id: 1, username: 'alice', text: 'Hello team!', created_at: '2025-01-01T10:00:00Z', avatar: null }],
          });
        }),
      );

      renderSharedTrip('collab-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      const collabTab = screen.getByRole('button', { name: /chat/i });
      expect(collabTab).toBeInTheDocument();

      fireEvent.click(collabTab);

      await waitFor(() => {
        expect(screen.getByText('Hello team!')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-013: Day card expands when clicked', () => {
    it('reveals place names after clicking a collapsed day card header', async () => {
      const day = { id: 101, trip_id: 1, day_number: 1, date: '2026-07-01', title: 'Day One', notes: null };
      const place = { id: 201, trip_id: 1, name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945, category_id: null, image_url: null, address: null };

      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'expand-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
            days: [day],
            assignments: {
              '101': [{ id: 301, day_id: 101, place_id: 201, order_index: 0, place }],
            },
            dayNotes: {},
            places: [place],
            reservations: [],
            accommodations: [],
            packing: [],
            budget: [],
            categories: [],
            permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('expand-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      // Eiffel Tower is only in the mocked map tooltip (1 occurrence)
      expect(screen.getAllByText('Eiffel Tower')).toHaveLength(1);

      // Click the day card header to expand it
      fireEvent.click(screen.getByText('Day One'));

      // Now Eiffel Tower also appears in the expanded day content
      await waitFor(() => {
        expect(screen.getAllByText('Eiffel Tower')).toHaveLength(2);
      });
    });
  });

  describe('FE-PAGE-SHARED-014: Language picker toggles', () => {
    it('opens language dropdown and closes after selecting a language', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      // Language picker button shows current language
      const langButton = screen.getByRole('button', { name: /english/i });
      expect(langButton).toBeInTheDocument();

      // Open the dropdown
      fireEvent.click(langButton);

      // Language options should now be visible
      expect(screen.getByRole('button', { name: /deutsch/i })).toBeInTheDocument();

      // Select a different language
      fireEvent.click(screen.getByRole('button', { name: /deutsch/i }));

      // Dropdown should close — Español is no longer visible
      expect(screen.queryByRole('button', { name: /español/i })).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-015: TREK branding footer is rendered', () => {
    it('renders the Shared via TREK footer', async () => {
      renderSharedTrip('test-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      expect(screen.getByText(/shared via/i)).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-016: Bookings tab shows reservation list', () => {
    it('renders reservations when bookings tab is active and reservations are provided', async () => {
      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'bookings-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
            days: [],
            assignments: {},
            dayNotes: {},
            places: [],
            reservations: [
              { id: 1, title: 'Flight to Paris', type: 'flight', status: 'confirmed', reservation_time: '2026-07-01T10:00:00', metadata: '{}' },
            ],
            accommodations: [],
            packing: [],
            budget: [],
            categories: [],
            permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('bookings-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      await waitFor(() => {
        expect(screen.getByText('Flight to Paris')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SHARED-017: Multi-leg flight shows each leg in the Day Plan', () => {
    const day = { id: 101, trip_id: 1, day_number: 1, date: '2026-07-01', title: 'Day One', notes: null };
    const multiLegFlight = {
      id: 9, trip_id: 1, title: 'Flight', type: 'flight', status: 'confirmed',
      day_id: 101, end_day_id: 101,
      reservation_time: '2026-07-01T08:00:00', reservation_end_time: '2026-07-01T20:00:00',
      metadata: JSON.stringify({
        legs: [
          { from: 'FRA', to: 'BER', airline: 'Lufthansa', flight_number: 'LH1', dep_day_id: 101, dep_time: '08:00', arr_day_id: 101, arr_time: '09:00' },
          { from: 'BER', to: 'HND', airline: 'Lufthansa', flight_number: 'LH2', dep_day_id: 101, dep_time: '10:00', arr_day_id: 101, arr_time: '20:00' },
        ],
        departure_airport: 'FRA', arrival_airport: 'HND', airline: 'Lufthansa', flight_number: 'LH1',
      }),
    };

    function serveMultiLeg(token: string) {
      server.use(
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== token) return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
            days: [day],
            assignments: {},
            dayNotes: {},
            places: [],
            reservations: [multiLegFlight],
            accommodations: [],
            packing: [],
            budget: [],
            categories: [],
            permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
            collab: [],
          });
        }),
      );
    }

    it('renders each leg with its own route, not the overall start/end', async () => {
      serveMultiLeg('multileg-token');
      renderSharedTrip('multileg-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      // Expand the day to reveal the timeline
      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => {
        expect(screen.getByText(/FRA → BER/)).toBeInTheDocument();
      });
      // Second leg shows its OWN route + flight number (the bug showed the overall route here)
      expect(screen.getByText(/BER → HND/)).toBeInTheDocument();
      expect(screen.getByText(/LH2/)).toBeInTheDocument();
      // The overall start→end must NOT appear on any leg
      expect(screen.queryByText(/FRA → HND/)).toBeNull();
    });

    it('lists each leg flight number in the Bookings tab', async () => {
      serveMultiLeg('multileg-bookings-token');
      renderSharedTrip('multileg-bookings-token');

      await waitFor(() => {
        expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      await waitFor(() => {
        expect(screen.getByText(/LH1/)).toBeInTheDocument();
      });
      expect(screen.getByText(/LH2/)).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-018: untitled day uses the translated day label (#1296)', () => {
    it('renders the day-number label via i18n (German), not a hardcoded English string', async () => {
      seedStore(useSettingsStore, { settings: buildSettings({ language: 'de' }) });
      const day = { id: 101, trip_id: 1, day_number: 1, date: '2026-07-01', title: null, notes: null };
      server.use(
        http.get('/api/shared/:token', () => HttpResponse.json({
          trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05' },
          days: [day],
          assignments: {},
          dayNotes: {},
          places: [],
          reservations: [],
          accommodations: [],
          packing: [],
          budget: [],
          categories: [],
          permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: false },
          collab: [],
        })),
      );
      renderSharedTrip('test-token');
      // The untitled day shows the German label "Tag 1", proving the hardcoded English
      // "Day 1" was replaced by the i18n key t('dayplan.dayN'). It appears twice since
      // the day picker above the map was added (#1962): once as a chip, once on the card.
      await waitFor(() => expect(screen.getAllByText('Tag 1')).toHaveLength(2));
      const labels = screen.getAllByText('Tag 1');
      // One of each: the picker chip carries aria-pressed, the day card's header aria-expanded.
      expect(labels.filter((el) => el.closest('[aria-pressed]'))).toHaveLength(1);
      expect(labels.filter((el) => el.closest('[aria-expanded]'))).toHaveLength(1);
    });
  });

  describe('FE-PAGE-SHARED-019: budget renders in the owner\'s baseCurrency, not the EUR trip fallback (#1361)', () => {
    it('labels totals with the payload baseCurrency even when the trip currency is EUR', async () => {
      server.use(
        // No FX needed when the expense is already in the base; stub frankfurter so
        // the live-rate fetch never hits the network in tests.
        http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([])),
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'cad-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05', currency: 'EUR' },
            baseCurrency: 'CAD',
            days: [], assignments: {}, dayNotes: {}, places: [], reservations: [], accommodations: [], packing: [],
            budget: [{ id: 1, name: 'Hotel', total_price: '200', category: 'Accommodation', currency: 'CAD' }],
            categories: [],
            permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('cad-token');
      await waitFor(() => expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /costs/i }));

      await waitFor(() => expect(screen.getByText('Hotel')).toBeInTheDocument());
      // Total + per-row labelled CAD; never the EUR fallback.
      expect(screen.getAllByText(/200\.00 CAD/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/EUR/)).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-020: mixed-currency expenses convert into baseCurrency via live FX (#1361)', () => {
    it('converts a EUR expense into the base using fetched rates', async () => {
      // Distinct base (NZD) so this test can't read the cached CAD rates seeded by
      // FE-PAGE-SHARED-019 (useExchangeRates caches per base in module memory).
      server.use(
        // rates[X] = units of X per 1 base(NZD); 0.8 EUR per NZD → 100 EUR = 125.00 NZD
        // (a clean 2-decimal result, distinct from the unconverted 100).
        http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([{ quote: 'EUR', rate: 0.8 }])),
        http.get('/api/shared/:token', ({ params }) => {
          if (params.token !== 'mixed-token') return;
          return HttpResponse.json({
            trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01', end_date: '2026-07-05', currency: 'EUR' },
            baseCurrency: 'NZD',
            days: [], assignments: {}, dayNotes: {}, places: [], reservations: [], accommodations: [], packing: [],
            budget: [{ id: 1, name: 'Dinner', total_price: '100', category: 'Food', currency: 'EUR' }],
            categories: [],
            permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
            collab: [],
          });
        }),
      );

      renderSharedTrip('mixed-token');
      await waitFor(() => expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /costs/i }));

      await waitFor(() => expect(screen.getByText('Dinner')).toBeInTheDocument());
      // 100 EUR / 0.8 = 125.00 NZD once the rate resolves.
      await waitFor(() => expect(screen.getAllByText(/125\.00 NZD/).length).toBeGreaterThan(0));
    });
  });

  // FE-PAGE-SHARED-021 to FE-PAGE-SHARED-037 drive the remaining render branches of
  // the page: header variants, the permission-driven tab strip, and every item kind
  // the day timeline, bookings, packing, costs and chat sections can produce.

  const ALL_TABS = { share_bookings: true, share_packing: true, share_budget: true, share_collab: true };

  function payload(over: Record<string, unknown> = {}) {
    return {
      trip: { id: 1, title: 'Shared Paris Trip' },
      days: [],
      assignments: {},
      dayNotes: {},
      places: [],
      reservations: [],
      accommodations: [],
      packing: [],
      budget: [],
      categories: [],
      permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: false },
      collab: [],
      ...over,
    };
  }

  /** Serve one payload for `token`; anything else falls through to the default handler. */
  function serve(token: string, body: Record<string, unknown>) {
    server.use(
      http.get('/api/shared/:token', ({ params }) => (params.token === token ? HttpResponse.json(body) : undefined)),
    );
  }

  async function open(token: string, body: Record<string, unknown>) {
    serve(token, body);
    renderSharedTrip(token);
    await waitFor(() => expect(screen.getByText('Shared Paris Trip')).toBeInTheDocument());
  }

  function coverStyle(): string {
    const layer = document.querySelector('div[style*="background-image"]') as HTMLElement | null;
    return layer?.style.backgroundImage ?? '';
  }

  /** The page formats dates through the active locale (en-US in tests). */
  const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(iso).toLocaleDateString('en-US', opts);

  describe('FE-PAGE-SHARED-021: cover image, description and date range in the header', () => {
    it('uses an absolute cover URL unchanged and renders the description', async () => {
      await open('cover-http-token', payload({
        trip: {
          id: 1, title: 'Shared Paris Trip', description: 'Five days of pastry',
          cover_image: 'https://cdn.example.com/a.jpg',
        },
      }));

      expect(coverStyle()).toContain('https://cdn.example.com/a.jpg');
      expect(screen.getByText('Five days of pastry')).toBeInTheDocument();
      // Without start/end dates the date pill is skipped entirely.
      expect(screen.queryByText(/days$/)).toBeNull();
    });

    it('keeps a root-relative cover path as-is', async () => {
      await open('cover-abs-token', payload({
        trip: { id: 1, title: 'Shared Paris Trip', cover_image: '/uploads/covers/b.jpg' },
      }));

      expect(coverStyle()).toContain('/uploads/covers/b.jpg');
      expect(coverStyle()).not.toContain('/uploads//uploads/');
    });

    it('prefixes a bare filename with the uploads directory', async () => {
      await open('cover-bare-token', payload({
        trip: { id: 1, title: 'Shared Paris Trip', cover_image: 'c.jpg' },
      }));

      expect(coverStyle()).toContain('/uploads/c.jpg');
    });

    it('shows only the start date and no day count when the trip has no days', async () => {
      await open('startonly-token', payload({
        trip: { id: 1, title: 'Shared Paris Trip', start_date: '2026-07-01' },
      }));

      expect(
        screen.getByText(fmtDate('2026-07-01T00:00:00Z', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^\d+ days$/)).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-022: a payload without optional collections still renders', () => {
    it('falls back to empty lists when places, reservations and permissions are missing', async () => {
      await open('sparse-token', {
        trip: { id: 1, title: 'Shared Paris Trip' },
        days: [{ id: 1, trip_id: 1, day_number: 1, date: null, title: 'Lone day' }],
        assignments: {},
        dayNotes: {},
      });

      // share_map is undefined, so the Plan tab (the !== false branch) stays visible.
      expect(screen.getByRole('button', { name: /plan/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /bookings/i })).toBeNull();
      expect(screen.getByTestId('map-container')).toBeInTheDocument();
      // The day card still renders even though reservations/accommodations are absent.
      expect(screen.getByText('Lone day')).toBeInTheDocument();
      expect(screen.getByText('0 places')).toBeInTheDocument();
      expect(screen.getByText(/shared via/i)).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-023: share_map=false hides the plan tab', () => {
    it('lands on the first shared section instead of an empty map', async () => {
      await open('nomap-token', payload({
        permissions: { share_map: false, ...ALL_TABS },
        packing: [{ id: 1, name: 'Passport', category: null, checked: false }],
        reservations: [{ id: 1, title: 'Hotel Ibis', type: 'hotel', status: 'pending', metadata: null }],
      }));

      expect(screen.queryByRole('button', { name: /plan/i })).toBeNull();
      // Bookings is the first shared section, so it is auto-selected and rendered.
      await waitFor(() => expect(screen.getByText('Hotel Ibis')).toBeInTheDocument());
      expect(screen.queryByTestId('map-container')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-024: day header details', () => {
    it('renders an accommodation badge, the place count and the undated fallback', async () => {
      const day = { id: 5, trip_id: 1, day_number: 1, date: null, title: null };
      await open('accom-token', payload({
        days: [day],
        accommodations: [{ id: 3, place_name: 'Hotel Lutetia', start_day_id: 5, end_day_id: 5 }],
      }));

      // Twice since the day picker landed (#1962): the chip above the map and the card.
      const dayLabels = screen.getAllByText('Day 1');
      expect(dayLabels).toHaveLength(2);
      // One of each: the picker chip carries aria-pressed, the day card's header aria-expanded.
      expect(dayLabels.filter((el) => el.closest('[aria-pressed]'))).toHaveLength(1);
      expect(dayLabels.filter((el) => el.closest('[aria-expanded]'))).toHaveLength(1);
      expect(screen.getByText('Hotel Lutetia')).toBeInTheDocument();
      expect(screen.getByText('0 places')).toBeInTheDocument();
      // No date row for an undated day.
      expect(screen.queryByText(/2026/)).toBeNull();
    });

    it('sorts days by day_number regardless of payload order', async () => {
      await open('order-token', payload({
        days: [
          { id: 2, trip_id: 1, day_number: 2, date: null, title: 'Second' },
          { id: 1, trip_id: 1, day_number: 1, date: null, title: 'First' },
        ],
      }));

      const titles = Array.from(document.querySelectorAll('div')).map((d) => d.textContent);
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(titles.join('|').indexOf('First')).toBeLessThan(titles.join('|').lastIndexOf('Second'));
    });
  });

  describe('FE-PAGE-SHARED-025: expanded day renders every place variant', () => {
    const day = { id: 7, trip_id: 1, day_number: 1, date: '2026-07-01', title: 'Day One' };
    const withImage = {
      id: 201, name: 'Louvre', lat: 48.86, lng: 2.33, category_id: 4,
      image_url: '/uploads/places/louvre.jpg', address: 'Rue de Rivoli', place_time: '09:00', end_time: '11:00',
    };
    const withDescription = {
      id: 202, name: 'Seine Walk', lat: null, lng: null, category_id: null,
      image_url: null, address: null, description: 'Along the river', place_time: '12:00', end_time: null,
    };
    const bare = { id: 203, name: 'Mystery Stop', lat: null, lng: null, category_id: 99, image_url: null };

    it('shows the photo, the category colour, the address/description fallback and the time range', async () => {
      await open('places-token', payload({
        days: [day],
        places: [withImage, withDescription, bare],
        categories: [{ id: 4, name: 'Museum', color: '#ff0000', icon: 'landmark' }],
        assignments: {
          '7': [
            { id: 301, day_id: 7, place_id: 201, order_index: 0, place: withImage },
            { id: 302, day_id: 7, place_id: 202, order_index: 1, place: withDescription },
            { id: 303, day_id: 7, place_id: 203, order_index: 2, place: bare },
            // A dangling assignment whose place was deleted must not crash the timeline.
            { id: 304, day_id: 7, place_id: 999, order_index: 3, place: null },
          ],
        },
      }));

      // The count matches the rendered rows — the assignment whose place is gone is left out.
      expect(screen.getByText('3 places')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => expect(screen.getByText('Rue de Rivoli')).toBeInTheDocument());
      expect((document.querySelector('img[src="/uploads/places/louvre.jpg"]') as HTMLImageElement)).toBeInTheDocument();
      // A place with no address falls back to its description.
      expect(screen.getByText('Along the river')).toBeInTheDocument();
      // The bare place shows neither line and no time badge.
      expect(screen.getByText('Mystery Stop')).toBeInTheDocument();
      expect(screen.getByText(/09:00 – 11:00/)).toBeInTheDocument();
      expect(screen.getByText(/^12:00$/)).toBeInTheDocument();
    });

    it('only maps the selected day and refits the map to it', async () => {
      await open('mapday-token', payload({
        days: [day],
        places: [withImage, withDescription],
        assignments: { '7': [{ id: 301, day_id: 7, place_id: 201, order_index: 0, place: withImage }] },
      }));

      // Unselected: both places are candidates, but only the geocoded one has a marker.
      expect(screen.getAllByText('Louvre')).toHaveLength(1);
      expect(screen.queryByText('Seine Walk')).toBeNull();

      fireEvent.click(screen.getByText('Day One'));
      await waitFor(() => expect(screen.getAllByText('Louvre')).toHaveLength(2));

      // Collapsing again restores the trip-wide marker set.
      fireEvent.click(screen.getByText('Day One'));
      await waitFor(() => expect(screen.getAllByText('Louvre')).toHaveLength(1));
    });
  });

  // ── Day order, route line and the day picker at the map (#1962) ────────────
  describe('FE-PAGE-SHARED-038: day markers carry their order and a connecting line', () => {
    const day = { id: 7, trip_id: 1, day_number: 1, date: '2026-07-02', title: 'Day One' };
    const louvre = { id: 201, name: 'Louvre', lat: 48.86, lng: 2.33, category: { id: 1, name: 'Sight', color: '#ff0000', icon: 'landmark' } };
    const orsay = { id: 202, name: 'Orsay', lat: 48.85, lng: 2.32, category: null };
    const notre = { id: 203, name: 'Notre-Dame', lat: 48.853, lng: 2.35, category: null };

    // Every divIcon call the last render produced, as raw html strings.
    const iconHtml = () => (L.divIcon as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => String(c[0].html));

    beforeEach(() => (L.divIcon as unknown as ReturnType<typeof vi.fn>).mockClear());

    it('numbers the stops by order_index, not by payload order', async () => {
      await open('order-map-token', payload({
        days: [day],
        places: [louvre, orsay, notre],
        assignments: {
          '7': [
            { id: 302, day_id: 7, place_id: 202, order_index: 1, place: orsay },
            { id: 303, day_id: 7, place_id: 203, order_index: 2, place: notre },
            { id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre },
          ],
        },
      }));

      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() => expect(iconHtml().some((h: string) => h.includes('>1<'))).toBe(true));

      const html = iconHtml();
      // Louvre is order_index 0 and therefore 1, regardless of where it sat in the payload.
      expect(html.filter((h: string) => h.includes('>1<'))).toHaveLength(1);
      expect(html.filter((h: string) => h.includes('>2<'))).toHaveLength(1);
      expect(html.filter((h: string) => h.includes('>3<'))).toHaveLength(1);
    });

    it('shows both positions once for a stop the day visits twice, and renders it once', async () => {
      await open('twice-token', payload({
        days: [day],
        places: [louvre, orsay],
        assignments: {
          '7': [
            { id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre },
            { id: 302, day_id: 7, place_id: 202, order_index: 1, place: orsay },
            { id: 303, day_id: 7, place_id: 201, order_index: 2, place: louvre },
          ],
        },
      }));

      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() => expect(iconHtml().some((h: string) => h.includes('1 \u00b7 3'))).toBe(true));
      // One marker for the repeated place, not two with the same React key.
      expect(iconHtml().filter((h: string) => h.includes('1 \u00b7 3'))).toHaveLength(1);
    });

    it('leaves the trip-wide pool unnumbered, since it has no order to show', async () => {
      await open('nonum-token', payload({
        days: [day],
        places: [louvre, orsay],
        assignments: { '7': [{ id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre }] },
      }));

      await waitFor(() => expect(iconHtml().length).toBeGreaterThan(0));
      expect(iconHtml().some((h: string) => h.includes('border-radius:8px'))).toBe(false);
    });

    it('draws the connecting line only for a day with more than one stop', async () => {
      await open('line-token', payload({
        days: [day],
        places: [louvre, orsay],
        assignments: {
          '7': [
            { id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre },
            { id: 302, day_id: 7, place_id: 202, order_index: 1, place: orsay },
          ],
        },
      }));

      // No day selected: no line, even though the trip has two geocoded places.
      expect(screen.queryByTestId('route-line')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() => expect(screen.getByTestId('route-line')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'All' }));
      await waitFor(() => expect(screen.queryByTestId('route-line')).toBeNull());
    });

    it('does not draw a line for a day with a single stop', async () => {
      await open('single-token', payload({
        days: [day],
        places: [louvre],
        assignments: { '7': [{ id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre }] },
      }));

      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() => expect(screen.getAllByText('Louvre').length).toBeGreaterThan(1));
      expect(screen.queryByTestId('route-line')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-039: the day picker sits at the map and agrees with the day card', () => {
    const day = { id: 7, trip_id: 1, day_number: 1, date: '2026-07-02', title: 'Day One' };
    const louvre = { id: 201, name: 'Louvre', lat: 48.86, lng: 2.33, category: null };
    const orsay = { id: 202, name: 'Orsay', lat: 48.85, lng: 2.32, category: null };

    it('narrows the markers to one day and back again', async () => {
      await open('picker-token', payload({
        days: [day],
        places: [louvre, orsay],
        assignments: { '7': [{ id: 301, day_id: 7, place_id: 201, order_index: 0, place: louvre }] },
      }));

      // All: both geocoded places are on the map, so Orsay's tooltip is present.
      expect(screen.getByText('Orsay')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() => expect(screen.queryByText('Orsay')).toBeNull());

      fireEvent.click(screen.getByRole('button', { name: 'All' }));
      await waitFor(() => expect(screen.getByText('Orsay')).toBeInTheDocument());
    });

    it('marks the active chip for assistive tech', async () => {
      await open('pressed-token', payload({ days: [day], places: [louvre], assignments: {} }));

      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Day 1' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Day 1' })).toHaveAttribute('aria-pressed', 'true'),
      );
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('FE-PAGE-SHARED-041: a share link visitor gets a basemap that needs no key', () => {
    const louvre = { id: 201, name: 'Louvre', lat: 48.86, lng: 2.33, category: null };

    it('draws the OpenFreeMap style rather than raster tiles', async () => {
      // A visitor has no settings of their own, so the map falls back to the app
      // default. CARTO stamps "API KEY REQUIRED" over keyless tiles since
      // 26.08.2026, and a share link is exactly where nobody has a key.
      await open('basemap-token', payload({ days: [], places: [louvre], assignments: {} }));

      expect(screen.getByTestId('vector-basemap')).toHaveAttribute(
        'data-style',
        'https://tiles.openfreemap.org/styles/positron',
      );
      expect(screen.queryByTestId('raster-tiles')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-040: trip-wide markers keep their category colour', () => {
    // The payload nests the category on a day's assignments but sends it flat on the
    // trip-wide pool, so reading only the nested shape painted every marker indigo.
    it('reads the flat category_color the trip pool sends', async () => {
      (L.divIcon as unknown as ReturnType<typeof vi.fn>).mockClear();
      await open('flatcat-token', payload({
        days: [],
        places: [{ id: 201, name: 'Louvre', lat: 48.86, lng: 2.33, category_color: '#ff8800', category_icon: 'landmark' }],
        assignments: {},
      }));

      await waitFor(() => expect((L.divIcon as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
      const html = (L.divIcon as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => String(c[0].html));
      expect(html.some((h: string) => h.includes('#ff8800'))).toBe(true);
      expect(html.some((h: string) => h.includes('#6366f1'))).toBe(false);
    });
  });

  describe('FE-PAGE-SHARED-026: expanded day renders notes and single-leg transports', () => {
    const day = { id: 9, trip_id: 1, day_number: 1, date: '2026-07-02', title: 'Day One' };

    it('renders timed and untimed notes plus flight, train and fallback transport rows', async () => {
      await open('transport-token', payload({
        days: [day],
        dayNotes: {
          '9': [
            { id: 41, day_id: 9, text: 'Buy museum pass', time: '08:30', sort_order: 0 },
            { id: 42, day_id: 9, text: 'Anything goes', time: null, sort_order: 1 },
          ],
        },
        reservations: [
          {
            id: 51, title: 'Flight home', type: 'flight', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T18:00:00', reservation_end_time: '2026-07-02T20:30:00',
            // Already-parsed metadata (not a JSON string) must work too.
            metadata: { airline: 'Air France', flight_number: 'AF1', departure_airport: 'CDG', arrival_airport: 'TXL' },
          },
          {
            id: 52, title: 'ICE 599', type: 'train', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T09:15:00', reservation_end_time: null,
            metadata: JSON.stringify({ train_number: 'ICE 599', platform: '7' }),
          },
          {
            id: 53, title: 'Harbour ferry', type: 'ferry', status: 'pending', day_id: 9, end_day_id: 9,
            reservation_time: null, reservation_end_time: null, metadata: '',
          },
        ],
      }));

      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => expect(screen.getByText('Buy museum pass')).toBeInTheDocument());
      expect(screen.getByText('08:30')).toBeInTheDocument();
      expect(screen.getByText('Anything goes')).toBeInTheDocument();

      expect(screen.getByText('Air France · AF1 · CDG → TXL')).toBeInTheDocument();
      expect(screen.getByText(/Flight home · 18:00–20:30/)).toBeInTheDocument();
      expect(screen.getByText('ICE 599 · Gl. 7')).toBeInTheDocument();
      expect(screen.getByText(/^ICE 599 · 09:15$/)).toBeInTheDocument();
      // An unmapped transport type falls back to the generic ticket row with no subtitle.
      expect(screen.getByText('Harbour ferry')).toBeInTheDocument();
    });

    it('leaves the subtitle empty when the metadata carries no route at all', async () => {
      await open('nometa-token', payload({
        days: [day],
        reservations: [
          {
            id: 61, title: 'Bus 100', type: 'bus', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T07:00:00', metadata: null,
          },
          {
            id: 62, title: 'Regio', type: 'train', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T08:00:00', metadata: JSON.stringify({}),
          },
          {
            id: 63, title: 'Shuttle', type: 'flight', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T10:00:00', metadata: JSON.stringify({ airline: 'KLM' }),
          },
        ],
      }));

      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => expect(screen.getByText(/Bus 100 · 07:00/)).toBeInTheDocument());
      expect(screen.getByText(/Regio · 08:00/)).toBeInTheDocument();
      // Only the airline is known, so no airport pair is appended.
      expect(screen.getByText('KLM')).toBeInTheDocument();
    });

    it('renders each leg of a multi-leg train with its own train number and platform', async () => {
      await open('trainlegs-token', payload({
        days: [day],
        reservations: [
          {
            id: 71, title: 'Rail to Milan', type: 'train', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T06:00:00', reservation_end_time: '2026-07-02T18:00:00',
            metadata: JSON.stringify({
              legs: [
                { from: 'Berlin', to: 'Basel', train_number: 'ICE 73', platform: '3', dep_day_id: 9, dep_time: '06:00', arr_day_id: 9, arr_time: '12:00' },
                { train_number: 'EC 51', dep_day_id: 9, dep_time: '12:30', arr_day_id: 9, arr_time: '18:00' },
              ],
            }),
          },
        ],
      }));

      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => expect(screen.getByText('ICE 73 · Gl. 3 · Berlin → Basel')).toBeInTheDocument());
      // The second leg has neither platform nor stations, so only its number shows.
      expect(screen.getByText('EC 51')).toBeInTheDocument();
    });

    it('drops the route from a flight leg that has no airports of its own', async () => {
      await open('flightlegs-token', payload({
        days: [day],
        reservations: [
          {
            id: 72, title: 'Long haul', type: 'flight', status: 'confirmed', day_id: 9, end_day_id: 9,
            reservation_time: '2026-07-02T06:00:00', reservation_end_time: '2026-07-02T22:00:00',
            metadata: JSON.stringify({
              legs: [
                { from: 'FRA', to: 'DXB', airline: 'Emirates', flight_number: 'EK46', dep_day_id: 9, dep_time: '06:00', arr_day_id: 9, arr_time: '14:00' },
                { airline: 'Emirates', flight_number: 'EK350', dep_day_id: 9, dep_time: '16:00', arr_day_id: 9, arr_time: '22:00' },
              ],
            }),
          },
        ],
      }));

      fireEvent.click(screen.getByText('Day One'));

      await waitFor(() => expect(screen.getByText('Emirates · EK46 · FRA → DXB')).toBeInTheDocument());
      expect(screen.getByText('Emirates · EK350')).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SHARED-027: bookings tab detail rows', () => {
    it('shows date, time and location only when present and marks the status', async () => {
      await open('bookingmeta-token', payload({
        permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
        reservations: [
          {
            id: 81, title: 'Museum entry', type: 'ticket', status: 'pending',
            reservation_time: '2026-07-03T14:00:00', location: 'Louvre', metadata: '{}',
          },
          {
            id: 82, title: 'Rental car', type: 'car', status: 'confirmed',
            reservation_time: null, location: null, metadata: { airline: 'Sixt', flight_number: 'X9' },
          },
          {
            id: 83, title: 'Night bus', type: 'bus', status: 'confirmed',
            reservation_time: null, location: null, metadata: null,
          },
          {
            id: 84, title: 'Coach', type: 'car', status: 'confirmed',
            reservation_time: null, location: null, metadata: { airline: 'Flixbus' },
          },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      await waitFor(() => expect(screen.getByText('Museum entry')).toBeInTheDocument());
      expect(
        screen.getByText(fmtDate('2026-07-03T00:00:00Z', { day: 'numeric', month: 'short', timeZone: 'UTC' })),
      ).toBeInTheDocument();
      expect(screen.getByText('14:00')).toBeInTheDocument();
      expect(screen.getByText('Louvre')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();

      // No date/time/location for the car — only the metadata airline line survives.
      expect(screen.getByText('Sixt X9')).toBeInTheDocument();
      expect(screen.getAllByText('Confirmed')).toHaveLength(3);
      // Metadata-less bookings render the title only, no meta line.
      expect(screen.getByText('Night bus')).toBeInTheDocument();
      // An airline without a flight number appends nothing after it.
      expect(screen.getByText('Flixbus')).toBeInTheDocument();
    });

    it('lists train legs with platform labels in the bookings tab', async () => {
      await open('bookingtrain-token', payload({
        permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
        reservations: [
          {
            id: 91, title: 'Rail pass', type: 'train', status: 'confirmed',
            reservation_time: '2026-07-04', metadata: JSON.stringify({
              legs: [
                { from: 'Bern', to: 'Zurich', train_number: 'IC 8', platform: '12' },
                { train_number: 'S3' },
              ],
            }),
          },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      await waitFor(() => expect(screen.getByText('IC 8 Platform 12 Bern → Zurich')).toBeInTheDocument());
      expect(screen.getByText('S3')).toBeInTheDocument();
      // A bare date without a time renders the date chip only.
      expect(
        screen.getByText(fmtDate('2026-07-04T00:00:00Z', { day: 'numeric', month: 'short', timeZone: 'UTC' })),
      ).toBeInTheDocument();
    });

    it('omits the route of a flight leg without airports', async () => {
      await open('bookingflight-token', payload({
        permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
        reservations: [
          {
            id: 92, title: 'Long haul', type: 'flight', status: 'confirmed', reservation_time: null,
            metadata: JSON.stringify({
              legs: [
                { from: 'FRA', to: 'DXB', airline: 'Emirates', flight_number: 'EK46' },
                { airline: 'Emirates', flight_number: 'EK350' },
              ],
            }),
          },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      await waitFor(() => expect(screen.getByText('Emirates EK46 FRA → DXB')).toBeInTheDocument());
      expect(screen.getByText('Emirates EK350')).toBeInTheDocument();
    });

    it('renders no booking list at all when the trip has none', async () => {
      await open('nobookings-token', payload({
        permissions: { share_bookings: true, share_packing: false, share_budget: false, share_collab: false },
      }));

      fireEvent.click(screen.getByRole('button', { name: /bookings/i }));

      expect(screen.queryByText('Confirmed')).toBeNull();
      expect(screen.queryByTestId('map-container')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-028: packing list grouping', () => {
    it('groups by category, falls back to Other and strikes through checked items', async () => {
      await open('packinggroup-token', payload({
        permissions: { share_bookings: false, share_packing: true, share_budget: false, share_collab: false },
        packing: [
          { id: 1, name: 'Toothbrush', category: 'Bathroom', checked: true },
          { id: 2, name: 'Towel', category: 'Bathroom', checked: false },
          { id: 3, name: 'Charger', category: null, checked: false },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /packing/i }));

      await waitFor(() => expect(screen.getByText('Bathroom')).toBeInTheDocument());
      expect(screen.getByText('Other')).toBeInTheDocument();
      expect(screen.getByText('Toothbrush')).toHaveStyle({ textDecoration: 'line-through' });
      expect(screen.getByText('Towel')).toHaveStyle({ textDecoration: 'none' });
    });

    it('renders nothing when the packing list is empty', async () => {
      await open('packingempty-token', payload({
        permissions: { share_bookings: false, share_packing: true, share_budget: false, share_collab: false },
      }));

      fireEvent.click(screen.getByRole('button', { name: /packing/i }));
      expect(screen.queryByText('Other')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-029: costs tab fallbacks', () => {
    it('uses the trip currency for rows without one and dashes out priceless items', async () => {
      server.use(http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([])));
      await open('costfallback-token', payload({
        trip: { id: 1, title: 'Shared Paris Trip', currency: 'GBP' },
        permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
        budget: [
          { id: 1, name: 'Hostel', total_price: '80', category: 'Stay', currency: null },
          { id: 2, name: 'Museum pass', total_price: null, category: null, currency: null },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /costs/i }));

      await waitFor(() => expect(screen.getByText('Hostel')).toBeInTheDocument());
      expect(screen.getByText('Stay')).toBeInTheDocument();
      expect(screen.getByText('Other')).toBeInTheDocument();
      expect(screen.getByText('—')).toBeInTheDocument();
      // The priceless row contributes 0, so the total equals the single priced row.
      expect(screen.getAllByText('80.00 GBP').length).toBeGreaterThanOrEqual(2);
    });

    it('falls back to the payload base currency and treats an unparsable price as zero', async () => {
      server.use(http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([])));
      await open('costbase-token', payload({
        // Neither the trip nor the rows name a currency, so curOf() lands on the base.
        trip: { id: 1, title: 'Shared Paris Trip' },
        baseCurrency: 'SEK',
        permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
        budget: [{ id: 1, name: 'Tips', total_price: 'free', category: 'Misc', currency: null }],
      }));

      fireEvent.click(screen.getByRole('button', { name: /costs/i }));

      await waitFor(() => expect(screen.getByText('Tips')).toBeInTheDocument());
      expect(screen.getAllByText('0.00 SEK').length).toBeGreaterThanOrEqual(3);
    });

    it('renders nothing when there are no expenses', async () => {
      await open('costempty-token', payload({
        permissions: { share_bookings: false, share_packing: false, share_budget: true, share_collab: false },
      }));

      fireEvent.click(screen.getByRole('button', { name: /costs/i }));
      expect(screen.queryByText('Total Costs')).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-030: chat tab message rendering', () => {
    it('prints one date separator per day and falls back to an initial without an avatar', async () => {
      await open('chatgroup-token', payload({
        permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: true },
        collab: [
          { id: 1, username: 'alice', text: 'Morning', created_at: '2026-07-01T08:00:00Z', avatar: 'a.png' },
          { id: 2, username: 'bob', text: 'Afternoon', created_at: '2026-07-01T14:00:00Z', avatar: null },
          { id: 3, username: null, text: 'Next day', created_at: '2026-07-02T09:00:00Z', avatar: null },
        ],
      }));

      fireEvent.click(screen.getByRole('button', { name: /chat/i }));

      await waitFor(() => expect(screen.getByText('Morning')).toBeInTheDocument());
      expect(screen.getByText(/Chat · 3 messages/)).toBeInTheDocument();
      // Two distinct days -> exactly one separator each, none for the second message
      // of day one.
      const sep = (iso: string) => fmtDate(iso, { weekday: 'short', day: 'numeric', month: 'short' });
      expect(screen.getAllByText(sep('2026-07-01T08:00:00Z'))).toHaveLength(1);
      expect(screen.getAllByText(sep('2026-07-02T09:00:00Z'))).toHaveLength(1);
      expect(document.querySelector('img[src*="a.png"]')).toBeInTheDocument();
      expect(screen.getByText('B')).toBeInTheDocument();
      // A message without a username renders the "?" placeholder.
      expect(screen.getByText('?')).toBeInTheDocument();
    });

    it('renders nothing when the chat is empty', async () => {
      await open('chatempty-token', payload({
        permissions: { share_bookings: false, share_packing: false, share_budget: false, share_collab: true },
      }));

      fireEvent.click(screen.getByRole('button', { name: /chat/i }));
      expect(screen.queryByText(/messages/)).toBeNull();
    });
  });

  describe('FE-PAGE-SHARED-031: language options highlight on hover', () => {
    it('paints and clears the hover background of a language entry', async () => {
      await open('langhover-token', payload());

      fireEvent.click(screen.getByRole('button', { name: /english/i }));
      const option = screen.getByRole('button', { name: /deutsch/i });

      fireEvent.mouseEnter(option);
      expect(option.style.background).toBe('var(--bg-hover)');
      fireEvent.mouseLeave(option);
      expect(option.style.background).toBe('none');
    });
  });

  describe('FE-PAGE-SHARED-037: a multi-day parking only shows on its drop-off and pickup day (#1937)', () => {
    const days = [
      { id: 9, trip_id: 1, day_number: 1, date: '2026-07-01', title: 'Day One' },
      { id: 10, trip_id: 1, day_number: 2, date: '2026-07-02', title: 'Day Two' },
      { id: 11, trip_id: 1, day_number: 3, date: '2026-07-03', title: 'Day Three' },
    ];

    it('skips the days in between and leaves that day collapsed', async () => {
      await open('parking-token', payload({
        days,
        reservations: [
          {
            id: 81, title: 'Airport Parking', type: 'parking', status: 'confirmed', day_id: 9, end_day_id: 11,
            reservation_time: '2026-07-01T05:30:00', reservation_end_time: '2026-07-03T19:00:00', metadata: null,
          },
        ],
      }));

      // Only one day is expanded at a time, so each day is checked on its own.
      fireEvent.click(screen.getByText('Day One'));
      await waitFor(() => expect(screen.getByText(/Airport Parking/)).toBeInTheDocument());

      fireEvent.click(screen.getByText('Day Two'));
      await waitFor(() => expect(screen.queryByText(/Airport Parking/)).toBeNull());

      fireEvent.click(screen.getByText('Day Three'));
      await waitFor(() => expect(screen.getByText(/Airport Parking/)).toBeInTheDocument());
    });
  });
});
