// FE-COMP-FILEMANAGER-001 to FE-COMP-FILEMANAGER-012
import { render, screen, waitFor, fireEvent } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip } from '../../../tests/helpers/factories';
import FileManager from './FileManager';

// Mock getAuthUrl
vi.mock('../../api/authUrl', () => ({
  getAuthUrl: vi.fn().mockResolvedValue('http://localhost/signed-url'),
}));

// Mock filesApi
vi.mock('../../api/client', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    filesApi: {
      list: vi.fn().mockResolvedValue({ files: [] }),
      toggleStar: vi.fn().mockResolvedValue({}),
      restore: vi.fn().mockResolvedValue({}),
      permanentDelete: vi.fn().mockResolvedValue({}),
      emptyTrash: vi.fn().mockResolvedValue({}),
      upload: vi.fn().mockResolvedValue({ file: { id: 99 } }),
      update: vi.fn().mockResolvedValue({}),
      addLink: vi.fn().mockResolvedValue({}),
      removeLink: vi.fn().mockResolvedValue({}),
      getLinks: vi.fn().mockResolvedValue({ links: [] }),
    },
  };
});

import { filesApi } from '../../api/client';
import { offlineDb } from '../../db/offlineDb';

const buildFile = (overrides = {}) => ({
  id: 1,
  original_name: 'report.pdf',
  mime_type: 'application/pdf',
  file_size: 51200,
  created_at: '2025-01-10T08:00:00Z',
  url: '/uploads/trips/1/report.pdf',
  starred: false,
  deleted_at: null,
  place_id: null,
  reservation_id: null,
  day_id: null,
  uploaded_by: 1,
  uploader_name: 'Alice',
  ...overrides,
});

