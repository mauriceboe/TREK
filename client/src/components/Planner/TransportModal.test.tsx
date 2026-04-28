// FE-PLANNER-TRANSMODAL-001 to FE-PLANNER-TRANSMODAL-021
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
  buildReservation,
  buildTripFile,
} from '../../../tests/helpers/factories';
import { TransportModal } from './TransportModal';

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ id: '1' }) };
});

vi.mock('../shared/CustomTimePicker', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="time-picker" type="text" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));

vi.mock('./AirportSelect', () => ({
  default: ({ onChange }: { onChange: (a: any) => void }) => (
    <input data-testid="airport-select" type="text" onChange={e => onChange({ iata: e.target.value, name: e.target.value, city: '', country: '', lat: 0, lng: 0, tz: 'UTC', icao: null })} />
  ),
}));

vi.mock('./LocationSelect', () => ({
  default: ({ onChange }: { onChange: (l: any) => void }) => (
    <input data-testid="location-select" type="text" onChange={e => onChange({ name: e.target.value, lat: 0, lng: 0, address: null })} />
  ),
}));

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSave: vi.fn().mockResolvedValue(undefined),
  reservation: null,
  days: [],
  selectedDayId: null,
  files: [],
  onFileUpload: vi.fn().mockResolvedValue(undefined),
  onFileDelete: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }), budgetItems: [] });
  vi.clearAllMocks();
});

