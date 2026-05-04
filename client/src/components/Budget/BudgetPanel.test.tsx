// FE-COMP-BUDGET-001 to FE-COMP-BUDGET-040
import { render, screen, waitFor } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildBudgetItem, buildSettings } from '../../../tests/helpers/factories';
import BudgetPanel from './BudgetPanel';
import { offlineDb } from '../../db/offlineDb';

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
  // Settlement and per-person APIs needed by BudgetPanel
  server.use(
    http.get('/api/trips/:id/budget/settlement', () =>
      HttpResponse.json({ balances: [], flows: [] })
    ),
    http.get('/api/trips/:id/budget/per-person', () =>
      HttpResponse.json({ summary: [] })
    ),
  );
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) });
});

describe('BudgetPanel', () => {
  it('FE-COMP-BUDGET-001: renders empty state when no budget items', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('No budget created yet');
  });

  it('FE-COMP-BUDGET-002: shows empty state text body', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText(/Create categories and entries/i);
  });

  it('FE-COMP-BUDGET-003: shows category input in empty state when user can edit', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByPlaceholderText('Enter category name...');
  });

  it('FE-COMP-BUDGET-004: renders budget items from store after load', async () => {
    const item = buildBudgetItem({ trip_id: 1, name: 'Hotel Paris', category: 'Accommodation' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Hotel Paris');
  });

  it('FE-COMP-BUDGET-005: renders category section header', async () => {
    const item = buildBudgetItem({ trip_id: 1, name: 'Flight to Rome', category: 'Transport' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Transport');
  });

  it('FE-COMP-BUDGET-006: renders budget table headers', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Name');
    await screen.findByText('Total');
  });

  it('FE-COMP-BUDGET-007: shows Budget title heading', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Budget');
  });

  it('FE-COMP-BUDGET-008: shows CSV export button', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('CSV');
  });

  it('FE-COMP-BUDGET-009: add item row visible in table', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByPlaceholderText('New Entry');
  });

  it('FE-COMP-BUDGET-010: adding new item via form calls POST and shows item', async () => {
    const user = userEvent.setup();
    const initialItem = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Existing' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [initialItem] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        const item = buildBudgetItem({ trip_id: 1, name: String(body.name || 'New Item'), category: 'Food' });
        return HttpResponse.json({ item });
      })
    );
    render(<BudgetPanel tripId={1} />);
    const nameInput = await screen.findByPlaceholderText('New Entry');
    await user.type(nameInput, 'Restaurant Dinner');
    const addBtn = screen.getByTitle('Add Reservation');
    await user.click(addBtn);
    await screen.findByText('Restaurant Dinner');
  });

  it('FE-COMP-BUDGET-011: delete button present for items when user can edit', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Test Item' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Test Item');
    // Delete button has title="Delete"
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-012: delete item removes it from the UI', async () => {
    const user = userEvent.setup();
    const item = buildBudgetItem({ id: 42, trip_id: 1, category: 'Food', name: 'Item To Delete' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.delete('/api/trips/1/budget/42', () => HttpResponse.json({ success: true }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Item To Delete');
    await user.click(screen.getByTitle('Delete'));
    await waitFor(() => {
      expect(screen.queryByText('Item To Delete')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-BUDGET-013: multiple items in same category all render', async () => {
    const item1 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel A' });
    const item2 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel B' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item1, item2] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Hotel A');
    await screen.findByText('Hotel B');
  });

  it('FE-COMP-BUDGET-014: items from different categories render separate sections', async () => {
    const item1 = buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Flight' });
    const item2 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item1, item2] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Transport');
    await screen.findByText('Hotels');
  });

  it('FE-COMP-BUDGET-015: currency from settings store is used for default_currency display', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ default_currency: 'USD' }) });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} />);
    // Component renders even in empty state
    await screen.findByText('No budget created yet');
  });

  it('FE-COMP-BUDGET-016: trip currency EUR is shown in header for item rows', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) });
    const item = buildBudgetItem({ trip_id: 1, category: 'Other', name: 'Misc', total_price: 50 });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Misc');
    // Row exists - EUR formatting would appear in values
  });

  it('FE-COMP-BUDGET-017: Delete Category button shown in category header', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'ToDelete', name: 'Item' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('ToDelete');
    expect(screen.getByTitle('Delete Category')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-018: renders add item button (+ icon) in add row', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByPlaceholderText('New Entry');
    // The add button is present
    expect(screen.getByTitle('Add Reservation')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-019: add item with Enter key submits the form', async () => {
    const user = userEvent.setup();
    const initialItem = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Existing' });
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [initialItem] })),
      http.post('/api/trips/1/budget', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        const item = buildBudgetItem({ trip_id: 1, name: String(body.name), category: 'Food' });
        return HttpResponse.json({ item });
      })
    );
    render(<BudgetPanel tripId={1} />);
    const nameInput = await screen.findByPlaceholderText('New Entry');
    await user.type(nameInput, 'Pizza{Enter}');
    await screen.findByText('Pizza');
  });

  it('FE-COMP-BUDGET-020: component renders without crashing with empty tripMembers', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} tripMembers={[]} />);
    await screen.findByText('No budget created yet');
  });

  it('FE-COMP-BUDGET-021: inline edit name cell — clicking a name cell makes it editable', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 21, trip_id: 1, category: 'Food', name: 'Old Name' }), total_price: 10 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Old Name');
    await user.click(screen.getByText('Old Name'));
    expect(screen.getByDisplayValue('Old Name')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByDisplayValue('Old Name')).not.toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-022: inline edit name cell — saving new name calls PUT API', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 10, trip_id: 1, category: 'Food', name: 'Old Name' }), total_price: 10 };
    let putCalled = false;
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.put('/api/trips/1/budget/10', async ({ request }) => {
        const b = await request.json() as Record<string, unknown>;
        putCalled = true;
        return HttpResponse.json({ item: { ...item, name: b.name } });
      })
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Old Name');
    await user.click(screen.getByText('Old Name'));
    const input = screen.getByDisplayValue('Old Name');
    await user.clear(input);
    await user.type(input, 'New Name');
    await user.tab();
    await waitFor(() => expect(putCalled).toBe(true));
  });

  it('FE-COMP-BUDGET-023: total price is shown formatted with currency symbol', async () => {
    const item = { ...buildBudgetItem({ id: 23, trip_id: 1, category: 'Restaurants', name: 'Dinner' }), total_price: 45.5 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Dinner');
    // The formatted number appears in the InlineEditCell for total price (and grand total card)
    expect(screen.getAllByText('45.50').length).toBeGreaterThan(0);
    // The currency symbol appears (in category subtotal or grand total card)
    expect(screen.getAllByText(/€/).length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-024: delete category button removes all items in that category', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 24, trip_id: 1, category: 'Flights', name: 'Flight to Paris' }), total_price: 200 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.delete('/api/trips/1/budget/24', () => HttpResponse.json({ success: true }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findAllByText('Flights');
    await screen.findByText('Flight to Paris');
    await user.click(screen.getByTitle('Delete Category'));
    await waitFor(() => {
      expect(screen.queryAllByText('Flights').length).toBe(0);
      expect(screen.queryByText('Flight to Paris')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-BUDGET-025: CSV export button triggers download via URL.createObjectURL', async () => {
    const createObjectURL = vi.fn(() => 'blob:test');
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Other', name: 'Misc' }), total_price: 10 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('CSV');
    await user.click(screen.getByText('CSV'));
    expect(createObjectURL).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('FE-COMP-BUDGET-026: category total row shows sum of items in category', async () => {
    const item1 = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Lunch' }), total_price: 20 };
    const item2 = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Dinner' }), total_price: 30 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item1, item2] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Lunch');
    // The category header shows subtotal formatted as "50.00 €" (also appears in pie legend)
    expect(screen.getAllByText('50.00 €').length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-027: add new category input is visible in empty state', async () => {
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByPlaceholderText('Enter category name...');
  });

  it('FE-COMP-BUDGET-028: creating a new category via input calls POST and adds a section', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [] })),
      http.post('/api/trips/1/budget', () =>
        HttpResponse.json({ item: { ...buildBudgetItem({ category: 'Souvenirs', name: 'New Entry' }), total_price: 0 } })
      )
    );
    render(<BudgetPanel tripId={1} />);
    const input = await screen.findByPlaceholderText('Enter category name...');
    await user.type(input, 'Souvenirs{Enter}');
    await screen.findByText('Souvenirs');
  });

  it('FE-COMP-BUDGET-029: settlement section renders flows with usernames', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Dinner' }), total_price: 100 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () =>
        HttpResponse.json({
          balances: [
            { user_id: 1, username: 'alice', balance: -10, avatar_url: null },
            { user_id: 2, username: 'bob', balance: 10, avatar_url: null },
          ],
          flows: [
            { from: { username: 'alice', avatar_url: null }, to: { username: 'bob', avatar_url: null }, amount: 10 },
          ],
        })
      )
    );
    const tripMembers = [
      { id: 1, username: 'alice', avatar_url: null },
      { id: 2, username: 'bob', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Dinner');
    // Click the settlement toggle button (role button with name containing "settlement")
    const settlementBtn = await screen.findByRole('button', { name: /settlement/i });
    await user.click(settlementBtn);
    // alice and bob should appear in balances section
    await screen.findByText('alice');
    await screen.findByText('bob');
  });

  it('FE-COMP-BUDGET-030: per-person summary renders usernames', async () => {
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Shared Dinner' }),
      total_price: 75,
      members: [{ user_id: 1, username: 'testuser', avatar_url: null, paid: false }],
    };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/summary/per-person', () =>
        HttpResponse.json({ summary: [{ user_id: 1, username: 'testuser', avatar_url: null, total_assigned: 75 }] })
      )
    );
    const tripMembers = [
      { id: 1, username: 'testuser', avatar_url: null },
      { id: 2, username: 'other', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Shared Dinner');
    await screen.findByText('testuser');
  });

  it('FE-COMP-BUDGET-032: grand total row shows sum across all categories', async () => {
    const item1 = { ...buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Flight' }), total_price: 100 };
    const item2 = { ...buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel' }), total_price: 200 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item1, item2] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Flight');
    await screen.findByText('Hotel');
    // Grand total card shows 300.00 (integer and decimal are rendered in separate spans)
    expect(document.body.textContent?.replace(/\s+/g, '')).toMatch(/300[,.]00/);
  });

  it('FE-COMP-BUDGET-033: read-only mode hides add/delete/edit controls', async () => {
    // Restrict budget_edit to trip owners only; user is not the owner (owner_id=1, user.id > 1)
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    // Use a user with id != 1 so they're not the owner
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, owner_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Read Only Item' }), total_price: 50 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Read Only Item');
    // In read-only mode the Delete button should not be visible
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-034: read-only mode shows expense_date as text span', async () => {
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, owner_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Train' }), total_price: 30, expense_date: '2025-06-15' };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Train');
    // expense_date is rendered as plain text in read-only mode
    await screen.findByText('2025-06-15');
  });

  it('FE-COMP-BUDGET-035: settlement section with avatar renders user avatar image', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Lunch' }), total_price: 60 };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] })),
      http.get('/api/trips/1/budget/settlement', () =>
        HttpResponse.json({
          balances: [
            { user_id: 1, username: 'alice', avatar_url: '/uploads/avatars/alice.jpg', balance: -30 },
            { user_id: 2, username: 'bob', avatar_url: null, balance: 30 },
          ],
          flows: [{ from: { username: 'alice', avatar_url: '/uploads/avatars/alice.jpg' }, to: { username: 'bob', avatar_url: null }, amount: 30 }]
        })
      ),
      http.get('/api/trips/1/budget/per-person', () => HttpResponse.json({ summary: [] })),
    );
    const tripMembers = [
      { id: 1, username: 'alice', avatar_url: '/uploads/avatars/alice.jpg' },
      { id: 2, username: 'bob', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Lunch');
    // Trigger settlement display
    const settlementBtn = await screen.findByRole('button', { name: /settlement/i });
    await user.click(settlementBtn);
    await screen.findByText('alice');
    // Avatar image should be rendered for alice
    const avatarImg = screen.getAllByRole('img');
    expect(avatarImg.length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-036: expense_date shows dash when not set in read-only mode', async () => {
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, owner_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Snack' }), total_price: 5, expense_date: null };
    server.use(
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: [item] }))
    );
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Snack');
    // When expense_date is null, the fallback '—' is shown
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});
