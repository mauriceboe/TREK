// FE-COMP-PLACEFORM-001 to FE-COMP-PLACEFORM-036, FE-PLANNER-PLACEFORM-016 to FE-PLANNER-PLACEFORM-067, plus FE-PLANNER-PLACEFORM-068 to -072
import { render, screen, waitFor, fireEvent, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useAddonStore } from '../../store/addonStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildPlace, buildCategory, buildAssignment } from '../../../tests/helpers/factories';
import PlaceFormModal from './PlaceFormModal';

// Mock CustomTimePicker so we get a simple text input instead of the portal-heavy UI
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
  onSave: vi.fn(),
  place: null,
  prefillCoords: null,
  tripId: 1,
  categories: [],
  onCategoryCreated: vi.fn(),
  assignmentId: null,
  dayAssignments: [],
};

beforeEach(() => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, hasMapsKey: false });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
});

describe('PlaceFormModal', () => {
  it('FE-COMP-PLACEFORM-001: renders modal when isOpen is true', () => {
    render(<PlaceFormModal {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-002: shows Add Place title for new place', () => {
    render(<PlaceFormModal {...defaultProps} place={null} />);
    // places.addPlace = "Add Place/Activity"
    expect(screen.getAllByText(/Add Place\/Activity/i).length).toBeGreaterThan(0);
  });

  it('FE-COMP-PLACEFORM-003: shows Edit Place title when editing', () => {
    const place = buildPlace({ name: 'Eiffel Tower' });
    render(<PlaceFormModal {...defaultProps} place={place} />);
    expect(screen.getByText('Edit Place')).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-004: shows Name field with placeholder', () => {
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i)).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-005: shows Description field', () => {
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Short description/i)).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-006: shows Address field', () => {
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Street, City, Country/i)).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-007: shows Add button for new place', () => {
    render(<PlaceFormModal {...defaultProps} place={null} />);
    expect(screen.getByRole('button', { name: /^Add$/i })).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-008: shows Update button when editing', () => {
    const place = buildPlace({ name: 'Test Place' });
    render(<PlaceFormModal {...defaultProps} place={place} />);
    expect(screen.getByRole('button', { name: /^Update$/i })).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-009: shows Cancel button', () => {
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-010: clicking Cancel calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PlaceFormModal {...defaultProps} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('FE-COMP-PLACEFORM-011: pre-fills name field when editing existing place', () => {
    const place = buildPlace({ name: 'Notre Dame' });
    render(<PlaceFormModal {...defaultProps} place={place} />);
    const nameInput = screen.getByDisplayValue('Notre Dame');
    expect(nameInput).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-012: pre-fills address when editing existing place', () => {
    const place = buildPlace({ name: 'Test', address: '123 Main St' });
    render(<PlaceFormModal {...defaultProps} place={place} />);
    expect(screen.getByDisplayValue('123 Main St')).toBeInTheDocument();
  });

  it('FE-COMP-PLACEFORM-013: submitting empty form does not call onSave (name required)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    // Form validation prevents calling onSave without a name
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-COMP-PLACEFORM-014: typing in name field and submitting calls onSave', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Sacre Coeur');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sacre Coeur' }));
  });

  it('FE-COMP-PLACEFORM-015: categories appear in category selector', () => {
    const cats = [buildCategory({ name: 'Museum' }), buildCategory({ name: 'Park' })];
    render(<PlaceFormModal {...defaultProps} categories={cats} />);
    // Category label is present
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  // ── Form initialization ──────────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-016: prefillCoords populates lat/lng/name', () => {
    render(
      <PlaceFormModal
        {...defaultProps}
        place={null}
        prefillCoords={{ lat: 48.8566, lng: 2.3522, name: 'Paris', address: 'Paris, France' }}
      />,
    );
    expect(screen.getByDisplayValue('48.8566')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Paris')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-017: form resets when isOpen changes from place to null', () => {
    const place = buildPlace({ name: 'Old Place' });
    const { rerender } = render(<PlaceFormModal {...defaultProps} place={place} isOpen={true} />);
    expect(screen.getByDisplayValue('Old Place')).toBeInTheDocument();

    rerender(<PlaceFormModal {...defaultProps} place={null} isOpen={false} />);
    expect(screen.queryByDisplayValue('Old Place')).not.toBeInTheDocument();
  });

  // ── Maps search ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-018: maps search populates results via button click', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/search', () =>
        HttpResponse.json({
          places: [{ name: 'Eiffel Tower', address: 'Paris', lat: '48.8584', lng: '2.2945' }],
        }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel Tower');

    // The search button is the sibling button of the search input
    const searchRow = searchInput.closest('.flex') as HTMLElement;
    const searchBtn = within(searchRow).getByRole('button');
    await user.click(searchBtn);

    expect(await screen.findByText('Eiffel Tower')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-019: pressing Enter in search input triggers search', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/search', () =>
        HttpResponse.json({
          places: [{ name: 'Eiffel Tower', address: 'Paris', lat: '48.8584', lng: '2.2945' }],
        }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel Tower');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Eiffel Tower')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-020: clicking a maps result fills the form', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/search', () =>
        HttpResponse.json({
          places: [{ name: 'Eiffel Tower', address: 'Paris', lat: '48.8584', lng: '2.2945' }],
        }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel Tower');
    await user.keyboard('{Enter}');

    const resultBtn = await screen.findByText('Eiffel Tower');
    await user.click(resultBtn);

    expect(screen.getByDisplayValue('Eiffel Tower')).toBeInTheDocument();
    expect(screen.getByDisplayValue('48.8584')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-021: maps search error surfaces the server-provided reason', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;

    const user = userEvent.setup();
    // The backend forwards the real upstream error (e.g. a Google Places API message);
    // the modal must show it instead of a generic "search failed" so the cause is visible.
    server.use(
      http.post('/api/maps/search', () =>
        HttpResponse.json({ error: 'Places API (New) has not been used in project 123 or it is disabled' }, { status: 403 })),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'someplace');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.stringMatching(/Places API \(New\) has not been used/i),
        'error',
        undefined,
      );
    });

    delete window.__addToast;
  });

  // ── Autocomplete suggestion click (#1192) ─────────────────────────────────────
  // Selecting a dropdown suggestion does a second `details` lookup which is fragile
  // (details kill-switch, an overloaded OSM Overpass mirror, upstream errors). When
  // it yields no usable place the modal must fall back to the reliable text search
  // instead of dead-ending on "Place search failed".

  async function openSuggestion(user: ReturnType<typeof userEvent.setup>) {
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel');
    // Debounced autocomplete (300ms) then the dropdown renders the suggestion.
    return screen.findByText('Paris, France');
  }

  it('FE-PLANNER-PLACEFORM-021b: suggestion click falls back to search when details fails', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/autocomplete', () =>
        HttpResponse.json({
          suggestions: [{ placeId: 'node:123', mainText: 'Eiffel Tower', secondaryText: 'Paris, France' }],
          source: 'nominatim',
        }),
      ),
      // details rejects (e.g. proxy 504 from a hung Overpass mirror)
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      http.post('/api/maps/search', () =>
        HttpResponse.json({
          places: [{ name: 'Eiffel Tower', address: 'Paris, France', lat: '48.8584', lng: '2.2945' }],
          source: 'openstreetmap',
        }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const suggestion = await openSuggestion(user);
    await user.click(suggestion);

    // Form is populated from the search fallback, and no error toast is shown.
    expect(await screen.findByDisplayValue('48.8584')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2.2945')).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalledWith(expect.anything(), 'error', expect.anything());
    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-021c: suggestion click falls back when details is disabled (place: null)', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/autocomplete', () =>
        HttpResponse.json({
          suggestions: [{ placeId: 'node:123', mainText: 'Eiffel Tower', secondaryText: 'Paris, France' }],
          source: 'nominatim',
        }),
      ),
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({ place: null, disabled: true })),
      http.post('/api/maps/search', () =>
        HttpResponse.json({
          places: [{ name: 'Eiffel Tower', address: 'Paris, France', lat: '48.8584', lng: '2.2945' }],
          source: 'openstreetmap',
        }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const suggestion = await openSuggestion(user);
    await user.click(suggestion);

    expect(await screen.findByDisplayValue('48.8584')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-021d: suggestion click shows error only when the fallback also finds nothing', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/autocomplete', () =>
        HttpResponse.json({
          suggestions: [{ placeId: 'node:123', mainText: 'Eiffel Tower', secondaryText: 'Paris, France' }],
          source: 'nominatim',
        }),
      ),
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({ place: null, disabled: true })),
      http.post('/api/maps/search', () => HttpResponse.json({ places: [], source: 'openstreetmap' })),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const suggestion = await openSuggestion(user);
    await user.click(suggestion);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith('Place search failed.', 'error', undefined);
    });
    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-022: hasMapsKey=false shows OSM active message', () => {
    // hasMapsKey is false by default in beforeEach
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByText(/OpenStreetMap/i)).toBeInTheDocument();
  });

  // The notice says what is actually true per provider choice, not "add a
  // Google key" on an install whose admin picked Amap. See utils/placesProvider.
  describe('FE-PLANNER-PLACEFORM-022b: the OSM notice follows the provider choice', () => {
    it('suggests the Amap key when the admin chose Amap and none is set', () => {
      seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, hasMapsKey: false, hasAmapKey: false, placesProvider: 'amap' });
      render(<PlaceFormModal {...defaultProps} />);
      expect(screen.getByText(/高德|Amap/i)).toBeInTheDocument();
    });

    it('stays quiet when the chosen provider has its key', () => {
      seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, hasMapsKey: false, hasAmapKey: true, placesProvider: 'amap' });
      render(<PlaceFormModal {...defaultProps} />);
      expect(screen.queryByText(/OpenStreetMap/i)).not.toBeInTheDocument();
    });

    it('stays quiet when the admin explicitly chose OpenStreetMap', () => {
      seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, hasMapsKey: false, hasAmapKey: false, placesProvider: 'openstreetmap' });
      render(<PlaceFormModal {...defaultProps} />);
      // A deliberate choice is not a gap to fill — no upsell line at all.
      expect(screen.queryByText(/OpenStreetMap/i)).not.toBeInTheDocument();
    });

    it('stays quiet under auto when a Google key is configured', () => {
      seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, hasMapsKey: true, hasAmapKey: true, placesProvider: 'auto' });
      render(<PlaceFormModal {...defaultProps} />);
      expect(screen.queryByText(/OpenStreetMap/i)).not.toBeInTheDocument();
    });
  });

  // ── Category ─────────────────────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-023: category selector renders options', () => {
    // The component conditionally shows CustomSelect (showNewCategory=false) or text input
    // Default state shows CustomSelect; no visible "+" trigger exists in current code
    const cats = [buildCategory({ name: 'Beaches' }), buildCategory({ name: 'Museums' })];
    render(<PlaceFormModal {...defaultProps} categories={cats} />);
    // The "No category" placeholder text from CustomSelect should be visible
    expect(screen.getByText(/No category/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-023b: editing a place shows its assigned category, not the placeholder (#1134)', () => {
    // Regression: form.category_id is a string but the option values were numbers,
    // so CustomSelect's strict-equality match failed and the trigger fell back to
    // "No category". With string option values the chosen category renders.
    const cat = buildCategory({ name: 'Museums' });
    const place = buildPlace({ name: 'Louvre', category_id: cat.id });
    render(<PlaceFormModal {...defaultProps} place={place} categories={[cat]} />);
    // Dropdown is closed, so the only place the category name can appear is the trigger.
    expect(screen.getByText('Museums')).toBeInTheDocument();
    expect(screen.queryByText(/No category/i)).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-024: onCategoryCreated is called when creating a category', async () => {
    const user = userEvent.setup();
    const onCategoryCreated = vi.fn().mockResolvedValue({ id: 99, name: 'Beaches', color: '#6366f1', icon: 'MapPin' });

    render(<PlaceFormModal {...defaultProps} onCategoryCreated={onCategoryCreated} />);
    expect(onCategoryCreated).not.toHaveBeenCalled();

    // The plus next to the category select swaps in the inline name field.
    await user.click(screen.getByRole('button', { name: 'New category' }));
    await user.type(screen.getByPlaceholderText('Category name'), 'Beaches');
    await user.click(screen.getByRole('button', { name: 'OK' }));

    expect(onCategoryCreated).toHaveBeenCalledWith({ name: 'Beaches', color: '#6366f1', icon: 'MapPin' });
    // The new category is selected and the inline field closes again.
    await waitFor(() => expect(screen.queryByPlaceholderText('Category name')).not.toBeInTheDocument());
  });

  it('FE-PLANNER-PLACEFORM-024b: an empty category name does not call onCategoryCreated', async () => {
    const user = userEvent.setup();
    const onCategoryCreated = vi.fn();

    render(<PlaceFormModal {...defaultProps} onCategoryCreated={onCategoryCreated} />);
    await user.click(screen.getByRole('button', { name: 'New category' }));
    await user.click(screen.getByRole('button', { name: 'OK' }));

    expect(onCategoryCreated).not.toHaveBeenCalled();

    const inlineRow = screen.getByPlaceholderText('Category name').parentElement!;
    await user.click(within(inlineRow).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('Category name')).not.toBeInTheDocument();
  });

  // ── Time section (edit mode only) ────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-025: time section is NOT shown in create mode', () => {
    render(<PlaceFormModal {...defaultProps} place={null} />);
    // English labels are 'Start' and 'End' (places.startTime / places.endTime)
    expect(screen.queryByText(/^Start$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^End$/i)).not.toBeInTheDocument();
    // Also verify no time pickers rendered
    expect(screen.queryByTestId('time-picker')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-026: time section is hidden in edit mode when no assignment is in context', () => {
    // Times are per day-assignment; editing a pool place with no day in context
    // (assignmentId null) hides the fields, which otherwise would not persist (#1247)
    const place = buildPlace({ name: 'Test' });
    render(<PlaceFormModal {...defaultProps} place={place} assignmentId={null} />);
    expect(screen.queryByTestId('time-picker')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-026b: time section IS shown when an assignment is in context', () => {
    const place = buildPlace({ name: 'Test', place_time: '09:00', end_time: '10:00' });
    const assignment = buildAssignment({ id: 10, day_id: 5, place });
    render(<PlaceFormModal {...defaultProps} place={place} assignmentId={10} dayAssignments={[assignment]} />);
    expect(screen.getAllByTestId('time-picker').length).toBeGreaterThanOrEqual(2);
  });

  it('FE-PLANNER-PLACEFORM-026c: hydrates Start/End from the assignment when the pool place lacks times (#1247)', () => {
    // The pool Place carries no times — they live on the day-assignment. Opening the
    // editor with an assignmentId must hydrate the fields from assignment.place, not
    // the (timeless) pool place that the Places panel passes in.
    const poolPlace = buildPlace({ id: 7, name: 'Museum' });
    const assignmentPlace = buildPlace({ id: 7, name: 'Museum', place_time: '20:20', end_time: '20:34' });
    const assignment = buildAssignment({ id: 42, day_id: 3, place: assignmentPlace });
    render(<PlaceFormModal {...defaultProps} place={poolPlace} assignmentId={42} dayAssignments={[assignment]} />);
    expect(screen.getByDisplayValue('20:20')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20:34')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-027: end-before-start error disables submit', () => {
    // Build an assignment whose place has end_time before place_time
    const place = buildPlace({ name: 'Test', place_time: '14:00', end_time: '13:00' });
    const assignment = buildAssignment({ id: 11, day_id: 5, place });
    render(<PlaceFormModal {...defaultProps} place={place} assignmentId={11} dayAssignments={[assignment]} />);

    // hasTimeError = true → submit button disabled
    const submitBtn = screen.getByRole('button', { name: /^Update$/i });
    expect(submitBtn).toBeDisabled();
  });

  it('FE-PLANNER-PLACEFORM-028: time collision warning appears when assignments overlap', () => {
    // Create an assignment for the "current" place being edited
    const currentPlace = buildPlace({ name: 'My Event', place_time: '12:30', end_time: '13:30' });
    const conflictingPlace = buildPlace({ name: 'Other Event', place_time: '13:00', end_time: '14:00' });

    const currentAssignment = buildAssignment({ id: 10, day_id: 5, place: currentPlace });
    const otherAssignment = buildAssignment({ id: 20, day_id: 5, place: conflictingPlace });

    render(
      <PlaceFormModal
        {...defaultProps}
        place={currentPlace}
        assignmentId={10}
        dayAssignments={[currentAssignment, otherAssignment]}
      />,
    );

    // English translation: 'places.timeCollision' = 'Time overlap with:'
    expect(screen.getByText(/Time overlap with:/i)).toBeInTheDocument();
  });

  // ── File attachments ──────────────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-029: file attachment section shown when canUploadFiles=true', () => {
    // Default: permissions={} → not configured → allow → canUploadFiles=true
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.getByText('Attach')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-030: file attachment section hidden when canUploadFiles=false', () => {
    // Set file_upload to 'admin' level; non-admin user cannot upload
    seedStore(usePermissionsStore, { permissions: { file_upload: 'admin' } });
    render(<PlaceFormModal {...defaultProps} />);
    expect(screen.queryByText('Attach')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-031: pending files list shows file names after adding', async () => {
    render(<PlaceFormModal {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText('photo.jpg');
  });

  it('FE-PLANNER-PLACEFORM-032: removing a pending file removes it from the list', async () => {
    const user = userEvent.setup();
    render(<PlaceFormModal {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(['x'], 'remove-me.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByText('remove-me.jpg');

    // The X button is inside the file item's container div
    const fileItem = screen.getByText('remove-me.jpg').closest('div.flex') as HTMLElement;
    const removeBtn = within(fileItem).getByRole('button');
    await user.click(removeBtn);

    expect(screen.queryByText('remove-me.jpg')).not.toBeInTheDocument();
  });

  // ── Submit ────────────────────────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-033: onSave receives parsed lat/lng as numbers', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Notre Dame');

    const latInput = screen.getByPlaceholderText(/Latitude/i);
    await user.clear(latInput);
    await user.type(latInput, '48.853');

    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ lat: 48.853 }));
  });

  it('FE-PLANNER-PLACEFORM-034: onSave error shows toast', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;

    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Server error'));

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Notre Dame');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith('Server error', 'error', undefined);
    });

    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-035: save button shows "Saving..." while saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Notre Dame');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument();
    });
  });

  it('FE-PLANNER-PLACEFORM-036: lat/lng paste splits "48.8566, 2.3522" into lat and lng fields', () => {
    render(<PlaceFormModal {...defaultProps} />);
    const latInput = screen.getByPlaceholderText(/Latitude/i);

    fireEvent.paste(latInput, {
      clipboardData: {
        getData: () => '48.8566, 2.3522',
      },
    });

    expect(screen.getByDisplayValue('48.8566')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2.3522')).toBeInTheDocument();
  });

  // ── Duplicate detection (#1152) ────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-037: a same-named place warns first and saves only on the second click', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, { trip: buildTrip({ id: 1 }), places: [buildPlace({ name: 'Louvre' })] });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    // Case-insensitive match against the existing trip place.
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), '  louvre ');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Louvre'), 'warning', undefined);
    // The button now reads as the explicit confirmation.
    const addAnyway = await screen.findByRole('button', { name: /Add anyway/i });
    await user.click(addAnyway);
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-038: near-identical coordinates count as a duplicate even under a new name', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [buildPlace({ name: 'Tour Eiffel', lat: 48.8584, lng: 2.2945 })],
    });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Iron Lady');
    fireEvent.paste(screen.getByPlaceholderText(/Latitude/i), {
      clipboardData: { getData: () => '48.85845, 2.29455' },
    });
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Tour Eiffel'), 'warning', undefined);

    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-039: a far-away place with a fresh name saves straight away', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [buildPlace({ name: 'Tour Eiffel', lat: 48.8584, lng: 2.2945 })],
    });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Colosseum');
    fireEvent.paste(screen.getByPlaceholderText(/Latitude/i), {
      clipboardData: { getData: () => '41.8902, 12.4922' },
    });
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Colosseum', lat: 41.8902, lng: 12.4922 }));
  });

  it('FE-PLANNER-PLACEFORM-040: editing an existing place never triggers the duplicate guard', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const place = buildPlace({ name: 'Louvre' });
    seedStore(useTripStore, { trip: buildTrip({ id: 1 }), places: [place] });

    render(<PlaceFormModal {...defaultProps} place={place} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: /^Update$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it('FE-PLANNER-PLACEFORM-041: an empty name is rejected with the name-required toast', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('Please enter a name', 'error', undefined);

    delete window.__addToast;
  });

  // ── Location bias from the trip's existing places ───────────────────────────

  it('FE-PLANNER-PLACEFORM-042: a tight cluster of trip places biases the autocomplete bounding box', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/maps/autocomplete', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ suggestions: [] });
      }),
    );
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [
        buildPlace({ lat: 48.85, lng: 2.34 }),
        buildPlace({ lat: 48.87, lng: 2.37 }),
        // Garbage coordinates must be skipped, not poison the box.
        buildPlace({ lat: 'x' as unknown as number, lng: 'y' as unknown as number }),
      ],
    });

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].locationBias).toEqual({
      low: { lat: 48.85, lng: 2.34 },
      high: { lat: 48.87, lng: 2.37 },
    });
  });

  it('FE-PLANNER-PLACEFORM-043: places spread over more than 500 km send no location bias', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/maps/autocomplete', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ suggestions: [] });
      }),
    );
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [buildPlace({ lat: 48.85, lng: 2.34 }), buildPlace({ lat: 41.89, lng: 12.49 })],
    });

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].locationBias).toBeUndefined();
  });

  it('FE-PLANNER-PLACEFORM-043b: trip places with unusable coordinates yield no bias at all', async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post('/api/maps/autocomplete', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ suggestions: [] });
      }),
    );
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [buildPlace({ lat: 'x' as unknown as number, lng: 'y' as unknown as number })],
    });

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].locationBias).toBeUndefined();
  });

  it('FE-PLANNER-PLACEFORM-045b: focusing with a Google Maps URL in the box fetches no suggestions', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post('/api/maps/autocomplete', () => {
        calls += 1;
        return HttpResponse.json({ suggestions: [] });
      }),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'https://maps.google.com/maps?q=x');
    fireEvent.focus(searchInput);

    await waitFor(() => expect(screen.queryByText('Paris, France')).not.toBeInTheDocument());
    expect(calls).toBe(0);
  });

  it('FE-PLANNER-PLACEFORM-044: a failing autocomplete clears the dropdown instead of surfacing an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    server.use(http.post('/api/maps/autocomplete', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith('Autocomplete failed:', expect.anything()));
    expect(addToast).not.toHaveBeenCalled();

    consoleError.mockRestore();
    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-045: re-focusing the search box refetches when the dropdown is empty', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post('/api/maps/autocomplete', () => {
        calls += 1;
        return HttpResponse.json({ suggestions: [] });
      }),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel');
    await waitFor(() => expect(calls).toBe(1));

    fireEvent.focus(searchInput);
    await waitFor(() => expect(calls).toBe(2));
  });

  // ── Maps search / Google Maps URL resolve ──────────────────────────────────

  it('FE-PLANNER-PLACEFORM-046: clicking search with an empty box makes no request', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post('/api/maps/search', () => {
        calls += 1;
        return HttpResponse.json({ places: [] });
      }),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    const searchBtn = within(searchInput.closest('.flex') as HTMLElement).getByRole('button');
    await user.click(searchBtn);

    expect(calls).toBe(0);
  });

  it('FE-PLANNER-PLACEFORM-047: pasting a Google Maps URL resolves it straight into the form', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/resolve-url', () =>
        HttpResponse.json({ name: 'Notre-Dame', address: 'Parvis Notre-Dame, Paris', lat: 48.8530, lng: 2.3499, google_ftid: 'ftid-1' }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'https://maps.google.com/maps?q=notredame');
    await user.keyboard('{Enter}');

    expect(await screen.findByDisplayValue('Notre-Dame')).toBeInTheDocument();
    expect(screen.getByDisplayValue('48.853')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Parvis Notre-Dame, Paris')).toBeInTheDocument();
    // The URL is consumed, so the search box empties out.
    expect(screen.getByPlaceholderText('Search places...')).toHaveValue('');
    expect(addToast).toHaveBeenCalledWith('Place imported from URL', 'success', undefined);

    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-048: an unresolvable Google Maps URL falls through to the text search', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/resolve-url', () => HttpResponse.json({ name: 'Notre-Dame', lat: null, lng: null })),
      http.post('/api/maps/search', () =>
        HttpResponse.json({ places: [{ name: 'Notre-Dame de Paris', address: 'Paris', lat: '48.853', lng: '2.3499' }] }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'https://maps.google.com/maps?q=notredame');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Notre-Dame de Paris')).toBeInTheDocument();
  });

  // ── Autocomplete keyboard navigation ───────────────────────────────────────

  const twoSuggestions = () =>
    http.post('/api/maps/autocomplete', () =>
      HttpResponse.json({
        suggestions: [
          { placeId: 'node:1', mainText: 'Eiffel Tower', secondaryText: 'Paris, France' },
          { placeId: 'node:2', mainText: 'Eiffel Museum', secondaryText: 'Berlin, Germany' },
        ],
      }),
    );

  it('FE-PLANNER-PLACEFORM-049: ArrowDown/ArrowUp move the highlight and Enter picks the highlighted suggestion', async () => {
    const user = userEvent.setup();
    server.use(
      twoSuggestions(),
      http.get('/api/maps/details/:placeId', () =>
        HttpResponse.json({ place: { name: 'Eiffel Museum', address: 'Berlin', lat: 52.52, lng: 13.405 } }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiffel');
    await screen.findByText('Paris, France');

    // -1 → wraps to the last entry, then ArrowDown wraps back to the first.
    await user.keyboard('{ArrowUp}');
    expect(screen.getByText('Eiffel Museum').closest('button')).toHaveClass('bg-surface-tertiary');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText('Eiffel Tower').closest('button')).toHaveClass('bg-surface-tertiary');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText('Eiffel Museum').closest('button')).toHaveClass('bg-surface-tertiary');

    await user.keyboard('{Enter}');
    expect(await screen.findByDisplayValue('52.52')).toBeInTheDocument();
    expect(screen.getByDisplayValue('13.405')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-050: Escape closes the dropdown without searching', async () => {
    const user = userEvent.setup();
    let searches = 0;
    server.use(
      twoSuggestions(),
      http.post('/api/maps/search', () => {
        searches += 1;
        return HttpResponse.json({ places: [] });
      }),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');
    await screen.findByText('Paris, France');

    await user.keyboard('{Escape}');
    expect(screen.queryByText('Paris, France')).not.toBeInTheDocument();
    expect(searches).toBe(0);
  });

  it('FE-PLANNER-PLACEFORM-051: Enter with nothing highlighted closes the dropdown and runs the full search', async () => {
    const user = userEvent.setup();
    server.use(
      twoSuggestions(),
      http.post('/api/maps/search', () =>
        HttpResponse.json({ places: [{ name: 'Eiffel Tower', address: 'Champ de Mars', lat: '48.8584', lng: '2.2945' }] }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');
    await screen.findByText('Paris, France');

    await user.keyboard('{Enter}');
    expect(await screen.findByText('Champ de Mars')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-052: when both details and the search fallback fail the query is restored', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    server.use(
      twoSuggestions(),
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
      http.post('/api/maps/search', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');
    await user.click(await screen.findByText('Paris, France'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/Place search failed|nope/i), 'error', undefined),
    );
    // The typed query comes back so the user can retry instead of starting over.
    await waitFor(() => expect(screen.getByPlaceholderText('Search places...')).toHaveValue('Eiffel'));

    consoleError.mockRestore();
    delete window.__addToast;
  });

  it('FE-PLANNER-PLACEFORM-053: a Google place id shared with an existing trip place is flagged as duplicate', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      places: [buildPlace({ name: 'Already Here', google_place_id: 'gp-1', lat: null, lng: null })],
    });
    server.use(
      http.post('/api/maps/search', () =>
        HttpResponse.json({ places: [{ name: 'Same Spot', address: 'Somewhere', lat: '10', lng: '10', google_place_id: 'gp-1' }] }),
      ),
    );

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'same spot');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByText('Same Spot'));

    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Already Here'), 'warning', undefined);

    delete window.__addToast;
  });

  // ── Paste-to-attach ────────────────────────────────────────────────────────

  function pasteItems(target: Element, items: { type: string; file: File | null }[]) {
    fireEvent.paste(target, {
      clipboardData: {
        items: items.map(i => ({ type: i.type, getAsFile: () => i.file })),
      },
    });
  }

  it('FE-PLANNER-PLACEFORM-054: pasting an image attaches it as a pending file', () => {
    render(<PlaceFormModal {...defaultProps} />);
    const form = document.querySelector('form') as HTMLFormElement;
    pasteItems(form, [
      { type: 'text/plain', file: null },
      { type: 'image/png', file: new File(['x'], 'screenshot.png', { type: 'image/png' }) },
    ]);
    expect(screen.getByText('screenshot.png')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-057: a prefilled place drives the detail column, not the previous one', () => {
    // A POI tapped on the map opens the dialog through prefillCoords, never
    // through the search handler — the column used to keep the last place.
    const { rerender } = render(
      <PlaceFormModal {...defaultProps} prefillCoords={{ lat: 53.55, lng: 9.99, name: 'Helgas Kitchen', osm_id: 'node:1' }} />,
    );
    expect(screen.getByDisplayValue('Helgas Kitchen')).toBeInTheDocument();

    rerender(
      <PlaceFormModal {...defaultProps} prefillCoords={{ lat: 50.9, lng: 6.96, name: 'Museum Ludwig', osm_id: 'node:2' }} />,
    );
    expect(screen.getByDisplayValue('Museum Ludwig')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Helgas Kitchen')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-055: pasting plain text alone attaches nothing', () => {
    render(<PlaceFormModal {...defaultProps} />);
    const form = document.querySelector('form') as HTMLFormElement;
    pasteItems(form, [{ type: 'text/plain', file: null }]);
    // The list only renders once something is attached, so its absence is the
    // assertion (this used to lean on the clipboard hint, which is gone).
    expect(screen.queryByTestId('pending-files')).not.toBeInTheDocument();

    // Counter-check, so the assertion above cannot pass on a missing testid:
    // a real file does show up in that list.
    pasteItems(form, [{ type: 'image/png', file: new File(['x'], 'shot.png', { type: 'image/png' }) }]);
    expect(screen.getByTestId('pending-files')).toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-056: paste is ignored entirely without upload permission', () => {
    seedStore(usePermissionsStore, { permissions: { file_upload: 'admin' } });
    render(<PlaceFormModal {...defaultProps} />);
    const form = document.querySelector('form') as HTMLFormElement;
    pasteItems(form, [{ type: 'application/pdf', file: new File(['x'], 'ticket.pdf', { type: 'application/pdf' }) }]);
    expect(screen.queryByText('ticket.pdf')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-057: the Attach button opens the hidden file input', async () => {
    const user = userEvent.setup();
    render(<PlaceFormModal {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: /Attach/i }));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  // ── Remaining form fields ──────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-058: description, notes, website and category all reach the save payload', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const cat = buildCategory({ name: 'Museums' });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} categories={[cat]} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Louvre');
    await user.type(screen.getByPlaceholderText(/Short description/i), 'Glass pyramid');
    await user.type(screen.getByPlaceholderText(/Personal notes/i), 'Book ahead');
    await user.type(screen.getByPlaceholderText(/Street, City, Country/i), 'Rue de Rivoli');
    await user.type(screen.getByPlaceholderText(/Longitude/i), '2.3376');
    await user.type(screen.getByPlaceholderText('https://...'), 'https://louvre.fr');
    // Pick the category through the CustomSelect trigger.
    await user.click(screen.getByText(/No category/i));
    await user.click(screen.getByRole('button', { name: 'Museums' }));

    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Louvre',
        description: 'Glass pyramid',
        notes: 'Book ahead',
        address: 'Rue de Rivoli',
        lng: 2.3376,
        website: 'https://louvre.fr',
        category_id: String(cat.id),
      }),
    );
  });

  it('FE-PLANNER-PLACEFORM-059: the Collections column only appears on desktop with the addon enabled', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'collections', name: 'Collections', type: 'collections', icon: '', enabled: true }],
      loaded: true,
    });
    const { unmount } = render(<PlaceFormModal {...defaultProps} isMobile={false} />);
    expect(screen.getByPlaceholderText(/Search your saved places/i)).toBeInTheDocument();
    unmount();

    render(<PlaceFormModal {...defaultProps} isMobile />);
    expect(screen.queryByPlaceholderText(/Search your saved places/i)).not.toBeInTheDocument();
  });

  // ── Time section edge cases ────────────────────────────────────────────────

  it('FE-PLANNER-PLACEFORM-060: editing the times through the pickers updates the save payload', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const place = buildPlace({ name: 'Museum' });
    const assignment = buildAssignment({ id: 12, day_id: 4, place });

    render(<PlaceFormModal {...defaultProps} place={place} assignmentId={12} dayAssignments={[assignment]} onSave={onSave} />);
    const [start, end] = screen.getAllByTestId('time-picker');
    fireEvent.change(start, { target: { value: '09:00' } });
    fireEvent.change(end, { target: { value: '10:30' } });

    await user.click(screen.getByRole('button', { name: /^Update$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ place_time: '09:00', end_time: '10:30' }));
  });

  it('FE-PLANNER-PLACEFORM-061: an assignment id that is not in the day list reports no collisions', () => {
    const place = buildPlace({ name: 'Ghost', place_time: '12:00', end_time: '13:00' });
    render(<PlaceFormModal {...defaultProps} place={place} assignmentId={999} dayAssignments={[]} />);
    expect(screen.getAllByTestId('time-picker').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Time overlap with:/i)).not.toBeInTheDocument();
  });

  it('FE-PLANNER-PLACEFORM-062: collisions ignore other days and timeless assignments', () => {
    const current = buildPlace({ name: 'My Event', place_time: '12:30', end_time: '13:30' });
    const otherDay = buildPlace({ name: 'Other Day Event', place_time: '13:00', end_time: '14:00' });
    const timeless = buildPlace({ name: 'Timeless Event' });
    const overlapping = buildPlace({ name: 'Overlapping Event', place_time: '13:00', end_time: '14:00' });

    render(
      <PlaceFormModal
        {...defaultProps}
        place={current}
        assignmentId={10}
        dayAssignments={[
          buildAssignment({ id: 10, day_id: 5, place: current }),
          buildAssignment({ id: 20, day_id: 6, place: otherDay }),
          buildAssignment({ id: 30, day_id: 5, place: timeless }),
          buildAssignment({ id: 40, day_id: 5, place: overlapping }),
        ]}
      />,
    );

    const warning = screen.getByText(/Time overlap with:/i).closest('div') as HTMLElement;
    expect(warning).toHaveTextContent('Overlapping Event');
    expect(warning).not.toHaveTextContent('Other Day Event');
    expect(warning).not.toHaveTextContent('Timeless Event');
  });
});

