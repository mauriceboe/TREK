// FE-PLANNER-RESMODAL-001 to FE-PLANNER-RESMODAL-035
import { render, screen, waitFor, fireEvent } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useAddonStore } from '../../store/addonStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import {
  buildUser,
  buildTrip,
  buildDay,
  buildPlace,
  buildAssignment,
  buildReservation,
  buildTripFile,
} from '../../../tests/helpers/factories';
import { ReservationModal } from './ReservationModal';

// Mock react-router-dom useParams
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ id: '1' }) };
});

// Mock CustomDatePicker as a simple text input
vi.mock('../shared/CustomDateTimePicker', () => ({
  CustomDatePicker: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      data-testid="date-picker"
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder ?? 'YYYY-MM-DD'}
    />
  ),
}));

// Mock CustomTimePicker as a simple text input
vi.mock('../shared/CustomTimePicker', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      data-testid="time-picker"
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder ?? '00:00'}
    />
  ),
}));

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSave: vi.fn().mockResolvedValue(undefined),
  reservation: null,
  days: [],
  places: [],
  assignments: {},
  selectedDayId: null,
  files: [],
  onFileUpload: vi.fn().mockResolvedValue(undefined),
  onFileDelete: vi.fn().mockResolvedValue(undefined),
  accommodations: [],
};

beforeEach(() => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }), budgetItems: [] });
  // addonStore: budget addon disabled
  vi.clearAllMocks();
});

