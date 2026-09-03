/**
 * The read-side plugin service + controller (#plugins, M0). Lists installed
 * plugins and reports whether the runtime is enabled (TREK_PLUGINS_ENABLED).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE plugins (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT, icon TEXT, version TEXT,
    status TEXT, enabled INTEGER DEFAULT 0, last_error TEXT, reviewed_at TEXT, source_repo TEXT, config TEXT DEFAULT '{}', permissions TEXT DEFAULT '[]', granted_permissions TEXT DEFAULT '[]', capabilities TEXT DEFAULT '{}', dependencies TEXT DEFAULT '{}', operator_egress INTEGER DEFAULT 0, updated_at TEXT,
    author_pubkey TEXT, update_block_code TEXT, update_block_detail TEXT, update_block_version TEXT,
    trek_range TEXT, sort_order INTEGER DEFAULT 0, update_hold INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE plugin_settings_fields (plugin_id TEXT, field_key TEXT, scope TEXT, secret INTEGER, required INTEGER DEFAULT 0, input_type TEXT DEFAULT 'text', default_value TEXT);
    CREATE TABLE plugin_error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, level TEXT, message TEXT, ts TEXT DEFAULT '2026-01-01');`);
  return { testDb: db };
});
vi.mock('../../../src/db/database', () => ({ db: testDb }));
import { db as dbConn } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';

import { AddonsService } from '../../../src/nest/addons/addons.service';
import { PluginsService } from '../../../src/nest/plugins/plugins.service';
import { PluginsController } from '../../../src/nest/plugins/plugins.controller';
import { PluginsFeedController } from '../../../src/nest/plugins/plugins-feed.controller';
import type { RuntimeEnvService } from '../../../src/nest/app-config/runtime-env.service';

beforeEach(() => {
  testDb.exec('DELETE FROM plugins');
  testDb.exec('DELETE FROM plugin_settings_fields');
  delete process.env.TREK_PLUGINS_ENABLED;
});
afterEach(() => {
  delete process.env.TREK_PLUGINS_ENABLED;
});

describe('PluginsService.list', () => {
  it('returns the installed plugins and the runtime-enabled flag', () => {
    testDb
      .prepare('INSERT INTO plugins (id, name, description, type, status, version) VALUES (?,?,?,?,?,?)')
      .run('flight', 'Flight', 'desc', 'widget', 'inactive', '1.0.0');
    process.env.TREK_PLUGINS_ENABLED = 'true';

    const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
    expect(out.enabled).toBe(true);
    expect(out.plugins).toHaveLength(1);
    expect(out.plugins[0]).toMatchObject({ id: 'flight', name: 'Flight', status: 'inactive' });
  });

  describe('TREK-range bypass', () => {
    const APP_VERSION = process.env.APP_VERSION;
    afterEach(() => {
      delete process.env.TREK_PLUGINS_IGNORE_TREK_RANGE;
      if (APP_VERSION === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = APP_VERSION;
    });
    const seed = () =>
      testDb
        .prepare("INSERT INTO plugins (id, name, type, status, version, trek_range) VALUES ('old','Old','widget','inactive','1.0.0','>=3.0.0 <4.0.0')")
        .run();

    it('reports the switch off and an outgrown plugin as hostIncompatible by default', () => {
      process.env.APP_VERSION = '4.1.0';
      seed();
      const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
      expect(out.ignoreTrekRange).toBe(false);
      expect(out.plugins[0]).toMatchObject({ dependencyStatus: 'hostIncompatible', trekRangeBypassed: null });
    });

    it('with the switch on, the plugin may activate but the row still says it is outside its range', () => {
      process.env.APP_VERSION = '4.1.0';
      process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
      seed();
      const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
      expect(out.ignoreTrekRange).toBe(true);
      expect(out.plugins[0]).toMatchObject({
        dependencyStatus: 'ok',
        trekRangeBypassed: { trekRange: '>=3.0.0 <4.0.0', hostVersion: '4.1.0' },
      });
    });

    it('a plugin inside its range carries no marker even with the switch on', () => {
      process.env.APP_VERSION = '3.5.0';
      process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
      seed();
      const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
      expect(out.plugins[0]).toMatchObject({ dependencyStatus: 'ok', trekRangeBypassed: null });
    });
  });

  it('surfaces updateHold as a boolean (held plugins leave the update banner)', () => {
    testDb
      .prepare("INSERT INTO plugins (id, name, type, status, version, update_hold) VALUES ('held','Held','widget','inactive','1.0.0',1)")
      .run();
    testDb
      .prepare("INSERT INTO plugins (id, name, type, status, version) VALUES ('free','Free','widget','inactive','1.0.0')")
      .run();

    const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
    expect(out.plugins.find((p) => p.id === 'held')).toMatchObject({ updateHold: true });
    expect(out.plugins.find((p) => p.id === 'free')).toMatchObject({ updateHold: false });
  });

  it('resumeUpdates clears the hold and reports whether the plugin existed', () => {
    testDb
      .prepare("INSERT INTO plugins (id, name, type, status, version, update_hold) VALUES ('held','Held','widget','inactive','1.0.0',1)")
      .run();
    const svc = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn)));

    expect(svc.resumeUpdates('held')).toBe(true);
    expect(testDb.prepare("SELECT update_hold FROM plugins WHERE id='held'").get()).toMatchObject({ update_hold: 0 });
    expect(svc.resumeUpdates('ghost')).toBe(false);
  });

  it('reports enabled by default (no kill switch set)', () => {
    testDb
      .prepare('INSERT INTO plugins (id, name, description, type, status, version) VALUES (?,?,?,?,?,?)')
      .run('flight', 'Flight', 'desc', 'widget', 'inactive', '1.0.0');

    const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
    expect(out.enabled).toBe(true);
    expect(out.plugins).toHaveLength(1);
  });

  it('reports disabled when the kill switch is off (TREK_PLUGINS_ENABLED=false)', () => {
    process.env.TREK_PLUGINS_ENABLED = 'false';
    const out = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list();
    expect(out.enabled).toBe(false);
    expect(out.plugins).toEqual([]);
  });

  // The four trust states an admin can be in. `signed` derives from the TOFU-pinned
  // author key; sideloaded/dev-linked derive from source_repo — so they are NOT
  // mutually exclusive in the data, and a sideloaded plugin legitimately reports
  // signed:false. The UI's precedence rule (source badge wins) depends on that being
  // reported honestly rather than papered over here.
  describe('signature status', () => {
    const insert = (id: string, sourceRepo: string | null, pubkey: string | null) =>
      testDb
        .prepare('INSERT INTO plugins (id, name, type, status, version, source_repo, author_pubkey) VALUES (?,?,?,?,?,?,?)')
        .run(id, id, 'widget', 'inactive', '1.0.0', sourceRepo, pubkey);

    it('reports signed + a display fingerprint for a registry plugin with a pinned key', () => {
      const key = 'RWTvBn0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd';
      insert('signed-one', 'acme/signed-one', key);

      const p = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list().plugins[0];
      expect(p.signed).toBe(true);
      // Short head…tail, for eyeballing against what the author reads out over the
      // phone. NOT a confidentiality measure — the key is public, and the re-trust
      // round-trip deliberately carries it in full.
      expect(p.keyFingerprint).toBe(`${key.slice(0, 8)}…${key.slice(-8)}`);
    });

    it('reports unsigned for a registry plugin with no pinned key', () => {
      insert('plain', 'acme/plain', null);
      const p = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list().plugins[0];
      expect(p.signed).toBe(false);
      expect(p.keyFingerprint).toBeNull();
    });

    it('reports unsigned for a sideloaded and a dev-linked plugin (they carry no key)', () => {
      insert('uploaded', 'local:upload', null);
      insert('linked', 'local:link', null);
      const plugins = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list().plugins;
      expect(plugins.map((p) => [p.id, p.signed, p.source_repo])).toEqual([
        ['linked', false, 'local:link'],
        ['uploaded', false, 'local:upload'],
      ]);
    });

    it('surfaces a recorded update block, and reports none when there is none', () => {
      insert('blocked', 'acme/blocked', 'RWTvBn0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd');
      insert('fine', 'acme/fine', null);
      testDb
        .prepare('UPDATE plugins SET update_block_code = ?, update_block_detail = ?, update_block_version = ? WHERE id = ?')
        .run('SIGNATURE_KEY_CHANGED', 'the key changed', '2.0.0', 'blocked');

      const byId = Object.fromEntries(new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list().plugins.map((p) => [p.id, p]));
      expect(byId.blocked.updateBlock).toEqual({ code: 'SIGNATURE_KEY_CHANGED', detail: 'the key changed', version: '2.0.0' });
      expect(byId.fine.updateBlock).toBeNull();
    });

    it('never leaks the raw pinned key into the list response (only the fingerprint)', () => {
      insert('signed-one', 'acme/signed-one', 'RWTvBn0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd');
      // PluginListItem is an interface, so it has no implicit index signature and cannot
      // be narrowed to a record directly. Widening through unknown is what lets this case
      // probe for a key the contract deliberately does not declare.
      const p = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).list()
        .plugins[0] as unknown as Record<string, unknown>;
      expect(p.author_pubkey).toBeUndefined();
    });
  });

  it('controller delegates to the service', () => {
    const svc = { list: vi.fn(() => ({ enabled: false, plugins: [] })) } as unknown as PluginsService;
    const runtime = {} as unknown as import('../../../src/nest/plugins/plugin-runtime.service').PluginRuntimeService;
    const res = new PluginsController(svc, runtime, {} as never, { isManaged: () => false } as unknown as RuntimeEnvService).list();
    expect(svc.list).toHaveBeenCalled();
    expect(res).toEqual({ enabled: false, plugins: [] });
  });
});

describe('PluginsFeedController (client feed)', () => {
  it('returns active plugins when enabled, nothing when disabled', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status) VALUES ('w','W','widget','Box','active')").run();
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status) VALUES ('i','I','integration','Plug','inactive')").run();
    const feed = new PluginsFeedController(new DatabaseService(dbConn));

    process.env.TREK_PLUGINS_ENABLED = 'true';
    const active = feed.list();
    expect(active.plugins).toEqual([{ id: 'w', name: 'W', type: 'widget', icon: 'Box', slot: 'sidebar' }]);

    process.env.TREK_PLUGINS_ENABLED = 'false';
    expect(feed.list().plugins).toEqual([]);
  });

  it('exposes the widget slot from capabilities (hero) and defaults on bad JSON', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('h','H','widget','Box','active','{\"widget\":{\"slot\":\"hero\"}}')").run();
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('b','B','widget','Box','active','not-json')").run();
    process.env.TREK_PLUGINS_ENABLED = 'true';
    const out = new PluginsFeedController(new DatabaseService(dbConn)).list();
    expect(out.plugins.find((p) => p.id === 'h')?.slot).toBe('hero');
    expect(out.plugins.find((p) => p.id === 'b')?.slot).toBe('sidebar');
  });

  it('exposes the day-detail slot (a day-panel widget must not fall back to the dashboard)', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('d','D','widget','Box','active','{\"widget\":{\"slot\":\"day-detail\"}}')").run();
    process.env.TREK_PLUGINS_ENABLED = 'true';
    expect(new PluginsFeedController(new DatabaseService(dbConn)).list().plugins.find((p) => p.id === 'd')?.slot).toBe('day-detail');
  });

  it('exposes settingsUi only when the capability is exactly true', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('su','S','widget','Box','active','{\"settingsUi\":true}')").run();
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('no','N','widget','Box','active','{\"settingsUi\":\"yes\"}')").run();
    process.env.TREK_PLUGINS_ENABLED = 'true';
    const out = new PluginsFeedController(new DatabaseService(dbConn)).list();
    expect(out.plugins.find((p) => p.id === 'su')?.settingsUi).toBe(true);
    expect(out.plugins.find((p) => p.id === 'no')?.settingsUi).toBeUndefined();
  });

  it('exposes the reservation-detail slot (a booking-card widget must not fall back to the dashboard)', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('r','R','widget','Box','active','{\"widget\":{\"slot\":\"reservation-detail\"}}')").run();
    process.env.TREK_PLUGINS_ENABLED = 'true';
    expect(new PluginsFeedController(new DatabaseService(dbConn)).list().plugins.find((p) => p.id === 'r')?.slot).toBe('reservation-detail');
  });

  it('exposes tripPage for trip-page plugins, re-validated against the replaceable-tab whitelist', () => {
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('t','T','trip-page','Box','active','{\"tripPage\":{\"replaces\":[\"transports\",\"buchungen\"],\"position\":1}}')").run();
    // a hand-edited row trying to hide 'plan' (or junk) is filtered here, not just at install
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('evil','E','trip-page','Box','active','{\"tripPage\":{\"replaces\":[\"plan\",\"nope\"],\"position\":-3}}')").run();
    // the capability is meaningless off a trip-page and must not leak onto widgets
    testDb.prepare("INSERT INTO plugins (id, name, type, icon, status, capabilities) VALUES ('w2','W2','widget','Box','active','{\"tripPage\":{\"replaces\":[\"transports\"]}}')").run();
    process.env.TREK_PLUGINS_ENABLED = 'true';
    const out = new PluginsFeedController(new DatabaseService(dbConn)).list();
    expect(out.plugins.find((p) => p.id === 't')?.tripPage).toEqual({ replaces: ['transports', 'buchungen'], position: 1 });
    expect(out.plugins.find((p) => p.id === 'evil')?.tripPage).toBeUndefined();
    expect(out.plugins.find((p) => p.id === 'w2')?.tripPage).toBeUndefined();
  });
});

describe('PluginsController M2 endpoints', () => {
  const svc = {
    getInstanceConfig: vi.fn(() => ({ a: 1 })),
    instanceSettingsFields: vi.fn(() => [{ key: 'a' }]),
    updateInstanceConfig: vi.fn(() => ({ a: 2 })),
  } as unknown as PluginsService;
  // None of the endpoints below carry the marker, so the ordinary install is the
  // whole story here; the refusals have their own tests.
  const envStub = { isManaged: () => false } as unknown as RuntimeEnvService;

  beforeEach(() => {
    (svc.getInstanceConfig as ReturnType<typeof vi.fn>).mockClear();
    (svc.updateInstanceConfig as ReturnType<typeof vi.fn>).mockClear();
    process.env.TREK_PLUGINS_ENABLED = 'true';
  });

  it('get/update config delegate to the service (get carries the form fields, update the restart)', async () => {
    const rt = { activate: vi.fn(), deactivate: vi.fn(), isActive: vi.fn(), respawnIfActive: vi.fn(async () => false), actionsOf: vi.fn(() => []) } as never;
    const c = new PluginsController(svc, rt, {} as never, envStub);
    expect(c.getConfig('x')).toEqual({ fields: [{ key: 'a' }], config: { a: 1 }, actions: [] });
    expect(await c.updateConfig('x', { a: 2 })).toEqual({ config: { a: 2 }, restarted: false });
  });

  it('activate spawns via the runtime when enabled', async () => {
    const rt = { activate: vi.fn(async () => {}), isActive: vi.fn(() => true) } as never;
    const out = await new PluginsController(svc, rt, {} as never, envStub).activate('x', {});
    expect(out).toEqual({ status: 'active' });
  });

  it('activate is 503 when the runtime is disabled', async () => {
    process.env.TREK_PLUGINS_ENABLED = 'false';
    const rt = { activate: vi.fn(), isActive: vi.fn() } as never;
    await expect(new PluginsController(svc, rt, {} as never, envStub).activate('x', {})).rejects.toMatchObject({ status: 503 });
  });

  it('activate surfaces an activation error as 400', async () => {
    const rt = { activate: vi.fn(async () => { throw new Error('bad code'); }), isActive: vi.fn(() => false) } as never;
    await expect(new PluginsController(svc, rt, {} as never, envStub).activate('x', {})).rejects.toMatchObject({ status: 400 });
  });

  it('deactivate stops the plugin (and cascades to dependents)', async () => {
    const deactivateWithDependents = vi.fn(async () => ['x']);
    const rt = { deactivateWithDependents } as never;
    expect(await new PluginsController(svc, rt, {} as never, envStub).deactivate('x')).toEqual({ status: 'inactive' });
    expect(deactivateWithDependents).toHaveBeenCalledWith('x');
  });
});

describe('PluginsService instance config', () => {
  it('encrypts secret fields on write and masks them on read; keeps plaintext for non-secrets', () => {
    testDb.prepare("INSERT INTO plugins (id, name, status, config) VALUES ('x','X','inactive','{}')").run();
    testDb.prepare("INSERT INTO plugin_settings_fields (plugin_id, field_key, scope, secret) VALUES ('x','api_key','instance',1)").run();
    testDb.prepare("INSERT INTO plugin_settings_fields (plugin_id, field_key, scope, secret) VALUES ('x','server','instance',0)").run();

    const svc = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn)));
    const masked = svc.updateInstanceConfig('x', { api_key: 'super-secret', server: 'https://h' });
    // client gets the masked view
    expect(masked.api_key).toBe('••••••••');
    expect(masked.server).toBe('https://h');

    // stored value is encrypted, not plaintext
    const stored = JSON.parse((testDb.prepare("SELECT config FROM plugins WHERE id='x'").get() as { config: string }).config);
    expect(stored.api_key).not.toBe('super-secret');
    expect(String(stored.api_key)).toMatch(/^enc:/);
    expect(stored.server).toBe('https://h');

    // an unchanged mask does not overwrite the stored secret
    svc.updateInstanceConfig('x', { api_key: '••••••••' });
    const still = JSON.parse((testDb.prepare("SELECT config FROM plugins WHERE id='x'").get() as { config: string }).config);
    expect(still.api_key).toBe(stored.api_key);

    expect(svc.getInstanceConfig('x').api_key).toBe('••••••••');
  });

  it('drops a key the plugin never declared, like the user-scope sibling does', () => {
    testDb.prepare("INSERT INTO plugins (id, name, status, config) VALUES ('y','Y','inactive','{}')").run();
    testDb.prepare("INSERT INTO plugin_settings_fields (plugin_id, field_key, scope, secret) VALUES ('y','server','instance',0)").run();

    const svc = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn)));
    const masked = svc.updateInstanceConfig('y', { server: 'https://h', smuggled: 'nope' });

    expect(masked.server).toBe('https://h');
    expect(masked.smuggled).toBeUndefined();
    const stored = JSON.parse((testDb.prepare("SELECT config FROM plugins WHERE id='y'").get() as { config: string }).config);
    expect(stored).toEqual({ server: 'https://h' });
  });

  it('throws for an unknown plugin', () => {
    expect(() => new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).updateInstanceConfig('nope', {})).toThrow(/not found/);
    expect(() => new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn))).getInstanceConfig('nope')).toThrow(/not found/);
  });
});

describe('PluginsService error log', () => {
  beforeEach(() => testDb.exec('DELETE FROM plugin_error_log'));
  it('lists and clears a plugin error log', () => {
    testDb.prepare("INSERT INTO plugin_error_log (plugin_id, level, message) VALUES ('p','error','boom')").run();
    const svc = new PluginsService(new DatabaseService(dbConn), new AddonsService(new DatabaseService(dbConn)));
    expect(svc.errors('p')).toEqual([{ ts: '2026-01-01', level: 'error', message: 'boom' }]);
    svc.clearErrors('p');
    expect(svc.errors('p')).toEqual([]);
  });
});
