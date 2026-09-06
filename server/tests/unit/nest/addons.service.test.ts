import { describe, it, expect, vi, beforeEach } from 'vitest';

// Three distinct prepare(...).all() reads (addons, photo_providers, photo_provider_fields).
// A single shared statement is reused, so .all() is fed result sets in call order.
const { dbMock } = vi.hoisted(() => {
  const stmt = { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() };
  return { dbMock: { prepare: vi.fn(() => stmt), _stmt: stmt } };
});
vi.mock('../../../src/db/database', () => ({ db: dbMock, closeDb: () => {}, reinitialize: () => {} }));
import { db as dbConn } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';

const { getPhotoProviderConfig } = vi.hoisted(() => ({ getPhotoProviderConfig: vi.fn(() => ({})) }));
vi.mock('../../../src/nest/memories/memories.helpers', () => ({ getPhotoProviderConfig }));

import { AddonsService } from '../../../src/nest/addons/addons.service';

function svc() {
  return new AddonsService(new DatabaseService(dbConn));
}

type ListAddon = ReturnType<AddonsService['list']>['addons'][number];

type PhotoProviderField = {
  key: string;
  label: string;
  input_type: string;
  placeholder: string;
  hint: string | null;
  required: boolean;
  secret: boolean;
  settings_key: string | null;
  payload_key: string | null;
  sort_order: number;
};

// list() spreads plain addons and photo providers into one array, and a provider
// object structurally extends a plain one. TypeScript reduces the element union
// to the plain shape, so `config` and `fields` are invisible on res.addons even
// though the provider entries carry them at runtime. Provider assertions read
// the fields through here instead of casting at every call site.
function providerFields(addon: ListAddon): PhotoProviderField[] {
  return (addon as ListAddon & { fields: PhotoProviderField[] }).fields;
}

// Feed list()'s reads in call order: addons, providers, fields (.all), then the
// collab-features rows (.all) and the bag-tracking row (.get) from app_settings.
// The provider query now sits behind an isAddonEnabled(journey) read (.get), fed
// first as enabled so every case below sees its providers.
function feedReads(
  addons: unknown[],
  providers: unknown[],
  fields: unknown[],
  collabRows: unknown[] = [],
  bagRow: { value: string } | undefined = undefined,
) {
  dbMock._stmt.all
    .mockReturnValueOnce(addons)
    .mockReturnValueOnce(providers)
    .mockReturnValueOnce(fields)
    .mockReturnValueOnce(collabRows);
  dbMock._stmt.get.mockReturnValueOnce({ enabled: 1 }).mockReturnValueOnce(bagRow);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock._stmt.all.mockReturnValue([]);
  dbMock._stmt.get.mockReturnValue(undefined);
  getPhotoProviderConfig.mockReturnValue({});
});