// FE-W5PFM-001 to FE-W5PFM-014 — the remaining prefill, response-shape and
// error branches of the place form.
describe('PlaceFormModal remaining branches', () => {
  it('FE-W5PFM-001: an existing place with empty fields opens on the defaults', () => {
    const place = buildPlace({
      name: null, description: null, address: null, lat: null, lng: null,
      category_id: null, notes: null, transport_mode: null, website: null,
    });
    render(<PlaceFormModal {...defaultProps} place={place} />);

    expect(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i)).toHaveValue('');
    expect(screen.getByPlaceholderText(/Latitude/i)).toHaveValue('');
    expect(screen.getByPlaceholderText(/Longitude/i)).toHaveValue('');
    expect(screen.getByPlaceholderText('https://...')).toHaveValue('');
  });

  it('FE-W5PFM-002: prefilled coordinates without a name only fill the coordinates', () => {
    render(<PlaceFormModal {...defaultProps} prefillCoords={{ lat: 48.8584, lng: 2.2945 }} />);

    expect(screen.getByPlaceholderText(/Latitude/i)).toHaveValue('48.8584');
    expect(screen.getByPlaceholderText(/Longitude/i)).toHaveValue('2.2945');
    expect(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i)).toHaveValue('');
    expect(screen.getByPlaceholderText(/Street, City, Country/i)).toHaveValue('');
  });

  it('FE-W5PFM-003: an autocomplete response without a suggestions array shows no dropdown', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/maps/autocomplete', () => HttpResponse.json({})));

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'Eiffel');

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(screen.queryByText('Eiffel Tower, Paris')).not.toBeInTheDocument();
  });

  it('FE-W5PFM-004: an aborted autocomplete is swallowed without logging', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const gate: { release?: () => void } = {};
    let seen = 0;
    server.use(
      http.post('/api/maps/autocomplete', async () => {
        seen += 1;
        if (seen === 1) await new Promise<void>(res => { gate.release = res; });
        return HttpResponse.json({
          suggestions: [{ placeId: 'node:1', mainText: 'Eiffel Tower', secondaryText: 'Paris, France' }],
        });
      }),
    );

    render(<PlaceFormModal {...defaultProps} />);
    const searchInput = screen.getByPlaceholderText('Search places...');
    await user.type(searchInput, 'Eiff');
    await waitFor(() => expect(seen).toBe(1));
    // The second query aborts the still-open first one
    await user.type(searchInput, 'el tower');
    await waitFor(() => expect(seen).toBe(2));
    gate.release?.();

    expect(await screen.findByText('Paris, France')).toBeInTheDocument();
    expect(screen.getAllByText('Eiffel Tower')).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalledWith('Autocomplete failed:', expect.anything());
    consoleError.mockRestore();
  });

  it('FE-W5PFM-005: a resolved URL without a name or address keeps the form values', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/resolve-url', () => HttpResponse.json({ lat: 48.853, lng: 2.3499 })),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Kept Name');
    await user.type(screen.getByPlaceholderText('Search places...'), 'https://maps.google.com/maps?q=x');
    await user.keyboard('{Enter}');

    expect(await screen.findByDisplayValue('48.853')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i)).toHaveValue('Kept Name');
  });

  it('FE-W5PFM-006: a search response without a places array renders no results', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/maps/search', () => HttpResponse.json({})));

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText('Search places...'), 'nowhere');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByPlaceholderText('Search places...')).toHaveValue('nowhere'));
    expect(screen.queryByRole('button', { name: /nowhere/i })).not.toBeInTheDocument();
  });

  it('FE-W5PFM-007: picking a bare search result leaves the typed fields alone', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/maps/search', () => HttpResponse.json({ places: [{ name: 'Bare Result' }] })),
    );

    render(<PlaceFormModal {...defaultProps} />);
    await user.type(screen.getByPlaceholderText(/Street, City, Country/i), 'Rue de Rivoli');
    await user.type(screen.getByPlaceholderText('Search places...'), 'bare');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByText('Bare Result'));

    expect(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i)).toHaveValue('Bare Result');
    expect(screen.getByPlaceholderText(/Street, City, Country/i)).toHaveValue('Rue de Rivoli');
    expect(screen.getByPlaceholderText(/Latitude/i)).toHaveValue('');
  });

  it('FE-W5PFM-008: a place sharing only the name is flagged as a duplicate', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, { trip: buildTrip({ id: 1 }), places: [buildPlace({ name: 'Louvre', lat: null, lng: null })] });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'louvre');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Louvre'), 'warning', undefined);

    // The second click is the explicit confirmation
    await user.click(screen.getByRole('button', { name: /Add anyway/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());

    delete window.__addToast;
  });

  it('FE-W5PFM-009: a place sharing only the coordinates is flagged as a duplicate', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, { trip: buildTrip({ id: 1 }), places: [buildPlace({ name: null, lat: 48.8584, lng: 2.2945 })] });

    render(<PlaceFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Tour Eiffel');
    await user.type(screen.getByPlaceholderText(/Latitude/i), '48.85841');
    await user.type(screen.getByPlaceholderText(/Longitude/i), '2.29451');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    expect(onSave).not.toHaveBeenCalled();
    // the existing place has no name, so the warning falls back to the typed one
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Tour Eiffel'), 'warning', undefined);

    delete window.__addToast;
  });

  it('FE-W5PFM-010: a rejected save without an Error surfaces the generic message', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue('nope');
    const onClose = vi.fn();

    render(<PlaceFormModal {...defaultProps} onSave={onSave} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), 'Louvre');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Failed to save', 'error', undefined));
    expect(onClose).not.toHaveBeenCalled();

    delete window.__addToast;
  });

  it('FE-W5PFM-011: pasting a coordinate pair into latitude fills both fields', () => {
    render(<PlaceFormModal {...defaultProps} />);
    const lat = screen.getByPlaceholderText(/Latitude/i);

    fireEvent.paste(lat, { clipboardData: { getData: () => ' 48.8584, 2.2945 ' } });
    expect(screen.getByPlaceholderText(/Latitude/i)).toHaveValue('48.8584');
    expect(screen.getByPlaceholderText(/Longitude/i)).toHaveValue('2.2945');
  });

  it('FE-W5PFM-012: pasting anything else into latitude is left to the input', () => {
    render(<PlaceFormModal {...defaultProps} />);
    const lat = screen.getByPlaceholderText(/Latitude/i);

    fireEvent.paste(lat, { clipboardData: { getData: () => 'not a coordinate' } });
    expect(screen.getByPlaceholderText(/Longitude/i)).toHaveValue('');
  });

  it('FE-W5PFM-013: a missing category list still renders the no-category option', () => {
    render(<PlaceFormModal {...defaultProps} categories={null} />);

    expect(screen.getByText(/No category/i)).toBeInTheDocument();
  });

  it('FE-W5PFM-014: an open-ended assignment collapses to a point in time', () => {
    const current = buildPlace({ name: 'My Event', place_time: '11:30', end_time: '' });
    const spanning = buildPlace({ name: 'Spanning Event', place_time: '11:00', end_time: '12:00' });
    const earlier = buildPlace({ name: 'Earlier Event', place_time: '11:00', end_time: '' });

    render(
      <PlaceFormModal
        {...defaultProps}
        place={current}
        assignmentId={10}
        dayAssignments={[
          buildAssignment({ id: 10, day_id: 5, place: current }),
          buildAssignment({ id: 20, day_id: 5, place: spanning }),
          buildAssignment({ id: 30, day_id: 5, place: earlier }),
        ]}
      />,
    );

    const warning = screen.getByText(/Time overlap with:/i).closest('div') as HTMLElement;
    expect(warning).toHaveTextContent('Spanning Event');
    expect(warning).not.toHaveTextContent('Earlier Event');
  });

  /**
   * FE-PLANNER-PLACEFORM-063..068 — what a second pick may overwrite.
   *
   * Search Hamburg Airport, then Berlin Hauptbahnhof, and the airport's website
   * was still in the field: `result.website || prev.website` cannot tell "the
   * user typed this" from "the last result wrote this". Saving then gave the
   * station the airport's website.
   */
  describe('picking a second place', () => {
    const searchFor = async (user: ReturnType<typeof userEvent.setup>, place: Record<string, unknown>) => {
      server.use(http.post('/api/maps/search', () => HttpResponse.json({ places: [place] })));
      const searchInput = screen.getByPlaceholderText('Search places...');
      await user.clear(searchInput);
      await user.type(searchInput, String(place.name));
      const searchRow = searchInput.closest('.flex') as HTMLElement;
      await user.click(within(searchRow).getByRole('button'));
      await user.click(await screen.findByText(String(place.name)));
    };

    const AIRPORT = {
      name: 'Hamburg Airport',
      address: 'Hamburg',
      lat: '53.6323',
      lng: '10.0067',
      website: 'https://www.hamburg-airport.de/',
    };
    const STATION = { name: 'Berlin Hauptbahnhof', address: 'Berlin', lat: '52.525', lng: '13.3694' };

    const websiteInput = () => screen.getByPlaceholderText('https://...') as HTMLInputElement;

    it('FE-PLANNER-PLACEFORM-063: a place with no website clears the previous one', async () => {
      const user = userEvent.setup();
      render(<PlaceFormModal {...defaultProps} />);

      await searchFor(user, AIRPORT);
      expect(websiteInput().value).toBe('https://www.hamburg-airport.de/');

      await searchFor(user, STATION);
      expect(websiteInput().value).toBe('');
    });

    it('FE-PLANNER-PLACEFORM-064: a website the user typed survives the next pick', async () => {
      const user = userEvent.setup();
      render(<PlaceFormModal {...defaultProps} />);

      await user.type(websiteInput(), 'https://mine.example');
      await searchFor(user, STATION);

      expect(websiteInput().value).toBe('https://mine.example');
    });

    it('FE-PLANNER-PLACEFORM-065: a picked value the user then edited also survives', async () => {
      const user = userEvent.setup();
      render(<PlaceFormModal {...defaultProps} />);

      await searchFor(user, AIRPORT);
      await user.clear(websiteInput());
      await user.type(websiteInput(), 'https://corrected.example');
      await searchFor(user, STATION);

      expect(websiteInput().value).toBe('https://corrected.example');
    });

    it('FE-PLANNER-PLACEFORM-066: the ids of the previous place do not travel with the new one', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      render(<PlaceFormModal {...defaultProps} onSave={onSave} />);

      await searchFor(user, { ...AIRPORT, google_place_id: 'ChIJham' });
      await searchFor(user, { ...STATION, osm_id: 'relation:3600565' });
      await user.click(screen.getByRole('button', { name: /^Add$/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const payload = onSave.mock.calls[0][0];
      expect(payload.osm_id).toBe('relation:3600565');
      expect(payload.google_place_id).toBeFalsy();
    });

    it('FE-PLANNER-PLACEFORM-067: editing a saved place keeps its stored website', async () => {
      // The dangerous direction: the form was filled from the database, so a
      // search result that says nothing about a field must not empty it.
      const user = userEvent.setup();
      render(
        <PlaceFormModal
          {...defaultProps}
          place={{ id: 7, name: 'Old', website: 'https://stored.example', lat: 1, lng: 2 } as never}
        />,
      );
      expect(websiteInput().value).toBe('https://stored.example');

      await searchFor(user, STATION);
      expect(websiteInput().value).toBe('https://stored.example');
    });
  });

  // ── Linked expense (#1298) — the same block bookings have ──────────────────

  describe('Costs section', () => {
    const withBudget = () => seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });

    it('FE-PLANNER-PLACEFORM-068: the block only appears while the Budget addon is on', () => {
      const { unmount } = render(<PlaceFormModal {...defaultProps} />);
      expect(screen.queryByRole('button', { name: /Create expense/i })).not.toBeInTheDocument();
      unmount();

      withBudget();
      render(<PlaceFormModal {...defaultProps} />);
      expect(screen.getByRole('button', { name: /Create expense/i })).toBeInTheDocument();
    });

    it('FE-PLANNER-PLACEFORM-069: creating an expense saves the place first, then opens the editor', async () => {
      withBudget();
      const onSave = vi.fn().mockResolvedValue({ id: 42 });
      const onOpenExpense = vi.fn();
      render(<PlaceFormModal {...defaultProps} onSave={onSave} onOpenExpense={onOpenExpense} />);

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), { target: { value: 'Louvre' } });
      fireEvent.click(screen.getByRole('button', { name: /Create expense/i }));

      await waitFor(() => expect(onOpenExpense).toHaveBeenCalled());
      expect(onSave).toHaveBeenCalled();
      expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(onOpenExpense.mock.invocationCallOrder[0]);
      expect(onOpenExpense).toHaveBeenCalledWith({
        prefill: { placeId: 42, name: 'Louvre', category: 'activities' },
      });
    });

    it('FE-PLANNER-PLACEFORM-070: a save that yields no id opens no editor', async () => {
      withBudget();
      const onSave = vi.fn().mockResolvedValue(undefined);
      const onOpenExpense = vi.fn();
      render(<PlaceFormModal {...defaultProps} onSave={onSave} onOpenExpense={onOpenExpense} />);

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), { target: { value: 'Louvre' } });
      fireEvent.click(screen.getByRole('button', { name: /Create expense/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onOpenExpense).not.toHaveBeenCalled();
    });

    it('FE-PLANNER-PLACEFORM-070b: a nameless click drops the intent instead of arming the next save', async () => {
      withBudget();
      const onSave = vi.fn().mockResolvedValue({ id: 42 });
      const onOpenExpense = vi.fn();
      render(<PlaceFormModal {...defaultProps} onSave={onSave} onOpenExpense={onOpenExpense} />);

      // No name yet — the save is refused and the intent must not survive it.
      fireEvent.click(screen.getByRole('button', { name: /Create expense/i }));
      await waitFor(() => expect(onSave).not.toHaveBeenCalled());

      fireEvent.change(screen.getByPlaceholderText(/e\.g\. Eiffel Tower/i), { target: { value: 'Louvre' } });
      fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(onOpenExpense).not.toHaveBeenCalled();
    });

    it('FE-PLANNER-PLACEFORM-071: an already-linked expense is shown with its amount instead of the button', () => {
      withBudget();
      seedStore(useTripStore, {
        trip: buildTrip({ id: 1 }),
        budgetItems: [{ id: 8, trip_id: 1, name: 'Louvre tickets', total_price: 34, category: 'activities', place_id: 7 }],
      });
      render(<PlaceFormModal {...defaultProps} place={{ id: 7, name: 'Louvre' } as never} />);

      expect(screen.getByText('Louvre tickets')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Create expense/i })).not.toBeInTheDocument();
    });

    it('FE-PLANNER-PLACEFORM-072: an expense linked to another place is not claimed', () => {
      withBudget();
      seedStore(useTripStore, {
        trip: buildTrip({ id: 1 }),
        budgetItems: [{ id: 8, trip_id: 1, name: 'Orsay tickets', total_price: 16, category: 'activities', place_id: 99 }],
      });
      render(<PlaceFormModal {...defaultProps} place={{ id: 7, name: 'Louvre' } as never} />);

      expect(screen.queryByText('Orsay tickets')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Create expense/i })).toBeInTheDocument();
    });
  });
});