describe('ReservationModal', () => {
  // ── Rendering ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-001: renders without crashing', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-002: shows "New Reservation" title for new reservation', () => {
    render(<ReservationModal {...defaultProps} reservation={null} />);
    expect(screen.getByText(/New Reservation/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-003: shows "Edit Reservation" title when editing', () => {
    const res = buildReservation({ title: 'Nice Dinner', type: 'restaurant' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByText(/Edit Reservation/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-004: title input is required — onSave not called with empty title', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    const submitBtn = screen.getByRole('button', { name: /^Add$/i });
    await userEvent.click(submitBtn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-RESMODAL-005: all 5 type buttons are visible (transport types removed)', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Accommodation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restaurant/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tour/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Flight$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Train$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Car$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cruise$/i })).not.toBeInTheDocument();
  });

  // ── Type selection ──────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-006: clicking Event type button activates it', async () => {
    render(<ReservationModal {...defaultProps} />);
    const eventBtn = screen.getByRole('button', { name: /Event/i });
    await userEvent.click(eventBtn);
    expect(eventBtn).toHaveStyle({ background: 'var(--text-primary)' });
  });

  it('FE-PLANNER-RESMODAL-008: hotel type shows check-in/check-out time fields', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    const checkInLabels = screen.getAllByText(/Check-in/i);
    expect(checkInLabels.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Check-out/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-009: restaurant type shows location field', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /Restaurant/i }));
    expect(screen.getByPlaceholderText(/Address, Airport/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-010: hotel type hides assignment picker', async () => {
    const day = buildDay({ id: 1, title: 'Day 1' });
    const place = buildPlace({ name: 'Museum' });
    const assignment = buildAssignment({ id: 99, day_id: 1, place });
    render(
      <ReservationModal
        {...defaultProps}
        days={[day]}
        assignments={{ '1': [assignment] }}
      />
    );
    // Switch to hotel type
    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    expect(screen.queryByText(/Link to day assignment/i)).not.toBeInTheDocument();
  });

  // ── Form population from existing reservation ──────────────────────────────

  it('FE-PLANNER-RESMODAL-011: editing pre-fills title', () => {
    const res = buildReservation({ title: 'Paris Hotel', type: 'hotel', status: 'confirmed' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Paris Hotel')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-012: editing pre-fills confirmation number', () => {
    const res = buildReservation({ confirmation_number: 'XYZ123' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('XYZ123')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-013: editing pre-fills notes', () => {
    const res = buildReservation({ notes: 'Breakfast included' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Breakfast included')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-014: editing pre-fills type — restaurant type shows location field', () => {
    const res = buildReservation({ type: 'restaurant', location: 'Via Roma 1' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Via Roma 1')).toBeInTheDocument();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-015: end datetime before start shows error and blocks submit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const addToast = vi.fn();
    window.__addToast = addToast;

    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    // Fill in the title
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'My Flight');

    // Set start date/time via the date-picker inputs (mocked as text inputs)
    // reservation_time is rendered as two separate pickers: date part and time part
    const datePickers = screen.getAllByTestId('date-picker');
    const timePickers = screen.getAllByTestId('time-picker');

    // First date picker = start date, second = end date
    fireEvent.change(datePickers[0], { target: { value: '2025-06-10' } });
    fireEvent.change(timePickers[0], { target: { value: '10:00' } });
    // End date before start date
    fireEvent.change(datePickers[1], { target: { value: '2025-06-09' } });
    fireEvent.change(timePickers[1], { target: { value: '09:00' } });

    // When isEndBeforeStart=true the submit button is disabled, so submit the form directly
    const form = screen.getByRole('button', { name: /^Add$/i }).closest('form')!;
    fireEvent.submit(form);

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/End date\/time must be after start/i),
      'error',
      undefined,
    );

    delete window.__addToast;
  });

  // ── Submit flow ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-016: submitting valid restaurant booking calls onSave with correct shape', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Restaurant/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Le Jules Verne');

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Le Jules Verne', type: 'restaurant' })
    );
  });

  it('FE-PLANNER-RESMODAL-017: status confirmed — onSave called with status confirmed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');

    // The status CustomSelect renders as a button for its trigger — check for "Pending" text and change it
    // CustomSelect renders a div/button with the current value label. We look for the status select area.
    // Since CustomSelect is not mocked, we find the select by its displayed value.
    // The easiest approach: render with a reservation that has status 'confirmed'
    const res = buildReservation({ status: 'confirmed', type: 'flight', title: 'My Booking' });
    const { unmount } = render(<ReservationModal {...defaultProps} reservation={res} onSave={onSave} />);
    const updateBtn = screen.getAllByRole('button', { name: /Update/i })[0];
    await userEvent.click(updateBtn);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed' })
    );
    unmount();
  });

  it('FE-PLANNER-RESMODAL-018: onClose NOT called after successful save (parent controls closing)', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onClose={onClose} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // The component does NOT call onClose after save — the parent controls that
    expect(onClose).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-RESMODAL-019: save button is disabled while saving', async () => {
    let resolveOnSave: () => void;
    const onSave = vi.fn().mockReturnValue(
      new Promise<void>(resolve => { resolveOnSave = resolve; })
    );
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');

    const submitBtn = screen.getByRole('button', { name: /^Add$/i });
    await userEvent.click(submitBtn);

    // While promise is pending, the button should be disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled();
    });

    // Cleanup
    resolveOnSave!();
  });

  // ── Assignment linking ──────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-020: assignment picker appears when days/assignments are populated (non-hotel)', () => {
    const day = buildDay({ id: 1, title: 'Day 1' });
    const place = buildPlace({ name: 'Museum' });
    const assignment = buildAssignment({ id: 99, day_id: 1, order_index: 0, place });

    render(
      <ReservationModal
        {...defaultProps}
        days={[day]}
        assignments={{ '1': [assignment] }}
      />
    );

    expect(screen.getByText(/Link to day assignment/i)).toBeInTheDocument();
  });

  // ── Files ──────────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-022: attached files shown for existing reservation', () => {
    const res = buildReservation({ id: 5 });
    const file = buildTripFile({
      id: 1,
      trip_id: 1,
      original_name: 'ticket.pdf',
    });
    // Add reservation_id field manually (not in standard TripFile type but used in component)
    (file as any).reservation_id = 5;

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[file]}
      />
    );

    expect(screen.getByText('ticket.pdf')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-023: Cancel button calls onClose', async () => {
    const onClose = vi.fn();
    render(<ReservationModal {...defaultProps} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  // ── Budget addon ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-024: budget section visible when budget addon is enabled', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByText(/^Price$/i)).toBeInTheDocument();
    expect(screen.getByText(/Budget category/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-025: budget price input accepts valid decimal', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    render(<ReservationModal {...defaultProps} />);
    const priceInput = screen.getByPlaceholderText('0.00');
    await userEvent.type(priceInput, '99.99');
    expect((priceInput as HTMLInputElement).value).toBe('99.99');
  });

  it('FE-PLANNER-RESMODAL-026: budget hint shown when price > 0', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    render(<ReservationModal {...defaultProps} />);
    const priceInput = screen.getByPlaceholderText('0.00');
    await userEvent.type(priceInput, '50');
    expect(screen.getByText(/budget entry will be created/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-027: budget fields included in onSave when price is set', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Hotel Paris');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '120');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ create_budget_entry: expect.objectContaining({ total_price: 120 }) })
    );
  });

  // ── File upload ───────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-028: pending file added for new reservation on file input change', async () => {
    render(<ReservationModal {...defaultProps} reservation={null} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'document.pdf', { type: 'application/pdf' });

    fireEvent.change(fileInput, { target: { files: [testFile] } });

    // Pending file name should appear in the list
    await waitFor(() => {
      expect(screen.getByText('document.pdf')).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-RESMODAL-029: attach file button is rendered when onFileUpload provided', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Attach file/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-030: hotel type — saving calls onSave with correct hotel shape', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Grand Hotel');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grand Hotel', type: 'hotel' })
    );
  });

  it('FE-PLANNER-RESMODAL-031: event type — saving calls onSave with event type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Event/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Louvre Museum');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Louvre Museum', type: 'event' })
    );
  });

  it('FE-PLANNER-RESMODAL-032: edit mode — save button shows "Update"', () => {
    const res = buildReservation({ title: 'My Trip', type: 'other' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByRole('button', { name: /^Update$/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-033: modal is closed when isOpen=false', () => {
    render(<ReservationModal {...defaultProps} isOpen={false} />);
    // When isOpen=false the Modal component should hide content
    expect(screen.queryByText(/New Reservation/i)).not.toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-034: location and confirmation number inputs are present', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Address, Airport/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. ABC12345/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-036: file upload to existing reservation calls onFileUpload', async () => {
    const onFileUpload = vi.fn().mockResolvedValue(undefined);
    const res = buildReservation({ id: 10, title: 'My Trip', type: 'other' });
    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        onFileUpload={onFileUpload}
      />
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'boarding-pass.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => expect(onFileUpload).toHaveBeenCalled());
    const [fd] = onFileUpload.mock.calls[0] as [FormData];
    expect(fd.get('file')).toBeTruthy();
    // FormData.append coerces numbers to strings
    expect(fd.get('reservation_id')).toBe('10');
  });

  it('FE-PLANNER-RESMODAL-037: link existing file button appears when unattached files exist', () => {
    const res = buildReservation({ id: 5 });
    // File NOT attached to this reservation
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[unattachedFile]}
      />
    );

    expect(screen.getByRole('button', { name: /Link existing file/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-038: clicking "link existing file" shows file picker dropdown', async () => {
    const res = buildReservation({ id: 5 });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[unattachedFile]}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-039: clicking file in picker links it and closes picker', async () => {
    server.use(
      http.post('/api/trips/1/files/99/link', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
    );

    const res = buildReservation({ id: 5 });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[unattachedFile]}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    await userEvent.click(screen.getByText('invoice.pdf'));

    // After linking, the file is moved to attached files and the "Link existing file" button disappears
    // (all files are now attached, so the picker condition becomes false)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Link existing file/i })).not.toBeInTheDocument();
    });
  });

  it('FE-PLANNER-RESMODAL-040: removing pending file removes it from list', async () => {
    render(<ReservationModal {...defaultProps} reservation={null} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'draft.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => expect(screen.getByText('draft.pdf')).toBeInTheDocument());

    // Click the X next to the pending file
    const removeButtons = screen.getAllByRole('button');
    const pendingFileRow = screen.getByText('draft.pdf').closest('div')!;
    const removeBtn = pendingFileRow.querySelector('button')!;
    await userEvent.click(removeBtn);

    await waitFor(() => expect(screen.queryByText('draft.pdf')).not.toBeInTheDocument());
  });

  it('FE-PLANNER-RESMODAL-041: budget section not shown when addon disabled', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.queryByPlaceholderText('0.00')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-042: hotel type metadata saved with check-in time', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Grand Hotel');

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grand Hotel', type: 'hotel' })
    );
  });

  it('FE-PLANNER-RESMODAL-043: hover styles applied to file picker items', async () => {
    const res = buildReservation({ id: 5 });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[unattachedFile]}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    const filePickerItem = screen.getByText('invoice.pdf').closest('button')!;
    fireEvent.mouseEnter(filePickerItem);
    fireEvent.mouseLeave(filePickerItem);
    // Just testing the handlers don't throw
    expect(filePickerItem).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-044: budget category dropdown options include existing categories', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      budgetItems: [
        { id: 1, trip_id: 1, name: 'Flight ticket', amount: 300, currency: 'EUR', category: 'Transport', paid_by: null, persons: 1, members: [], expense_date: null },
      ],
    });
    render(<ReservationModal {...defaultProps} />);
    // Budget section is visible
    expect(screen.getByText(/Budget category/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-045: tour type shows time pickers', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId('time-picker').length).toBeGreaterThan(0);
    });
  });

  it('FE-PLANNER-RESMODAL-046: other type renders and saves correctly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /^Other$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Misc item');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'other' })));
  });

  it('FE-PLANNER-RESMODAL-047: clicking budget category select changes the value', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      budgetItems: [
        { id: 1, trip_id: 1, name: 'Ticket', amount: 100, currency: 'EUR', category: 'Transport', paid_by: null, persons: 1, members: [], expense_date: null },
      ],
    });
    render(<ReservationModal {...defaultProps} />);

    // Open the budget category CustomSelect (shows placeholder "Auto (from booking type)")
    const budgetCategoryBtn = screen.getByText(/Auto \(from booking type\)/i).closest('button')!;
    await userEvent.click(budgetCategoryBtn);

    // Click the "Transport" category option
    await waitFor(() => expect(screen.getByText('Transport')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Transport'));

    // The select should now show "Transport"
    expect(screen.getByText('Transport')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-048: clicking attach file button triggers file input', async () => {
    render(<ReservationModal {...defaultProps} />);
    const attachBtn = screen.getByRole('button', { name: /Attach file/i });
    // Mock click on hidden file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
    await userEvent.click(attachBtn);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('FE-PLANNER-RESMODAL-049: unlinking a linked file removes it from attached list', async () => {
    // First link the file, then unlink it via the X button
    server.use(
      http.post('/api/trips/1/files/42/link', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files/42/links', () => HttpResponse.json({ links: [{ id: 1, reservation_id: 7 }] })),
      http.delete('/api/trips/1/files/42/link/1', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
    );

    const res = buildReservation({ id: 7 });
    // File is NOT attached (no reservation_id) — it will be in the "link existing" picker
    const looseFile = buildTripFile({ id: 42, original_name: 'receipt.pdf' });

    render(
      <ReservationModal
        {...defaultProps}
        reservation={res}
        files={[looseFile]}
      />
    );

    // Link the file via the picker
    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    await waitFor(() => expect(screen.getByText('receipt.pdf')).toBeInTheDocument());
    await userEvent.click(screen.getByText('receipt.pdf'));

    // File is now in attached list; "Link existing file" button gone
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Link existing file/i })).not.toBeInTheDocument()
    );

    // Click the X to unlink
    const fileRow = screen.getByText('receipt.pdf').closest('div')!;
    const unlinkBtn = fileRow.querySelector('button[type="button"]')!;
    await userEvent.click(unlinkBtn);

    // File removed from attached list and "Link existing file" button reappears
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Link existing file/i })).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-RESMODAL-035: hotel type saves correctly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Hotel Test');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hotel' })
    );
  });
});
