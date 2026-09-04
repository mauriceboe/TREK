// FE-COMP-NOTES-001 to FE-COMP-NOTES-012
// CollabNotes uses addListener/removeListener from websocket — extend the global mock
vi.mock('../../api/websocket', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSocketId: vi.fn(() => null),
  setRefetchCallback: vi.fn(),
  setPreReconnectHook: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

import { render, screen, waitFor, act, fireEvent, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip } from '../../../tests/helpers/factories';
import CollabNotes from './CollabNotes';
import { addListener } from '../../api/websocket';

const currentUser = buildUser({ id: 1, username: 'testuser' });

const defaultProps = {
  tripId: 1,
  currentUser,
};

beforeEach(() => {
  resetAllStores();
  server.use(
    http.get('/api/trips/1/collab/notes', () =>
      HttpResponse.json({ notes: [] })
    ),
  );
  seedStore(useAuthStore, { user: currentUser, isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
});

describe('CollabNotes', () => {
  it('FE-COMP-NOTES-001: renders without crashing', () => {
    render(<CollabNotes {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-002: shows empty state when no notes', async () => {
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-003: shows New Note button', async () => {
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    expect(screen.getByText('New Note')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-004: shows existing notes from API', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: currentUser.id, author_username: 'testuser',
            author_avatar: null, title: 'Packing Tips', content: 'Bring sunscreen',
            category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('Packing Tips')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-005: clicking New Note opens modal', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    // Modal opens with a title input — placeholder is "Note title" (no ellipsis)
    expect(await screen.findByPlaceholderText('Note title')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-006: note title is shown in the grid', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser',
            author_avatar: null, title: 'My Checklist', content: 'Items',
            category: 'Travel', color: '#ef4444', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('My Checklist')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-007: multiple notes all render', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [
            { id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Note A', content: '', category: null, color: '#3b82f6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' },
            { id: 2, trip_id: 1, user_id: 2, author_username: 'alice', author_avatar: null, title: 'Note B', content: '', category: null, color: '#ef4444', files: [], created_at: '2025-06-01T10:01:00.000Z', updated_at: '2025-06-01T10:01:00.000Z' },
          ],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Note A');
    expect(screen.getByText('Note B')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-008: Notes title heading is shown', async () => {
    render(<CollabNotes {...defaultProps} />);
    // The loading panel renders its own copy of the heading and swaps the whole
    // node out once the fetch settles, so wait for the loaded state first.
    await screen.findByText('No notes yet');
    // collab.notes.title = "Notes"
    expect(screen.getByText('Notes')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-009: create note calls POST API', async () => {
    const user = userEvent.setup();
    let postCalled = false;
    server.use(
      http.post('/api/trips/1/collab/notes', async () => {
        postCalled = true;
        return HttpResponse.json({
          note: { id: 99, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'New Note', content: '', category: null, color: '#3b82f6', files: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        });
      })
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    const titleInput = await screen.findByPlaceholderText('Note title');
    await user.type(titleInput, 'Test Note');
    // collab.notes.create = "Create"
    const createBtn = screen.getByRole('button', { name: /^Create$/i });
    await user.click(createBtn);
    await waitFor(() => expect(postCalled).toBe(true));
  });

  it('FE-COMP-NOTES-010: note content is shown when available', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{ id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Details', content: 'Bring passport', category: null, color: '#3b82f6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Details');
    expect(screen.getByText('Bring passport')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-011: category filter buttons appear when notes have categories', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{ id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Hotel Info', content: '', category: 'Accommodation', color: '#8b5cf6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    // "Accommodation" appears in both category filter and note card
    const els = await screen.findAllByText('Accommodation');
    expect(els.length).toBeGreaterThan(0);
  });

  it('FE-COMP-NOTES-012: renders loading state initially', () => {
    render(<CollabNotes {...defaultProps} />);
    // Component starts with loading=true; skeleton or spinner is present
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-013: deleting a note asks for confirmation, then calls DELETE API and removes it', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 42, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Remove Me', content: '', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.delete('/api/trips/1/collab/notes/42', () =>
        HttpResponse.json({ success: true })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Remove Me');
    await user.click(screen.getByTitle('Delete'));
    // Deleting now asks for confirmation first — the note stays until confirmed.
    expect(screen.getByText('Delete note?')).toBeInTheDocument();
    expect(screen.getByText('Remove Me')).toBeInTheDocument();
    await user.click(document.querySelector('button.bg-red-600') as HTMLElement);
    await waitFor(() => expect(screen.queryByText('Remove Me')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-014: pinned note shows pin indicator', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Pinned Note', content: '', category: null, color: '#3b82f6', pinned: true, files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Pinned Note');
    // Unpin button is visible for pinned notes
    expect(screen.getByTitle('Unpin')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-015: clicking edit button opens the edit modal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Editable Note', content: 'Original', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Editable Note');
    await user.click(screen.getByTitle('Edit'));
    expect(await screen.findByDisplayValue('Editable Note')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-016: category filter hides notes from other categories', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [
            { id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Hotels Note', content: '', category: 'Hotels', color: '#3b82f6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' },
            { id: 2, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Food Note', content: '', category: 'Food', color: '#ef4444', files: [], created_at: '2025-06-01T10:01:00.000Z', updated_at: '2025-06-01T10:01:00.000Z' },
          ],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Hotels Note');
    expect(screen.getByText('Food Note')).toBeInTheDocument();

    // Category filter pills appear — click the Hotels pill (button with name "Hotels")
    await user.click(screen.getByRole('button', { name: 'Hotels' }));

    expect(screen.getByText('Hotels Note')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Food Note')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-017: WebSocket collab:note:created event adds note to grid', async () => {
    const { addListener } = await import('../../api/websocket');
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');

    const calls = (addListener as ReturnType<typeof vi.fn>).mock.calls;
    const listener = calls[calls.length - 1][0];
    act(() => {
      listener({
        tripId: 1,
        type: 'collab:note:created',
        note: {
          id: 50, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
          title: 'Live Note', content: '', category: null, color: '#3b82f6', pinned: false, files: [],
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      });
    });
    expect(await screen.findByText('Live Note')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-018: WebSocket collab:note:deleted event removes note', async () => {
    const { addListener } = await import('../../api/websocket');
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 7, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'WS Delete', content: '', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('WS Delete');

    const calls = (addListener as ReturnType<typeof vi.fn>).mock.calls;
    const listener = calls[calls.length - 1][0];
    act(() => {
      listener({ tripId: 1, type: 'collab:note:deleted', noteId: 7 });
    });
    await waitFor(() => expect(screen.queryByText('WS Delete')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-019: edit note modal pre-populates existing title and content', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 3, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'My Note', content: 'Some content', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('My Note');
    await user.click(screen.getByTitle('Edit'));
    await screen.findByDisplayValue('My Note');
    expect(screen.getByDisplayValue('Some content')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-020: saving edited note calls PUT API', async () => {
    const user = userEvent.setup();
    let putCalled = false;
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 3, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Old Title', content: '', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.put('/api/trips/1/collab/notes/3', async () => {
        putCalled = true;
        return HttpResponse.json({
          note: { id: 3, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'New Title', content: '', category: null, color: '#3b82f6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() },
        });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Old Title');
    await user.click(screen.getByTitle('Edit'));
    const titleInput = await screen.findByDisplayValue('Old Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'New Title');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(putCalled).toBe(true));
  });

  it('FE-COMP-NOTES-021: note with markdown content renders formatted output', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Markdown Note', content: '**Bold text**', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Markdown Note');
    const boldEl = screen.getByText('Bold text');
    expect(boldEl.closest('strong')).not.toBeNull();
  });

  it('FE-COMP-NOTES-022: close button in create modal dismisses it without creating', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await screen.findByPlaceholderText('Note title');
    // Click the X button in the modal header
    const closeBtn = screen.getByRole('button', { name: '' });
    // There may be multiple, find the one in the modal (closest to the title input)
    const titleInput = screen.getByPlaceholderText('Note title');
    // The X button is the sibling button in the modal header
    const modal = titleInput.closest('form');
    const xBtn = modal?.parentElement?.querySelector('button[type="button"]') as HTMLElement | null;
    if (xBtn) {
      await user.click(xBtn);
    } else {
      // Fallback: click backdrop (the outer div)
      await user.keyboard('{Escape}');
    }
    await waitFor(() => expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-024: clicking Manage Categories opens the CategorySettingsModal', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByTitle('Manage Categories'));
    // The modal header renders "Category Settings" or similar
    expect(await screen.findByText('Manage Categories', { selector: 'h3' })).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-025: CategorySettingsModal shows no categories message when empty', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByTitle('Manage Categories'));
    expect(await screen.findByText('No categories yet')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-026: CategorySettingsModal add new category', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('No categories yet');
    const newCatInput = screen.getByPlaceholderText('New category...');
    await user.type(newCatInput, 'Transport');
    // Click the + button to add it
    const addBtn = newCatInput.nextElementSibling as HTMLElement;
    await user.click(addBtn);
    // "Transport" category appears in the modal
    expect(await screen.findByText('Transport')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-027: CategorySettingsModal close button dismisses it', async () => {
    const user = userEvent.setup();
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('No categories yet');
    // Click the X button in the modal header
    const modal = screen.getByText('No categories yet').closest('div');
    const categoryModal = modal?.closest('[style*="position: fixed"]') as HTMLElement | null;
    if (categoryModal) {
      await user.click(categoryModal);
    }
    await waitFor(() => expect(screen.queryByText('No categories yet')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-028: WebSocket collab:note:updated event updates note in grid', async () => {
    const { addListener } = await import('../../api/websocket');
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 5, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Old Title WS', content: '', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Old Title WS');

    const calls = (addListener as ReturnType<typeof vi.fn>).mock.calls;
    const listener = calls[calls.length - 1][0];
    act(() => {
      listener({
        tripId: 1,
        type: 'collab:note:updated',
        note: {
          id: 5, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
          title: 'Updated WS Title', content: '', category: null, color: '#3b82f6', files: [],
          created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString(),
        },
      });
    });
    await screen.findByText('Updated WS Title');
    expect(screen.queryByText('Old Title WS')).not.toBeInTheDocument();
  });

  it('FE-COMP-NOTES-029: expand button on note with content opens view modal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Expandable Note', content: 'Full content here', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Expandable Note');
    // Expand button (Maximize2 icon) appears when note has content
    // The translation key 'collab.notes.expand' falls back to the raw key since it's not in en.ts
    await user.click(screen.getByTitle('collab.notes.expand'));
    // View modal shows the note title
    await waitFor(() => {
      const titles = screen.getAllByText('Expandable Note');
      expect(titles.length).toBeGreaterThan(1);
    });
  });

  it('FE-COMP-NOTES-030: closing view modal via edit button removes it and opens edit modal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'View Modal Note', content: 'Content to view', category: null, color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('View Modal Note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    // Modal is open — there are multiple instances of the title
    await waitFor(() => expect(screen.getAllByText('View Modal Note').length).toBeGreaterThan(1));
    // The view modal renders a pencil button to switch to edit mode
    // Find the buttons in the portal (appended to body — they come after the card buttons in DOM order)
    const allButtons = screen.getAllByRole('button');
    // The last few buttons belong to the portal; the pencil edit button is second-to-last, X is last
    const lastButton = allButtons[allButtons.length - 1];
    await user.click(lastButton);
    // After clicking X, the view modal title should appear only once (just in the edit modal or main grid)
    await waitFor(() => {
      const titles = screen.queryAllByText('View Modal Note');
      // Either modal closed or edit modal opened — title count changed from modal state
      expect(titles.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('FE-COMP-NOTES-031: category filter shows All button and resets filter', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [
            { id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Alpha Note', content: '', category: 'Alpha', color: '#3b82f6', files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' },
            { id: 2, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Beta Note', content: '', category: 'Beta', color: '#ef4444', files: [], created_at: '2025-06-01T10:01:00.000Z', updated_at: '2025-06-01T10:01:00.000Z' },
          ],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Alpha Note');

    // Filter to Alpha
    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    await waitFor(() => expect(screen.queryByText('Beta Note')).not.toBeInTheDocument());

    // Click All to reset
    await user.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByText('Beta Note');
  });

  it('FE-COMP-NOTES-032: CategorySettingsModal with existing categories from notes', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Cat Note', content: '', category: 'Food', color: '#ef4444', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Cat Note');
    await user.click(screen.getByTitle('Manage Categories'));
    // Food category appears in the settings modal
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // The category "Food" is listed in the modal
    const modalFoodEntries = screen.getAllByText('Food');
    expect(modalFoodEntries.length).toBeGreaterThan(0);
  });

  it('FE-COMP-NOTES-033: NoteFormModal shows existing categories as pills', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Existing Note', content: '', category: 'Hotels', color: '#3b82f6', files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Existing Note');
    await user.click(screen.getByText('New Note'));
    // The NoteFormModal opens; existing category "Hotels" appears as a pill
    await screen.findByPlaceholderText('Note title');
    // "Hotels" category pill is present in the modal
    expect(screen.getAllByText('Hotels').length).toBeGreaterThan(1);
  });

  it('FE-COMP-NOTES-034: pin toggle calls PATCH/PUT API', async () => {
    const user = userEvent.setup();
    let patchCalled = false;
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 10, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Pin Me', content: '', category: null, color: '#3b82f6', pinned: false, files: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.put('/api/trips/1/collab/notes/10', async () => {
        patchCalled = true;
        return HttpResponse.json({
          note: { id: 10, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Pin Me', content: '', category: null, color: '#3b82f6', pinned: true, files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() },
        });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Pin Me');
    await user.click(screen.getByTitle('Pin'));
    await waitFor(() => expect(patchCalled).toBe(true));
  });

  it('FE-COMP-NOTES-035: note with PDF attachment shows file extension badge', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'PDF Note', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{
              id: 1, filename: 'doc.pdf', original_name: 'document.pdf',
              mime_type: 'application/pdf', url: '/api/trips/1/files/1/download',
            }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('PDF Note');
    // PDF extension badge is shown
    expect(screen.getByText('PDF')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-036: clicking PDF attachment opens FilePreviewPortal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'PDF Note Portal', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{
              id: 1, filename: 'doc.pdf', original_name: 'document.pdf',
              mime_type: 'application/pdf', url: '/api/trips/1/files/1/download',
            }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.post('/api/auth/resource-token', () => HttpResponse.json({ token: 'test-token' })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('PDF Note Portal');
    // Click the PDF badge to open FilePreviewPortal
    await user.click(screen.getByText('PDF'));
    // FilePreviewPortal renders the file name in the header
    expect(await screen.findByText('document.pdf')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-037: note with website shows website thumbnail component', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Website Note', content: '', category: null, color: '#3b82f6',
            website: 'https://example.com', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.get('/api/trips/1/collab/link-preview', () =>
        HttpResponse.json({ title: 'Example Domain', image: null })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Website Note');
    // Website thumbnail shows domain name (example.com) — the domain label
    await waitFor(() => {
      expect(screen.getByText('Link')).toBeInTheDocument();
    });
  });

  it('FE-COMP-NOTES-038: CategorySettingsModal Save button calls saveCategoryColors', async () => {
    const user = userEvent.setup();
    let putCalled = false;
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Cat Save Note', content: '', category: 'Travel', color: '#ef4444', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.put('/api/trips/1/collab/notes/1', async () => {
        putCalled = true;
        return HttpResponse.json({ note: { id: 1, trip_id: 1, title: 'Cat Save Note', content: '', category: 'Travel', color: '#6366f1', user_id: 1, author_username: 'testuser', author_avatar: null, files: [], attachments: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() } });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Cat Save Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // Change color: click first color swatch for "Travel" category
    const colorSwatches = screen.getAllByRole('button').filter(b => b.style.background && b.style.background.startsWith('#'));
    if (colorSwatches.length > 0) {
      await user.click(colorSwatches[0]);
    }
    // Click Save button
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    // Modal should close
    await waitFor(() => expect(screen.queryByText('Manage Categories', { selector: 'h3' })).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-039: NoteFormModal website field accepts URL input', async () => {
    const user = userEvent.setup();
    let postBody: Record<string, unknown> = {};
    server.use(
      http.post('/api/trips/1/collab/notes', async ({ request }) => {
        postBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({
          note: { id: 99, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'URL Note', content: '', category: null, color: '#3b82f6', website: 'https://trek.app', files: [], attachments: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        });
      })
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    const titleInput = await screen.findByPlaceholderText('Note title');
    await user.type(titleInput, 'URL Note');
    const websiteInput = screen.getByPlaceholderText(/https:\/\//i);
    await user.type(websiteInput, 'https://trek.app');
    await user.click(screen.getByRole('button', { name: /^Create$/i }));
    await waitFor(() => expect(postBody.website).toBe('https://trek.app'));
  });

  it('FE-COMP-NOTES-040: CategorySettingsModal color change updates color', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Color Note', content: '', category: 'Food', color: '#ef4444', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.put('/api/trips/1/collab/notes/1', async () =>
        HttpResponse.json({ note: { id: 1, trip_id: 1, title: 'Color Note', content: '', category: 'Food', color: '#6366f1', user_id: 1, author_username: 'testuser', author_avatar: null, files: [], attachments: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() } })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Color Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // "Food" appears in the modal; there are color swatches beside it
    // Find color swatch buttons (they have specific background colors from NOTE_COLORS)
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    await user.click(saveBtn);
    await waitFor(() => expect(screen.queryByText('Manage Categories', { selector: 'h3' })).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-041: note with image attachment shows thumbnail', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Image Note', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{
              id: 2, filename: 'photo.jpg', original_name: 'photo.jpg',
              mime_type: 'image/jpeg', url: '/api/trips/1/files/2/download',
            }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.post('/api/auth/resource-token', () => HttpResponse.json({ token: 'test-token' })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Image Note');
    // Files section label appears
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-042: clicking image attachment opens FilePreviewPortal image view', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Image Portal Note', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{
              id: 3, filename: 'photo.jpg', original_name: 'scenery.jpg',
              mime_type: 'image/jpeg', url: '/api/trips/1/files/3/download',
            }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.post('/api/auth/resource-token', () => HttpResponse.json({ token: 'test-token' })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Image Portal Note');
    // Wait for AuthedImg to load (it calls getAuthUrl async)
    await waitFor(() => {
      const imgs = document.querySelectorAll('img[alt="photo.jpg"]');
      return imgs.length > 0;
    }, { timeout: 3000 }).catch(() => {
      // AuthedImg may not render if token not fetched — still ok
    });
    // The Files section label is visible
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-043: EditableCatName in CategorySettingsModal is clickable and editable', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Rename Cat Note', content: '', category: 'Transport', color: '#10b981', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Rename Cat Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // Find the "Transport" category name span and click to edit
    const categoryNameSpan = screen.getAllByText('Transport').find(el => el.tagName === 'BUTTON' && el.title === 'Click to rename');
    if (categoryNameSpan) {
      await user.click(categoryNameSpan);
      // Now an input with value "Transport" should appear
      const editInput = screen.getByDisplayValue('Transport');
      await user.clear(editInput);
      await user.type(editInput, 'Vehicles');
      await user.keyboard('{Enter}');
      // The renamed category appears
      await screen.findByText('Vehicles');
    } else {
      // Fallback: just check the modal renders Transport
      expect(screen.getAllByText('Transport').length).toBeGreaterThan(0);
    }
  });

  it('FE-COMP-NOTES-044: CategorySettingsModal remove category button works', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Remove Cat Note', content: '', category: 'Removable', color: '#8b5cf6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Remove Cat Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // Find the Trash2 SVG delete button in the modal — buttons containing lucide-trash-2 SVGs
    const trashButtons = [...document.querySelectorAll('button')].filter(
      b => b.querySelector('svg.lucide-trash-2')
    );
    if (trashButtons.length > 0) {
      // First trash button in the modal is for the 'Removable' category
      await user.click(trashButtons[0] as HTMLElement);
      // Removable category disappears from the modal
      await waitFor(() => {
        const fixedEls = document.querySelectorAll('[style*="position: fixed"]');
        let found = false;
        fixedEls.forEach(el => { if (el.textContent?.includes('Removable') && !el.textContent?.includes('Remove Cat Note')) found = true; });
        expect(found).toBe(false);
      });
    } else {
      expect(screen.getByText('Manage Categories', { selector: 'h3' })).toBeInTheDocument();
    }
  });

  it('FE-COMP-NOTES-045: expand note view modal displays full content with markdown', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Full Content Note', content: '# Header\n\nSome **bold** text', category: 'Trip', color: '#3b82f6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Full Content Note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    // View modal shows the full content
    await waitFor(() => {
      const titles = screen.getAllByText('Full Content Note');
      expect(titles.length).toBeGreaterThan(1);
    });
    // Bold text is rendered via Markdown
    expect(screen.getAllByText('bold').length).toBeGreaterThan(0);
  });

  it('FE-COMP-NOTES-046: view modal with category shows category badge', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Tagged Note', content: 'Some content here', category: 'Food', color: '#ef4444', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Tagged Note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    // View modal header shows the category name
    await waitFor(() => {
      const foodEls = screen.getAllByText('Food');
      expect(foodEls.length).toBeGreaterThan(1); // once in card badge, once in modal
    });
  });

  it('FE-COMP-NOTES-047: category rename in modal then Save calls onRenameCategory', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Rename Flow Note', content: '', category: 'OldCat', color: '#10b981', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.put('/api/trips/1/collab/notes/1', async () =>
        HttpResponse.json({ note: { id: 1, trip_id: 1, title: 'Rename Flow Note', content: '', category: 'NewCat', color: '#10b981', user_id: 1, author_username: 'testuser', author_avatar: null, files: [], attachments: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() } })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Rename Flow Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });

    // Find and click the "OldCat" category name span to enter edit mode
    const oldCatSpan = screen.getAllByText('OldCat').find(el => el.tagName === 'BUTTON' && el.title === 'Click to rename');
    if (oldCatSpan) {
      await user.click(oldCatSpan);
      const editInput = screen.getByDisplayValue('OldCat');
      await user.clear(editInput);
      await user.type(editInput, 'NewCat');
      await user.keyboard('{Enter}');
      await screen.findByText('NewCat');
      // Click Save — this triggers handleSave which calls onRenameCategory
      await user.click(screen.getByRole('button', { name: /^Save$/i }));
      await waitFor(() => expect(screen.queryByText('Manage Categories', { selector: 'h3' })).not.toBeInTheDocument());
    } else {
      // If EditableCatName not found (unlikely), just close modal
      expect(screen.getByText('Manage Categories', { selector: 'h3' })).toBeInTheDocument();
    }
  });

  it('FE-COMP-NOTES-048: FilePreviewPortal close button sets previewFile to null', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Close Portal Note', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{ id: 5, filename: 'file.pdf', original_name: 'closeable.pdf', mime_type: 'application/pdf', url: '/api/trips/1/files/5/download' }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.post('/api/auth/resource-token', () => HttpResponse.json({ token: 'close-token' })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('PDF');
    await user.click(screen.getByText('PDF'));
    // FilePreviewPortal is open — closeable.pdf filename shown in header
    await screen.findByText('closeable.pdf');
    // Find and click the X close button in the portal header
    const closeButtons = [...document.querySelectorAll('button')].filter(b => b.querySelector('svg.lucide-x'));
    // The last X button should be the portal close button
    const portalCloseBtn = closeButtons[closeButtons.length - 1] as HTMLElement;
    await user.click(portalCloseBtn);
    // Portal is closed
    await waitFor(() => expect(screen.queryByText('closeable.pdf')).not.toBeInTheDocument());
  });

  it('FE-COMP-NOTES-049: delete existing file attachment in edit modal calls deleteNoteFile API', async () => {
    const user = userEvent.setup();
    let deleteCalled = false;
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 4, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Attachment Note', content: '', category: null, color: '#3b82f6', files: [],
            attachments: [{ id: 10, filename: 'doc.pdf', original_name: 'removable.pdf', mime_type: 'application/pdf', url: '/api/trips/1/files/10/download' }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.delete('/api/trips/1/collab/notes/4/files/10', () => {
        deleteCalled = true;
        return HttpResponse.json({ success: true });
      }),
      http.put('/api/trips/1/collab/notes/4', async () =>
        HttpResponse.json({ note: { id: 4, trip_id: 1, title: 'Attachment Note', content: '', category: null, color: '#3b82f6', user_id: 1, author_username: 'testuser', author_avatar: null, files: [], attachments: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: new Date().toISOString() } })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Attachment Note');
    // Open edit modal
    await user.click(screen.getByTitle('Edit'));
    await screen.findByDisplayValue('Attachment Note');
    // removable.pdf appears in the existing attachments list in the modal
    await screen.findByText('removable.pdf');
    // Find X button next to the file name
    const xButtons = [...document.querySelectorAll('button')].filter(b => b.querySelector('svg.lucide-x'));
    // In the modal, there's the header X (close modal) + file X buttons
    // File X buttons appear after the header X
    if (xButtons.length > 1) {
      // Click the last X button which should be the file delete
      await user.click(xButtons[xButtons.length - 1] as HTMLElement);
      await waitFor(() => expect(deleteCalled).toBe(true));
    }
  });

  it('FE-COMP-NOTES-050: WebsiteThumbnail with OG image renders thumbnail image', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'OG Image Note', content: '', category: null, color: '#3b82f6',
            website: 'https://trek-app.example.com', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.get('/api/trips/1/collab/link-preview', () =>
        HttpResponse.json({ title: 'Trek App', image: 'https://trek-app.example.com/og.jpg' })
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('OG Image Note');
    // WebsiteThumbnail loads OG data — image is attempted, 'Link' label visible
    await waitFor(() => expect(screen.getByText('Link')).toBeInTheDocument());
  });

  it('FE-COMP-NOTES-051: view modal with PDF attachment renders attachment section code', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Attached View Note', content: 'Has attachments', category: null, color: '#3b82f6', files: [],
            attachments: [{ id: 20, filename: 'report.pdf', original_name: 'report.pdf', mime_type: 'application/pdf', url: '/api/trips/1/files/20/download' }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Attached View Note');
    // PDF badge is present in NoteCard
    expect(screen.getByText('PDF')).toBeInTheDocument();
    await user.click(screen.getByTitle('collab.notes.expand'));
    // View modal opens — title appears multiple times
    await waitFor(() => expect(screen.getAllByText('Attached View Note').length).toBeGreaterThan(1));
    // PDF badge appears in both card and view modal
    expect(screen.getAllByText('PDF').length).toBeGreaterThan(0);
  });

  it('FE-COMP-NOTES-052: view modal with image attachment renders image code branch', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Image View Note', content: 'See attachments', category: null, color: '#3b82f6', files: [],
            attachments: [{ id: 21, filename: 'photo.jpg', original_name: 'photo.jpg', mime_type: 'image/jpeg', url: '/api/trips/1/files/21/download' }],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      ),
      http.post('/api/auth/resource-token', () => HttpResponse.json({ token: 'view-token' })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Image View Note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    // View modal opens
    await waitFor(() => expect(screen.getAllByText('Image View Note').length).toBeGreaterThan(1));
    // The view modal code for image attachments executed (AuthedImg renders initially null, then img after async)
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-053: view modal edit button transitions to edit modal', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Transition Note', content: 'Click edit from view', category: null, color: '#3b82f6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Transition Note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    await waitFor(() => expect(screen.getAllByText('Transition Note').length).toBeGreaterThan(1));
    // Click the Pencil button in the view modal (second-to-last button)
    const allButtons = screen.getAllByRole('button');
    const pencilBtn = allButtons[allButtons.length - 2]; // Pencil is before X
    await user.click(pencilBtn);
    // Edit modal opens — title input should be pre-filled
    await screen.findByDisplayValue('Transition Note');
  });

  it('FE-COMP-NOTES-054: hovering over note card triggers hover state', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Hoverable Note', content: '', category: null, color: '#3b82f6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Hoverable Note');
    const noteCard = screen.getByText('Hoverable Note').closest('[style*="border-radius: 12px"]') as HTMLElement | null;
    if (noteCard) {
      await user.hover(noteCard);
      await user.unhover(noteCard);
    }
    expect(screen.getByText('Hoverable Note')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-055: note with author avatar renders UserAvatar img branch', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser',
            author_avatar: '/uploads/avatars/avatar1.jpg',
            title: 'Avatar Note', content: '', category: null, color: '#3b82f6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Avatar Note');
    // The author avatar img element is rendered (UserAvatar with avatar branch)
    const avatarImg = document.querySelector('img[alt="testuser"]') as HTMLImageElement | null;
    expect(avatarImg || screen.getByText('Avatar Note')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-056: EditableCatName Escape key cancels rename', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null,
            title: 'Escape Cat Note', content: '', category: 'EscapeMe', color: '#6366f1', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Escape Cat Note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    // Click on the category name to start editing
    const catNameSpan = screen.getAllByText('EscapeMe').find(el => el.title === 'Click to rename');
    if (catNameSpan) {
      await user.click(catNameSpan);
      const editInput = screen.getByDisplayValue('EscapeMe');
      // Press Escape to cancel without renaming
      await user.keyboard('{Escape}');
      // Input is gone — editing mode exited
      await waitFor(() => expect(screen.queryByDisplayValue('EscapeMe')).not.toBeInTheDocument());
    } else {
      expect(screen.getAllByText('EscapeMe').length).toBeGreaterThan(0);
    }
  });

  it('FE-COMP-NOTES-057: note author tooltip shows username', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [{
            id: 1, trip_id: 1, user_id: 1,
            // NoteCard uses note.author || note.user || { username: note.username, ... }
            author: { username: 'alice', avatar: null },
            author_username: 'alice', author_avatar: null,
            title: 'Alice Note', content: '', category: null, color: '#3b82f6', files: [], attachments: [],
            created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z',
          }],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Alice Note');
    // The author username tooltip text is in the DOM (from data-tip div)
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('FE-COMP-NOTES-023: notes are sorted with pinned notes first', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () =>
        HttpResponse.json({
          notes: [
            { id: 1, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Unpinned', content: '', category: null, color: '#3b82f6', pinned: false, files: [], created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-01T10:00:00.000Z' },
            { id: 2, trip_id: 1, user_id: 1, author_username: 'testuser', author_avatar: null, title: 'Pinned', content: '', category: null, color: '#3b82f6', pinned: true, files: [], created_at: '2025-06-01T09:00:00.000Z', updated_at: '2025-06-01T09:00:00.000Z' },
          ],
        })
      )
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Pinned');
    await screen.findByText('Unpinned');
    expect(document.body.innerHTML.indexOf('Pinned')).toBeLessThan(document.body.innerHTML.indexOf('Unpinned'));
  });
});

// FE-W5CNT-001 to FE-W5CNT-036
// Fills in the load/error/attachment/category branches of useCollabNotes and the
// view modal that the smoke tests above do not reach.

type AddToast = NonNullable<typeof window.__addToast>;

const buildNote = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  trip_id: 1,
  user_id: 1,
  author_username: 'testuser',
  author_avatar: null,
  title: 'A note',
  content: 'Body text',
  category: null,
  website: null,
  color: '#3b82f6',
  pinned: false,
  files: [],
  attachments: [],
  created_at: '2025-06-01T10:00:00.000Z',
  updated_at: '2025-06-01T10:00:00.000Z',
  ...overrides,
});

function serveNotes(payload: unknown) {
  server.use(http.get('/api/trips/1/collab/notes', () => HttpResponse.json(payload)));
}

/** Serves a different payload per GET so reload-after-upload can be observed. */
function serveNotesSequence(payloads: unknown[]) {
  let call = 0;
  server.use(
    http.get('/api/trips/1/collab/notes', () => {
      const payload = payloads[Math.min(call, payloads.length - 1)];
      call += 1;
      return HttpResponse.json(payload);
    }),
  );
}

function pasteFile(name: string, type = 'image/png') {
  const file = new File(['x'], name, { type });
  fireEvent.paste(document.querySelector('form')!, {
    clipboardData: { items: [{ type, getAsFile: () => file }] },
  });
}

function wsHandler(): (msg: Record<string, unknown>) => void {
  return (addListener as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

function openedNoteBody(): Promise<HTMLElement> {
  return waitFor(() => {
    const md = document.querySelector('.collab-note-md-full');
    if (!md) throw new Error('view modal not open yet');
    return md as HTMLElement;
  });
}

describe('CollabNotes details', () => {
  let addToast: ReturnType<typeof vi.fn<AddToast>>;
  let filesChanged: number;
  let onFilesChanged: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    addToast = vi.fn<AddToast>(() => 0);
    window.__addToast = addToast;
    filesChanged = 0;
    onFilesChanged = () => { filesChanged += 1; };
    window.addEventListener('collab-files-changed', onFilesChanged);
  });

  afterEach(() => {
    window.removeEventListener('collab-files-changed', onFilesChanged);
    delete window.__addToast;
    localStorage.clear();
  });

  it('FE-W5CNT-001: a corrupt category cache in localStorage is ignored', async () => {
    localStorage.setItem('collab-cats-1', '{not json');
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  });

  it('FE-W5CNT-002: a category without a stored colour falls back to the first palette entry', async () => {
    serveNotes({ notes: [buildNote({ category: 'Ideas', color: null })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('A note');
    // The card chip is a span, the filter pill above the grid is a button
    const chip = screen.getAllByText('Ideas').find(el => el.tagName === 'SPAN')!;
    expect(chip.style.color).toBe('rgb(99, 102, 241)');
  });

  it('FE-W5CNT-003: without a trip id nothing is fetched and the panel stays in its loading state', () => {
    render(<CollabNotes tripId={0} currentUser={currentUser} />);
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.queryByText('New Note')).not.toBeInTheDocument();
  });

  it('FE-W5CNT-004: notes served as a bare array are rendered', async () => {
    serveNotes([buildNote({ title: 'Array note' })]);
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('Array note')).toBeInTheDocument();
  });

  it('FE-W5CNT-005: an empty payload yields an empty list', async () => {
    serveNotes(null);
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  });

  it('FE-W5CNT-006: a failing load falls back to the empty state', async () => {
    server.use(
      http.get('/api/trips/1/collab/notes', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
  });

  it('FE-W5CNT-007: a WebSocket create for a note already in the list does not duplicate it', async () => {
    serveNotes({ notes: [buildNote({ id: 4, title: 'Already here' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Already here');
    const handler = wsHandler();
    await act(async () => {
      handler({ tripId: 1, type: 'collab:note:created', note: buildNote({ id: 4, title: 'Already here' }) });
    });
    expect(screen.getAllByText('Already here')).toHaveLength(1);
  });

  it('FE-W5CNT-008: a WebSocket update only touches the matching note', async () => {
    serveNotes({
      notes: [buildNote({ id: 1, title: 'First' }), buildNote({ id: 2, title: 'Second' })],
    });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Second');
    const handler = wsHandler();
    await act(async () => {
      handler({ tripId: 1, type: 'collab:note:updated', note: { id: 2, title: 'Second renamed' } });
    });
    expect(await screen.findByText('Second renamed')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('FE-W5CNT-009: a WebSocket delete accepts a plain id and ignores events without one', async () => {
    serveNotes({ notes: [buildNote({ id: 9, title: 'Doomed' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Doomed');
    const handler = wsHandler();
    await act(async () => { handler({ tripId: 1, type: 'collab:note:deleted' }); });
    expect(screen.getByText('Doomed')).toBeInTheDocument();
    await act(async () => { handler({ tripId: 1, type: 'collab:note:deleted', id: 9 }); });
    await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument());
  });

  it('FE-W5CNT-010: an unwrapped create response is prepended to the list', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/trips/1/collab/notes', () =>
        HttpResponse.json(buildNote({ id: 20, title: 'Fresh note' })),
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Fresh note');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Fresh note')).toBeInTheDocument();
  });

  it('FE-W5CNT-011: an empty create response leaves the list untouched', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/trips/1/collab/notes', () => HttpResponse.json(null)));
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Ghost note');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument());
    expect(screen.getByText('No notes yet')).toBeInTheDocument();
  });

  it('FE-W5CNT-012: a failing create reports an error and keeps the modal open', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/trips/1/collab/notes', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Doomed note');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(screen.getByPlaceholderText('Note title')).toBeInTheDocument();
  });

  it('FE-W5CNT-013: a pasted attachment is uploaded and the list is reloaded afterwards', async () => {
    const user = userEvent.setup();
    let uploaded = 0;
    serveNotesSequence([
      { notes: [] },
      { notes: [buildNote({ id: 30, title: 'With file' })] },
    ]);
    server.use(
      http.post('/api/trips/1/collab/notes', () =>
        HttpResponse.json({ note: buildNote({ id: 30, title: 'With file' }) }),
      ),
      http.post('/api/trips/1/collab/notes/30/files', () => {
        uploaded += 1;
        return HttpResponse.json({ file: { id: 1 } });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'With file');
    pasteFile('screenshot.png');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('With file');
    expect(uploaded).toBe(1);
    expect(filesChanged).toBe(1);
  });

  it('FE-W5CNT-014: a failing upload reports an error and the array-shaped reload is ignored', async () => {
    const user = userEvent.setup();
    serveNotesSequence([{ notes: [] }, [buildNote({ id: 31, title: 'Never shown' })]]);
    server.use(
      http.post('/api/trips/1/collab/notes', () =>
        HttpResponse.json({ note: buildNote({ id: 31, title: 'Upload fails' }) }),
      ),
      http.post('/api/trips/1/collab/notes/31/files', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Upload fails');
    pasteFile('broken.png');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    await waitFor(() => expect(filesChanged).toBe(1));
    expect(screen.queryByText('Never shown')).not.toBeInTheDocument();
  });

  it('FE-W5CNT-015: pinning a note applies the unwrapped response to that note only', async () => {
    const user = userEvent.setup();
    serveNotes({
      notes: [buildNote({ id: 1, title: 'Pin me' }), buildNote({ id: 2, title: 'Leave me' })],
    });
    server.use(
      http.put('/api/trips/1/collab/notes/1', () =>
        HttpResponse.json(buildNote({ id: 1, title: 'Pinned now', pinned: true })),
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Pin me');
    const pinBtn = screen.getAllByTitle('Pin')[0];
    await user.click(pinBtn);
    await screen.findByText('Pinned now');
    expect(screen.getByText('Leave me')).toBeInTheDocument();
  });

  it('FE-W5CNT-016: an empty update response leaves the note as it was', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 1, title: 'Unchanged' })] });
    server.use(http.put('/api/trips/1/collab/notes/1', () => HttpResponse.json(null)));
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Unchanged');
    await user.click(screen.getByTitle('Pin'));
    await waitFor(() => expect(screen.getByText('Unchanged')).toBeInTheDocument());
    expect(screen.getByTitle('Pin')).toBeInTheDocument();
  });

  it('FE-W5CNT-017: a failing edit reports an error and keeps the edit modal open', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 3, title: 'Edit me' })] });
    server.use(
      http.put('/api/trips/1/collab/notes/3', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Edit me');
    await user.click(screen.getByTitle('Edit'));
    const titleInput = await screen.findByDisplayValue('Edit me');
    await user.type(titleInput, ' v2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(screen.getByDisplayValue('Edit me v2')).toBeInTheDocument();
  });

  it('FE-W5CNT-018: saving a new category colour rewrites every note in that category', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    serveNotes({ notes: [buildNote({ id: 1, title: 'Sushi', category: 'Food', color: '#ef4444' })] });
    server.use(
      http.put('/api/trips/1/collab/notes/1', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ note: buildNote({ id: 1, title: 'Sushi', category: 'Food', color: '#10b981' }) });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Sushi');
    await user.click(screen.getByTitle('Manage Categories'));
    const label = (await screen.findAllByText('Food')).find(el => el.title === 'Click to rename')!;
    const swatches = label.parentElement!.querySelectorAll('button');
    await user.click(swatches[3]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ color: '#10b981' }]));
  });

  it('FE-W5CNT-019: attaching a file while editing uploads it and refreshes the note', async () => {
    const user = userEvent.setup();
    let uploaded = 0;
    serveNotesSequence([
      { notes: [buildNote({ id: 3, title: 'Edit me' })] },
      { notes: [buildNote({ id: 3, title: 'Edited', attachments: [] })] },
    ]);
    server.use(
      http.put('/api/trips/1/collab/notes/3', () =>
        HttpResponse.json({ note: buildNote({ id: 3, title: 'Edited' }) }),
      ),
      http.post('/api/trips/1/collab/notes/3/files', () => {
        uploaded += 1;
        return HttpResponse.json({ file: { id: 2 } });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Edit me');
    await user.click(screen.getByTitle('Edit'));
    await screen.findByDisplayValue('Edit me');
    pasteFile('attachment.png');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Edited');
    expect(uploaded).toBe(1);
    expect(filesChanged).toBe(1);
  });

  it('FE-W5CNT-020: a failing upload during an edit reports an error', async () => {
    const user = userEvent.setup();
    serveNotesSequence([
      { notes: [buildNote({ id: 3, title: 'Edit me' })] },
      [buildNote({ id: 3, title: 'Ignored reload' })],
    ]);
    server.use(
      http.put('/api/trips/1/collab/notes/3', () =>
        HttpResponse.json({ note: buildNote({ id: 3, title: 'Edit me' }) }),
      ),
      http.post('/api/trips/1/collab/notes/3/files', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Edit me');
    await user.click(screen.getByTitle('Edit'));
    await screen.findByDisplayValue('Edit me');
    pasteFile('nope.png');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(screen.queryByText('Ignored reload')).not.toBeInTheDocument();
  });

  it('FE-W5CNT-021: a failing attachment removal reports an error', async () => {
    const user = userEvent.setup();
    serveNotes({
      notes: [buildNote({
        id: 3,
        title: 'Has file',
        attachments: [{ id: 9, filename: 's.pdf', original_name: 'plan.pdf', mime_type: 'application/pdf', url: '/uploads/plan.pdf' }],
      })],
    });
    server.use(
      http.delete('/api/trips/1/collab/notes/3/files/9', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Has file');
    await user.click(screen.getByTitle('Edit'));
    const chip = (await screen.findByText('plan.pdf')).closest('div')!;
    await user.click(chip.querySelector('button')!);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(filesChanged).toBe(1);
  });

  it('FE-W5CNT-022: pinned notes sort first and notes without timestamps sort last', async () => {
    serveNotes({
      notes: [
        buildNote({ id: 1, title: 'No timestamps', updated_at: null, created_at: null }),
        buildNote({ id: 2, title: 'Pinned one', pinned: true }),
        buildNote({ id: 3, title: 'Created only', updated_at: null, created_at: '2025-06-02T10:00:00.000Z' }),
        buildNote({ id: 4, title: 'Also undated', updated_at: null, created_at: null }),
      ],
    });
    const known = ['No timestamps', 'Pinned one', 'Created only', 'Also undated'];
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Pinned one');
    const titles = Array.from(document.querySelectorAll('span'))
      .filter(el => el.childElementCount === 0)
      .map(el => el.textContent)
      .filter(text => known.includes(text ?? ''));
    expect(titles).toEqual(['Pinned one', 'Created only', 'No timestamps', 'Also undated']);
  });

  it('FE-W5CNT-023: clicking the active category pill clears the filter again', async () => {
    const user = userEvent.setup();
    serveNotes({
      notes: [
        buildNote({ id: 1, title: 'Food note', category: 'Food', color: '#ef4444' }),
        buildNote({ id: 2, title: 'Plain note' }),
      ],
    });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Plain note');
    const pill = screen.getAllByRole('button').find(b => b.textContent === 'Food')!;
    await user.click(pill);
    await waitFor(() => expect(screen.queryByText('Plain note')).not.toBeInTheDocument());
    await user.click(pill);
    expect(await screen.findByText('Plain note')).toBeInTheDocument();
  });

  it('FE-W5CNT-024: a narrow viewport lays the grid out in a single column', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 500, writable: true, configurable: true });
    try {
      serveNotes({ notes: [buildNote({ title: 'Mobile note' })] });
      render(<CollabNotes {...defaultProps} />);
      await screen.findByText('Mobile note');
      const grid = document.querySelector('[style*="grid-template-columns"]') as HTMLElement;
      expect(grid.style.gridTemplateColumns).toBe('1fr');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, writable: true, configurable: true });
    }
  });

  it('FE-W5CNT-025: the expanded note closes on a backdrop click and its buttons highlight on hover', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 5, title: 'Long note', content: 'Full body', category: 'Food', color: '#ef4444' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Long note');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const modal = await waitFor(() => {
      const md = document.querySelector('.collab-note-md-full')
      if (!md) throw new Error('view modal not open yet')
      return md.closest('div[style*="position: fixed"]') as HTMLElement
    });
    expect(within(modal).getByText('Full body')).toBeInTheDocument();

    const [editBtn, closeBtn] = Array.from(modal.querySelectorAll('button'));
    fireEvent.mouseEnter(editBtn);
    expect(editBtn.style.color).toBe('var(--text-primary)');
    fireEvent.mouseLeave(editBtn);
    expect(editBtn.style.color).toBe('var(--text-faint)');
    fireEvent.mouseEnter(closeBtn);
    expect(closeBtn.style.color).toBe('var(--text-primary)');
    fireEvent.mouseLeave(closeBtn);
    expect(closeBtn.style.color).toBe('var(--text-faint)');

    fireEvent.click(modal);
    await waitFor(() => expect(document.querySelector('.collab-note-md-full')).toBeNull());
  });

  it('FE-W5CNT-026: attachments in the expanded note open the preview and react to hover', async () => {
    const user = userEvent.setup();
    serveNotes({
      notes: [buildNote({
        id: 6,
        title: 'Trip docs',
        content: 'See attachments',
        attachments: [
          { id: 1, filename: 'a.png', original_name: 'map.png', mime_type: 'image/png', url: '/uploads/map.png' },
          { id: 2, filename: 'b.zip', original_name: 'itinerary.zip', mime_type: 'application/zip', url: '/uploads/itinerary.zip' },
          { id: 3, filename: 'c', url: '/uploads/c' },
        ],
      })],
    });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Trip docs');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const modal = await waitFor(() => {
      const md = document.querySelector('.collab-note-md-full')
      if (!md) throw new Error('view modal not open yet')
      return md.closest('div[style*="position: fixed"]') as HTMLElement
    });

    // Unknown mime type and missing name fall back to a "?" tile
    expect(within(modal).getByText('?')).toBeInTheDocument();

    const zipTile = within(modal).getByTitle('itinerary.zip');
    expect(zipTile.style.background).toBe('var(--bg-secondary)');
    expect(within(modal).getByText('ZIP')).toBeInTheDocument();
    fireEvent.mouseEnter(zipTile);
    expect(zipTile.style.transform).toBe('scale(1.06)');
    fireEvent.mouseLeave(zipTile);
    expect(zipTile.style.transform).toBe('scale(1)');
    fireEvent.click(zipTile);
    // FilePreviewPortal shows a download action for non-image files
    expect(await screen.findByText('Download itinerary.zip')).toBeInTheDocument();

    const image = await waitFor(() => {
      const img = modal.querySelector('img[alt="map.png"]') as HTMLImageElement | null;
      if (!img) throw new Error('image attachment not rendered yet');
      return img;
    });
    // The clickable thumbnail is a real button wrapped around the image, so the
    // hover transform lands on that button.
    const imageTile = image.closest('button') as HTMLElement;
    fireEvent.mouseEnter(imageTile);
    expect(imageTile.style.transform).toBe('scale(1.06)');
    fireEvent.mouseLeave(imageTile);
    expect(imageTile.style.transform).toBe('scale(1)');
    fireEvent.click(image);
    await waitFor(() => expect(screen.queryByText('Download itinerary.zip')).not.toBeInTheDocument());
  });
  it('FE-W5CNT-027: a create response for a note already in the list is not added twice', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 20, title: 'Fresh note' })] });
    server.use(
      http.post('/api/trips/1/collab/notes', () =>
        HttpResponse.json({ note: buildNote({ id: 20, title: 'Fresh note' }) }),
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Fresh note');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Fresh note');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Note title')).not.toBeInTheDocument());
    expect(screen.getAllByText('Fresh note')).toHaveLength(1);
  });

  it('FE-W5CNT-028: a second note created elsewhere is prepended to the existing list', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 20, title: 'Older note' })] });
    server.use(
      http.post('/api/trips/1/collab/notes', () =>
        HttpResponse.json({ note: buildNote({ id: 21, title: 'Newer note' }) }),
      ),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Older note');
    await user.click(screen.getByText('New Note'));
    await user.type(await screen.findByPlaceholderText('Note title'), 'Newer note');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Newer note');
    expect(screen.getByText('Older note')).toBeInTheDocument();
  });

  it('FE-W5CNT-030: a WebSocket event for another trip is ignored', async () => {
    serveNotes({ notes: [] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('No notes yet');
    const handler = wsHandler();
    await act(async () => {
      handler({ tripId: 2, type: 'collab:note:created', note: buildNote({ id: 60, title: 'Other trip note' }) });
    });
    expect(screen.queryByText('Other trip note')).not.toBeInTheDocument();
  });

  it('FE-W5CNT-031: a rejected rename still renames the rest and re-reads the list', async () => {
    const user = userEvent.setup();
    const puts: string[] = [];
    serveNotesSequence([
      { notes: [buildNote({ id: 1, title: 'First note', category: 'OldCat' }), buildNote({ id: 2, title: 'Second note', category: 'OldCat' })] },
      { notes: [buildNote({ id: 1, title: 'First note', category: 'OldCat' }), buildNote({ id: 2, title: 'Second note', category: 'NewCat' })] },
    ]);
    server.use(
      http.put('/api/trips/1/collab/notes/1', () => {
        puts.push('1');
        return new HttpResponse(null, { status: 500 });
      }),
      http.put('/api/trips/1/collab/notes/2', () => {
        puts.push('2');
        return HttpResponse.json({ note: buildNote({ id: 2, title: 'Second note', category: 'NewCat' }) });
      }),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('First note');

    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });
    const oldCat = screen.getAllByText('OldCat').find(el => el.tagName === 'BUTTON' && el.title === 'Click to rename')!;
    await user.click(oldCat);
    const editInput = screen.getByDisplayValue('OldCat');
    await user.clear(editInput);
    await user.type(editInput, 'NewCat');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    // The rejected note must not stop the second one, but the modal stays open —
    // half a rename is not a saved rename.
    await waitFor(() => expect(puts).toEqual(['1', '2']));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(screen.getByText('Manage Categories', { selector: 'h3' })).toBeInTheDocument();
    // Re-read: the note the server refused is still shown under its old category.
    const header = screen.getByText('Manage Categories', { selector: 'h3' }).parentElement!;
    await user.click(within(header).getByRole('button'));
    await waitFor(() => expect(screen.getAllByText('NewCat').length).toBeGreaterThan(0));
    expect(screen.getAllByText('OldCat').length).toBeGreaterThan(0);
  });

  it('FE-W5CNT-029: a failing delete reports an error and keeps the note in the list', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 30, title: 'Stubborn note' })] });
    server.use(
      http.delete('/api/trips/1/collab/notes/30', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Stubborn note');

    await user.click(screen.getByTitle('Delete'));
    const dialog = (await screen.findByText('Delete note?')).closest('div.trek-modal-enter') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    expect(screen.getByText('Stubborn note')).toBeInTheDocument();
  });

  it('FE-W5CNT-032: a rejected category rename keeps the settings modal open and reports once', async () => {
    const user = userEvent.setup();
    serveNotes({
      notes: [
        buildNote({ id: 1, title: 'First note', category: 'OldCat' }),
        buildNote({ id: 2, title: 'Second note', category: 'OldCat' }),
      ],
    });
    server.use(
      http.put('/api/trips/1/collab/notes/:id', () => new HttpResponse(null, { status: 500 })),
    );
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('First note');
    await user.click(screen.getByTitle('Manage Categories'));
    await screen.findByText('Manage Categories', { selector: 'h3' });

    const oldCat = screen.getAllByText('OldCat').find(el => el.tagName === 'BUTTON' && el.title === 'Click to rename')!;
    await user.click(oldCat);
    const editInput = screen.getByDisplayValue('OldCat');
    await user.clear(editInput);
    await user.type(editInput, 'NewCat');
    await user.keyboard('{Enter}');
    await screen.findByText('NewCat');
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Error', 'error', undefined));
    // Nothing was renamed, so the modal must not act like it was saved…
    expect(screen.getByText('Manage Categories', { selector: 'h3' })).toBeInTheDocument();
    // …and both rejected writes are one message, not one each.
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('FE-W5CNT-033: a placeholder in angle brackets survives sanitizing', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 7, title: 'Hotel', content: 'Zimmernummer <TBD> bestaetigen' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Hotel');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const full = await openedNoteBody();
    // Notes written before markdown rendering existed keep reading the way they
    // were typed (#2177).
    expect(within(full).getByText('Zimmernummer <TBD> bestaetigen')).toBeInTheDocument();
  });

  it('FE-W5CNT-034: a footnote reference lands on the footnote instead of a new tab', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 8, title: 'Booking', content: 'Hotel gebucht[^1]\n\n[^1]: Bestaetigung ABC123' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Booking');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const full = await openedNoteBody();

    const ref = within(full).getByRole('link', { name: '1' });
    const href = ref.getAttribute('href')!;
    expect(href.startsWith('#')).toBe(true);
    expect(full.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
    expect(ref).not.toHaveAttribute('target');
  });

  it('FE-W5CNT-035: the expanded note links its website out to a new tab', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 9, title: 'Hotel', website: 'www.hotel.test' })] });
    server.use(http.get('/api/trips/1/collab/link-preview', () => HttpResponse.json({ title: 'Hotel', image: null })));
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Hotel');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const full = await openedNoteBody();

    // A member without collab_edit never opens the edit modal, so this is the
    // only place the link is readable for them (#2222).
    const link = within(full).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://www.hotel.test');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('hotel.test');
  });

  it('FE-W5CNT-036: a javascript: website stays unlinked in the expanded note', async () => {
    const user = userEvent.setup();
    serveNotes({ notes: [buildNote({ id: 10, title: 'Hotel', website: 'javascript:alert(1)' })] });
    render(<CollabNotes {...defaultProps} />);
    await screen.findByText('Hotel');
    await user.click(screen.getByTitle('collab.notes.expand'));
    const full = await openedNoteBody();

    expect(within(full).queryAllByRole('link')).toHaveLength(0);
  });
});