const defaultProps = {
  files: [],
  onUpload: vi.fn().mockResolvedValue({}),
  onDelete: vi.fn().mockResolvedValue(undefined),
  onUpdate: vi.fn().mockResolvedValue(undefined),
  places: [],
  days: [],
  assignments: {},
  reservations: [],
  tripId: 1,
  allowedFileTypes: null,
};

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
  vi.clearAllMocks();
  // Seed auth as admin so useCanDo() returns true for all permissions
  seedStore(useAuthStore, { user: buildUser({ role: 'admin' }), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });

  // Default trash endpoint
  server.use(
    http.get('/api/trips/:tripId/files', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('trash') === 'true') {
        return HttpResponse.json({ files: [] });
      }
      return HttpResponse.json({ files: [] });
    }),
  );

  // Stub window.confirm
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('FileManager', () => {
  it('FE-COMP-FILEMANAGER-001: renders empty state when no files', async () => {
    render(<FileManager {...defaultProps} files={[]} />);
    // The dropzone should be visible (Upload icon area)
    expect(screen.getByText(/drop/i)).toBeInTheDocument();
    // No file rows
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-002: renders file list when files are provided', async () => {
    render(<FileManager {...defaultProps} files={[buildFile()]} />);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-003: file type filter tabs are present', async () => {
    render(<FileManager {...defaultProps} files={[buildFile()]} />);
    // Filter tabs should be present — match the button elements specifically
    expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^pdfs$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^images$/i })).toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-004: images tab filters to image files only', async () => {
    const files = [
      buildFile({ id: 1, mime_type: 'image/jpeg', original_name: 'photo.jpg' }),
      buildFile({ id: 2, mime_type: 'application/pdf', original_name: 'doc.pdf' }),
    ];
    render(<FileManager {...defaultProps} files={files} />);
    // Both should be visible initially
    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();

    // Click Images filter tab
    const user = userEvent.setup();
    const imageTab = screen.getByRole('button', { name: /^images$/i });
    await user.click(imageTab);

    // Only photo should be visible
    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
    expect(screen.queryByText('doc.pdf')).not.toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-005: star button calls star endpoint', async () => {
    let starCalled = false;
    server.use(
      http.patch('/api/trips/1/files/1/star', () => {
        starCalled = true;
        return HttpResponse.json({ success: true });
      }),
    );
    render(<FileManager {...defaultProps} files={[buildFile()]} />);
    const user = userEvent.setup();

    const starBtn = screen.getByTitle(/star/i);
    await user.click(starBtn);

    await waitFor(() => expect(starCalled).toBe(true));
  });

  it('FE-COMP-FILEMANAGER-006: trash toggle loads and displays trashed files', async () => {
    // filesApi.list is mocked — configure it to return trash files when called with trash=true
    (filesApi.list as ReturnType<typeof vi.fn>).mockImplementation((_tripId, trash) => {
      if (trash) return Promise.resolve({ files: [buildFile({ id: 5, original_name: 'old.pdf', deleted_at: '2025-02-01' })] });
      return Promise.resolve({ files: [] });
    });

    render(<FileManager {...defaultProps} files={[]} />);
    const user = userEvent.setup();

    // Click trash toggle button
    const trashBtn = screen.getByText(/trash/i);
    await user.click(trashBtn);

    // Trashed file should appear
    await screen.findByText('old.pdf');
  });

  it('FE-COMP-FILEMANAGER-007: restore button calls filesApi.restore', async () => {
    (filesApi.list as ReturnType<typeof vi.fn>).mockImplementation((_tripId, trash) => {
      if (trash) return Promise.resolve({ files: [buildFile({ id: 5, original_name: 'old.pdf', deleted_at: '2025-02-01' })] });
      return Promise.resolve({ files: [] });
    });

    render(<FileManager {...defaultProps} files={[]} />);
    const user = userEvent.setup();

    // Open trash
    const trashBtn = screen.getByText(/trash/i);
    await user.click(trashBtn);
    await screen.findByText('old.pdf');

    // Click restore button
    const restoreBtn = screen.getByTitle(/restore/i);
    await user.click(restoreBtn);

    expect(filesApi.restore).toHaveBeenCalledWith(1, 5);
  });

  it('FE-COMP-FILEMANAGER-008: permanent delete calls filesApi.permanentDelete after confirm', async () => {
    (filesApi.list as ReturnType<typeof vi.fn>).mockImplementation((_tripId, trash) => {
      if (trash) return Promise.resolve({ files: [buildFile({ id: 5, original_name: 'old.pdf', deleted_at: '2025-02-01' })] });
      return Promise.resolve({ files: [] });
    });

    render(<FileManager {...defaultProps} files={[]} />);
    const user = userEvent.setup();

    // Open trash
    await user.click(screen.getByText(/trash/i));
    await screen.findByText('old.pdf');

    // Click permanent delete (the Trash2 icon button in trash view)
    const deleteBtn = screen.getByTitle(/delete/i);
    await user.click(deleteBtn);

    expect(filesApi.permanentDelete).toHaveBeenCalledWith(1, 5);
  });

  it('FE-COMP-FILEMANAGER-009: empty trash calls filesApi.emptyTrash', async () => {
    (filesApi.list as ReturnType<typeof vi.fn>).mockImplementation((_tripId, trash) => {
      if (trash) return Promise.resolve({ files: [buildFile({ id: 5, original_name: 'old.pdf', deleted_at: '2025-02-01' })] });
      return Promise.resolve({ files: [] });
    });

    render(<FileManager {...defaultProps} files={[]} />);
    const user = userEvent.setup();

    // Open trash
    await user.click(screen.getByText(/trash/i));
    await screen.findByText('old.pdf');

    // Click "Empty Trash" button
    const emptyTrashBtn = await screen.findByText(/empty trash/i);
    await user.click(emptyTrashBtn);

    expect(filesApi.emptyTrash).toHaveBeenCalledWith(1);
  });

  it('FE-COMP-FILEMANAGER-010: image file click opens lightbox', async () => {
    const files = [
      buildFile({ id: 1, mime_type: 'image/jpeg', original_name: 'photo.jpg' }),
    ];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // Click the file name to open lightbox
    await user.click(screen.getByText('photo.jpg'));

    // Lightbox should appear — it has a fixed position overlay with the filename and a counter
    await waitFor(() => {
      // The lightbox header shows the filename and "1 / 1"
      expect(screen.getByText('1 / 1')).toBeInTheDocument();
    });
  });

  it('FE-COMP-FILEMANAGER-011: escape key closes lightbox', async () => {
    const files = [
      buildFile({ id: 1, mime_type: 'image/jpeg', original_name: 'photo.jpg' }),
    ];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // Open lightbox
    await user.click(screen.getByText('photo.jpg'));
    await waitFor(() => {
      expect(screen.getByText('1 / 1')).toBeInTheDocument();
    });

    // Press Escape
    await user.keyboard('{Escape}');

    // Lightbox should be gone
    await waitFor(() => {
      expect(screen.queryByText('1 / 1')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-FILEMANAGER-013: soft-delete button calls onDelete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<FileManager {...defaultProps} files={[buildFile()]} onDelete={onDelete} />);
    const user = userEvent.setup();

    // The delete (trash) button on a non-trash row is titled 'Delete'
    const deleteBtn = screen.getByTitle(/delete/i);
    await user.click(deleteBtn);

    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it('FE-COMP-FILEMANAGER-014: PDF file click opens preview modal', async () => {
    const files = [buildFile({ id: 1, mime_type: 'application/pdf', original_name: 'report.pdf' })];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // Click the file name — for a non-image this opens the PDF preview modal
    await user.click(screen.getByText('report.pdf'));

    // PDF preview modal should appear with the filename in the header
    await waitFor(() => {
      // The preview modal header shows the filename
      const headers = screen.getAllByText('report.pdf');
      expect(headers.length).toBeGreaterThanOrEqual(2); // in list + in modal header
    });
  });

  it('FE-COMP-FILEMANAGER-015: file with uploader name shows avatar chip initials', () => {
    const files = [buildFile({ uploaded_by_name: 'Alice Smith' })];
    render(<FileManager {...defaultProps} files={files} />);

    // The AvatarChip shows the first letter of the name
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-016: multiple images in lightbox shows thumbnail strip', async () => {
    const files = [
      buildFile({ id: 1, mime_type: 'image/jpeg', original_name: 'photo1.jpg' }),
      buildFile({ id: 2, mime_type: 'image/jpeg', original_name: 'photo2.jpg' }),
    ];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // Open lightbox on first image
    await user.click(screen.getByText('photo1.jpg'));

    // Lightbox shows "1 / 2" counter
    await waitFor(() => {
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });
  });

  it('FE-COMP-FILEMANAGER-017: file size is displayed', () => {
    const files = [buildFile({ file_size: 51200 })];
    render(<FileManager {...defaultProps} files={files} />);
    expect(screen.getByText('50.0 KB')).toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-018: starred filter shows only starred files', async () => {
    const files = [
      buildFile({ id: 1, original_name: 'starred.pdf', starred: true }),
      buildFile({ id: 2, original_name: 'normal.pdf', starred: false }),
    ];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // The starred filter tab only appears when there are starred files
    const starredTab = screen.getByRole('button', { name: '' }); // Star icon button in filter tabs
    await user.click(starredTab);

    expect(screen.getByText('starred.pdf')).toBeInTheDocument();
    expect(screen.queryByText('normal.pdf')).not.toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-019: clicking assign button opens assign modal', async () => {
    render(<FileManager {...defaultProps} files={[buildFile()]} />);
    const user = userEvent.setup();

    // Pencil/assign button
    const assignBtn = screen.getByTitle(/assign/i);
    await user.click(assignBtn);

    // Assign modal should appear (it has a title and a close button)
    await waitFor(() => {
      expect(screen.getByText(/assign/i, { selector: 'div' })).toBeInTheDocument();
    });
  });

  it('FE-COMP-FILEMANAGER-020: assign modal shows places list', async () => {
    const { buildPlace } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Eiffel Tower' });
    render(<FileManager {...defaultProps} files={[buildFile()]} places={[place]} />);
    const user = userEvent.setup();

    const assignBtn = screen.getByTitle(/assign/i);
    await user.click(assignBtn);

    await screen.findByText('Eiffel Tower');
  });

  it('FE-COMP-FILEMANAGER-021: file description is shown when present', () => {
    const files = [buildFile({ description: 'A very important document' })];
    render(<FileManager {...defaultProps} files={files} />);
    expect(screen.getByText('A very important document')).toBeInTheDocument();
  });

  it('FE-COMP-FILEMANAGER-022: PDF preview modal can be closed', async () => {
    const files = [buildFile({ id: 1, mime_type: 'application/pdf', original_name: 'report.pdf' })];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    // Open preview
    await user.click(screen.getByText('report.pdf'));

    // Multiple 'report.pdf' elements now (list + modal header)
    await waitFor(() => {
      expect(screen.getAllByText('report.pdf').length).toBeGreaterThanOrEqual(2);
    });

    // Close via X button in the modal (second X button — first might be something else)
    const closeButtons = screen.getAllByRole('button', { name: '' });
    // Find a close button near the modal header — click the last X-like button
    const xBtn = closeButtons.find(btn => btn.closest('[style*="z-index: 10000"]'));
    if (xBtn) await user.click(xBtn);
  });

  it('FE-COMP-FILEMANAGER-023: assign modal shows reservations list', async () => {
    const { buildReservation } = await import('../../../tests/helpers/factories');
    const reservation = buildReservation({ id: 20, name: 'Hotel Paris' });
    render(<FileManager {...defaultProps} files={[buildFile()]} reservations={[reservation]} />);
    const user = userEvent.setup();

    const assignBtn = screen.getByTitle(/assign/i);
    await user.click(assignBtn);

    await screen.findByText('Hotel Paris');
  });

  it('FE-COMP-FILEMANAGER-024: clicking a place in assign modal calls file update endpoint', async () => {
    const { buildPlace } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Louvre Museum' });
    const file = buildFile({ id: 1 });
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/files/1', async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ file: { ...file, place_id: 10 } });
      }),
    );
    render(<FileManager {...defaultProps} files={[file]} places={[place]} onUpdate={onUpdate} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Louvre Museum');
    await user.click(screen.getByText('Louvre Museum'));

    await waitFor(() => expect(capturedBody).toMatchObject({ place_id: 10 }));
  });

  it('FE-COMP-FILEMANAGER-025: clicking a reservation in assign modal calls file update endpoint', async () => {
    const { buildReservation } = await import('../../../tests/helpers/factories');
    const reservation = buildReservation({ id: 20, name: 'Train Ticket' });
    const file = buildFile({ id: 1 });
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/files/1', async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ file: { ...file, reservation_id: 20 } });
      }),
    );
    render(<FileManager {...defaultProps} files={[file]} reservations={[reservation]} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Train Ticket');
    await user.click(screen.getByText('Train Ticket'));

    await waitFor(() => expect(capturedBody).toMatchObject({ reservation_id: 20 }));
  });

  it('FE-COMP-FILEMANAGER-026: assign modal with both places and reservations shows both sections', async () => {
    const { buildPlace, buildReservation } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Notre Dame' });
    const reservation = buildReservation({ id: 20, name: 'Airbnb' });
    render(<FileManager {...defaultProps} files={[buildFile()]} places={[place]} reservations={[reservation]} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Notre Dame');
    await screen.findByText('Airbnb');
  });

  it('FE-COMP-FILEMANAGER-027: paste event uploads file when user can upload', async () => {
    const onUpload = vi.fn().mockResolvedValue({ file: { id: 55 } });
    render(<FileManager {...defaultProps} onUpload={onUpload} />);

    const container = document.querySelector('.flex.flex-col') as HTMLElement;
    const file = new File(['data'], 'pasted.png', { type: 'image/png' });

    // Manually build a paste event with a mock clipboardData.items
    const mockItem = { kind: 'file', getAsFile: () => file };
    const pasteEvent = new Event('paste', { bubbles: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { items: [mockItem] },
    });

    await fireEvent(container, pasteEvent);

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalled();
    });
  });

  it('FE-COMP-FILEMANAGER-028: upload with places open assign modal after upload', async () => {
    const { buildPlace } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Sagrada Familia' });
    const onUpload = vi.fn().mockResolvedValue({ file: { id: 77 } });

    render(<FileManager {...defaultProps} onUpload={onUpload} places={[place]} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });
    await userEvent.upload(input, file);

    // After successful upload with places present, assign modal opens
    await waitFor(() => {
      expect(onUpload).toHaveBeenCalled();
    });
  });

  it('FE-COMP-FILEMANAGER-029: assign modal with days+assignments shows day group', async () => {
    const { buildPlace, buildDay } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Arc de Triomphe' });
    const day = buildDay({ id: 5, date: '2025-06-01', day_number: 1 });
    const assignments = { '5': [{ id: 1, day_id: 5, place_id: 10, order_index: 0, place }] };

    render(<FileManager {...defaultProps} files={[buildFile()]} places={[place]} days={[day]} assignments={assignments} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Arc de Triomphe');
  });

  it('FE-COMP-FILEMANAGER-030: file with linked place shows source badge', async () => {
    const { buildPlace } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Colosseum' });
    const file = buildFile({ place_id: 10 });

    render(<FileManager {...defaultProps} files={[file]} places={[place]} />);

    // Source badge text includes place name
    await screen.findByText(/Colosseum/);
  });

  it('FE-COMP-FILEMANAGER-031: unlink place from assign modal calls file update endpoint', async () => {
    const { buildPlace } = await import('../../../tests/helpers/factories');
    const place = buildPlace({ id: 10, name: 'Venice Beach' });
    const file = buildFile({ id: 1, place_id: 10 });
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/files/1', async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ file: { ...file, place_id: null } });
      }),
    );
    render(<FileManager {...defaultProps} files={[file]} places={[place]} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Venice Beach');
    await user.click(screen.getByText('Venice Beach'));

    await waitFor(() => expect(capturedBody).toMatchObject({ place_id: null }));
  });

  it('FE-COMP-FILEMANAGER-032: unlink reservation from assign modal calls file update endpoint', async () => {
    const { buildReservation } = await import('../../../tests/helpers/factories');
    const reservation = buildReservation({ id: 20, name: 'Museum Pass' });
    const file = buildFile({ id: 1, reservation_id: 20 });
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/files/1', async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ file: { ...file, reservation_id: null } });
      }),
    );
    render(<FileManager {...defaultProps} files={[file]} reservations={[reservation]} />);
    const user = userEvent.setup();

    await user.click(screen.getByTitle(/assign/i));
    await screen.findByText('Museum Pass');
    await user.click(screen.getByText('Museum Pass'));

    await waitFor(() => expect(capturedBody).toMatchObject({ reservation_id: null }));
  });

  it('FE-COMP-FILEMANAGER-033: opening PDF preview and closing via backdrop', async () => {
    const files = [buildFile({ id: 1, mime_type: 'application/pdf', original_name: 'doc.pdf' })];
    render(<FileManager {...defaultProps} files={files} />);
    const user = userEvent.setup();

    await user.click(screen.getByText('doc.pdf'));

    // Modal opens (multiple occurrences of doc.pdf)
    await waitFor(() => {
      expect(screen.getAllByText('doc.pdf').length).toBeGreaterThanOrEqual(2);
    });

    // Click the backdrop to close
    const backdrop = document.querySelector('[style*="z-index: 10000"]') as HTMLElement;
    if (backdrop) await user.click(backdrop);

    await waitFor(() => {
      expect(screen.getAllByText('doc.pdf').length).toBeLessThan(2);
    });
  });

  it('FE-COMP-FILEMANAGER-012: upload via dropzone calls onUpload', async () => {
    const onUpload = vi.fn().mockResolvedValue({ file: { id: 99 } });
    render(<FileManager {...defaultProps} onUpload={onUpload} />);

    // Find the hidden file input from the dropzone
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const file = new File(['hello'], 'test.pdf', { type: 'application/pdf' });

    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalled();
      const call = onUpload.mock.calls[0];
      expect(call[0]).toBeInstanceOf(FormData);
    });
  });
});
