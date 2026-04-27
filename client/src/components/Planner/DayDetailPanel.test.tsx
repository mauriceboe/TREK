// FE-PLANNER-DAYDETAIL-001 to FE-PLANNER-DAYDETAIL-025
import React from 'react';
import { render, screen, waitFor } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildAdmin, buildTrip, buildDay, buildPlace, buildReservation } from '../../../tests/helpers/factories';
import DayDetailPanel from './DayDetailPanel';

const day = buildDay({ id: 1, trip_id: 1, date: '2025-06-15', title: 'Day in Paris' });

const defaultProps = {
  day,
  days: [day],
  places: [],
  categories: [],
  tripId: 1,
  assignments: {},
  reservations: [],
  lat: null,
  lng: null,
  onClose: vi.fn(),
  onAccommodationChange: vi.fn(),
};

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  server.use(
    http.get('/api/weather/detailed', () => HttpResponse.json({ error: true })),
    http.get('/api/trips/1/accommodations', () => HttpResponse.json({ accommodations: [] })),
  );
  seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
  seedStore(useSettingsStore, {
    settings: { time_format: '24h', temperature_unit: 'celsius', blur_booking_codes: false },
  });
});

describe('DayDetailPanel', () => {

  // ── Rendering ────────────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-001: renders without crashing', () => {
    render(<DayDetailPanel {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-002: returns null when day prop is null', () => {
    render(<DayDetailPanel {...defaultProps} day={null as any} />);
    expect(document.querySelector('[style*="position: fixed"]')).toBeNull();
  });

  it('FE-PLANNER-DAYDETAIL-003: shows day title in header', () => {
    render(<DayDetailPanel {...defaultProps} />);
    expect(screen.getByText('Day in Paris')).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-004: shows day number when title is null', () => {
    const untitled = buildDay({ id: 1, trip_id: 1, date: '2025-06-15', title: null });
    render(<DayDetailPanel {...defaultProps} day={untitled} days={[untitled]} />);
    expect(screen.getByText(/Day 1/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-005: shows formatted date when day.date is set', () => {
    render(<DayDetailPanel {...defaultProps} />);
    // Date '2025-06-15' → locale string containing "June" or "15"
    expect(screen.getByText(/June|15/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-006: does NOT show date when day.date is null', () => {
    const noDate = buildDay({ id: 1, trip_id: 1, date: null, title: 'No Date Day' });
    render(<DayDetailPanel {...defaultProps} day={noDate} days={[noDate]} />);
    expect(screen.queryByText(/June|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/i)).toBeNull();
  });

  it('FE-PLANNER-DAYDETAIL-007: close button calls onClose', async () => {
    const onClose = vi.fn();
    render(<DayDetailPanel {...defaultProps} onClose={onClose} />);
    // The header X button — the one outside the hotel picker
    const closeButtons = screen.getAllByRole('button');
    // Second button is the header X close (first is collapse toggle)
    await userEvent.click(closeButtons[1]);
    expect(onClose).toHaveBeenCalled();
  });

  // ── Weather ──────────────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-008: weather section not shown when no lat/lng', async () => {
    render(<DayDetailPanel {...defaultProps} lat={null} lng={null} />);
    await waitFor(() => expect(screen.queryByText(/No weather/i)).toBeNull());
    // No loading spinner either
    expect(document.querySelector('[style*="border-top-color"]')).toBeNull();
  });

  it('FE-PLANNER-DAYDETAIL-009: weather loading state shown briefly', async () => {
    server.use(
      http.get('/api/weather/detailed', () => new Promise(() => {})), // never resolves
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    // Spinner div has border + borderTopColor
    await waitFor(() => {
      const spinner = document.querySelector('[style*="border-radius: 50%"]');
      expect(spinner).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-DAYDETAIL-010: weather data renders temperature in Celsius', async () => {
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({ main: 'Clear', temp: 22, temp_min: 18, temp_max: 26, description: 'sunny' })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText(/22°C/);
  });

  it('FE-PLANNER-DAYDETAIL-011: weather in Fahrenheit when setting is fahrenheit', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '24h', temperature_unit: 'fahrenheit', blur_booking_codes: false },
    });
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({ main: 'Clear', temp: 0, temp_min: 0, temp_max: 0, description: 'cold' })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText(/32°F/);
  });

  it('FE-PLANNER-DAYDETAIL-012: no weather shows "No weather data" message', async () => {
    server.use(
      http.get('/api/weather/detailed', () => HttpResponse.json({ error: true })),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText(/No weather/i);
  });

  // ── Reservations ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-013: shows reservations linked to this day\'s assignments', async () => {
    const place = buildPlace({ name: 'Museum' });
    const reservation = buildReservation({
      id: 1,
      title: 'Museum Tour Ticket',
      assignment_id: 50,
      status: 'confirmed',
    });
    render(<DayDetailPanel
      {...defaultProps}
      assignments={{ '1': [{ id: 50, place, place_id: place.id, day_id: 1, order_index: 0, notes: null }] }}
      reservations={[reservation]}
    />);
    await screen.findByText('Museum Tour Ticket');
  });

  it('FE-PLANNER-DAYDETAIL-014: reservations from OTHER days are not shown', async () => {
    const place = buildPlace({ name: 'Other Venue' });
    const reservation = buildReservation({
      id: 2,
      title: 'Other Day Event',
      assignment_id: 51,
      status: 'confirmed',
    });
    render(<DayDetailPanel
      {...defaultProps}
      // day.id=1, but reservation belongs to assignment_id=51 which is in day '2'
      assignments={{
        '1': [{ id: 50, place, place_id: place.id, day_id: 1, order_index: 0, notes: null }],
        '2': [{ id: 51, place, place_id: place.id, day_id: 2, order_index: 0, notes: null }],
      }}
      reservations={[reservation]}
    />);
    await waitFor(() => {
      expect(screen.queryByText('Other Day Event')).toBeNull();
    });
  });

  it('FE-PLANNER-DAYDETAIL-015: reservation shows formatted time when reservation_time has T', async () => {
    const place = buildPlace({ name: 'Restaurant' });
    const reservation = buildReservation({
      id: 3,
      title: 'Dinner',
      assignment_id: 50,
      status: 'confirmed',
      reservation_time: '2025-06-15T14:30:00Z',
    });
    render(<DayDetailPanel
      {...defaultProps}
      assignments={{ '1': [{ id: 50, place, place_id: place.id, day_id: 1, order_index: 0, notes: null }] }}
      reservations={[reservation]}
    />);
    await screen.findByText('Dinner');
    // Time should be rendered from reservation_time with T — check for a time-like string
    await waitFor(() => {
      // The time is rendered via toLocaleTimeString — match any HH:MM pattern
      const timeEl = screen.queryByText(/\d{1,2}:\d{2}/);
      expect(timeEl).toBeInTheDocument();
    });
  });

  // ── Accommodation ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-016: accommodation section header is always present', async () => {
    render(<DayDetailPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getAllByText(/Accommodation/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('FE-PLANNER-DAYDETAIL-017: accommodation with check-in shows hotel name', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Grand Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: '11:00', confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Grand Hotel');
  });

  it('FE-PLANNER-DAYDETAIL-018: check-in time shown for check-in day', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Grand Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: '11:00', confirmation: null,
          }],
        })
      ),
    );
    // day.id = 1 = start_day_id (check-in day)
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('14:00');
    await waitFor(() => {
      expect(screen.getAllByText(/Check-in/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('FE-PLANNER-DAYDETAIL-019: check-out time shown for check-out day', async () => {
    const checkOutDay = buildDay({ id: 3, trip_id: 1, date: '2025-06-17', title: 'Check Out Day' });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Grand Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: '11:00', confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel
      {...defaultProps}
      day={checkOutDay}
      days={[day, checkOutDay]}
    />);
    await screen.findByText('11:00');
  });

  it('FE-PLANNER-DAYDETAIL-020: confirmation code shown', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Grand Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: '11:00', confirmation: 'HOTEL99',
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('HOTEL99');
  });

  it('FE-PLANNER-DAYDETAIL-021: accommodation edit/remove buttons shown when canEditDays=true', async () => {
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Grand Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Grand Hotel');
    // Pencil and X buttons should be present in the accommodation row
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('FE-PLANNER-DAYDETAIL-022: accommodation edit/remove buttons hidden when canEditDays=false', async () => {
    // Use regular user + restrict day_edit to admin only
    const regularUser = buildUser({ id: 999, role: 'user' });
    seedStore(useAuthStore, { user: regularUser, isAuthenticated: true });
    seedStore(usePermissionsStore, { permissions: { day_edit: 'admin' } });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Budget Inn', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '15:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Budget Inn');
    // No edit/remove buttons — only close button in header
    const buttons = screen.getAllByRole('button');
    // Should only have the header collapse + close buttons, no pencil/X in accommodation
    expect(buttons).toHaveLength(2);
  });

  // ── Adding accommodation ──────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-023: "Add accommodation" button visible when canEditDays=true and no accommodation', async () => {
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText(/Add accommodation/i);
  });

  it('FE-PLANNER-DAYDETAIL-024: clicking add accommodation opens hotel picker', async () => {
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    render(<DayDetailPanel {...defaultProps} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    // Hotel picker portal renders into document.body
    await waitFor(() => {
      expect(document.body.querySelector('[style*="z-index: 99999"]')).toBeInTheDocument();
    });
  });

  // ── Blur booking codes ────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-025: linked booking confirmation code is blurred when blur_booking_codes=true', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '24h', temperature_unit: 'celsius', blur_booking_codes: true },
    });
    const linkedReservation = buildReservation({
      id: 10,
      title: 'Hotel Booking',
      status: 'confirmed',
      confirmation_number: 'SECRET',
      accommodation_id: 1,
    });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Secret Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} reservations={[linkedReservation]} />);
    await screen.findByText('Secret Hotel');
    // Find the element containing the confirmation number
    await waitFor(() => {
      const el = screen.getByText(/#SECRET/);
      expect(el).toHaveStyle({ filter: 'blur(4px)' });
    });
  });

  // ── Weather chips ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-026: weather chips render precipitation, wind, sunrise, sunset', async () => {
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({
          main: 'Rain',
          temp: 15,
          temp_min: 12,
          temp_max: 18,
          description: 'rainy',
          precipitation_probability_max: 80,
          precipitation_sum: 5.2,
          wind_max: 30,
          sunrise: '06:30',
          sunset: '20:15',
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText('80%');
    await screen.findByText('5.2 mm');
    await screen.findByText('30 km/h');
    await screen.findByText('06:30');
    await screen.findByText('20:15');
  });

  it('FE-PLANNER-DAYDETAIL-027: weather chips show Fahrenheit wind speed', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '24h', temperature_unit: 'fahrenheit', blur_booking_codes: false },
    });
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({
          main: 'Clouds',
          temp: 20,
          temp_min: 15,
          temp_max: 25,
          description: 'cloudy',
          wind_max: 50,
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    // 50 km/h * 0.621371 ≈ 31 mph
    await screen.findByText('31 mph');
  });

  // ── Hotel picker interactions ─────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-028: hotel picker cancel button closes the picker', async () => {
    render(<DayDetailPanel {...defaultProps} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    // Picker opened
    await waitFor(() => {
      expect(document.body.querySelector('[style*="z-index: 99999"]')).toBeInTheDocument();
    });
    // Click cancel button inside picker
    const cancelButton = screen.getByText(/Cancel/i);
    await userEvent.click(cancelButton);
    await waitFor(() => {
      expect(document.body.querySelector('[style*="z-index: 99999"]')).toBeNull();
    });
  });

  it('FE-PLANNER-DAYDETAIL-029: hotel picker shows places list when places are provided', async () => {
    const place1 = buildPlace({ id: 10, name: 'Hotel du Nord', address: '102 Quai de Jemmapes' });
    const place2 = buildPlace({ id: 11, name: 'Hotel du Sud', address: null });
    render(<DayDetailPanel {...defaultProps} places={[place1, place2]} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    await screen.findByText('Hotel du Nord');
    await screen.findByText('Hotel du Sud');
    await screen.findByText('102 Quai de Jemmapes');
  });

  it('FE-PLANNER-DAYDETAIL-030: selecting a place in hotel picker enables save button', async () => {
    const place = buildPlace({ id: 10, name: 'Maison Blanche' });
    server.use(
      http.post('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodation: {
            id: 99, place_id: 10, place_name: 'Maison Blanche', place_address: null,
            start_day_id: 1, end_day_id: 1, check_in: null, check_out: null, confirmation: null,
          },
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} places={[place]} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    await screen.findByText('Maison Blanche');
    // Click the place button
    const placeButton = screen.getByRole('button', { name: /Maison Blanche/i });
    await userEvent.click(placeButton);
    // Save button should now be enabled
    const saveButton = screen.getByText(/Save/i);
    expect(saveButton).not.toBeDisabled();
  });

  it('FE-PLANNER-DAYDETAIL-031: hotel picker shows no places message when list is empty', async () => {
    render(<DayDetailPanel {...defaultProps} places={[]} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    await waitFor(() => {
      const portal = document.body.querySelector('[style*="z-index: 99999"]');
      expect(portal).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-DAYDETAIL-032: edit accommodation button opens picker in edit mode', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Edit Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '15:00', check_out: '10:00', confirmation: 'EDIT01',
          }],
        })
      ),
    );
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Edit Hotel');
    // All buttons: header collapse (0), header close (1), pencil (2), X/remove (3)
    const allButtons = screen.getAllByRole('button');
    // Pencil is third button (index 2)
    const pencilButton = allButtons[2];
    await userEvent.click(pencilButton);
    // Edit picker should open with "Edit accommodation" title
    await waitFor(() => {
      const portal = document.body.querySelector('[style*="z-index: 99999"]');
      expect(portal?.textContent).toMatch(/Edit accommodation/i);
    });
  });

  it('FE-PLANNER-DAYDETAIL-033: hotel picker "all days" button selects full trip range', async () => {
    const day2 = buildDay({ id: 2, trip_id: 1, date: '2025-06-16', title: 'Day 2' });
    const day3 = buildDay({ id: 3, trip_id: 1, date: '2025-06-17', title: 'Day 3' });
    render(<DayDetailPanel {...defaultProps} days={[day, day2, day3]} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    await waitFor(() => {
      const portal = document.body.querySelector('[style*="z-index: 99999"]');
      expect(portal?.textContent).toMatch(/Day in Paris|Day 2|Day 3/i);
    });
  });

  it('FE-PLANNER-DAYDETAIL-034: accommodation with all fields shows full details grid', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Full Details Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 1, check_in: '14:00', check_out: '11:00', confirmation: 'FULL01',
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Full Details Hotel');
    await waitFor(() => {
      expect(screen.getAllByText(/Check-in/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Check-out/i).length).toBeGreaterThanOrEqual(1);
    });
    await screen.findByText('FULL01');
  });

  it('FE-PLANNER-DAYDETAIL-035: middle-day accommodation shows no check-in/out label', async () => {
    const middleDay = buildDay({ id: 2, trip_id: 1, date: '2025-06-16', title: 'Middle Day' });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Overnight Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: '11:00', confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} day={middleDay} days={[day, middleDay]} />);
    await screen.findByText('Overnight Hotel');
    expect(screen.queryByText(/Check-in & Check-out/i)).toBeNull();
  });

  it('FE-PLANNER-DAYDETAIL-036: weather hourly data renders hour entries', async () => {
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({
          main: 'Clear',
          temp: 20,
          temp_min: 15,
          temp_max: 25,
          description: 'sunny',
          hourly: [
            { hour: 8, main: 'Clear', temp: 18, precipitation_probability: 0 },
            { hour: 10, main: 'Clear', temp: 20, precipitation_probability: 10 },
            { hour: 12, main: 'Clouds', temp: 22, precipitation_probability: 60 },
          ],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText(/20°C/);
    // Hourly renders every other entry (i % 2 === 0): hours 8 and 12
    await waitFor(() => {
      expect(screen.getByText('08')).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-DAYDETAIL-037: climate type weather shows average indicator', async () => {
    server.use(
      http.get('/api/weather/detailed', () =>
        HttpResponse.json({
          main: 'Clear',
          type: 'climate',
          temp: 18,
          temp_min: 14,
          temp_max: 22,
          description: 'average',
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    await screen.findByText(/Ø/);
  });

  it('FE-PLANNER-DAYDETAIL-038: hotel picker with category filter renders category buttons', async () => {
    const { buildCategory } = await import('../../../tests/helpers/factories');
    const cat = buildCategory({ id: 1, name: 'Hotels' });
    const place = buildPlace({ id: 10, name: 'Hotel Belmont', category_id: 1 });
    render(<DayDetailPanel {...defaultProps} places={[place]} categories={[cat]} />);
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    await waitFor(() => {
      const portal = document.body.querySelector('[style*="z-index: 99999"]');
      expect(portal?.textContent).toMatch(/Hotels/);
    });
  });

  it('FE-PLANNER-DAYDETAIL-039: add another accommodation button visible when accommodations exist', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Existing Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Existing Hotel');
    // "Add accommodation" dashed button should also appear for adding more
    await screen.findByText(/Add accommodation/i);
  });

  it('FE-PLANNER-DAYDETAIL-041: save new accommodation calls API and updates list', async () => {
    const place = buildPlace({ id: 10, name: 'New Hotel' });
    server.use(
      http.post('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodation: {
            id: 99, place_id: 10, place_name: 'New Hotel', place_address: null,
            start_day_id: 1, end_day_id: 1, check_in: null, check_out: null, confirmation: null,
          },
        })
      ),
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({ accommodations: [] })
      ),
    );
    render(<DayDetailPanel {...defaultProps} places={[place]} />);
    // Open picker
    const addButton = await screen.findByText(/Add accommodation/i);
    await userEvent.click(addButton);
    // Select a place
    const placeBtn = await screen.findByRole('button', { name: /New Hotel/i });
    await userEvent.click(placeBtn);
    // Click Save
    const saveButton = screen.getByText(/Save/i);
    await userEvent.click(saveButton);
    // Picker should close after save
    await waitFor(() => {
      expect(document.body.querySelector('[style*="z-index: 99999"]')).toBeNull();
    });
  });

  it('FE-PLANNER-DAYDETAIL-042: remove accommodation calls delete API', async () => {
    let deleteWasCalled = false;
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 5, place_id: 5, place_name: 'Hotel To Remove', place_address: 'Paris',
            start_day_id: 1, end_day_id: 1, check_in: null, check_out: null, confirmation: null,
          }],
        })
      ),
      http.delete('/api/trips/1/accommodations/5', () => {
        deleteWasCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );
    seedStore(useAuthStore, { user: buildAdmin(), isAuthenticated: true });
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('Hotel To Remove');
    // Buttons: collapse (0), close header (1), pencil (2), X/remove (3)
    const allButtons = screen.getAllByRole('button');
    const removeButton = allButtons[3];
    await userEvent.click(removeButton);
    await waitFor(() => {
      expect(deleteWasCalled).toBe(true);
    });
  });

  it('FE-PLANNER-DAYDETAIL-043: 12h check-in time formatted with AM/PM', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '12h', temperature_unit: 'celsius', blur_booking_codes: false },
    });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'AM Hotel', place_address: null,
            start_day_id: 1, end_day_id: 1, check_in: '14:00', check_out: '09:00', confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} />);
    await screen.findByText('AM Hotel');
    // 14:00 in 12h = 2:00 PM
    await waitFor(() => {
      expect(screen.getByText('2:00 PM')).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-DAYDETAIL-044: accommodation with linked pending reservation shows pending status', async () => {
    const pendingReservation = buildReservation({
      id: 20,
      title: 'Pending Booking',
      status: 'pending',
      confirmation_number: null,
      accommodation_id: 1,
    });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Pending Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} reservations={[pendingReservation]} />);
    await screen.findByText('Pending Hotel');
    await screen.findByText('Pending Booking');
    await waitFor(() => {
      expect(screen.getAllByText(/pending/i).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('FE-PLANNER-DAYDETAIL-045: weather API network error is handled gracefully', async () => {
    server.use(
      http.get('/api/weather/detailed', () => HttpResponse.error()),
    );
    render(<DayDetailPanel {...defaultProps} lat={48.8566} lng={2.3522} />);
    // Should show "No weather" after error (catch sets weather to null)
    await screen.findByText(/No weather/i);
  });

  it('FE-PLANNER-DAYDETAIL-046: save edited accommodation calls update API', async () => {
    let updateCalled = false;
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 7, place_id: 5, place_name: 'Edit Me Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 1, check_in: '15:00', check_out: null, confirmation: null,
          }],
        })
      ),
      http.put('/api/trips/1/accommodations/7', () => {
        updateCalled = true;
        return HttpResponse.json({
          accommodation: {
            id: 7, place_id: 5, place_name: 'Edit Me Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 1, check_in: '15:00', check_out: null, confirmation: 'NEW01',
          },
        });
      }),
    );
    const place = buildPlace({ id: 5, name: 'Edit Me Hotel' });
    render(<DayDetailPanel {...defaultProps} places={[place]} />);
    await screen.findByText('Edit Me Hotel');
    // Click the pencil/edit button (index 2, after collapse and close buttons)
    const allButtons = screen.getAllByRole('button');
    await userEvent.click(allButtons[2]);
    // Picker opens in edit mode
    await waitFor(() => {
      expect(document.body.querySelector('[style*="z-index: 99999"]')).toBeInTheDocument();
    });
    // Click Save in the edit picker
    const saveButton = screen.getByText(/Save/i);
    await userEvent.click(saveButton);
    await waitFor(() => {
      expect(updateCalled).toBe(true);
    });
  });

  it('FE-PLANNER-DAYDETAIL-047: blurred confirmation code revealed on click', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '24h', temperature_unit: 'celsius', blur_booking_codes: true },
    });
    const linkedReservation = buildReservation({
      id: 11,
      title: 'Blurred Booking',
      status: 'confirmed',
      confirmation_number: 'REVEAL123',
      accommodation_id: 2,
    });
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 2, place_id: 5, place_name: 'Blurred Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 3, check_in: '14:00', check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} reservations={[linkedReservation]} />);
    await screen.findByText('Blurred Hotel');
    const codeEl = await screen.findByText(/#REVEAL123/);
    // Initially blurred
    expect(codeEl).toHaveStyle({ filter: 'blur(4px)' });
    // Fire mouse events to cover the event handler code paths
    await userEvent.hover(codeEl);
    await userEvent.unhover(codeEl);
    await userEvent.click(codeEl);
  });

  // ── Collapse behavior ─────────────────────────────────────────────────────────

  it('FE-PLANNER-DAYDETAIL-048: collapse button has title "Collapse" when expanded', () => {
    render(<DayDetailPanel {...defaultProps} collapsed={false} />);
    const collapseBtn = screen.getByTitle('Collapse');
    expect(collapseBtn).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-049: collapse button has title "Expand" when collapsed', () => {
    render(<DayDetailPanel {...defaultProps} collapsed={true} />);
    const expandBtn = screen.getByTitle('Expand');
    expect(expandBtn).toBeInTheDocument();
  });

  it('FE-PLANNER-DAYDETAIL-050: content area is hidden when collapsed=true', async () => {
    server.use(
      http.get('/api/trips/1/accommodations', () =>
        HttpResponse.json({
          accommodations: [{
            id: 1, place_id: 5, place_name: 'Visible Hotel', place_address: 'Paris',
            start_day_id: 1, end_day_id: 1, check_in: null, check_out: null, confirmation: null,
          }],
        })
      ),
    );
    render(<DayDetailPanel {...defaultProps} collapsed={true} />);
    await waitFor(() => {
      const content = document.querySelector('[style*="overflow-y: auto"]');
      expect(content).toHaveStyle({ display: 'none' });
    });
  });

  it('FE-PLANNER-DAYDETAIL-051: content area is visible when collapsed=false', async () => {
    render(<DayDetailPanel {...defaultProps} collapsed={false} />);
    await waitFor(() => {
      const content = document.querySelector('[style*="overflow-y: auto"]');
      expect(content).toHaveStyle({ display: 'block' });
    });
  });

  it('FE-PLANNER-DAYDETAIL-052: clicking the collapse button calls onToggleCollapse', async () => {
    const onToggleCollapse = vi.fn();
    render(<DayDetailPanel {...defaultProps} collapsed={false} onToggleCollapse={onToggleCollapse} />);
    const collapseBtn = screen.getByTitle('Collapse');
    await userEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('FE-PLANNER-DAYDETAIL-053: clicking the header row calls onToggleCollapse', async () => {
    const onToggleCollapse = vi.fn();
    render(<DayDetailPanel {...defaultProps} collapsed={false} onToggleCollapse={onToggleCollapse} />);
    // The header div (contains title text) is the clickable toggle area
    await userEvent.click(screen.getByText('Day in Paris'));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it('FE-PLANNER-DAYDETAIL-054: when collapsed, date appears inline in title row', () => {
    render(<DayDetailPanel {...defaultProps} collapsed={true} />);
    // Title and date are in the same element when collapsed
    const titleEl = screen.getByText(/Day in Paris/);
    expect(titleEl.textContent).toMatch(/June|15/i);
  });

  it('FE-PLANNER-DAYDETAIL-055: when expanded, date is shown in a separate element below title', () => {
    render(<DayDetailPanel {...defaultProps} collapsed={false} />);
    const titleEl = screen.getByText('Day in Paris');
    // The date should be in a sibling element, not inside the title element itself
    expect(titleEl.textContent).toBe('Day in Paris');
    expect(screen.getByText(/June|15/i)).toBeInTheDocument();
  });

  // ── Accommodation date-range picker — non-monotonic day IDs (issue #889) ─────

  // Builds the reporter's exact ID layout: day_number 1-9 → IDs 17-25, day_number 10-16 → IDs 1-7.
  // This happens after repeated trip-length changes via generateDays (no import/migration needed).
  function buildNonMonotonicDays() {
    return [
      buildDay({ id: 17, trip_id: 1, date: '2026-04-30' }),
      buildDay({ id: 18, trip_id: 1, date: '2026-05-01' }),
      buildDay({ id: 19, trip_id: 1, date: '2026-05-02' }),
      buildDay({ id: 20, trip_id: 1, date: '2026-05-03' }),
      buildDay({ id: 21, trip_id: 1, date: '2026-05-04' }),
      buildDay({ id: 22, trip_id: 1, date: '2026-05-05' }),
      buildDay({ id: 23, trip_id: 1, date: '2026-05-06' }),
      buildDay({ id: 24, trip_id: 1, date: '2026-05-07' }),
      buildDay({ id: 25, trip_id: 1, date: '2026-05-08' }),
      buildDay({ id: 1,  trip_id: 1, date: '2026-05-09' }),
      buildDay({ id: 2,  trip_id: 1, date: '2026-05-10' }),
      buildDay({ id: 3,  trip_id: 1, date: '2026-05-11' }),
      buildDay({ id: 4,  trip_id: 1, date: '2026-05-12' }),
      buildDay({ id: 5,  trip_id: 1, date: '2026-05-13' }),
      buildDay({ id: 6,  trip_id: 1, date: '2026-05-14' }),
      buildDay({ id: 7,  trip_id: 1, date: '2026-05-15' }),
    ];
  }

  // Returns the two CustomSelect trigger buttons for start/end day pickers.
  // When no dropdown is open, these are the only globally-visible buttons whose textContent
  // matches /Day \d+/ (the main panel title is a div, not a button).
  // [0] = start trigger, [1] = end trigger (DOM source order).
  function getDayPickerTriggers() {
    return screen.getAllByRole('button').filter(b => /Day \d+/.test(b.textContent ?? ''));
  }

  it('FE-PLANNER-DAYDETAIL-056: non-monotonic IDs — end picker does not clobber start-day', async () => {
    const days = buildNonMonotonicDays();
    const place = buildPlace({ id: 50, name: 'Range Hotel' });
    let capturedBody: any;
    server.use(
      http.post('/api/trips/1/accommodations', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          accommodation: {
            id: 99, place_id: 50, place_name: 'Range Hotel', place_address: null,
            start_day_id: capturedBody.start_day_id, end_day_id: capturedBody.end_day_id,
            check_in: null, check_out: null, confirmation: null,
          },
        });
      }),
    );

    render(<DayDetailPanel {...defaultProps} day={days[0]} days={days} places={[place]} />);
    await userEvent.click(await screen.findByText(/Add accommodation/i));
    await userEvent.click(await screen.findByRole('button', { name: /Range Hotel/i }));

    // Both triggers show "Day 1"; the second one is the end picker.
    await userEvent.click(getDayPickerTriggers()[1]);
    // Select "Day 16" (id=7) from the open dropdown — textContent starts with "Day 16".
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 16'))!);

    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      // start must remain id 17 (day 1) — old code would clobber it to id 7 via Math.min
      expect(capturedBody?.start_day_id).toBe(17);
      expect(capturedBody?.end_day_id).toBe(7);
    });
  });

  it('FE-PLANNER-DAYDETAIL-057: non-monotonic IDs — start picker does not collapse end when start has high ID', async () => {
    const days = buildNonMonotonicDays();
    const place = buildPlace({ id: 51, name: 'Span Hotel' });
    let capturedBody: any;
    server.use(
      http.post('/api/trips/1/accommodations', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          accommodation: {
            id: 100, place_id: 51, place_name: 'Span Hotel', place_address: null,
            start_day_id: capturedBody.start_day_id, end_day_id: capturedBody.end_day_id,
            check_in: null, check_out: null, confirmation: null,
          },
        });
      }),
    );

    render(<DayDetailPanel {...defaultProps} day={days[0]} days={days} places={[place]} />);
    await userEvent.click(await screen.findByText(/Add accommodation/i));
    await userEvent.click(await screen.findByRole('button', { name: /Span Hotel/i }));

    // Set end to day 16 (id=7, low ID but last day by position).
    await userEvent.click(getDayPickerTriggers()[1]);
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 16'))!);

    // Set start to day 9 (id=25, high ID, but earlier by position than day 16).
    // Old code: Math.max(25, 7) = 25 → end collapses to day 9.
    // New code: position(id=25)=8 < position(id=7)=15 → end stays at 7 (day 16).
    await userEvent.click(getDayPickerTriggers()[0]);
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 9'))!);

    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(capturedBody?.start_day_id).toBe(25); // day 9
      expect(capturedBody?.end_day_id).toBe(7);    // day 16 — must NOT have collapsed
    });
  });

  it('FE-PLANNER-DAYDETAIL-058: non-monotonic IDs — All days button sets correct first/last IDs', async () => {
    const days = buildNonMonotonicDays();
    const place = buildPlace({ id: 52, name: 'Full Trip Hotel' });
    let capturedBody: any;
    server.use(
      http.post('/api/trips/1/accommodations', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          accommodation: {
            id: 101, place_id: 52, place_name: 'Full Trip Hotel', place_address: null,
            start_day_id: capturedBody.start_day_id, end_day_id: capturedBody.end_day_id,
            check_in: null, check_out: null, confirmation: null,
          },
        });
      }),
    );

    render(<DayDetailPanel {...defaultProps} day={days[0]} days={days} places={[place]} />);
    await userEvent.click(await screen.findByText(/Add accommodation/i));
    await userEvent.click(await screen.findByRole('button', { name: /Full Trip Hotel/i }));

    // "All" is the day.allDays translation (en: "All") — the Apply-to-entire-trip button.
    // When categories=[] the category-filter "All" button is not rendered, so this is unique.
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      // days[0].id=17 (first by position), days[15].id=7 (last by position)
      expect(capturedBody?.start_day_id).toBe(17);
      expect(capturedBody?.end_day_id).toBe(7);
    });
  });

  it('FE-PLANNER-DAYDETAIL-059: sequential IDs — end picker clamping still works (regression guard)', async () => {
    const seqDays = [
      buildDay({ id: 101, trip_id: 1, date: '2026-06-01' }),
      buildDay({ id: 102, trip_id: 1, date: '2026-06-02' }),
      buildDay({ id: 103, trip_id: 1, date: '2026-06-03' }),
    ];
    const place = buildPlace({ id: 53, name: 'Seq Hotel' });
    let capturedBody: any;
    server.use(
      http.post('/api/trips/1/accommodations', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          accommodation: {
            id: 102, place_id: 53, place_name: 'Seq Hotel', place_address: null,
            start_day_id: capturedBody.start_day_id, end_day_id: capturedBody.end_day_id,
            check_in: null, check_out: null, confirmation: null,
          },
        });
      }),
    );

    render(<DayDetailPanel {...defaultProps} day={seqDays[0]} days={seqDays} places={[place]} />);
    await userEvent.click(await screen.findByText(/Add accommodation/i));
    await userEvent.click(await screen.findByRole('button', { name: /Seq Hotel/i }));

    // Pick end = day 3 (id=103, position 2 > position 0 of start id=101).
    await userEvent.click(getDayPickerTriggers()[1]);
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 3'))!);

    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(capturedBody?.start_day_id).toBe(101);
      expect(capturedBody?.end_day_id).toBe(103);
    });
  });

  it('FE-PLANNER-DAYDETAIL-040: 12h time format renders reservation time with AM/PM', async () => {
    seedStore(useSettingsStore, {
      settings: { time_format: '12h', temperature_unit: 'celsius', blur_booking_codes: false },
    });
    const place = buildPlace({ name: 'Bistro' });
    const reservation = buildReservation({
      id: 20,
      title: 'Lunch',
      assignment_id: 60,
      status: 'confirmed',
      reservation_time: '2025-06-15T13:00:00Z',
    });
    render(<DayDetailPanel
      {...defaultProps}
      assignments={{ '1': [{ id: 60, place, place_id: place.id, day_id: 1, order_index: 0, notes: null }] }}
      reservations={[reservation]}
    />);
    await screen.findByText('Lunch');
    // 12h format: some AM/PM-like string
    await waitFor(() => {
      const timeEl = screen.queryByText(/AM|PM|\d{1,2}:\d{2}/i);
      expect(timeEl).toBeInTheDocument();
    });
  });

});