describe('TransportModal', () => {
  // ── Rendering ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSMODAL-001: renders without crashing', () => {
    render(<TransportModal {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-002: shows "Add transport" title for new transport', () => {
    render(<TransportModal {...defaultProps} reservation={null} />);
    expect(screen.getByText(/Add transport/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-003: shows "Edit transport" title when editing', () => {
    const res = buildReservation({ title: 'Paris Flight', type: 'flight' });
    render(<TransportModal {...defaultProps} reservation={res} />);
    expect(screen.getByText(/Edit transport/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-004: title input is required — onSave not called with empty title', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TransportModal {...defaultProps} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-TRANSMODAL-005: all 4 transport type buttons are visible', () => {
    render(<TransportModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /^Flight$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Train$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Car$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cruise$/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-006: editing pre-fills title', () => {
    const res = buildReservation({ title: 'LH123 Frankfurt', type: 'flight' });
    render(<TransportModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('LH123 Frankfurt')).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-007: edit mode save button shows "Update"', () => {
    const res = buildReservation({ title: 'My Train', type: 'train' });
    render(<TransportModal {...defaultProps} reservation={res} />);
    expect(screen.getByRole('button', { name: /^Update$/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-008: Cancel button calls onClose', async () => {
    const onClose = vi.fn();
    render(<TransportModal {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('FE-PLANNER-TRANSMODAL-009: submitting valid flight calls onSave with correct type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TransportModal {...defaultProps} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'LH456');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'LH456', type: 'flight' }));
  });

  it('FE-PLANNER-TRANSMODAL-010: switching to train type calls onSave with train type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TransportModal {...defaultProps} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /^Train$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Eurostar');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'train' }));
  });

  // ── Budget addon ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSMODAL-011: budget section visible when addon is enabled', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    render(<TransportModal {...defaultProps} />);
    expect(screen.getByText(/^Price$/i)).toBeInTheDocument();
    expect(screen.getByText(/Budget category/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-012: budget section not shown when addon is disabled', () => {
    render(<TransportModal {...defaultProps} />);
    expect(screen.queryByPlaceholderText('0.00')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-013: budget fields included in onSave when price is set', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TransportModal {...defaultProps} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'ICE Train');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '85');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ create_budget_entry: expect.objectContaining({ total_price: 85 }) })
    );
  });

  // ── File attachment ───────────────────────────────────────────────────────────

  it('FE-PLANNER-TRANSMODAL-014: attach file button rendered when onFileUpload provided', () => {
    render(<TransportModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Attach file/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-015: attach file button absent when onFileUpload is undefined', () => {
    render(<TransportModal {...defaultProps} onFileUpload={undefined} />);
    expect(screen.queryByRole('button', { name: /Attach file/i })).not.toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-016: attached files shown for existing transport', () => {
    const res = buildReservation({ id: 5, type: 'flight' });
    const file = buildTripFile({ id: 1, trip_id: 1, original_name: 'boarding-pass.pdf' });
    (file as any).reservation_id = 5;

    render(<TransportModal {...defaultProps} reservation={res} files={[file]} />);
    expect(screen.getByText('boarding-pass.pdf')).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-017: pending file added for new transport on file input change', async () => {
    render(<TransportModal {...defaultProps} reservation={null} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'itinerary.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => expect(screen.getByText('itinerary.pdf')).toBeInTheDocument());
  });

  it('FE-PLANNER-TRANSMODAL-018: file upload to existing transport calls onFileUpload with correct FormData', async () => {
    const onFileUpload = vi.fn().mockResolvedValue(undefined);
    const res = buildReservation({ id: 10, type: 'train', title: 'Eurostar' });

    render(<TransportModal {...defaultProps} reservation={res} onFileUpload={onFileUpload} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'ticket.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => expect(onFileUpload).toHaveBeenCalled());
    const [fd] = onFileUpload.mock.calls[0] as [FormData];
    expect(fd.get('file')).toBeTruthy();
    expect(fd.get('reservation_id')).toBe('10');
  });

  it('FE-PLANNER-TRANSMODAL-019: link existing file button appears when unattached files exist', () => {
    const res = buildReservation({ id: 5, type: 'flight' });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(<TransportModal {...defaultProps} reservation={res} files={[unattachedFile]} />);
    expect(screen.getByRole('button', { name: /Link existing file/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-020: clicking "link existing file" shows file picker dropdown', async () => {
    const res = buildReservation({ id: 5, type: 'flight' });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(<TransportModal {...defaultProps} reservation={res} files={[unattachedFile]} />);
    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
  });

  it('FE-PLANNER-TRANSMODAL-021: clicking file in picker links it and closes picker', async () => {
    server.use(
      http.post('/api/trips/1/files/99/link', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
    );

    const res = buildReservation({ id: 5, type: 'flight' });
    const unattachedFile = buildTripFile({ id: 99, original_name: 'invoice.pdf' });

    render(<TransportModal {...defaultProps} reservation={res} files={[unattachedFile]} />);
    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    await userEvent.click(screen.getByText('invoice.pdf'));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Link existing file/i })).not.toBeInTheDocument();
    });
  });

  it('FE-PLANNER-TRANSMODAL-022: removing pending file removes it from list', async () => {
    render(<TransportModal {...defaultProps} reservation={null} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'draft.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });

    await waitFor(() => expect(screen.getByText('draft.pdf')).toBeInTheDocument());

    const pendingFileRow = screen.getByText('draft.pdf').closest('div')!;
    const removeBtn = pendingFileRow.querySelector('button')!;
    await userEvent.click(removeBtn);

    await waitFor(() => expect(screen.queryByText('draft.pdf')).not.toBeInTheDocument());
  });

  it('FE-PLANNER-TRANSMODAL-023: clicking attach file button triggers file input click', async () => {
    render(<TransportModal {...defaultProps} />);
    const attachBtn = screen.getByRole('button', { name: /Attach file/i });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
    await userEvent.click(attachBtn);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('FE-PLANNER-TRANSMODAL-024: unlinking a linked file removes it from attached list', async () => {
    server.use(
      http.post('/api/trips/1/files/42/link', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files/42/links', () => HttpResponse.json({ links: [{ id: 1, reservation_id: 7 }] })),
      http.delete('/api/trips/1/files/42/link/1', () => HttpResponse.json({ success: true })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
    );

    const res = buildReservation({ id: 7, type: 'car' });
    const looseFile = buildTripFile({ id: 42, original_name: 'rental-agreement.pdf' });

    render(<TransportModal {...defaultProps} reservation={res} files={[looseFile]} />);

    await userEvent.click(screen.getByRole('button', { name: /Link existing file/i }));
    await waitFor(() => expect(screen.getByText('rental-agreement.pdf')).toBeInTheDocument());
    await userEvent.click(screen.getByText('rental-agreement.pdf'));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Link existing file/i })).not.toBeInTheDocument()
    );

    const fileRow = screen.getByText('rental-agreement.pdf').closest('div')!;
    const unlinkBtn = fileRow.querySelector('button[type="button"]')!;
    await userEvent.click(unlinkBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Link existing file/i })).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-TRANSMODAL-025: pending files flushed after saving new transport', async () => {
    const savedReservation = buildReservation({ id: 99, type: 'flight' });
    const onSave = vi.fn().mockResolvedValue(savedReservation);
    const onFileUpload = vi.fn().mockResolvedValue(undefined);

    render(<TransportModal {...defaultProps} onSave={onSave} onFileUpload={onFileUpload} reservation={null} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(['content'], 'boarding.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [testFile] } });
    await waitFor(() => expect(screen.getByText('boarding.pdf')).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'LH001');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onFileUpload).toHaveBeenCalled());
    const [fd] = onFileUpload.mock.calls[0] as [FormData];
    expect(fd.get('reservation_id')).toBe('99');
    expect(fd.get('file')).toBeTruthy();
  });
});
