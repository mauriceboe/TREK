/**
 * End-to-end M2: the runtime service activates a plugin from its DB row and its
 * HTTP route works through the host→child invoke path, using its own isolated
 * db. Proves the full activate → route → deactivate loop.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE plugins (
    id TEXT PRIMARY KEY, status TEXT, enabled INTEGER DEFAULT 0, version TEXT, api_version INTEGER DEFAULT 1, permissions TEXT DEFAULT '[]', operator_egress INTEGER DEFAULT 0, granted_permissions TEXT DEFAULT '',
    config TEXT DEFAULT '{}', dependencies TEXT DEFAULT '{}', capabilities TEXT DEFAULT '{}', last_error TEXT, updated_at TEXT,
    -- Activation refuses a plugin that declares no TREK range, so the fixtures default to a
    -- satisfied one: these tests are about permissions/dependencies, and every row would
    -- otherwise fail on the version gate before reaching the behaviour under test. The gate
    -- itself is exercised in "TREK host-version gating" below, with explicit ranges.
    trek_range TEXT DEFAULT '>=3.0.0',
    source_repo TEXT, author_pubkey TEXT, update_block_code TEXT, update_block_detail TEXT, update_block_version TEXT);
    CREATE TABLE plugin_error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, level TEXT, message TEXT, ts TEXT);
    CREATE TABLE plugin_settings_fields (plugin_id TEXT, field_key TEXT, scope TEXT, secret INTEGER, default_value TEXT);
    CREATE TABLE settings (user_id INTEGER, key TEXT, value TEXT);
    CREATE TABLE plugin_entity_metadata (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, entity_type TEXT, entity_id INTEGER, key TEXT, value TEXT, updated_at TEXT);
    CREATE TABLE plugin_user_config (plugin_id TEXT, user_id INTEGER, field_key TEXT, value TEXT, PRIMARY KEY (plugin_id, user_id, field_key));
    CREATE TABLE plugin_oauth_tokens (plugin_id TEXT, user_id INTEGER, access_token TEXT, refresh_token TEXT, expires_at TEXT, scope TEXT, updated_at TEXT, PRIMARY KEY (plugin_id, user_id));
    CREATE TABLE plugin_oauth_state (state TEXT PRIMARY KEY, plugin_id TEXT, user_id INTEGER, verifier TEXT, created_at TEXT);
    CREATE TABLE plugin_meta_migrations (plugin_id TEXT, migration_id TEXT, PRIMARY KEY (plugin_id, migration_id));
    CREATE TABLE plugin_capability_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, acting_user_id INTEGER, method TEXT, resource TEXT, code TEXT, ts TEXT, prev_hash TEXT, hash TEXT);
    CREATE TABLE plugin_scheduled_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT NOT NULL, name TEXT NOT NULL, due_at INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT 'null', every_ms INTEGER, created_at TEXT DEFAULT (datetime('now')), UNIQUE(plugin_id, name));
    CREATE TABLE plugin_user_erasure_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(plugin_id, user_id));
    CREATE TABLE addons (id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0);
    -- The ADMIN audit log. Re-trusting a signing key is precisely the event that has to be
    -- reconstructible after an incident, so the write is asserted rather than assumed —
    -- writeAudit swallows its own failures, so without this table the audit silently did
    -- nothing and every test still passed. No users FK: this slim db has no users table
    -- (writeAudit's resolveUserEmail already degrades to "uid:N" on its own).
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER, action TEXT NOT NULL, resource TEXT, details TEXT, ip TEXT);`);
  return { testDb: db };
});
vi.mock('../../../src/db/database', () => ({ db: testDb, canAccessTrip: () => undefined }));
import { db as dbConn } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';
vi.mock('../../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));

import { PluginRuntimeService, PluginDependencyError } from '../../../src/nest/plugins/plugin-runtime.service';
import { createPluginRuntime } from '../../helpers/plugin-host';
import { DependencyCycleError } from '../../../src/nest/plugins/dependencies';

let codeRoot: string;
let dataRoot: string;
let runtime: PluginRuntimeService;

beforeAll(() => {
  codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-rt-code-'));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trekplug-rt-data-'));
  process.env.TREK_PLUGINS_DIR = codeRoot;
  process.env.TREK_PLUGINS_DATA_DIR = dataRoot;
  process.env.TREK_PLUGINS_ENABLED = 'true';

  const dir = path.join(codeRoot, 'counter', 'server');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `module.exports = {
      async onLoad(ctx) { await ctx.db.migrate('001', 'CREATE TABLE hits (n INTEGER)'); },
      routes: [
        { method: 'GET', path: '/count', auth: true, async handler(req, ctx) {
          await ctx.db.exec('INSERT INTO hits (n) VALUES (1)');
          const rows = await ctx.db.query('SELECT COUNT(*) AS c FROM hits');
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: rows[0].c, user: req.user }) };
        }},
        { method: 'GET', path: '/boom', auth: false, async handler() { throw new Error('route fail'); } },
      ]
    };`,
  );

  testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('counter','active','[\"db:own\"]','{}')").run();
  runtime = createPluginRuntime(new DatabaseService(dbConn));
});

afterAll(async () => {
  await runtime?.deactivate('counter').catch(() => {});
  delete process.env.TREK_PLUGINS_DIR;
  delete process.env.TREK_PLUGINS_DATA_DIR;
  delete process.env.TREK_PLUGINS_ENABLED;
  fs.rmSync(codeRoot, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('PluginRuntimeService (M2 end-to-end)', () => {
  it('activates a plugin and serves its route through the isolated child', async () => {
    await runtime.activate('counter');
    expect(runtime.isActive('counter')).toBe(true);
    expect(runtime.routesOf('counter')).toEqual([
      { i: 0, method: 'GET', path: '/count', auth: true },
      { i: 1, method: 'GET', path: '/boom', auth: false },
    ]);

    const r1 = (await runtime.invoke('counter', 'invoke.route', {
      routeId: 0,
      req: { method: 'GET', path: '/count', query: {}, body: null, user: { id: 5, username: 'ada', isAdmin: false } },
    })) as { status: number; body: string };
    expect(r1.status).toBe(200);
    const parsed = JSON.parse(r1.body);
    expect(parsed.count).toBe(1);
    expect(parsed.user).toEqual({ id: 5, username: 'ada', isAdmin: false });

    // its own db persists across invokes
    const r2 = (await runtime.invoke('counter', 'invoke.route', {
      routeId: 0,
      req: { method: 'GET', path: '/count', query: {}, body: null, user: { id: 5, username: 'ada', isAdmin: false } },
    })) as { body: string };
    expect(JSON.parse(r2.body).count).toBe(2);

    // DB status was persisted active by the supervisor hook
    const row = testDb.prepare("SELECT status FROM plugins WHERE id = 'counter'").get() as { status: string };
    expect(row.status).toBe('active');
  });

  it('invoke on a plugin that is not running rejects', async () => {
    await expect(runtime.invoke('never-activated', 'invoke.route', { routeId: 0, req: {} })).rejects.toThrow(/not active/);
  });

  it('a route that throws surfaces as a rejected invoke', async () => {
    await expect(
      runtime.invoke('counter', 'invoke.route', { routeId: 1, req: { method: 'GET', path: '/boom', query: {}, body: null, user: null } }),
    ).rejects.toThrow(/route fail/);
  });

  it('activate throws for an unknown plugin id', async () => {
    await expect(runtime.activate('ghost')).rejects.toThrow(/not found/);
  });

  it('re-consent gate: activating a consented plugin with WIDER permissions is refused without consent', async () => {
    // consented to db:own; a version now declaring db:read:users too must not auto-grant
    testDb.prepare("INSERT INTO plugins (id, status, permissions, granted_permissions, config) VALUES ('widener','inactive','[\"db:own\",\"db:read:users\"]','[\"db:own\"]','{}')").run();
    await expect(runtime.activate('widener')).rejects.toThrow(/re-consent|new permissions/);
    // the key case: a plugin consented to ZERO perms ('[]') is still "consented" —
    // a later widening to db:own is blocked, not silently granted.
    testDb.prepare("INSERT INTO plugins (id, status, permissions, granted_permissions, config) VALUES ('zeroperm','inactive','[\"db:own\"]','[]','{}')").run();
    await expect(runtime.activate('zeroperm')).rejects.toThrow(/re-consent|new permissions/);
    // (a NEVER-consented plugin — granted '' — consenting to its declared set on
    // first activate is covered by the 'counter' happy-path test above.)
  });

  it('onApplicationBootstrap is a no-op when the runtime is disabled', () => {
    process.env.TREK_PLUGINS_ENABLED = 'false';
    expect(() => createPluginRuntime(new DatabaseService(dbConn)).onApplicationBootstrap()).not.toThrow();
    process.env.TREK_PLUGINS_ENABLED = 'true';
  });

  it('deactivate stops the plugin and clears the enabled intent', async () => {
    await runtime.deactivate('counter');
    expect(runtime.isActive('counter')).toBe(false);
    const row = testDb.prepare("SELECT status, enabled FROM plugins WHERE id = 'counter'").get() as { status: string; enabled: number };
    expect(row.status).toBe('inactive');
    expect(row.enabled).toBe(0);
  });

  it('activate sets the enabled intent so it survives a reboot', async () => {
    await runtime.deactivate('counter');
    await runtime.activate('counter');
    const row = testDb.prepare("SELECT enabled FROM plugins WHERE id = 'counter'").get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('tolerates malformed granted_permissions / config JSON on activate', async () => {
    fs.mkdirSync(path.join(codeRoot, 'messy', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'messy', 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('messy','inactive','not-json','not-json')").run();
    const rt = createPluginRuntime(new DatabaseService(dbConn));
    await rt.activate('messy'); // must not throw despite the garbage JSON
    expect(rt.isActive('messy')).toBe(true);
    await rt.deactivate('messy');
  });

  it('erases and exports a user\'s own-db data through the GDPR hooks', async () => {
    const gdir = path.join(codeRoot, 'gdpr', 'server');
    fs.mkdirSync(gdir, { recursive: true });
    fs.writeFileSync(path.join(gdir, 'index.js'), `module.exports = {
      async onLoad(ctx) { await ctx.db.migrate('001', 'CREATE TABLE prefs (user_id INTEGER, v TEXT)'); },
      routes: [{ method: 'POST', path: '/seed', auth: true, async handler(req, ctx) {
        await ctx.db.exec('INSERT INTO prefs (user_id, v) VALUES (?, ?)', req.user.id, 'x');
        return { status: 200, body: 'ok' };
      }}],
      async exportUserData({ userId }, ctx) { return await ctx.db.query('SELECT v FROM prefs WHERE user_id = ?', userId); },
      async deleteUserData({ userId }, ctx) { await ctx.db.exec('DELETE FROM prefs WHERE user_id = ?', userId); },
    };`);
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('gdpr','active','[\"db:own\",\"hook:user-data\"]','{}')").run();
    await runtime.activate('gdpr');
    // seed a row for user 5
    await runtime.invoke('gdpr', 'invoke.route', { routeId: 0, req: { method: 'POST', path: '/seed', query: {}, body: null, user: { id: 5, username: 'a', isAdmin: false } } });

    // export sees the user's data, aggregated under the plugin id
    expect(await runtime.exportUserData(5)).toEqual([{ pluginId: 'gdpr', data: [{ v: 'x' }] }]);

    // erasure: enqueue (durable) + drain → the plugin deletes its rows and the queue clears
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runtime as any).enqueueUserErasure(5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime as any).drainUserErasures();
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='gdpr'").get()).toMatchObject({ c: 0 });
    // the export is now empty (rows gone), proving the handler ran end-to-end
    expect(await runtime.exportUserData(5)).toEqual([{ pluginId: 'gdpr', data: [] }]);

    await runtime.deactivate('gdpr');
  });

  it('the drain reap keeps a queued erasure while the plugin data dir survives (uninstall keep-data), reaping only once the data is gone', async () => {
    // uninstall(deleteData=false) removes the plugins row but DELIBERATELY keeps the data
    // dir and the queued erasure so a same-id reinstall can still honour it. The orphan
    // reap must not delete that row while the data dir is still present.
    const id = 'reaptest';
    const dir = path.join(dataRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.db'), 'x');
    testDb.prepare('INSERT INTO plugin_user_erasure_queue (plugin_id, user_id) VALUES (?, ?)').run(id, 9);
    // the plugin is gone from the registry (uninstalled) but its data dir remains
    expect(testDb.prepare('SELECT id FROM plugins WHERE id = ?').get(id)).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime as any).drainUserErasures();
    expect((testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='reaptest'").get() as { c: number }).c).toBe(1);

    // now the data is truly gone (deleteData=true / manual removal) → the row is reaped
    fs.rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime as any).drainUserErasures();
    expect((testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='reaptest'").get() as { c: number }).c).toBe(0);
  });

  it('leaves an erasure queued for a plugin that is offline, to run when it is back', async () => {
    // granted the hook but NOT active → enqueue keeps the row, drain leaves it
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('offliner','inactive','[\"db:own\",\"hook:user-data\"]','{}')").run();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runtime as any).enqueueUserErasure(9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime as any).drainUserErasures();
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='offliner' AND user_id=9").get()).toMatchObject({ c: 1 });
    // a plugin WITHOUT the grant is never enqueued in the first place
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='counter' AND user_id=9").get()).toMatchObject({ c: 0 });
  });

  it('onApplicationBootstrap boots every ENABLED plugin — even one left in error state', async () => {
    fs.mkdirSync(path.join(codeRoot, 'booter', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'booter', 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    // status='error' from a previous crash, but enabled=1 → must still boot
    testDb.prepare("INSERT INTO plugins (id, status, enabled, granted_permissions, config) VALUES ('booter','error',1,'[]','{}')").run();

    const rt = createPluginRuntime(new DatabaseService(dbConn));
    rt.onApplicationBootstrap(); // fire-and-forget spawn
    for (let i = 0; i < 40 && !rt.isActive('booter'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(rt.isActive('booter')).toBe(true);
    await rt.deactivate('booter');
  });

  it('onApplicationBootstrap does NOT boot a disabled plugin', async () => {
    fs.mkdirSync(path.join(codeRoot, 'sleeper', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'sleeper', 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb.prepare("INSERT INTO plugins (id, status, enabled, granted_permissions, config) VALUES ('sleeper','inactive',0,'[]','{}')").run();

    const rt = createPluginRuntime(new DatabaseService(dbConn));
    rt.onApplicationBootstrap();
    await new Promise((r) => setTimeout(r, 300));
    expect(rt.isActive('sleeper')).toBe(false);
  });

  it('outboundHostsOf extracts declared http:outbound hosts', () => {
    testDb.prepare("INSERT INTO plugins (id, status, granted_permissions, config) VALUES ('net','inactive','[\"db:own\",\"http:outbound:api.x.com\",\"http:outbound:*.y.com\"]','{}')").run();
    const rt = createPluginRuntime(new DatabaseService(dbConn));
    expect(rt.outboundHostsOf('net')).toEqual(['api.x.com', '*.y.com']);
    expect(rt.outboundHostsOf('missing')).toEqual([]);
  });

  it('uninstall removes the code, DB rows, settings and (with deleteData) data', async () => {
    fs.mkdirSync(path.join(codeRoot, 'gone', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'gone', 'server', 'index.js'), 'module.exports={}');
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('gone','inactive','[]','{}')").run();
    testDb.prepare("INSERT INTO plugin_settings_fields (plugin_id, field_key, scope, secret) VALUES ('gone','k','instance',0)").run();
    testDb.prepare("INSERT INTO settings (user_id, key, value) VALUES (1, 'plugin:gone:units', 'metric')").run();
    // Per-user secrets + OAuth tokens live in their OWN tables, not under settings —
    // a "delete all data" that leaves these behind leaks encrypted keys/tokens that a
    // same-id reinstall silently re-adopts (audit finding).
    testDb.prepare("INSERT INTO plugin_user_config (plugin_id, user_id, field_key, value) VALUES ('gone', 1, 'apiKey', 'enc:secret')").run();
    testDb.prepare("INSERT INTO plugin_oauth_tokens (plugin_id, user_id, access_token, refresh_token) VALUES ('gone', 1, 'at', 'rt')").run();
    testDb.prepare("INSERT INTO plugin_oauth_state (state, plugin_id, user_id, verifier) VALUES ('s1', 'gone', 1, 'v')").run();
    testDb.prepare("INSERT INTO plugin_meta_migrations (plugin_id, migration_id) VALUES ('gone', '001')").run();
    testDb.prepare("INSERT INTO plugin_capability_audit (plugin_id, method, code, ts, hash) VALUES ('gone', 'trips.getById', 'OK', 't', 'h')").run();
    testDb.prepare("INSERT INTO plugin_scheduled_tasks (plugin_id, name, due_at) VALUES ('gone', 'poll', 0)").run();
    testDb.prepare("INSERT INTO plugin_user_erasure_queue (plugin_id, user_id) VALUES ('gone', 7)").run();

    await createPluginRuntime(new DatabaseService(dbConn)).uninstall('gone', true);

    expect(fs.existsSync(path.join(codeRoot, 'gone'))).toBe(false);
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugins WHERE id='gone'").get()).toMatchObject({ c: 0 });
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugin_settings_fields WHERE plugin_id='gone'").get()).toMatchObject({ c: 0 });
    expect(testDb.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'plugin:gone:%'").get()).toMatchObject({ c: 0 });
    // the secret-bearing tables + the erasure queue must be purged too (data is gone)
    for (const t of ['plugin_user_config', 'plugin_oauth_tokens', 'plugin_oauth_state', 'plugin_meta_migrations', 'plugin_capability_audit', 'plugin_scheduled_tasks', 'plugin_user_erasure_queue']) {
      expect(testDb.prepare(`SELECT COUNT(*) c FROM ${t} WHERE plugin_id='gone'`).get()).toMatchObject({ c: 0 });
    }
  });

  it('uninstall WITHOUT deleteData keeps pending GDPR erasures (the data survives, so must the obligation)', async () => {
    fs.mkdirSync(path.join(codeRoot, 'keepdata', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'keepdata', 'server', 'index.js'), 'module.exports={}');
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('keepdata','inactive','[]','{}')").run();
    // a deleted user's erasure is still pending for this plugin
    testDb.prepare("INSERT INTO plugin_user_erasure_queue (plugin_id, user_id) VALUES ('keepdata', 42)").run();

    await createPluginRuntime(new DatabaseService(dbConn)).uninstall('keepdata', false); // keep the plugin's data

    // the plugin row is gone, but the erasure obligation is retained — a reinstall of the
    // same id will drain it and finally honour the deletion, instead of silently keeping
    // the user's data forever.
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugins WHERE id='keepdata'").get()).toMatchObject({ c: 0 });
    expect(testDb.prepare("SELECT COUNT(*) c FROM plugin_user_erasure_queue WHERE plugin_id='keepdata' AND user_id=42").get()).toMatchObject({ c: 1 });
  });

  it('the egress guard blocks a fetch to an undeclared host', async () => {
    fs.mkdirSync(path.join(codeRoot, 'nettry', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'nettry', 'server', 'index.js'),
      "module.exports = { async onLoad() { await fetch('https://blocked.example/x'); } };");
    testDb.prepare("INSERT INTO plugins (id, status, permissions, config) VALUES ('nettry','inactive','[]','{}')").run();
    // no http:outbound granted -> egress guard blocks all outbound -> onLoad throws
    await expect(createPluginRuntime(new DatabaseService(dbConn)).activate('nettry')).rejects.toThrow(/egress/);
    await createPluginRuntime(new DatabaseService(dbConn)).deactivate('nettry').catch(() => {});
  });

  it('onModuleDestroy tears down cleanly', async () => {
    await expect(createPluginRuntime(new DatabaseService(dbConn)).onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('PluginRuntimeService.update (re-consent gate)', () => {
  // update() now asks the registry which version this TREK can actually run before it
  // installs anything, so the fake has to answer resolveVersion as well as install.
  const fakeRegistry = (impl: () => void, latest = '2.0.0') =>
    ({
      resolveVersion: vi.fn(async () => ({ version: latest })),
      install: vi.fn(async () => { impl(); return { id: 'x', version: latest }; }),
    }) as unknown as import('../../../src/nest/plugins/registry/registry.service').PluginRegistryService;

  const seed = (id: string, enabled: number, permissions: string[], granted: string[]) => {
    fs.mkdirSync(path.join(codeRoot, id, 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, id, 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb.prepare('INSERT INTO plugins (id, status, enabled, permissions, granted_permissions, config) VALUES (?,?,?,?,?,?)')
      .run(id, enabled ? 'active' : 'inactive', enabled, JSON.stringify(permissions), JSON.stringify(granted), '{}');
  };

  it('restarts transparently when the new version requests no new permissions', async () => {
    seed('upd-same', 1, ['db:own'], ['db:own']);
    const rt = createPluginRuntime(new DatabaseService(dbConn), fakeRegistry(() => {})); // declared perms unchanged
    await rt.activate('upd-same');
    const res = await rt.update('upd-same');
    expect(res).toMatchObject({ activated: true, newPermissions: [], newEgress: [] });
    expect(rt.isActive('upd-same')).toBe(true);
    await rt.deactivate('upd-same');
  });

  it('leaves the plugin inactive and reports the delta when new rights are requested', async () => {
    seed('upd-wider', 1, ['db:own'], ['db:own']);
    const rt = createPluginRuntime(
      new DatabaseService(dbConn),
      fakeRegistry(() => {
        testDb.prepare("UPDATE plugins SET permissions = ? WHERE id = 'upd-wider'")
          .run(JSON.stringify(['db:own', 'db:read:trips', 'http:outbound:api.new.com']));
      }),
    );
    await rt.activate('upd-wider');
    const res = await rt.update('upd-wider');
    expect(res.activated).toBe(false);
    expect(res.newPermissions).toEqual(['db:read:trips']);
    expect(res.newEgress).toEqual(['api.new.com']);
    expect(rt.isActive('upd-wider')).toBe(false);
    expect(testDb.prepare("SELECT enabled FROM plugins WHERE id='upd-wider'").get()).toMatchObject({ enabled: 0 });
  });

  it('a disabled plugin stays disabled even with no new permissions', async () => {
    seed('upd-off', 0, ['db:own'], ['db:own']);
    const res = await createPluginRuntime(new DatabaseService(dbConn), fakeRegistry(() => {})).update('upd-off');
    expect(res).toMatchObject({ activated: false, newPermissions: [], newEgress: [] });
  });

  it('throws for an unknown plugin id', async () => {
    await expect(createPluginRuntime(new DatabaseService(dbConn), fakeRegistry(() => {})).update('ghost-upd')).rejects.toThrow(/not found/);
  });

  it('throws if no registry service is wired', async () => {
    seed('upd-noreg', 0, ['db:own'], ['db:own']);
    await expect(createPluginRuntime(new DatabaseService(dbConn)).update('upd-noreg')).rejects.toThrow(/registry service unavailable/);
  });
});

describe('PluginRuntimeService dependency gating', () => {
  const deps = (d: { requiredAddons?: string[]; pluginDependencies?: { id: string; version: string }[] }) =>
    JSON.stringify({ requiredAddons: d.requiredAddons ?? [], pluginDependencies: d.pluginDependencies ?? [] });
  const insertPlugin = (id: string, dependencies: string, enabled = 0, version = '1.0.0') =>
    testDb.prepare("INSERT INTO plugins (id, status, enabled, version, permissions, granted_permissions, config, dependencies) VALUES (?, 'inactive', ?, ?, '[]', '[]', '{}', ?)")
      .run(id, enabled, version, dependencies);
  const cleanup = (...ids: string[]) => { for (const id of ids) testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id); };

  it('blocks activation when a required addon is disabled', async () => {
    testDb.prepare("INSERT OR REPLACE INTO addons (id, enabled) VALUES ('budget', 0)").run();
    insertPlugin('needs-budget', deps({ requiredAddons: ['budget'] }));
    await expect(runtime.activate('needs-budget')).rejects.toMatchObject({ code: 'ADDON_DISABLED' });
    expect((testDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get('needs-budget') as { enabled: number }).enabled).toBe(0);
    cleanup('needs-budget');
  });

  it('activates once the required addon is enabled', async () => {
    testDb.prepare("INSERT OR REPLACE INTO addons (id, enabled) VALUES ('budget', 1)").run();
    insertPlugin('needs-budget2', deps({ requiredAddons: ['budget'] }));
    // No code on disk → the supervisor spawn fails, but the addon gate passed (it did
    // not throw PluginDependencyError). Assert it got past the gate to the spawn.
    await expect(runtime.activate('needs-budget2')).rejects.not.toBeInstanceOf(PluginDependencyError);
    cleanup('needs-budget2');
  });

  it('blocks activation when a plugin dependency is missing', async () => {
    insertPlugin('needs-ghost', deps({ pluginDependencies: [{ id: 'ghost', version: '*' }] }));
    await expect(runtime.activate('needs-ghost')).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
    cleanup('needs-ghost');
  });

  it('blocks activation when a dependency version does not satisfy the range', async () => {
    insertPlugin('dep-lib', deps({}), 1, '1.0.0');
    insertPlugin('needs-v2', deps({ pluginDependencies: [{ id: 'dep-lib', version: '>=2.0.0' }] }));
    const err = await runtime.activate('needs-v2').catch((e) => e);
    expect(err).toBeInstanceOf(PluginDependencyError);
    expect(err.detail.versionMismatch).toEqual([{ id: 'dep-lib', wanted: '>=2.0.0', installed: '1.0.0' }]);
    cleanup('needs-v2', 'dep-lib');
  });

  it('refuses a dependency cycle', async () => {
    insertPlugin('cyc-a', deps({ pluginDependencies: [{ id: 'cyc-b', version: '*' }] }));
    insertPlugin('cyc-b', deps({ pluginDependencies: [{ id: 'cyc-a', version: '*' }] }));
    await expect(runtime.activate('cyc-a')).rejects.toBeInstanceOf(DependencyCycleError);
    cleanup('cyc-a', 'cyc-b');
  });

  it('deactivateForDisabledAddon disables plugins requiring the addon and their dependents', async () => {
    insertPlugin('base-b', deps({ requiredAddons: ['budget'] }), 1);
    insertPlugin('dependent-b', deps({ pluginDependencies: [{ id: 'base-b', version: '*' }] }), 1);
    insertPlugin('unrelated-b', deps({}), 1);
    const disabled = await runtime.deactivateForDisabledAddon('budget');
    expect(disabled.sort()).toEqual(['base-b', 'dependent-b']);
    expect((testDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get('base-b') as { enabled: number }).enabled).toBe(0);
    expect((testDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get('unrelated-b') as { enabled: number }).enabled).toBe(1);
    cleanup('base-b', 'dependent-b', 'unrelated-b');
  });

  it('deactivateWithDependents cascades to (transitive) dependents, dependents first', async () => {
    insertPlugin('lib-x', deps({}), 1);
    insertPlugin('mid-x', deps({ pluginDependencies: [{ id: 'lib-x', version: '*' }] }), 1);
    insertPlugin('top-x', deps({ pluginDependencies: [{ id: 'mid-x', version: '*' }] }), 1);
    insertPlugin('other-x', deps({}), 1);
    const disabled = await runtime.deactivateWithDependents('lib-x');
    expect(disabled).toEqual(['top-x', 'mid-x', 'lib-x']); // deepest dependent first, root last
    for (const id of ['lib-x', 'mid-x', 'top-x']) {
      expect((testDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get(id) as { enabled: number }).enabled).toBe(0);
    }
    expect((testDb.prepare('SELECT enabled FROM plugins WHERE id = ?').get('other-x') as { enabled: number }).enabled).toBe(1);
    cleanup('lib-x', 'mid-x', 'top-x', 'other-x');
  });
});

describe('PluginRuntimeService inter-plugin (exports + events)', () => {
  beforeAll(async () => {
    fs.mkdirSync(path.join(codeRoot, 'lib', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(codeRoot, 'lib', 'server', 'index.js'),
      `module.exports = {
        async onLoad(ctx) { ctx.events.emit('ping', { hi: true }); },
        exports: { async greet(args) { return { greeting: 'hi ' + (args && args.who), from: 'lib' }; } },
        routes: [],
      };`,
    );
    fs.mkdirSync(path.join(codeRoot, 'consumer', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(codeRoot, 'consumer', 'server', 'index.js'),
      `module.exports = {
        subscriptions: [{ plugin: 'lib', event: 'ping', async handler(payload, ctx) { ctx.log.info('got ping', payload); } }],
        routes: [{ method: 'GET', path: '/call', auth: false, async handler(_req, ctx) {
          const r = await ctx.plugins.call('lib', 'greet', { who: 'consumer' });
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) };
        } }],
      };`,
    );
    testDb.prepare("INSERT INTO plugins (id, status, version, permissions, config, capabilities, dependencies) VALUES ('lib','inactive','1.5.0','[]','{}',?,'{}')")
      .run(JSON.stringify({ provides: ['greet'], emits: ['ping'] }));
    testDb.prepare("INSERT INTO plugins (id, status, version, permissions, config, capabilities, dependencies) VALUES ('consumer','inactive','1.0.0','[]','{}','{}',?)")
      .run(JSON.stringify({ requiredAddons: [], pluginDependencies: [{ id: 'lib', version: '>=1.0.0 <2.0.0' }] }));
    await runtime.activate('lib');
    await runtime.activate('consumer');
  });
  afterAll(async () => {
    await runtime.deactivate('consumer').catch(() => {});
    await runtime.deactivate('lib').catch(() => {});
  });

  it('routes ctx.plugins.call through the host to the dependency export', async () => {
    const res = (await runtime.invoke('consumer', 'invoke.route', {
      routeId: 0,
      req: { method: 'GET', path: '/call', query: {}, body: null, user: { id: 7, username: 'x', isAdmin: false } },
    })) as { status: number; body: string };
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ greeting: 'hi consumer', from: 'lib' });
  });

  it('refuses a call from a non-dependent and to an undeclared export', async () => {
    await expect(runtime.callPlugin('lib', 'consumer', 'anything', {}, 7)).rejects.toThrow(/does not declare|not active|does not export/);
    await expect(runtime.callPlugin('consumer', 'lib', 'nope', {}, 7)).rejects.toThrow(/does not export/);
  });

  it('emitPluginEvent validates the declared event and fans out without throwing', () => {
    expect(() => runtime.emitPluginEvent('lib', 'ping', { x: 1 })).not.toThrow();
    expect(() => runtime.emitPluginEvent('lib', 'not-declared', {})).toThrow(/does not declare event/);
  });
});

/**
 * Re-trust: re-pinning a ROTATED author signing key and updating, in one call.
 *
 * The one-call shape is the safety property. A re-pin that returned and left the client
 * to then call /update would leave a window where author_pubkey is pinned to a key no
 * install has ever verified against — and if that second call never arrives (the admin
 * closes the tab), the plugin just sits there, pinned to an unverified key.
 */
