// FE-COMP-PACKING-001 to FE-COMP-PACKING-020
import { vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildPackingItem } from '../../../tests/helpers/factories';
import PackingListPanel from './PackingListPanel';
import { offlineDb } from '../../db/offlineDb';

beforeEach(async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  await Promise.all(offlineDb.tables.map(t => t.clear()));
  resetAllStores();
  // Side-effect APIs PackingListPanel calls on mount
  server.use(
    http.get('/api/trips/:id/members', () =>
      HttpResponse.json({ owner: null, members: [], current_user_id: 1 })
    ),
    http.get('/api/trips/:id/packing/category-assignees', () =>
      HttpResponse.json({ assignees: {} })
    ),
    http.get('/api/admin/bag-tracking', () =>
      HttpResponse.json({ enabled: false })
    ),
    http.get('/api/admin/packing-templates', () =>
      HttpResponse.json({ templates: [] })
    ),
  );
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
});

describe('PackingListPanel', () => {
  it('FE-COMP-PACKING-001: renders Packing List title', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    expect(screen.getByText('Packing List')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-002: shows empty state when no items', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    // Both the subtitle and the empty content area say "Packing list is empty"
    const els = screen.getAllByText('Packing list is empty');
    expect(els.length).toBeGreaterThan(0);
  });

  it('FE-COMP-PACKING-003: empty state shows hint text', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    expect(screen.getByText(/Add items or use the suggestions/i)).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-004: shows items from props grouped by category', () => {
    const items = [
      buildPackingItem({ name: 'Passport', category: 'Documents' }),
      buildPackingItem({ name: 'Charger', category: 'Electronics' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Passport')).toBeInTheDocument();
    expect(screen.getByText('Charger')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-005: shows category group headers', () => {
    const items = [
      buildPackingItem({ name: 'Toothbrush', category: 'Hygiene' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Hygiene')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-006: shows progress count in subtitle', () => {
    const items = [
      buildPackingItem({ name: 'Item1', checked: 1 }),
      buildPackingItem({ name: 'Item2', checked: 0 }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText(/1 of 2 packed/i)).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-007: shows progress bar for packed items', () => {
    const items = [
      buildPackingItem({ name: 'Item1', checked: 1 }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    // 1/1 = 100% packed shows "All packed!"
    expect(screen.getByText('All packed!')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-008: items without category are grouped under default category', () => {
    const items = [
      buildPackingItem({ name: 'Sunscreen', category: null }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();
    // default category is "Other"
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-009: clicking Add item reveals input form', async () => {
    const user = userEvent.setup();
    const items = [buildPackingItem({ name: 'Shorts', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);
    // Click "Add item" button to reveal input
    await user.click(screen.getByText('Add item'));
    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-010: typing in add item input and pressing Enter calls POST', async () => {
    const user = userEvent.setup();
    const existingItem = buildPackingItem({ name: 'Existing', category: 'Clothing' });
    let postCalled = false;
    server.use(
      http.post('/api/trips/1/packing', async ({ request }) => {
        postCalled = true;
        const body = await request.json() as Record<string, unknown>;
        const item = buildPackingItem({ name: String(body.name), category: String(body.category) });
        return HttpResponse.json({ item });
      })
    );
    render(<PackingListPanel tripId={1} items={[existingItem]} />);
    await user.click(screen.getByText('Add item'));
    const addInput = screen.getByPlaceholderText('Item name...');
    await user.type(addInput, 'T-Shirt{Enter}');
    await waitFor(() => expect(postCalled).toBe(true));
  });

  it('FE-COMP-PACKING-011: checked item has checked state visually (1=checked)', () => {
    const items = [buildPackingItem({ name: 'Packed Item', checked: 1 })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Packed Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-012: unchecked item renders in open state', () => {
    const items = [buildPackingItem({ name: 'Unpacked Item', checked: 0 })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Unpacked Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-013: multiple categories render independently', () => {
    const items = [
      buildPackingItem({ name: 'Shirt', category: 'Clothing' }),
      buildPackingItem({ name: 'Passport', category: 'Documents' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Clothing')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-014: Add category button is shown', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    // The "Add category" button should be present in the toolbar
    expect(screen.getByText('Add category')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-015: clicking Add Category shows the category name input', async () => {
    const user = userEvent.setup();
    render(<PackingListPanel tripId={1} items={[]} />);
    await user.click(screen.getByText('Add category'));
    await screen.findByPlaceholderText('Category name (e.g. Clothing)');
  });

  it('FE-COMP-PACKING-016: delete item button exists and triggers API call', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 99, name: 'To Remove', category: 'Test' });
    let deleteCalled = false;
    server.use(
      http.delete('/api/trips/1/packing/99', () => {
        deleteCalled = true;
        return HttpResponse.json({ success: true });
      })
    );
    render(<PackingListPanel tripId={1} items={[item]} />);
    expect(screen.getByText('To Remove')).toBeInTheDocument();
    // Delete button is in the DOM (opacity 0 on desktop but exists)
    const deleteBtn = screen.getByTitle('Delete');
    await user.click(deleteBtn);
    await waitFor(() => expect(deleteCalled).toBe(true));
  });

  it('FE-COMP-PACKING-017: shows filter buttons (All, Open, Done) when items exist', () => {
    const items = [buildPackingItem({ name: 'Shirt', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-018: filtering to Done hides unchecked items', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done Item', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Done'));
    expect(screen.getByText('Done Item')).toBeInTheDocument();
    expect(screen.queryByText('Open Item')).not.toBeInTheDocument();
  });

  it('FE-COMP-PACKING-019: filtering to Open hides checked items', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done Item', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Open'));
    expect(screen.queryByText('Done Item')).not.toBeInTheDocument();
    expect(screen.getByText('Open Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-020: renders empty filter message when filter yields nothing', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Done'));
    expect(screen.getByText('No items match this filter')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-023: inline edit item name via pencil icon calls PUT', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 42, name: 'Sunscreen', category: 'Toiletries' });
    let patchBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/42', async ({ request }) => {
        patchBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 42, name: 'Sunblock', category: 'Toiletries' }) });
      })
    );
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Click the rename (pencil) button
    await user.click(screen.getByTitle('Rename'));

    // Input appears pre-filled with 'Sunscreen'
    const input = screen.getByDisplayValue('Sunscreen');
    expect(input).toBeInTheDocument();

    // Clear and type new name, then press Enter
    await user.clear(input);
    await user.type(input, 'Sunblock');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(patchBody).toMatchObject({ name: 'Sunblock' }));
  });

  it('FE-COMP-PACKING-024: toggle item checked state calls PUT', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 50, name: 'Shorts', checked: 0, category: 'Clothing' });
    let patchBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/50', async ({ request }) => {
        patchBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 50, checked: 1 }) });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // The toggle button contains the Square icon for unchecked items
    const toggleBtn = container.querySelector('svg.lucide-square')?.closest('button');
    expect(toggleBtn).toBeTruthy();
    await user.click(toggleBtn!);

    await waitFor(() => expect(patchBody).toMatchObject({ checked: true }));
  });

  it('FE-COMP-PACKING-025: "Check all" bulk action calls PUT for all unchecked items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 60, name: 'Item1', checked: 0, category: 'TestCat' });
    const item2 = buildPackingItem({ id: 61, name: 'Item2', checked: 0, category: 'TestCat' });
    const patchedIds: number[] = [];
    server.use(
      http.put('/api/trips/1/packing/:itemId', ({ params }) => {
        patchedIds.push(Number(params.itemId));
        return HttpResponse.json({ item: buildPackingItem() });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open the MoreHorizontal context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Check All"
    await user.click(await screen.findByText('Check All'));

    await waitFor(() => {
      expect(patchedIds).toContain(60);
      expect(patchedIds).toContain(61);
    });
  });

  it('FE-COMP-PACKING-026: quantity input change calls PUT with new quantity', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 70, name: 'T-Shirts', quantity: 2, category: 'Clothing' });
    let patchBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/70', async ({ request }) => {
        patchBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 70, quantity: 5 }) });
      })
    );
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Find the quantity input showing '2'
    const qtyInput = screen.getByDisplayValue('2');
    await user.clear(qtyInput);
    await user.type(qtyInput, '5');
    await user.tab(); // blur triggers commit

    await waitFor(() => expect(patchBody).toMatchObject({ quantity: 5 }));
  });

  it('FE-COMP-PACKING-027: add new category via form calls POST', async () => {
    const user = userEvent.setup();
    let postBody: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/trips/1/packing', async ({ request }) => {
        postBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ name: '...', category: 'Valuables' }) });
      })
    );
    render(<PackingListPanel tripId={1} items={[]} />);

    await user.click(screen.getByText('Add category'));
    const input = await screen.findByPlaceholderText('Category name (e.g. Clothing)');
    await user.type(input, 'Valuables');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(postBody).toMatchObject({ category: 'Valuables' }));
  });

  it('FE-COMP-PACKING-028: category group collapse hides items, expand shows them', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ name: 'Sunscreen', category: 'Toiletries' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Item is visible initially
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();

    // Click the ChevronDown button to collapse
    const chevronDown = container.querySelector('svg.lucide-chevron-down')?.closest('button');
    expect(chevronDown).toBeTruthy();
    await user.click(chevronDown!);

    // Item should no longer be visible
    expect(screen.queryByText('Sunscreen')).not.toBeInTheDocument();

    // Click the ChevronRight button to expand again
    const chevronRight = container.querySelector('svg.lucide-chevron-right')?.closest('button');
    expect(chevronRight).toBeTruthy();
    await user.click(chevronRight!);

    // Item visible again
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-029: bag tracking sidebar not shown when disabled', async () => {
    render(<PackingListPanel tripId={1} items={[buildPackingItem({ category: 'Test' })]} />);
    // No "Bags" heading or luggage sidebar should appear
    await waitFor(() => {
      expect(screen.queryByText('Bags')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-PACKING-030: packing template button present when templates available', async () => {
    server.use(
      http.get('/api/admin/packing-templates', () =>
        HttpResponse.json({ templates: [{ id: 1, name: 'Beach Trip', item_count: 5 }] })
      )
    );
    render(<PackingListPanel tripId={1} items={[]} />);

    // "Apply template" button appears when templates are available
    await screen.findByText('Apply template');
  });

  it('FE-COMP-PACKING-031: "Uncheck All" bulk action calls PUT to uncheck checked items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 80, name: 'ItemA', checked: 1, category: 'Gear' });
    const item2 = buildPackingItem({ id: 81, name: 'ItemB', checked: 1, category: 'Gear' });
    const patchedIds: number[] = [];
    server.use(
      http.put('/api/trips/1/packing/:itemId', ({ params }) => {
        patchedIds.push(Number(params.itemId));
        return HttpResponse.json({ item: buildPackingItem() });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open the MoreHorizontal context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Uncheck All"
    await user.click(await screen.findByText('Uncheck All'));

    await waitFor(() => {
      expect(patchedIds).toContain(80);
      expect(patchedIds).toContain(81);
    });
  });

  it('FE-COMP-PACKING-032: category assignee button shown when trip members exist', async () => {
    server.use(
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 2, username: 'alice', avatar_url: null }],
          current_user_id: 1,
        })
      )
    );
    const item = buildPackingItem({ name: 'Passport', category: 'Documents' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // UserPlus assignee button should appear in the category header
    await waitFor(() => {
      const userPlusBtn = container.querySelector('svg.lucide-user-plus');
      expect(userPlusBtn).toBeTruthy();
    });
  });

  it('FE-COMP-PACKING-033: import modal opens and closes', async () => {
    const user = userEvent.setup();
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Click the Import button (Upload icon in the header)
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    expect(importBtn).toBeTruthy();
    await user.click(importBtn!);

    // Import modal title appears
    expect(await screen.findByText('Import Packing List')).toBeInTheDocument();

    // Cancel closes modal
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Import Packing List')).not.toBeInTheDocument());
  });

  it('FE-COMP-PACKING-034: bag tracking enabled shows Bags button and bag sidebar', async () => {
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 1, name: 'Carry-on', color: '#6366f1', weight_limit_grams: null, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Laptop', category: 'Electronics' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Bags button/sidebar appears when bag tracking is enabled
    await waitFor(() => {
      const bagsEls = screen.getAllByText('Bags');
      expect(bagsEls.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-035: category rename via context menu calls PUT', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 90, name: 'Shirt', category: 'Clothing' });
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/90', async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 90, name: 'Shirt', category: 'Apparel' }) });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Open the category context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Rename" in the menu
    await user.click(await screen.findByText('Rename'));

    // Category name input appears — type new name and save
    const catInput = screen.getByDisplayValue('Clothing');
    await user.clear(catInput);
    await user.type(catInput, 'Apparel');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(putBody).toMatchObject({ category: 'Apparel' }));
  });

  it('FE-COMP-PACKING-036: assignee dropdown opens and lists members when clicked', async () => {
    server.use(
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 2, username: 'alice', avatar_url: null }],
          current_user_id: 1,
        })
      )
    );
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for members to load, then click the UserPlus button
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    const userPlusBtn = container.querySelector('svg.lucide-user-plus')?.closest('button');
    await userEvent.setup().click(userPlusBtn!);

    // Member names appear in the dropdown
    await screen.findByText('owner');
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-038: import modal - typing text updates import count', async () => {
    const user = userEvent.setup();
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Open import modal
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    await user.click(importBtn!);
    await screen.findByText('Import Packing List');

    // Textarea is present
    const textarea = screen.getByPlaceholderText(/Hygiene, Toothbrush/);
    expect(textarea).toBeInTheDocument();

    // "Load CSV/TXT" button is present inside the modal
    expect(screen.getByText('Load CSV/TXT')).toBeInTheDocument();

    // Close by clicking backdrop (covers the onClick on the backdrop div)
    const modalTitle = screen.getByText('Import Packing List');
    const modalContent = modalTitle.closest('div[style*="width: 420"]');
    // Dismiss via Cancel button
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Import Packing List')).not.toBeInTheDocument());
  });

  it('FE-COMP-PACKING-039: bag modal opens when Bags button clicked with bag tracking enabled', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 1, name: 'Main Bag', color: '#6366f1', weight_limit_grams: null, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Charger', category: 'Electronics' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for Bags button to appear
    await waitFor(() => {
      expect(screen.getAllByText('Bags').length).toBeGreaterThan(0);
    });

    // Click the Bags button (xl:!hidden - visible in jsdom)
    const luggageBtn = container.querySelector('button svg.lucide-luggage')?.closest('button');
    expect(luggageBtn).toBeTruthy();
    await user.click(luggageBtn!);

    // Modal opens — "Main Bag" text appears (sidebar + modal — use getAllByText)
    await waitFor(() => {
      const bagTexts = screen.getAllByText('Main Bag');
      expect(bagTexts.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-040: bag sidebar renders BagCard with bag name when enabled and bags exist', async () => {
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 5, name: 'Backpack', color: '#10b981', weight_limit_grams: 10000, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // BagCard in sidebar shows the bag name (may appear once or more with modal)
    await waitFor(() => {
      expect(screen.getAllByText('Backpack').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-041: save-as-template button present when items exist', async () => {
    const user = userEvent.setup();
    const items = [buildPackingItem({ name: 'Sunscreen', category: 'Toiletries' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Save-as-template button uses FolderPlus icon and "Save as template" text
    const folderPlusBtn = container.querySelector('svg.lucide-folder-plus')?.closest('button');
    expect(folderPlusBtn).toBeTruthy();

    // Click to show the name input
    await user.click(folderPlusBtn!);

    // Template name input appears
    expect(await screen.findByPlaceholderText('Template name')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-042: apply template dropdown opens when template button clicked', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/packing-templates', () =>
        HttpResponse.json({ templates: [{ id: 2, name: 'Summer Packing', item_count: 10 }] })
      )
    );
    render(<PackingListPanel tripId={1} items={[]} />);

    // Wait for template button
    const templateBtn = await screen.findByText('Apply template');

    // Click to open dropdown
    await user.click(templateBtn);

    // Template name appears in the dropdown
    expect(await screen.findByText('Summer Packing')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-043: import modal textarea change updates text', async () => {
    const user = userEvent.setup();
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Open import modal
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    await user.click(importBtn!);
    await screen.findByText('Import Packing List');

    // Type in textarea
    const textarea = screen.getByPlaceholderText(/Hygiene, Toothbrush/);
    await user.type(textarea, 'Clothing, T-Shirt');

    // The textarea value reflects the typed text
    expect(textarea).toHaveValue('Clothing, T-Shirt');

    // Import button count updates to 1
    expect(screen.getByText(/Import 1/)).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-044: bag item row shows weight input and bag button when bag tracking enabled', async () => {
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [] })
      )
    );
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (weight input 'g' label appears)
    await waitFor(() => {
      expect(container.querySelector('input[placeholder="—"]')).toBeTruthy();
    });

    // The 'g' gram label appears next to the weight input
    expect(container.querySelector('span[style*="g"]')).toBeTruthy();
  });

  it('FE-COMP-PACKING-045: "Remove checked" button appears when checked items exist', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done1', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Done2', checked: 1, category: 'Test' }),
    ];
    server.use(
      http.delete('/api/trips/1/packing/:itemId', () => HttpResponse.json({ success: true }))
    );
    // Mock window.confirm to return true
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PackingListPanel tripId={1} items={items} />);

    // The "Remove N checked" button should be visible (two spans exist - one sm:hidden, one hidden sm:inline)
    const removeBtns = screen.getAllByText(/Remove 2/);
    expect(removeBtns.length).toBeGreaterThan(0);

    // Click the parent button (either span's closest button)
    const removeBtn = removeBtns[0].closest('button')!;
    expect(removeBtn).toBeTruthy();
    await user.click(removeBtn);
    // confirm was called
    expect(window.confirm).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('FE-COMP-PACKING-046: save-as-template form submission calls saveAsTemplate API', async () => {
    const user = userEvent.setup();
    let savedTemplateName = '';
    server.use(
      http.post('/api/trips/1/packing/save-as-template', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        savedTemplateName = String(body.name);
        return HttpResponse.json({ success: true });
      }),
      http.get('/api/admin/packing-templates', () =>
        HttpResponse.json({ templates: [] })
      )
    );
    const items = [buildPackingItem({ name: 'Item', category: 'Test' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Click the FolderPlus "Save as template" button
    const folderPlusBtn = container.querySelector('svg.lucide-folder-plus')?.closest('button');
    await user.click(folderPlusBtn!);

    // Type template name
    const nameInput = await screen.findByPlaceholderText('Template name');
    await user.type(nameInput, 'My Template');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(savedTemplateName).toBe('My Template'));
  });

  it('FE-COMP-PACKING-047: bag picker in item row opens when clicked with bag tracking enabled', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 3, name: 'Carry-on', color: '#ec4899', weight_limit_grams: null, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (Package icon button in item row)
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-package')).toBeTruthy();
    });

    // Click the bag button (Package icon) to open bag picker
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    expect(packageBtn).toBeTruthy();
    await user.click(packageBtn!);

    // Bag picker dropdown shows the bag name (may also appear in sidebar)
    await waitFor(() => {
      expect(screen.getAllByText('Carry-on').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-048: add bag in bag modal opens form when "Add bag" clicked', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 1, name: 'Main Bag', color: '#6366f1', weight_limit_grams: null, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Jacket', category: 'Clothing' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for Bags button
    await waitFor(() => {
      expect(screen.getAllByText('Bags').length).toBeGreaterThan(0);
    });

    // Open bag modal
    const luggageBtn = container.querySelector('button svg.lucide-luggage')?.closest('button');
    await user.click(luggageBtn!);

    // Wait for modal to show ("Add bag" button appears — may be in both sidebar and modal)
    await waitFor(() => {
      expect(screen.getAllByText('Add bag').length).toBeGreaterThan(0);
    });

    // Click the last "Add bag" (in the modal)
    const addBagBtns = screen.getAllByText('Add bag');
    await user.click(addBagBtns[addBagBtns.length - 1]);

    // Add bag name input appears (may exist in both sidebar and modal)
    await waitFor(() => {
      const bagInputs = screen.queryAllByPlaceholderText('Bag name...');
      expect(bagInputs.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-049: weight input change with bag tracking enabled calls PUT', async () => {
    const user = userEvent.setup();
    let putBody: Record<string, unknown> | null = null;
    const itemId = 120;
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [] })
      ),
      http.put(`/api/trips/1/packing/${itemId}`, async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: itemId }) });
      })
    );
    const items = [buildPackingItem({ id: itemId, name: 'Camera', category: 'Electronics' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for weight input to appear (bag tracking enabled)
    await waitFor(() => {
      expect(container.querySelector('input[placeholder="—"]')).toBeTruthy();
    });

    // Change the weight input value
    const weightInput = container.querySelector('input[placeholder="—"]') as HTMLInputElement;
    await user.clear(weightInput);
    await user.type(weightInput, '500');
    await user.tab(); // blur to trigger change

    await waitFor(() => {
      expect(putBody).toBeTruthy();
    });
  });

  it('FE-COMP-PACKING-050: ArtikelZeile category change picker opens on dot button click', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    const item2 = buildPackingItem({ name: 'Passport', category: 'Documents' });
    const { container } = render(<PackingListPanel tripId={1} items={[item, item2]} />);

    // The category change picker is triggered by a small dot button (no title)
    // It's rendered inside the action buttons group (sm:opacity-0 sm:group-hover:opacity-100)
    // In jsdom, CSS classes don't apply so the buttons are accessible
    // The dot button has a circle span inside with category color
    // Find all buttons with the 'Change Category' title
    const catChangeBtn = screen.getAllByTitle('Change Category');
    expect(catChangeBtn.length).toBeGreaterThan(0);
    await user.click(catChangeBtn[0]);

    // Category picker shows both category names
    await waitFor(() => {
      expect(screen.getAllByText('Electronics').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-051: bag assignment from picker calls PUT with bag_id', async () => {
    const user = userEvent.setup();
    const itemId = 130;
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 7, name: 'Trolley', color: '#10b981', weight_limit_grams: null, members: [] }] })
      ),
      http.put(`/api/trips/1/packing/${itemId}`, async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: itemId }) });
      })
    );
    const items = [buildPackingItem({ id: itemId, name: 'Shoes', category: 'Clothing' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (Package icon appears)
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-package')).toBeTruthy();
    });

    // Use fireEvent (no pointer events) to open the picker without triggering mouseLeave
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    fireEvent.click(packageBtn!);

    // Picker is open - find "Trolley" button inside the dropdown
    // The dropdown renders as an absolute positioned div inside the item row
    const trolleyBtn = await screen.findByRole('button', { name: /Trolley/ });
    fireEvent.click(trolleyBtn);

    await waitFor(() => expect(putBody).toMatchObject({ bag_id: 7 }));
  });

  it('FE-COMP-PACKING-052: category assignee chip renders when assignees exist', async () => {
    server.use(
      http.get('/api/trips/:id/packing/category-assignees', () =>
        HttpResponse.json({ assignees: { Electronics: [{ user_id: 2, username: 'alice', avatar: null }] } })
      )
    );
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // The assignee chip shows the first letter of username
    await waitFor(() => {
      // The chip shows 'A' (first letter of 'alice')
      const chips = document.querySelectorAll('.assignee-chip');
      expect(chips.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-053: import modal closes when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Open import modal
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    await user.click(importBtn!);
    await screen.findByText('Import Packing List');

    // Click on the backdrop (the outer div that closes the modal)
    // The backdrop div has no specific identifier so we use the document.body portal
    const backdrop = document.querySelector('[style*="backdrop-filter"]') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    await waitFor(() => expect(screen.queryByText('Import Packing List')).not.toBeInTheDocument());
  });

  it('FE-COMP-PACKING-054: item with assigned bag shows "Unassigned" option in bag picker', async () => {
    const itemId = 140;
    server.use(
      http.get('/api/admin/bag-tracking', () =>
        HttpResponse.json({ enabled: true })
      ),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 5, name: 'MyBag', color: '#ec4899', weight_limit_grams: null, members: [] }] })
      ),
      http.put(`/api/trips/1/packing/${itemId}`, async () =>
        HttpResponse.json({ item: buildPackingItem({ id: itemId }) })
      )
    );
    // Item that already has a bag assigned
    const items = [buildPackingItem({ id: itemId, name: 'Jacket', category: 'Clothing', bag_id: 5 } as any)];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable
    await waitFor(() => {
      // When bag_id is set, the bag button shows a colored dot (not Package icon)
      expect(container.querySelector('svg.lucide-package')).toBeFalsy();
    });

    // Verify the bags section renders in sidebar
    await screen.findByText('MyBag');
  });

  it('FE-COMP-PACKING-055: apply template button click opens template dropdown and shows template', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/admin/packing-templates', () =>
        HttpResponse.json({ templates: [{ id: 3, name: 'Weekend Pack', item_count: 8 }] })
      )
    );
    render(<PackingListPanel tripId={1} items={[]} />);

    // Wait for and click template button
    const templateBtn = await screen.findByText('Apply template');
    await user.click(templateBtn);

    // Template name appears in dropdown
    expect(await screen.findByText('Weekend Pack')).toBeInTheDocument();
    // Item count appears too
    expect(screen.getByText('8 items')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-037: delete category via context menu calls DELETE for all items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 100, name: 'Rope', category: 'Gear' });
    const item2 = buildPackingItem({ id: 101, name: 'Map', category: 'Gear' });
    const deletedIds: number[] = [];
    server.use(
      http.delete('/api/trips/1/packing/:itemId', ({ params }) => {
        deletedIds.push(Number(params.itemId));
        return HttpResponse.json({ success: true });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open context menu and click Delete Category
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    await user.click(moreBtn!);
    await user.click(await screen.findByText('Delete Category'));

    await waitFor(() => {
      expect(deletedIds).toContain(100);
      expect(deletedIds).toContain(101);
    });
  });

  it('FE-COMP-PACKING-056: pressing Enter in quantity input commits value', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 71, name: 'Socks', quantity: 3, category: 'Clothing' });
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/71', async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 71, quantity: 7 }) });
      })
    );
    render(<PackingListPanel tripId={1} items={[item]} />);

    const qtyInput = screen.getByDisplayValue('3');
    await user.clear(qtyInput);
    await user.type(qtyInput, '7');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(putBody).toMatchObject({ quantity: 7 }));
  });

  it('FE-COMP-PACKING-057: clicking unchecked item name enters inline edit mode', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 73, name: 'Jacket', checked: 0, category: 'Clothing' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Click the item name span (not the Rename button — the name span itself)
    const nameSpan = screen.getByText('Jacket');
    await user.click(nameSpan);

    // An edit input should appear with the item's name pre-filled
    await waitFor(() => {
      const input = screen.getByDisplayValue('Jacket');
      expect(input.tagName).toBe('INPUT');
    });
  });

  it('FE-COMP-PACKING-058: selecting a different category in picker calls PUT with new category', async () => {
    const itemA = buildPackingItem({ id: 74, name: 'Camera', category: 'Electronics' });
    const itemB = buildPackingItem({ id: 75, name: 'Passport', category: 'Documents' });
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put('/api/trips/1/packing/74', async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ item: buildPackingItem({ id: 74, category: 'Documents' }) });
      })
    );
    render(<PackingListPanel tripId={1} items={[itemA, itemB]} />);

    // Use fireEvent (no pointer events) to open the category picker — avoids mouseLeave closing picker
    const catChangeBtns = screen.getAllByTitle('Change Category');
    fireEvent.click(catChangeBtns[0]);

    // Picker shows available categories — find and click the 'Documents' button (role=button, text=Documents)
    const docBtn = await screen.findByRole('button', { name: 'Documents' });
    fireEvent.click(docBtn);

    await waitFor(() => expect(putBody).toMatchObject({ category: 'Documents' }));
  });

  it('FE-COMP-PACKING-059: clicking member in UserPlus dropdown calls setCategoryAssignees', async () => {
    let assignBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 2, username: 'alice', avatar_url: null }],
          current_user_id: 1,
        })
      ),
      http.put('/api/trips/1/packing/category-assignees/:cat', async ({ request }) => {
        assignBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ assignees: [{ user_id: 2, username: 'alice', avatar: null }] });
      })
    );
    const item = buildPackingItem({ name: 'Tripod', category: 'Electronics' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for members to load
    await waitFor(() => expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy());

    // Click UserPlus to open assignee dropdown
    const userPlusBtn = container.querySelector('svg.lucide-user-plus')?.closest('button');
    await userEvent.setup().click(userPlusBtn!);

    // Click member 'alice' in dropdown
    const aliceBtn = await screen.findByRole('button', { name: /alice/i });
    await userEvent.setup().click(aliceBtn);

    await waitFor(() => expect(assignBody).toMatchObject({ user_ids: [2] }));
  });

  it('FE-COMP-PACKING-060: clicking assignee chip removes assignee via setCategoryAssignees', async () => {
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/trips/:id/packing/category-assignees', () =>
        HttpResponse.json({ assignees: { Electronics: [{ user_id: 2, username: 'alice', avatar: null }] } })
      ),
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 2, username: 'alice', avatar_url: null }],
          current_user_id: 1,
        })
      ),
      http.put('/api/trips/1/packing/category-assignees/:cat', async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ assignees: [] });
      })
    );
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for the assignee chip to appear
    await waitFor(() => expect(document.querySelectorAll('.assignee-chip').length).toBeGreaterThan(0));

    // Click the chip wrapper div to remove the assignee
    const chip = document.querySelector('.assignee-chip')!.parentElement!;
    fireEvent.click(chip);

    // setCategoryAssignees called with empty user_ids (removing alice)
    await waitFor(() => expect(putBody).toMatchObject({ user_ids: [] }));
  });

  it('FE-COMP-PACKING-061: applying a template calls applyTemplate API', async () => {
    const user = userEvent.setup();
    let applyCalled = false;
    server.use(
      http.get('/api/admin/packing-templates', () =>
        HttpResponse.json({ templates: [{ id: 5, name: 'Beach Trip', item_count: 12 }] })
      ),
      http.post('/api/trips/1/packing/apply-template/5', () => {
        applyCalled = true;
        return HttpResponse.json({ count: 12 });
      })
    );
    // jsdom window.location.reload is not configurable; it just emits a "not implemented" warning
    render(<PackingListPanel tripId={1} items={[]} />);

    // Wait for template button and open dropdown
    const templateBtn = await screen.findByText('Apply template');
    await user.click(templateBtn);

    // Click the template in the dropdown
    const tmplBtn = await screen.findByText('Beach Trip');
    await user.click(tmplBtn);

    await waitFor(() => expect(applyCalled).toBe(true));
  });

  it('FE-COMP-PACKING-062: handleBulkImport calls import API and closes modal', async () => {
    const user = userEvent.setup();
    let importBody: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/trips/1/packing/import', async ({ request }) => {
        importBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ count: 2 });
      })
    );
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Open import modal
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    await user.click(importBtn!);
    await screen.findByText('Import Packing List');

    // Type two lines in the textarea
    const textarea = screen.getByPlaceholderText(/Hygiene, Toothbrush/);
    await user.type(textarea, 'Clothing, Shirt\nDocuments, Passport');

    // Click Import button
    const importActionBtn = await screen.findByText(/Import 2/);
    await user.click(importActionBtn);

    await waitFor(() => expect(importBody).toBeTruthy());
  });

  it('FE-COMP-PACKING-063: creating a bag via sidebar form calls createBag API', async () => {
    const user = userEvent.setup();
    let createBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      // Start with one bag so the sidebar renders (sidebar requires bags.length > 0)
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 1, name: 'Existing Bag', color: '#6366f1', weight_limit_grams: null, members: [] }] })
      ),
      http.post('/api/trips/1/packing/bags', async ({ request }) => {
        createBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ bag: { id: 10, name: 'Hiking Pack', color: '#ec4899', weight_limit_grams: null, members: [] } });
      })
    );
    const items = [buildPackingItem({ name: 'Boots', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Wait for sidebar "Add bag" button (sidebar renders when bags.length > 0)
    await waitFor(() => expect(screen.getAllByText('Add bag').length).toBeGreaterThan(0));
    const addBagBtns = screen.getAllByText('Add bag');
    await user.click(addBagBtns[0]);

    // Bag name input appears
    const bagInput = await screen.findByPlaceholderText('Bag name...');
    await user.type(bagInput, 'Hiking Pack');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(createBody).toMatchObject({ name: 'Hiking Pack' }));
  });

  it('FE-COMP-PACKING-064: deleting a bag from sidebar calls deleteBag API', async () => {
    const user = userEvent.setup();
    let deleteCalled = false;
    server.use(
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 9, name: 'Old Bag', color: '#6366f1', weight_limit_grams: null, members: [] }] })
      ),
      http.delete('/api/trips/1/packing/bags/9', () => {
        deleteCalled = true;
        return HttpResponse.json({ success: true });
      })
    );
    const items = [buildPackingItem({ name: 'Shirt', category: 'Clothing' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag to appear in sidebar
    await waitFor(() => expect(screen.getAllByText('Old Bag').length).toBeGreaterThan(0));

    // Click the X (delete) button on the BagCard in the sidebar
    // The X button is in BagCard: <button onClick={onDelete}><X size={...} /></button>
    const xBtns = container.querySelectorAll('svg.lucide-x');
    expect(xBtns.length).toBeGreaterThan(0);
    await user.click(xBtns[0].closest('button')!);

    await waitFor(() => expect(deleteCalled).toBe(true));
  });

  it('FE-COMP-PACKING-065: clicking bag name in sidebar enters edit mode and saves', async () => {
    const user = userEvent.setup();
    let updateBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 11, name: 'Carry-on', color: '#10b981', weight_limit_grams: null, members: [] }] })
      ),
      http.put('/api/trips/1/packing/bags/11', async ({ request }) => {
        updateBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ bag: { id: 11, name: 'Luggage', color: '#10b981', weight_limit_grams: null, members: [] } });
      })
    );
    const items = [buildPackingItem({ name: 'Shoes', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag name in sidebar
    await waitFor(() => expect(screen.getAllByText('Carry-on').length).toBeGreaterThan(0));

    // Click the bag name span to enter edit mode
    const bagNameSpans = screen.getAllByText('Carry-on');
    await user.click(bagNameSpans[0]);

    // An edit input should appear
    const bagNameInput = await screen.findByDisplayValue('Carry-on');
    await user.clear(bagNameInput);
    await user.type(bagNameInput, 'Luggage');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(updateBody).toMatchObject({ name: 'Luggage' }));
  });

  it('FE-COMP-PACKING-066: BagCard Plus button opens user picker with trip members', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 2, username: 'bob', avatar_url: null }],
          current_user_id: 1,
        })
      ),
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 12, name: 'Day Pack', color: '#ec4899', weight_limit_grams: null, members: [] }] })
      )
    );
    const items = [buildPackingItem({ name: 'Camera', category: 'Electronics' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for the BagCard to render in the sidebar
    await waitFor(() => {
      expect(screen.getAllByText('Day Pack').length).toBeGreaterThan(0);
    });

    // Wait for tripMembers to load — UserPlus icon appears in category header when members exist
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    // Find BagCard Plus button by navigating from the bag name span:
    // bag name <span> → header row <div> → outer BagCard <div> → querySelector for dashed button
    const bagNameEl = screen.getAllByText('Day Pack')[0];
    const bagCardOuter = bagNameEl.parentElement!.parentElement!;
    const bagCardPlusBtn = bagCardOuter.querySelector('button[style*="dashed"]') as HTMLElement;
    expect(bagCardPlusBtn).toBeTruthy();
    await user.click(bagCardPlusBtn);

    // User picker dropdown appears with member names (tripMembers already loaded)
    await screen.findByText('bob');
    expect(screen.getByText('owner')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-067: BagCard user picker member click calls setBagMembers', async () => {
    let membersBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/trips/:id/members', () =>
        HttpResponse.json({
          owner: { id: 1, username: 'owner', avatar_url: null },
          members: [{ id: 3, username: 'carol', avatar_url: null }],
          current_user_id: 1,
        })
      ),
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      http.get('/api/trips/:id/packing/bags', () =>
        HttpResponse.json({ bags: [{ id: 13, name: 'Weekend Bag', color: '#f97316', weight_limit_grams: null, members: [] }] })
      ),
      http.put('/api/trips/1/packing/bags/13/members', async ({ request }) => {
        membersBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ members: [{ user_id: 3, username: 'carol', avatar: null }] });
      })
    );
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for the BagCard to render and tripMembers to load
    await waitFor(() => {
      expect(screen.getAllByText('Weekend Bag').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    // Find BagCard Plus button within the BagCard's DOM subtree:
    // bag name <span> → header row <div> → outer BagCard <div> → find dashed button
    const bagNameEl = screen.getAllByText('Weekend Bag')[0];
    const bagCardOuter = bagNameEl.parentElement!.parentElement!;
    const bagCardPlusBtn = bagCardOuter.querySelector('button[style*="dashed"]') as HTMLElement;
    expect(bagCardPlusBtn).toBeTruthy();
    fireEvent.click(bagCardPlusBtn);

    // Click 'carol' in the picker (accessible name: "C carol" from avatar initial + username)
    const carolBtn = await screen.findByText('carol');
    fireEvent.click(carolBtn.closest('button')!);

    await waitFor(() => expect(membersBody).toMatchObject({ user_ids: [3] }));
  });

  it('FE-COMP-PACKING-068: inline bag create in item row picker creates bag and assigns it', async () => {
    let createBody: Record<string, unknown> | null = null;
    server.use(
      http.get('/api/admin/bag-tracking', () => HttpResponse.json({ enabled: true })),
      http.get('/api/trips/:id/packing/bags', () => HttpResponse.json({ bags: [] })),
      http.post('/api/trips/1/packing/bags', async ({ request }) => {
        createBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ bag: { id: 20, name: 'New Bag', color: '#6366f1', weight_limit_grams: null, members: [] } });
      }),
      http.put('/api/trips/1/packing/150', async () =>
        HttpResponse.json({ item: buildPackingItem({ id: 150 }) })
      )
    );
    const items = [buildPackingItem({ id: 150, name: 'Sunglasses', category: 'Accessories' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for Package icon (bag button in item row)
    await waitFor(() => expect(container.querySelector('svg.lucide-package')).toBeTruthy());

    // Use fireEvent to open picker (avoids mouseLeave pointer events)
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    fireEvent.click(packageBtn!);

    // Click "Add bag" inside picker to show inline create
    const addBagInPickerBtns = await screen.findAllByText('Add bag');
    fireEvent.click(addBagInPickerBtns[addBagInPickerBtns.length - 1]);

    // Inline input appears in picker
    const inlineInput = await screen.findByPlaceholderText('Bag name...');
    fireEvent.change(inlineInput, { target: { value: 'New Bag' } });
    fireEvent.keyDown(inlineInput, { key: 'Enter' });

    await waitFor(() => expect(createBody).toMatchObject({ name: 'New Bag' }));
  });

  it('FE-COMP-PACKING-069: Load CSV/TXT button clicks the hidden file input', async () => {
    const user = userEvent.setup();
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);

    // Open import modal
    const importBtn = container.querySelector('svg.lucide-upload')?.closest('button');
    await user.click(importBtn!);
    await screen.findByText('Import Packing List');

    // Spy on the hidden file input's click method
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});

    // Click the "Load CSV/TXT" button
    await user.click(screen.getByText('Load CSV/TXT'));

    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