describe('AddonsService.list', () => {
  it('returns the collab features and the bag-tracking flag from app_settings', () => {
    feedReads([], [], [], [{ key: 'collab_chat_enabled', value: 'false' }], { value: 'true' });

    const res = svc().list();
    expect(res.collabFeatures).toEqual({ chat: false, notes: true, polls: true, whatsnext: true });
    expect(res.bagTracking).toBe(true);
    expect(res.addons).toEqual([]);
  });

  it('coerces the addon enabled column to a boolean (both 1 and 0)', () => {
    feedReads(
      [
        { id: 'atlas', name: 'Atlas', type: 'page', icon: 'globe', enabled: 1 },
        { id: 'vacay', name: 'Vacay', type: 'page', icon: 'sun', enabled: 0 },
      ],
      [],
      [],
    );

    const res = svc().list();
    expect(res.addons).toEqual([
      { id: 'atlas', name: 'Atlas', type: 'page', icon: 'globe', enabled: true },
      { id: 'vacay', name: 'Vacay', type: 'page', icon: 'sun', enabled: false },
    ]);
  });

  it('maps a photo provider with no fields to an empty fields array (the || [] fallback)', () => {
    feedReads(
      [],
      [{ id: 'immich', name: 'Immich', icon: 'image', enabled: 1, sort_order: 0 }],
      [],
    );
    getPhotoProviderConfig.mockReturnValue({ baseUrl: 'http://x' });

    const res = svc().list();
    expect(res.addons).toEqual([
      {
        id: 'immich',
        name: 'Immich',
        type: 'photo_provider',
        icon: 'image',
        enabled: true,
        config: { baseUrl: 'http://x' },
        fields: [],
      },
    ]);
    expect(getPhotoProviderConfig).toHaveBeenCalledWith('immich');
  });

  it('coerces a disabled photo provider enabled flag to false', () => {
    feedReads(
      [],
      [{ id: 'synology', name: 'Synology', icon: 'image', enabled: 0, sort_order: 1 }],
      [],
    );

    const res = svc().list();
    expect((res.addons[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it('groups multiple fields under their provider and keeps insertion order', () => {
    feedReads(
      [],
      [{ id: 'immich', name: 'Immich', icon: 'image', enabled: 1, sort_order: 0 }],
      [
        {
          provider_id: 'immich',
          field_key: 'url',
          label: 'URL',
          input_type: 'text',
          placeholder: 'https://',
          hint: 'Base URL',
          required: 1,
          secret: 0,
          settings_key: 'immich_url',
          payload_key: 'url',
          sort_order: 0,
        },
        // Second field for the SAME provider exercises the `get(...) || []` truthy branch.
        {
          provider_id: 'immich',
          field_key: 'token',
          label: 'Token',
          input_type: 'password',
          placeholder: null,
          hint: null,
          required: 0,
          secret: 1,
          settings_key: null,
          payload_key: null,
          sort_order: 1,
        },
      ],
    );

    const res = svc().list();
    expect(providerFields(res.addons[0])).toEqual([
      {
        key: 'url',
        label: 'URL',
        input_type: 'text',
        placeholder: 'https://',
        hint: 'Base URL',
        required: true,
        secret: false,
        settings_key: 'immich_url',
        payload_key: 'url',
        sort_order: 0,
      },
      {
        key: 'token',
        label: 'Token',
        input_type: 'password',
        placeholder: '',
        hint: null,
        required: false,
        secret: true,
        settings_key: null,
        payload_key: null,
        sort_order: 1,
      },
    ]);
  });

  it('falls back placeholder→"", hint→null, settings/payload keys→null when columns are missing/empty', () => {
    feedReads(
      [],
      [{ id: 'p', name: 'P', icon: 'i', enabled: 1, sort_order: 0 }],
      [
        {
          provider_id: 'p',
          field_key: 'k',
          label: 'L',
          input_type: 'text',
          // placeholder/hint/settings_key/payload_key omitted entirely (undefined)
          required: 0,
          secret: 0,
          sort_order: 0,
        },
      ],
    );

    const res = svc().list();
    const field = providerFields(res.addons[0])[0];
    expect(field).toMatchObject({
      placeholder: '',
      hint: null,
      settings_key: null,
      payload_key: null,
    });
  });

  it('keeps fields belonging to other providers out of a provider with none of its own', () => {
    // A field exists, but for a DIFFERENT provider than the one returned — exercises
    // the `fieldsByProvider.get(p.id) || []` fallback while the map is non-empty.
    feedReads(
      [],
      [{ id: 'has-none', name: 'X', icon: 'i', enabled: 1, sort_order: 0 }],
      [
        {
          provider_id: 'other',
          field_key: 'k',
          label: 'L',
          input_type: 'text',
          required: 0,
          secret: 0,
          sort_order: 0,
        },
      ],
    );

    const res = svc().list();
    expect(providerFields(res.addons[0])).toEqual([]);
  });

  it('concatenates regular addons before the photo providers', () => {
    feedReads(
      [{ id: 'atlas', name: 'Atlas', type: 'page', icon: 'globe', enabled: 1 }],
      [{ id: 'immich', name: 'Immich', icon: 'image', enabled: 1, sort_order: 0 }],
      [],
    );

    const res = svc().list();
    expect(res.addons.map((a) => (a as { id: string }).id)).toEqual(['atlas', 'immich']);
    expect((res.addons[1] as { type: string }).type).toBe('photo_provider');
  });

  it('drops the photo providers while the journey addon is off, whatever their rows say', () => {
    // The journey gate (.get) answers disabled, so the provider query is never
    // made and the .all chain shortens to addons, fields, collab.
    dbMock._stmt.get.mockReturnValueOnce({ enabled: 0 });
    dbMock._stmt.all
      .mockReturnValueOnce([{ id: 'atlas', name: 'Atlas', type: 'page', icon: 'globe', enabled: 1 }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    const res = svc().list();
    expect(res.addons).toEqual([{ id: 'atlas', name: 'Atlas', type: 'page', icon: 'globe', enabled: true }]);
    const providerReads = (dbMock.prepare.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('FROM photo_providers'));
    expect(providerReads).toEqual([]);
  });
});

// Direct coverage of the enablement reads/writers relocated from
// services/adminService (finding `admin-1`). The polarity asymmetry is on
// purpose: bag tracking is opt-in (=== 'true'), collab flags opt-out (!== 'false').
describe('AddonsService addon/feature flags', () => {
  it('isAddonEnabled coerces the enabled column (1/0/missing row)', () => {
    dbMock._stmt.get.mockReturnValueOnce({ enabled: 1 });
    expect(svc().isAddonEnabled('budget')).toBe(true);
    dbMock._stmt.get.mockReturnValueOnce({ enabled: 0 });
    expect(svc().isAddonEnabled('budget')).toBe(false);
    dbMock._stmt.get.mockReturnValueOnce(undefined);
    expect(svc().isAddonEnabled('nope')).toBe(false);
  });

  it('getBagTracking is opt-in: only the literal string true enables it', () => {
    dbMock._stmt.get.mockReturnValueOnce({ value: 'true' });
    expect(svc().getBagTracking()).toEqual({ enabled: true });
    dbMock._stmt.get.mockReturnValueOnce({ value: 'false' });
    expect(svc().getBagTracking()).toEqual({ enabled: false });
    dbMock._stmt.get.mockReturnValueOnce(undefined); // absent row → OFF
    expect(svc().getBagTracking()).toEqual({ enabled: false });
  });

  it('updateBagTracking persists true/false strings and echoes the flag (ADMIN-SVC-030)', () => {
    expect(svc().updateBagTracking(true)).toEqual({ enabled: true });
    expect(dbMock._stmt.run).toHaveBeenCalledWith('true');
    expect(svc().updateBagTracking(false)).toEqual({ enabled: false });
    expect(dbMock._stmt.run).toHaveBeenCalledWith('false');
  });

  it('getCollabFeatures is opt-out: absent rows default ON, only false disables', () => {
    dbMock._stmt.all.mockReturnValueOnce([
      { key: 'collab_chat_enabled', value: 'false' },
      { key: 'collab_polls_enabled', value: 'true' },
    ]);
    expect(svc().getCollabFeatures()).toEqual({ chat: false, notes: true, polls: true, whatsnext: true });
  });

  it('updateCollabFeatures writes only the provided flags and reports changed (#1414, ADMIN-SVC-070)', () => {
    // before-read: all default ON; after-read: chat flipped off → changed
    dbMock._stmt.all.mockReturnValueOnce([]).mockReturnValueOnce([{ key: 'collab_chat_enabled', value: 'false' }]);
    const first = svc().updateCollabFeatures({ chat: false });
    expect(first.changed).toBe(true);
    expect(first.features.chat).toBe(false);
    expect(dbMock._stmt.run).toHaveBeenCalledTimes(1);
    expect(dbMock._stmt.run).toHaveBeenCalledWith('collab_chat_enabled', 'false');

    // identical save → before and after read the same → no change, MCP sessions must survive
    dbMock._stmt.run.mockClear();
    dbMock._stmt.all
      .mockReturnValueOnce([{ key: 'collab_chat_enabled', value: 'false' }])
      .mockReturnValueOnce([{ key: 'collab_chat_enabled', value: 'false' }]);
    const second = svc().updateCollabFeatures({ chat: false });
    expect(second.changed).toBe(false);
    expect(dbMock._stmt.run).toHaveBeenCalledWith('collab_chat_enabled', 'false');

    // undefined flags are not written
    dbMock._stmt.run.mockClear();
    dbMock._stmt.all.mockReturnValueOnce([]).mockReturnValueOnce([]);
    const third = svc().updateCollabFeatures({});
    expect(third.changed).toBe(false);
    expect(dbMock._stmt.run).not.toHaveBeenCalled();
  });
});

/**
 * The three places flags moved here from AdminService, where they were raw
 * app_settings SQL sitting next to flags that already delegated to this service.
 * They are fail-CLOSED (`=== 'true'`), matching getBagTracking: unset used to read as
 * ON (`!== 'false'`), and a migration backfills 'true' for existing installs so
 * nobody loses a feature on upgrade.
 */
describe('AddonsService places flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases = [
    ['getPlacesPhotos', 'updatePlacesPhotos', 'places_photos_enabled'],
    ['getPlacesAutocomplete', 'updatePlacesAutocomplete', 'places_autocomplete_enabled'],
    ['getPlacesDetails', 'updatePlacesDetails', 'places_details_enabled'],
  ] as const;

  it('ADDONS-SVC-080 an unset flag reads as OFF, and anything but the literal true does too', () => {
    for (const [getter, , key] of cases) {
      dbMock._stmt.get.mockReturnValueOnce(undefined);
      expect(svc()[getter]()).toEqual({ enabled: false });
      expect(dbMock.prepare).toHaveBeenLastCalledWith('SELECT value FROM app_settings WHERE key = ?');
      expect(dbMock._stmt.get).toHaveBeenLastCalledWith(key);

      dbMock._stmt.get.mockReturnValueOnce({ value: 'garbage' });
      expect(svc()[getter]()).toEqual({ enabled: false });
    }
  });

  it('ADDONS-SVC-081 a stored "true" reads as ON', () => {
    for (const [getter] of cases) {
      dbMock._stmt.get.mockReturnValueOnce({ value: 'true' });
      expect(svc()[getter]()).toEqual({ enabled: true });
    }
  });

  it('ADDONS-SVC-082 the setters persist the literal string and echo the boolean back', () => {
    for (const [, setter, key] of cases) {
      expect(svc()[setter](true)).toEqual({ enabled: true });
      expect(dbMock._stmt.run).toHaveBeenLastCalledWith(key, 'true');
      expect(svc()[setter](false)).toEqual({ enabled: false });
      expect(dbMock._stmt.run).toHaveBeenLastCalledWith(key, 'false');
    }
  });
});

/**
 * Enrichment sits beside the three above and reads the opposite way round.
 *
 * They are fail-closed because a migration backfilled a row for every install
 * that predates the change. This one is new: there is nothing to backfill, so
 * fail-open reaches the same place without a migration for one boolean. What
 * matters is that it agrees with PlaceEnrichmentService.enrichDisabled(), which
 * reads the same key — if the two ever diverge the panel shows "off" while the
 * feature runs.
 */
describe('AddonsService places enrichment flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ADDONS-SVC-083 an unset flag reads as ON', () => {
    dbMock._stmt.get.mockReturnValueOnce(undefined);
    expect(svc().getPlacesEnrich()).toEqual({ enabled: true });
  });

  it('ADDONS-SVC-084 only the literal "false" switches it off', () => {
    dbMock._stmt.get.mockReturnValueOnce({ value: 'false' });
    expect(svc().getPlacesEnrich()).toEqual({ enabled: false });

    for (const value of ['true', 'garbage', '']) {
      dbMock._stmt.get.mockReturnValueOnce({ value });
      expect(svc().getPlacesEnrich()).toEqual({ enabled: true });
    }
  });

  it('ADDONS-SVC-085 the setter persists the literal string and echoes the boolean back', () => {
    expect(svc().updatePlacesEnrich(false)).toEqual({ enabled: false });
    expect(dbMock._stmt.run).toHaveBeenLastCalledWith('places_enrich_enabled', 'false');
    expect(svc().updatePlacesEnrich(true)).toEqual({ enabled: true });
    expect(dbMock._stmt.run).toHaveBeenLastCalledWith('places_enrich_enabled', 'true');
  });
});

/**
 * The transit backend (#1699) is a name, not a flag, so it needs the
 * unrecognised-value case the booleans get for free: anything that is not a
 * known provider must read as Transitous rather than silently billing the
 * install's Google key.
 */
describe('AddonsService transit provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ADDONS-SVC-086 an unset provider reads as Transitous, with no key anywhere', () => {
    dbMock._stmt.get.mockReturnValue(undefined);
    expect(svc().getTransitProvider()).toEqual({ provider: 'transitous', googleKeySource: null });
  });

  it('ADDONS-SVC-087 only a known provider name is honoured', () => {
    dbMock._stmt.get.mockReturnValueOnce({ value: 'google' }).mockReturnValue(undefined);
    expect(svc().getTransitProvider().provider).toBe('google');

    for (const value of ['someday-maps', '', 'GOOGLE']) {
      dbMock._stmt.get.mockReset();
      dbMock._stmt.get.mockReturnValueOnce({ value }).mockReturnValue(undefined);
      expect(svc().getTransitProvider().provider).toBe('transitous');
    }
  });

  it('ADDONS-SVC-088 the setter persists the name and echoes it back', () => {
    dbMock._stmt.get.mockReturnValue(undefined);
    expect(svc().updateTransitProvider('google').provider).toBe('google');
    expect(dbMock._stmt.run).toHaveBeenLastCalledWith('transit_provider', 'google');
    expect(svc().updateTransitProvider('transitous').provider).toBe('transitous');
    expect(dbMock._stmt.run).toHaveBeenLastCalledWith('transit_provider', 'transitous');
  });

  /**
   * The warning the admin panel renders is driven entirely by this field, so
   * the instance/user-row split is the part worth pinning: only 'user-row'
   * means "works for this admin, Transitous for everybody else".
   */
  it('ADDONS-SVC-089 reports where the Google key resolved from', () => {
    // provider row, then the instance maps_api_key row.
    dbMock._stmt.get.mockReset();
    dbMock._stmt.get.mockReturnValueOnce({ value: 'google' }).mockReturnValueOnce({ value: 'instance-key' });
    expect(svc().getTransitProvider(7).googleKeySource).toBe('instance');

    // No instance row, but the caller's own users column has one.
    dbMock._stmt.get.mockReset();
    dbMock._stmt.get
      .mockReturnValueOnce({ value: 'google' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ maps_api_key: 'personal-key' });
    expect(svc().getTransitProvider(7).googleKeySource).toBe('user-row');

    // Nothing anywhere.
    dbMock._stmt.get.mockReset();
    dbMock._stmt.get.mockReturnValue(undefined);
    expect(svc().getTransitProvider(7).googleKeySource).toBeNull();
  });
});