describe('PluginRuntimeService.retrust', () => {
  const seed = (id: string, pinned: string) => {
    fs.mkdirSync(path.join(codeRoot, id, 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, id, 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb
      .prepare(
        `INSERT INTO plugins (id, status, enabled, version, permissions, granted_permissions, config, source_repo, author_pubkey,
                              update_block_code, update_block_detail, update_block_version)
         VALUES (?,'active',1,'1.0.0','["db:own"]','["db:own"]','{}','acme/x',?,'SIGNATURE_KEY_CHANGED','key changed','2.0.0')`,
      )
      .run(id, pinned);
  };

  /** A registry whose install() re-pins to the new key, as the real one does. */
  const registryFor = (id: string) =>
    ({
      assertRetrustable: vi.fn(async (_id: string, key: string) => ({ authorPublicKey: key })),
      install: vi.fn(async (_id: string, opts?: { retrustKey?: string }) => {
        testDb
          .prepare("UPDATE plugins SET author_pubkey = ?, version = '2.0.0', update_block_code = NULL, update_block_version = NULL WHERE id = ?")
          .run(opts?.retrustKey, id);
        return { id, version: '2.0.0' };
      }),
    }) as unknown as import('../../../src/nest/plugins/registry/registry.service').PluginRegistryService;

  it('re-pins AND installs in one call: the new key is pinned, the version moved, the block gone', async () => {
    seed('rt-ok', 'OLDKEY');
    const registry = registryFor('rt-ok');
    const rt = createPluginRuntime(new DatabaseService(dbConn), registry);
    await rt.activate('rt-ok');

    await rt.retrust('rt-ok', '2.0.0', 'NEWKEY', { userId: 1, ip: '10.0.0.1' });

    // The condition is re-derived SERVER-side before anything moves — the UI hiding the
    // button is a convenience, not the control.
    expect(registry.assertRetrustable).toHaveBeenCalledWith('rt-ok', 'NEWKEY');
    const row = testDb.prepare("SELECT author_pubkey, version, update_block_code FROM plugins WHERE id='rt-ok'").get() as {
      author_pubkey: string | null;
      version: string;
      update_block_code: string | null;
    };
    expect(row.author_pubkey).toBe('NEWKEY');
    expect(row.author_pubkey).not.toBeNull(); // never NULL: that would re-open the unsigned path
    expect(row.version).toBe('2.0.0');
    expect(row.update_block_code).toBeNull(); // no half-state left for the admin to trip over

    // Audited. Both fingerprints are the point: after an incident, "which key did we move
    // FROM, and to what?" is the question, and an entry that records only the new key
    // cannot answer it. This goes to the ADMIN log — a lifecycle act by an admin does not
    // belong in the plugin capability log, which answers "what have plugins done in my name?"
    const audit = testDb.prepare("SELECT * FROM audit_log WHERE action = 'admin.plugin_retrust'").get() as {
      user_id: number;
      resource: string;
      details: string;
      ip: string;
    };
    expect(audit).toBeDefined();
    expect(audit.resource).toBe('rt-ok');
    expect(audit.user_id).toBe(1);
    expect(audit.ip).toBe('10.0.0.1');
    expect(JSON.parse(audit.details)).toEqual({
      plugin: 'rt-ok',
      version: '2.0.0',
      oldKeyFingerprint: 'OLDKEY',
      newKeyFingerprint: 'NEWKEY',
    });
    await rt.deactivate('rt-ok');
  });

  it('changes nothing when the pre-check refuses (an invalid signature is not re-trustable)', async () => {
    seed('rt-no', 'OLDKEY');
    const registry = registryFor('rt-no');
    vi.mocked(registry.assertRetrustable).mockRejectedValue(new Error('nothing to re-trust'));
    const rt = createPluginRuntime(new DatabaseService(dbConn), registry);

    await expect(rt.retrust('rt-no', '2.0.0', 'NEWKEY', { userId: 1 })).rejects.toThrow(/nothing to re-trust/);

    expect(registry.install).not.toHaveBeenCalled();
    const row = testDb.prepare("SELECT author_pubkey, update_block_code FROM plugins WHERE id='rt-no'").get() as {
      author_pubkey: string;
      update_block_code: string;
    };
    expect(row.author_pubkey).toBe('OLDKEY');
    expect(row.update_block_code).toBe('SIGNATURE_KEY_CHANGED'); // the block stands

    // …and nothing is audited. A refused re-trust must not leave a trace that reads like
    // one that happened — an audit log that logs attempts as if they were acts is worse
    // than no audit log, because it is believed.
    const audited = testDb
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.plugin_retrust' AND resource = 'rt-no'")
      .get() as { n: number };
    expect(audited.n).toBe(0);
  });

  // Activating the plugin at its OLD version resolves nothing. If an off/on toggle wiped
  // the block, the admin would silently lose the warning while it still applied — which is
  // exactly the "quietly stops updating" failure the block exists to prevent.
  it('activate does NOT clear a recorded update block', async () => {
    seed('rt-act', 'OLDKEY');
    const rt = createPluginRuntime(new DatabaseService(dbConn), registryFor('rt-act'));

    await rt.deactivate('rt-act');
    await rt.activate('rt-act');

    const row = testDb.prepare("SELECT update_block_code, update_block_version FROM plugins WHERE id='rt-act'").get() as {
      update_block_code: string;
      update_block_version: string;
    };
    expect(row.update_block_code).toBe('SIGNATURE_KEY_CHANGED');
    expect(row.update_block_version).toBe('2.0.0');
    await rt.deactivate('rt-act');
  });
});

/**
 * The activation gate is where an incompatible plugin is actually STOPPED.
 *
 * Install alone can't be the whole answer: a plugin installed legitimately on TREK 3.3
 * still sits on disk after the operator upgrades to 4.0, and its code — written against a
 * host it declared it doesn't support — would otherwise be spawned on the next boot.
 */
describe('TREK host-version gating', () => {
  const seedRanged = (id: string, trekRange: string | null, enabled = 0) => {
    fs.mkdirSync(path.join(codeRoot, id, 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, id, 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb.prepare("INSERT INTO plugins (id, status, enabled, permissions, granted_permissions, config, trek_range) VALUES (?, ?, ?, '[]', '[]', '{}', ?)")
      .run(id, enabled ? 'active' : 'inactive', enabled, trekRange);
  };
  const cleanup = (...ids: string[]) => { for (const id of ids) testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id); };

  afterEach(() => { delete process.env.APP_VERSION; });

  it('refuses to activate a plugin this TREK has outgrown, and says so with a code', async () => {
    process.env.APP_VERSION = '4.0.0';
    seedRanged('outgrown', '>=3.2.0 <4.0.0');
    const err = await createPluginRuntime(new DatabaseService(dbConn)).activate('outgrown').catch((e) => e);
    expect(err).toBeInstanceOf(PluginDependencyError);
    expect(err).toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    expect(err.detail).toMatchObject({ trekRange: '>=3.2.0 <4.0.0', hostVersion: '4.0.0' });
    // It stays INSTALLED and visible — the admin needs to see it to act on it.
    expect(testDb.prepare("SELECT id FROM plugins WHERE id='outgrown'").get()).toBeTruthy();
    cleanup('outgrown');
  });

  it('refuses a plugin that never declared a range at all', async () => {
    process.env.APP_VERSION = '3.3.0';
    seedRanged('undeclared', null);
    await expect(createPluginRuntime(new DatabaseService(dbConn)).activate('undeclared')).rejects.toMatchObject({ code: 'TREK_VERSION_UNKNOWN' });
    cleanup('undeclared');
  });

  it('activates normally when the range admits the host', async () => {
    process.env.APP_VERSION = '3.3.0';
    seedRanged('fits', '>=3.2.0 <4.0.0');
    const rt = createPluginRuntime(new DatabaseService(dbConn));
    await rt.activate('fits');
    expect(rt.isActive('fits')).toBe(true);
    await rt.deactivate('fits');
    cleanup('fits');
  });

  it('boots cleanly with an enabled-but-incompatible plugin, reconciling it to disabled', async () => {
    // The regression this guards: a bespoke error class here would miss the boot loop's
    // reconciliation (it only catches PluginDependencyError / DependencyCycleError), so the
    // row would keep enabled=1 + status='active' while no child was ever spawned — the admin
    // panel showing a green, running plugin that does not exist.
    process.env.APP_VERSION = '4.0.0';
    seedRanged('boot-broken', '>=3.2.0 <4.0.0', 1);
    const rt = createPluginRuntime(new DatabaseService(dbConn));
    expect(() => rt.onApplicationBootstrap()).not.toThrow();
    for (let i = 0; i < 40; i++) {
      const row = testDb.prepare("SELECT enabled FROM plugins WHERE id='boot-broken'").get() as { enabled: number };
      if (row.enabled === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(testDb.prepare("SELECT enabled FROM plugins WHERE id='boot-broken'").get()).toMatchObject({ enabled: 0 });
    expect(rt.isActive('boot-broken')).toBe(false);
    cleanup('boot-broken');
  });

  describe('with TREK_PLUGINS_IGNORE_TREK_RANGE set', () => {
    beforeEach(() => { process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1'; });
    afterEach(() => { delete process.env.TREK_PLUGINS_IGNORE_TREK_RANGE; });

    it('activates a plugin this TREK has outgrown, warning in the log instead of refusing', async () => {
      process.env.APP_VERSION = '4.0.0';
      seedRanged('outgrown-ok', '>=3.2.0 <4.0.0');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rt = createPluginRuntime(new DatabaseService(dbConn));
      await rt.activate('outgrown-ok');
      expect(rt.isActive('outgrown-ok')).toBe(true);
      expect(warn.mock.calls.some((c) => /outgrown-ok.*>=3\.2\.0 <4\.0\.0.*4\.0\.0/.test(String(c[0])))).toBe(true);
      warn.mockRestore();
      await rt.deactivate('outgrown-ok');
      cleanup('outgrown-ok');
    });

    it('activates a plugin that never declared a range', async () => {
      process.env.APP_VERSION = '3.3.0';
      seedRanged('undeclared-ok', null);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rt = createPluginRuntime(new DatabaseService(dbConn));
      await rt.activate('undeclared-ok');
      expect(rt.isActive('undeclared-ok')).toBe(true);
      warn.mockRestore();
      await rt.deactivate('undeclared-ok');
      cleanup('undeclared-ok');
    });
  });

  it('checks the version BEFORE permissions — an unrunnable plugin gets no consent dialog', async () => {
    // Consenting to permissions would not make it start, so offering the dialog is a lie.
    process.env.APP_VERSION = '4.0.0';
    fs.mkdirSync(path.join(codeRoot, 'both-wrong', 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'both-wrong', 'server', 'index.js'), 'module.exports = {};');
    testDb.prepare("INSERT INTO plugins (id, status, enabled, permissions, granted_permissions, config, trek_range) VALUES ('both-wrong','inactive',0,'[\"db:own\"]','[]','{}','>=3.2.0 <4.0.0')").run();
    await expect(createPluginRuntime(new DatabaseService(dbConn)).activate('both-wrong')).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    cleanup('both-wrong');
  });
});

/**
 * The activation gate also refuses a plugin whose manifest `apiVersion` is newer than
 * what this TREK's plugin-API surface supports (`PLUGIN_API_VERSION`) — mirrors the
 * TREK-version gate above, just for the plugin-API surface instead of the host version.
 */
describe('plugin-API version gating', () => {
  const seedApi = (id: string, apiVersion: number) => {
    fs.mkdirSync(path.join(codeRoot, id, 'server'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, id, 'server', 'index.js'), 'module.exports = { async onLoad() {} };');
    testDb
      .prepare(
        "INSERT INTO plugins (id, status, enabled, permissions, granted_permissions, config, trek_range, api_version) VALUES (?, 'inactive', 0, '[]', '[]', '{}', '>=3.0.0', ?)",
      )
      .run(id, apiVersion);
  };
  const cleanup = (...ids: string[]) => { for (const id of ids) testDb.prepare('DELETE FROM plugins WHERE id = ?').run(id); };

  it('refuses to activate a plugin whose apiVersion this TREK does not support', async () => {
    seedApi('future-api', 2);
    const err = await createPluginRuntime(new DatabaseService(dbConn)).activate('future-api').catch((e) => e);
    expect(err).toBeInstanceOf(PluginDependencyError);
    expect(err).toMatchObject({ code: 'API_VERSION_INCOMPATIBLE' });
    expect(err.message).toBe('plugin requires plugin-API v2; this TREK supports v1');
    cleanup('future-api');
  });

  it('still refuses a newer apiVersion when the TREK-range bypass is on — it is not a range problem', async () => {
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
    try {
      seedApi('future-api-bypass', 2);
      await expect(createPluginRuntime(new DatabaseService(dbConn)).activate('future-api-bypass')).rejects.toMatchObject({ code: 'API_VERSION_INCOMPATIBLE' });
    } finally {
      delete process.env.TREK_PLUGINS_IGNORE_TREK_RANGE;
      cleanup('future-api-bypass');
    }
  });

  it('activates normally when apiVersion is within what this TREK supports', async () => {
    seedApi('current-api', 1);
    const rt = createPluginRuntime(new DatabaseService(dbConn));
    await rt.activate('current-api');
    expect(rt.isActive('current-api')).toBe(true);
    await rt.deactivate('current-api');
    cleanup('current-api');
  });
});
