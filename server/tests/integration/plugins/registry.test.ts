/**
 * TREK-side registry service (#plugins, M5): browse the aggregated registry and
 * install a pinned version through the full verify -> extract -> validate ->
 * move -> register pipeline (with the network download mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';

const { safeDownload } = vi.hoisted(() => ({ safeDownload: vi.fn() }));
vi.mock('../../../src/nest/plugins/install/safe-fetch', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  safeDownload,
}));

const { testDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plugins (id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT, icon TEXT, version TEXT,
      api_version INTEGER, min_trek_version TEXT, trek_range TEXT, permissions TEXT, capabilities TEXT DEFAULT '{}', dependencies TEXT DEFAULT '{}', operator_egress INTEGER DEFAULT 0, granted_permissions TEXT, status TEXT, enabled INTEGER DEFAULT 0, config TEXT,
      source_repo TEXT, source_commit TEXT, sha256 TEXT, reviewed_at TEXT, author_pubkey TEXT, updated_at TEXT,
      update_block_code TEXT, update_block_detail TEXT, update_block_version TEXT, update_hold INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE plugin_settings_fields (plugin_id TEXT, field_key TEXT, label TEXT, input_type TEXT, placeholder TEXT, hint TEXT, required INTEGER, secret INTEGER, scope TEXT, options TEXT, oauth_config TEXT, default_value TEXT, sort_order INTEGER);
    CREATE TABLE plugin_error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, level TEXT, message TEXT, ts TEXT);`);
  return { testDb: db };
});
vi.mock('../../../src/db/database', () => ({ db: testDb, canAccessTrip: () => undefined }));
import { db as dbConn } from '../../../src/db/database';
import { DatabaseService } from '../../../src/nest/database/database.service';

import { PluginRegistryService, RegistryError, __clearRegistryCacheForTests } from '../../../src/nest/plugins/registry/registry.service';
import type { ManifestPreview } from '../../../src/nest/plugins/registry/registry.service';

// ── tiny tar.gz builder (wraps the plugin in a codeload-style top dir) ────────
function tarHeader(name: string, size: number, typeflag = '0'): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0); h.write('0000644', 100); h.write('0000000', 108); h.write('0000000', 116);
  h.write(size.toString(8).padStart(11, '0'), 124); h.write('00000000000', 136);
  h.write('        ', 148); h.write(typeflag, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
// Every artifact declares a `trek` range by default — install REQUIRES one, so a fixture
// without it would be testing the version gate rather than whatever the test is about.
// Pass an explicit `trek` (or null, spread last) to exercise the gate itself.
function makeArtifact(manifest: object): Buffer {
  const withTrek = { trek: '>=3.2.0', ...manifest };
  const files = [
    { name: 'plug-abc/', type: '5' as const, data: '' },
    { name: 'plug-abc/trek-plugin.json', type: '0' as const, data: JSON.stringify(withTrek) },
    { name: 'plug-abc/server/', type: '5' as const, data: '' },
    { name: 'plug-abc/server/index.js', type: '0' as const, data: 'module.exports={}' },
  ];
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.data);
    parts.push(tarHeader(f.name, f.type === '5' ? 0 : body.length, f.type));
    if (f.type === '0') { parts.push(body); const pad = (512 - (body.length % 512)) % 512; if (pad) parts.push(Buffer.alloc(pad, 0)); }
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

const REGISTRY = {
  schemaVersion: 1,
  plugins: [
    {
      id: 'flight-tracker', name: 'Flight', author: 'Acme', description: 'flights', repo: 'acme/trek-flight',
      type: 'widget', icon: 'Plane', reviewedAt: '2026-06-20',
      versions: [{ version: '1.0.0', gitTag: 'v1.0.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/acme/trek-flight/tar.gz/aaaa', sha256: '', minTrekVersion: '3.2.0' }],
    },
  ],
};

let dataRoot: string;
let codeRoot: string;
let svc: PluginRegistryService;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-data-'));
  codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-code-'));
  process.env.TREK_PLUGINS_DATA_DIR = dataRoot;
  process.env.TREK_PLUGINS_DIR = codeRoot;
  testDb.exec('DELETE FROM plugins; DELETE FROM plugin_settings_fields; DELETE FROM plugin_error_log');
  __clearRegistryCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => REGISTRY }) as unknown as Response));
  svc = new PluginRegistryService(new DatabaseService(dbConn));
});
afterEach(() => {
  vi.unstubAllGlobals();
  safeDownload.mockReset();
  delete (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey;
  delete (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature;
  delete process.env.TREK_PLUGINS_DATA_DIR;
  delete process.env.TREK_PLUGINS_DIR;
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(codeRoot, { recursive: true, force: true });
});

/** Ed25519 keypair as (raw 32-byte pubkey base64, raw-signature signer). */
function signingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pubB64: (publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) as Buffer).toString('base64'),
    sign: (b: Buffer) => (edSign(null, b, privateKey) as Buffer).toString('base64'),
  };
}
function stageSignedArtifact(pubB64: string, sig: (b: Buffer) => string): Buffer {
  const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
  REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
  (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey = pubB64;
  (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature = sig(artifact);
  safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });
  return artifact;
}

describe('PluginRegistryService', () => {
  it('browse maps the aggregated registry to metadata', async () => {
    const list = await svc.browse();
    expect(list).toEqual([
      expect.objectContaining({ id: 'flight-tracker', name: 'Flight', latest: '1.0.0', minTrekVersion: '3.2.0', reviewedAt: '2026-06-20' }),
    ]);
  });

  // The store tile has no manifest to read (the aggregated index carries no manifests), so
  // the entry's icon is the only thing standing between it and a generic Blocks glyph.
  it('browse carries the entry icon through to the store tile', async () => {
    const [entry] = await svc.browse();
    expect(entry.icon).toBe('Plane');
  });

  it('browse exposes a screenshot url pinned at the reviewed commit', async () => {
    const list = await svc.browse();
    expect(list[0].screenshotUrl).toBe(`https://raw.githubusercontent.com/acme/trek-flight/${'a'.repeat(40)}/docs/screenshot.png`);
  });

  // The registry aggregate now resolves the cover at build time (docs/screenshot.png
  // else the first resolving README image) and injects screenshotUrl. When present it
  // must win over the docs/screenshot.png guess — that's what gives entries without a
  // committed docs/screenshot.png a non-blank card.
  it('browse prefers a build-injected screenshotUrl over the docs/screenshot.png guess', async () => {
    const injected = 'https://raw.githubusercontent.com/acme/trek-flight/bbbb/docs/img1.png';
    (REGISTRY.plugins[0] as { screenshotUrl?: string }).screenshotUrl = injected;
    try {
      const [entry] = await svc.browse();
      expect(entry.screenshotUrl).toBe(injected);
      const d = await svc.detail('flight-tracker');
      expect(d.screenshotUrl).toBe(injected);
    } finally {
      delete (REGISTRY.plugins[0] as { screenshotUrl?: string }).screenshotUrl;
    }
  });

  it('detail merges registry metadata with a live manifest preview', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({
        id: 'flight-tracker', permissions: ['db:read:trips', 'http:outbound'], egress: ['api.example.com'],
        settings: [{ key: 'api_key', label: 'API Key', input_type: 'password', scope: 'instance', required: true, secret: true }],
        license: 'MIT', icon: 'Plane',
      })),
      sha256: 'unused',
    });
    const d = await svc.detail('flight-tracker');
    expect(safeDownload).toHaveBeenCalledWith(
      `https://raw.githubusercontent.com/acme/trek-flight/${'a'.repeat(40)}/trek-plugin.json`,
      expect.any(Number),
    );
    expect(d).toMatchObject({
      id: 'flight-tracker', repo: 'acme/trek-flight', latest: '1.0.0', reviewedAt: '2026-06-20',
      screenshotUrl: `https://raw.githubusercontent.com/acme/trek-flight/${'a'.repeat(40)}/docs/screenshot.png`,
      manifest: {
        permissions: ['db:read:trips', 'http:outbound'],
        egress: ['api.example.com'],
        settings: [{ key: 'api_key', label: 'API Key', inputType: 'password', scope: 'instance', required: true }],
        license: 'MIT', icon: 'Plane',
      },
    });
  });

  it('detail carries the UI-facing capabilities, so the review sheet can chip a tab takeover', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({
        id: 'flight-tracker', permissions: [], egress: [],
        capabilities: { widget: { slot: 'hero' }, tripPage: { replaces: ['places'], position: 3 }, settingsUi: true },
      })),
      sha256: 'unused',
    });
    const d = (await svc.detail('flight-tracker')) as { manifest: ManifestPreview };
    expect(d.manifest.capabilities).toEqual({ widget: { slot: 'hero' }, tripPage: { replaces: ['places'] } });
  });

  it('detail leaves capabilities empty when the manifest declares none', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({ id: 'flight-tracker', permissions: [], capabilities: { widget: {} } })),
      sha256: 'unused',
    });
    const d = (await svc.detail('flight-tracker')) as { manifest: ManifestPreview };
    expect(d.manifest.capabilities).toEqual({ widget: {} });
  });

  it('detail soft-fails the manifest fetch (registry metadata still renders)', async () => {
    safeDownload.mockRejectedValue(new Error('offline'));
    const d = await svc.detail('flight-tracker');
    expect(d).toMatchObject({ id: 'flight-tracker', manifest: null });
  });

  it('detail tolerates a malformed manifest shape', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({ permissions: 'not-an-array', settings: [{ label: 'no key' }], egress: [7, 'ok.host'] })),
      sha256: 'unused',
    });
    const d = (await svc.detail('flight-tracker')) as { manifest: { permissions: string[]; egress: string[]; settings: unknown[] } };
    expect(d.manifest).toMatchObject({ permissions: [], egress: ['ok.host'], settings: [] });
  });

  it('detail surfaces operatorEgress, so the pre-install review can say the host list is not the whole story', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({ permissions: ['http:outbound:gotify.net'], egress: ['gotify.net'], operatorEgress: true })),
      sha256: 'unused',
    });
    const d = (await svc.detail('flight-tracker')) as { manifest: { operatorEgress: boolean; egress: string[] } };
    expect(d.manifest).toMatchObject({ egress: ['gotify.net'], operatorEgress: true });
  });

  it('detail defaults operatorEgress to false (an ordinary plugin must not claim it)', async () => {
    safeDownload.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify({ permissions: [], egress: ['api.example.com'] })),
      sha256: 'unused',
    });
    const d = (await svc.detail('flight-tracker')) as { manifest: { operatorEgress: boolean } };
    expect(d.manifest.operatorEgress).toBe(false);
  });

  it('detail is cached per plugin (one manifest fetch across calls)', async () => {
    safeDownload.mockResolvedValue({ bytes: Buffer.from('{}'), sha256: 'unused' });
    await svc.detail('flight-tracker');
    await svc.detail('flight-tracker');
    expect(safeDownload).toHaveBeenCalledTimes(1);
  });

  it('detail does not negative-cache a failed manifest fetch (next open retries)', async () => {
    safeDownload.mockRejectedValueOnce(new Error('github hiccup'));
    const first = (await svc.detail('flight-tracker')) as { manifest: unknown };
    expect(first.manifest).toBeNull();
    safeDownload.mockResolvedValue({ bytes: Buffer.from(JSON.stringify({ permissions: ['db:own'] })), sha256: 'unused' });
    const second = (await svc.detail('flight-tracker')) as { manifest: { permissions: string[] } };
    expect(second.manifest).toMatchObject({ permissions: ['db:own'] });
    expect(safeDownload).toHaveBeenCalledTimes(2);
  });

  it('detail rejects an unknown plugin id', async () => {
    await expect(svc.detail('ghost')).rejects.toThrow(RegistryError);
  });

  // The per-plugin update hold: a DELIBERATE non-latest install excludes the plugin from
  // the update banner until the admin resumes updates or lands back on the newest
  // compatible version. Dependency resolution pins versions too, but never deliberately —
  // the `explicit` flag is what separates the two.
  describe('recomputeUpdateHold', () => {
    const twoVersions = {
      schemaVersion: 1,
      plugins: [
        {
          id: 'flight-tracker', name: 'Flight', author: 'Acme', description: 'flights', repo: 'acme/trek-flight', type: 'widget',
          versions: [
            { version: '2.0.0', gitTag: 'v2.0.0', commitSha: 'b'.repeat(40), downloadUrl: 'https://x/2', sha256: '2'.repeat(64) },
            { version: '1.0.0', gitTag: 'v1.0.0', commitSha: 'd'.repeat(40), downloadUrl: 'https://x/1', sha256: '0'.repeat(64) },
          ],
        },
      ],
    };
    const seedRow = (hold = 0) =>
      testDb.prepare("INSERT INTO plugins (id, status, enabled, update_hold) VALUES ('flight-tracker','inactive',0,?)").run(hold);
    const holdInDb = () =>
      (testDb.prepare("SELECT update_hold FROM plugins WHERE id='flight-tracker'").get() as { update_hold: number }).update_hold;

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => twoVersions }) as unknown as Response));
      __clearRegistryCacheForTests();
    });

    it('holds when the admin explicitly picked an older version', async () => {
      seedRow();
      await expect(svc.recomputeUpdateHold('flight-tracker', '1.0.0', true)).resolves.toBe(true);
      expect(holdInDb()).toBe(1);
    });

    it('does not hold when the explicit pick IS the newest compatible version', async () => {
      seedRow(1);
      await expect(svc.recomputeUpdateHold('flight-tracker', '2.0.0', true)).resolves.toBe(false);
      expect(holdInDb()).toBe(0);
    });

    // The comparison is against the newest version THIS TREK can run, not the newest
    // published one. Both fixtures above leave `trek` unset, so every version is
    // compatible and the two readings agree; only a version this host must skip tells
    // them apart. Getting it wrong stamps a hold on an admin who picked the best
    // available version, and the row silently leaves the banner and "Update all".
    it('does not hold when a newer version exists but this TREK cannot run it', async () => {
      const withIncompatibleNewest = {
        schemaVersion: 1,
        plugins: [
          {
            ...twoVersions.plugins[0],
            versions: [
              { version: '3.0.0', gitTag: 'v3.0.0', commitSha: 'c'.repeat(40), downloadUrl: 'https://x/3', sha256: '3'.repeat(64), trek: '>=4.0.0' },
              ...twoVersions.plugins[0].versions,
            ],
          },
        ],
      };
      process.env.APP_VERSION = '3.3.0';
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => withIncompatibleNewest }) as unknown as Response));
      __clearRegistryCacheForTests();
      try {
        seedRow(1);
        await expect(svc.recomputeUpdateHold('flight-tracker', '2.0.0', true)).resolves.toBe(false);
        expect(holdInDb()).toBe(0);
      } finally {
        delete process.env.APP_VERSION;
      }
    });

    it('a non-deliberate update clears a stale hold', async () => {
      seedRow(1);
      await expect(svc.recomputeUpdateHold('flight-tracker', '2.0.0', false)).resolves.toBe(false);
      expect(holdInDb()).toBe(0);
    });

    it('an unresolvable registry never sets a hold', async () => {
      seedRow();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      __clearRegistryCacheForTests();
      await expect(svc.recomputeUpdateHold('flight-tracker', '1.0.0', true)).resolves.toBe(false);
      expect(holdInDb()).toBe(0);
    });
  });

  // The version picker's data: every published version, each with its OWN server-computed
  // compat verdict — the client has no semver and must never re-derive range logic.
  it('detail lists every published version with its own compat verdict', async () => {
    process.env.APP_VERSION = '3.3.0';
    const multi = {
      schemaVersion: 1,
      plugins: [
        {
          id: 'flight-tracker', name: 'Flight', author: 'Acme', description: 'flights', repo: 'acme/trek-flight',
          type: 'widget', authorPublicKey: 'K'.repeat(44),
          versions: [
            { version: '2.0.0', gitTag: 'v2.0.0', commitSha: 'b'.repeat(40), downloadUrl: 'https://x/2', sha256: '2'.repeat(64), trek: '>=4.0.0', publishedAt: '2026-08-01', size: 2048, signature: 'sig2' },
            { version: '1.5.0', gitTag: 'v1.5.0', commitSha: 'c'.repeat(40), downloadUrl: 'https://x/15', sha256: '1'.repeat(64), trek: '>=3.0.0 <4.0.0', publishedAt: '2026-07-01', size: 1024 },
            { version: '1.0.0', gitTag: 'v1.0.0', commitSha: 'd'.repeat(40), downloadUrl: 'https://x/1', sha256: '0'.repeat(64), minTrekVersion: '3.0.0' },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => multi }) as unknown as Response));
    __clearRegistryCacheForTests();
    try {
      const d = (await svc.detail('flight-tracker')) as { versions: unknown };
      expect(d.versions).toEqual([
        { version: '2.0.0', publishedAt: '2026-08-01', size: 2048, signed: true, trek: '>=4.0.0', compatible: false },
        { version: '1.5.0', publishedAt: '2026-07-01', size: 1024, signed: false, trek: '>=3.0.0 <4.0.0', compatible: true },
        // A legacy entry composes its requirement from the min/max bounds it has.
        { version: '1.0.0', publishedAt: null, size: null, signed: false, trek: '>=3.0.0', compatible: true },
      ]);
    } finally {
      delete process.env.APP_VERSION;
    }
  });

  it('fetchRegistry soft-fails to an empty registry on a cold cache', async () => {
    __clearRegistryCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await new PluginRegistryService(new DatabaseService(dbConn)).fetchRegistry()).plugins).toEqual([]);
  });

  it('installs a pinned version end to end (verify -> extract -> register inactive)', async () => {
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    const sha = createHash('sha256').update(artifact).digest('hex');
    REGISTRY.plugins[0].versions[0].sha256 = sha;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });

    const out = await svc.install('flight-tracker');
    expect(out).toEqual({ id: 'flight-tracker', version: '1.0.0', trekRangeBypassed: null });

    // moved into place + registered inactive with provenance
    expect(fs.existsSync(path.join(codeRoot, 'flight-tracker', 'trek-plugin.json'))).toBe(true);
    const row = testDb.prepare("SELECT status, source_repo, source_commit FROM plugins WHERE id='flight-tracker'").get() as { status: string; source_repo: string; source_commit: string };
    expect(row).toMatchObject({ status: 'inactive', source_repo: 'acme/trek-flight', source_commit: 'a'.repeat(40) });
    // no staging left behind
    const staging = path.join(dataRoot, '.staging');
    expect(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0).toBe(true);
  });

  it('rejects an sha256 mismatch', async () => {
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget' });
    REGISTRY.plugins[0].versions[0].sha256 = 'b'.repeat(64);
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: 'c'.repeat(64) });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/integrity/);
  });

  it('rejects an unknown plugin id', async () => {
    await expect(svc.install('ghost')).rejects.toThrow(RegistryError);
  });

  it('caches the registry (one fetch across calls)', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => REGISTRY }) as unknown as Response);
    vi.stubGlobal('fetch', spy);
    __clearRegistryCacheForTests();
    await svc.fetchRegistry();
    await svc.fetchRegistry();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('force refresh bypasses the cache and busts the CDN', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => REGISTRY }) as unknown as Response);
    vi.stubGlobal('fetch', spy);
    __clearRegistryCacheForTests();
    await svc.fetchRegistry();       // primes the 30-min cache (fetch #1)
    await svc.fetchRegistry(true);   // force → refetches despite the warm cache
    expect(spy).toHaveBeenCalledTimes(2);
    const [url, opts] = spy.mock.calls[1] as unknown as [string | URL, { headers?: Record<string, string> }];
    expect(String(url)).toMatch(/[?&]_=\d+/);            // cache-buster query
    expect(opts.headers?.['Cache-Control']).toBe('no-cache');
  });

  // ── Sideload (upload your own plugin) ────────────────────────────────────────
  it('sideload: stage + commit installs an uploaded plugin INACTIVE as local:upload', () => {
    const zip = makeArtifact({ id: 'my-upload', name: 'Uploaded', version: '2.0.0', type: 'widget', permissions: ['db:own'] });
    const staged = svc.stageUpload(zip);
    expect(staged.id).toBe('my-upload');
    expect(staged.version).toBe('2.0.0');

    svc.commitUpload(staged);

    const row = testDb.prepare('SELECT status, source_repo, reviewed_at, version FROM plugins WHERE id = ?').get('my-upload') as
      { status: string; source_repo: string | null; reviewed_at: string | null; version: string } | undefined;
    expect(row?.status).toBe('inactive');       // never auto-activates
    expect(row?.source_repo).toBe('local:upload');
    expect(row?.reviewed_at).toBeNull();        // unsigned + unreviewed → flagged in the UI
    expect(row?.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(codeRoot, 'my-upload', 'trek-plugin.json'))).toBe(true);
    expect(fs.existsSync(staged.stagingDir)).toBe(false); // staging cleaned up
  });

  it('sideload: rejects an oversized archive', () => {
    expect(() => svc.stageUpload(Buffer.alloc(50 * 1024 * 1024 + 8192))).toThrow(/50MB|exceed/i);
  });

  it('sideload: rejects an archive without a manifest', () => {
    const empty = zlib.gzipSync(Buffer.alloc(1024, 0)); // valid gzip, empty tar
    expect(() => svc.stageUpload(empty)).toThrow(/trek-plugin\.json/);
  });

  it('sideload: forces INACTIVE even when replacing a plugin that was active', () => {
    const zip = () => makeArtifact({ id: 'my-upload', name: 'Uploaded', version: '2.0.0', type: 'widget', permissions: ['db:own'] });
    svc.commitUpload(svc.stageUpload(zip()));                                            // first install
    testDb.prepare("UPDATE plugins SET status = 'active', enabled = 1 WHERE id = 'my-upload'").run(); // admin activated it
    svc.commitUpload(svc.stageUpload(zip()));                                            // re-upload replaces the code
    const row = testDb.prepare('SELECT status, enabled FROM plugins WHERE id = ?').get('my-upload') as { status: string; enabled: number };
    expect(row.status).toBe('inactive');   // discoverPlugins keeps the old status; commitUpload floors it back to inactive
    expect(row.enabled).toBe(0);
  });

  it('soft-fails on a non-ok registry response', async () => {
    __clearRegistryCacheForTests();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    expect((await svc.fetchRegistry()).plugins).toEqual([]);
  });

  it('rejects a version that is not listed', async () => {
    await expect(svc.install('flight-tracker', { version: '9.9.9' })).rejects.toThrow(/not found/);
  });

  it('rejects an archive without a manifest', async () => {
    const parts = [Buffer.alloc(1024, 0)]; // empty tar
    const empty = zlib.gzipSync(Buffer.concat(parts));
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(empty).digest('hex');
    safeDownload.mockResolvedValue({ bytes: empty, sha256: REGISTRY.plugins[0].versions[0].sha256 });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/no trek-plugin.json/);
  });

  it('rejects a manifest id that does not match the registry id', async () => {
    const artifact = makeArtifact({ id: 'other-id', name: 'X', version: '1.0.0', type: 'widget' });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/!=/);
  });

  it('installs a signed plugin and pins the author key (TOFU)', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    await expect(svc.install('flight-tracker')).resolves.toEqual({ id: 'flight-tracker', version: '1.0.0', trekRangeBypassed: null });
    const row = testDb.prepare("SELECT author_pubkey FROM plugins WHERE id='flight-tracker'").get() as { author_pubkey: string };
    expect(row.author_pubkey).toBe(k.pubB64);
  });

  it('rejects a signed plugin whose signature does not verify', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, () => k.sign(Buffer.from('different bytes')));
    await expect(svc.install('flight-tracker')).rejects.toThrow(/signature verification failed/);
  });

  it('rejects an update whose author key differs from the pinned one (TOFU mismatch)', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');
    const b = signingKey();
    stageSignedArtifact(b.pubB64, b.sign); // valid signature, but a different author key
    await expect(svc.install('flight-tracker')).rejects.toThrow(/author signing key changed/);
  });

  it('rejects a half-signed entry (key without a signature)', async () => {
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey = signingKey().pubB64; // no version signature
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/incomplete signature/);
  });

  it('refuses to downgrade a previously-signed plugin to an unsigned update', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    await svc.install('flight-tracker');
    // now offer an unsigned update
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    delete (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey;
    delete (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/unsigned/);
  });
});

/**
 * Machine-readable codes on the four signature refusals.
 *
 * These exist because exactly ONE of the four (a rotated key) may ever be overridden by
 * an admin, and the UI has to tell them apart without reading prose. A client that
 * string-matches the message will eventually offer "re-trust" on a signature that simply
 * does not verify — the worst outcome this whole surface could produce.
 */
describe('signature failure codes', () => {
  const codeOf = async (): Promise<string | undefined> => {
    try {
      await svc.install('flight-tracker');
      return undefined; // installed — no refusal
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryError);
      return (e as RegistryError).code;
    }
  };

  it('SIGNATURE_MISSING — was signed before, the update is unsigned', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    await svc.install('flight-tracker');

    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    delete (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey;
    delete (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });

    expect(await codeOf()).toBe('SIGNATURE_MISSING');
  });

  it('SIGNATURE_INCOMPLETE — an author key with no version signature', async () => {
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey = signingKey().pubB64;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });

    expect(await codeOf()).toBe('SIGNATURE_INCOMPLETE');
  });

  it('SIGNATURE_KEY_CHANGED — the pinned key no longer matches the registry entry', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');
    const b = signingKey();
    stageSignedArtifact(b.pubB64, b.sign); // a VALID signature — under a different key

    expect(await codeOf()).toBe('SIGNATURE_KEY_CHANGED');
  });

  it('SIGNATURE_INVALID — a well-formed signature that does not verify', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, () => k.sign(Buffer.from('different bytes')));

    expect(await codeOf()).toBe('SIGNATURE_INVALID');
  });

  // verifyAuthorSignature THROWS SignatureError (not RegistryError) on a malformed key or
  // signature, and that used to escape verifySignatureAndTofu untyped. To an admin a
  // malformed signature and an invalid one are the same thing, and both are non-overridable.
  it('SIGNATURE_INVALID — a MALFORMED signature (SignatureError is mapped, not leaked)', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature = Buffer.from('nonsense').toString('base64');

    expect(await codeOf()).toBe('SIGNATURE_INVALID');
  });

  it('SIGNATURE_INVALID — a MALFORMED author key', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey = Buffer.from('not-a-key').toString('base64');

    expect(await codeOf()).toBe('SIGNATURE_INVALID');
  });

  it('records the refusal so the admin list can keep showing it, and clears it on a later success', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');

    const b = signingKey();
    stageSignedArtifact(b.pubB64, b.sign);
    await expect(svc.install('flight-tracker')).rejects.toThrow();

    const blocked = testDb.prepare("SELECT * FROM plugins WHERE id='flight-tracker'").get() as Record<string, unknown>;
    expect(blocked.update_block_code).toBe('SIGNATURE_KEY_CHANGED');
    expect(blocked.update_block_version).toBe('1.0.0');
    // The plugin still RUNS fine on its old code — a blocked update is not a broken
    // runtime, and marking it 'error' would make the health dot lie.
    expect(blocked.status).not.toBe('error');
    // ...and the old key is still pinned. A refused update changes nothing.
    expect(blocked.author_pubkey).toBe(a.pubB64);

    // The author reverts to the original key: the install succeeds and the block goes.
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');
    const after = testDb.prepare("SELECT * FROM plugins WHERE id='flight-tracker'").get() as Record<string, unknown>;
    expect(after.update_block_code).toBeNull();
    expect(after.update_block_version).toBeNull();
  });

  it('browse reports signed + the full author key (a public key — the re-trust round-trip needs it exact)', async () => {
    const k = signingKey();
    stageSignedArtifact(k.pubB64, k.sign);
    __clearRegistryCacheForTests();

    const [entry] = await svc.browse();
    expect(entry.signed).toBe(true);
    expect(entry.authorPublicKey).toBe(k.pubB64);
  });

  it('browse reports unsigned when the entry has no key', async () => {
    const [entry] = await svc.browse();
    expect(entry.signed).toBe(false);
    expect(entry.authorPublicKey).toBeNull();
  });
});

/**
 * Re-trust. These encode the two decisions that make this surface safe rather than merely
 * visible; if they ever go green by accident, the feature is a downgrade hole.
 *
 *  D1 — a re-trust moves the pin from one VERIFIED key to another verified key. The
 *       obvious implementation (clear author_pubkey to NULL and let TOFU re-pin) would
 *       return the plugin to the "never been signed" state, where an UNSIGNED update is
 *       legitimately accepted. That trades a key-rotation block for a silent downgrade.
 *  D2 — re-trust is offered ONLY for a rotated key. A signature that doesn't verify means
 *       the bytes are not what the author signed; there is no story where waving that
 *       through is right. Enforced in the SERVICE, not by hiding a button.
 */
describe('re-trust (assertRetrustable)', () => {
  /** Install under key `a`, then have the registry offer key `b` — the rotation case. */
  async function rotateTo(b: { pubB64: string; sign: (x: Buffer) => string }, a = signingKey()) {
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');
    testDb.prepare("UPDATE plugins SET source_repo='acme/trek-flight' WHERE id='flight-tracker'").run();
    stageSignedArtifact(b.pubB64, b.sign);
    return a;
  }

  it('accepts the rotated key the admin was shown, and hands back the entry', async () => {
    const b = signingKey();
    await rotateTo(b);
    await expect(svc.assertRetrustable('flight-tracker', b.pubB64)).resolves.toMatchObject({ authorPublicKey: b.pubB64 });
  });

  // D1 (TOCTOU): the client echoes back the key the DIALOG rendered. If the entry has been
  // re-keyed AGAIN since then, the admin would be blessing a key they never laid eyes on.
  it('refuses when the entry was re-keyed again between the dialog and the click', async () => {
    const b = signingKey();
    await rotateTo(b);
    const c = signingKey();
    stageSignedArtifact(c.pubB64, c.sign); // the registry moved on to a THIRD key
    __clearRegistryCacheForTests();

    await expect(svc.assertRetrustable('flight-tracker', b.pubB64)).rejects.toMatchObject({ code: 'RETRUST_KEY_MISMATCH' });
  });

  // D2, enforced server-side. The UI hiding the button is a convenience, not the control.
  it('refuses a plugin whose key did NOT change (nothing to re-trust)', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');
    testDb.prepare("UPDATE plugins SET source_repo='acme/trek-flight' WHERE id='flight-tracker'").run();

    await expect(svc.assertRetrustable('flight-tracker', a.pubB64)).rejects.toMatchObject({ code: 'RETRUST_NOT_APPLICABLE' });
  });

  it('refuses a sideloaded plugin (it sits outside the registry trust model entirely)', async () => {
    const b = signingKey();
    await rotateTo(b);
    testDb.prepare("UPDATE plugins SET source_repo='local:upload' WHERE id='flight-tracker'").run();

    await expect(svc.assertRetrustable('flight-tracker', b.pubB64)).rejects.toMatchObject({ code: 'RETRUST_NOT_APPLICABLE' });
  });

  // D1, the one that matters most: a key an admin blesses must still SIGN THE CODE it
  // ships. Re-trusting is not a way to install something unverified.
  it('refuses to install under a re-trusted key that does not actually validate the artifact', async () => {
    const b = signingKey();
    const a = await rotateTo(b);
    // The registry now offers b's key — but the signature is garbage under it.
    (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature = b.sign(Buffer.from('other bytes'));
    __clearRegistryCacheForTests();

    await expect(svc.install('flight-tracker', { version: '1.0.0', retrustKey: b.pubB64 })).rejects.toMatchObject({
      code: 'SIGNATURE_INVALID',
    });
    // The old key is STILL pinned — a refused re-trust changes nothing.
    const row = testDb.prepare("SELECT author_pubkey FROM plugins WHERE id='flight-tracker'").get() as { author_pubkey: string };
    expect(row.author_pubkey).toBe(a.pubB64);
  });

  it('re-pins to the new key once the artifact verifies under it — and NEVER to NULL', async () => {
    const b = signingKey();
    await rotateTo(b);
    __clearRegistryCacheForTests();

    await expect(svc.install('flight-tracker', { version: '1.0.0', retrustKey: b.pubB64 })).resolves.toMatchObject({ version: '1.0.0' });
    const row = testDb.prepare("SELECT author_pubkey, update_block_code FROM plugins WHERE id='flight-tracker'").get() as {
      author_pubkey: string | null;
      update_block_code: string | null;
    };
    expect(row.author_pubkey).toBe(b.pubB64);
    expect(row.author_pubkey).not.toBeNull();
    expect(row.update_block_code).toBeNull();
  });

  // The retrustKey override lifts ONLY the key-change stop. Handing it an unsigned entry
  // must not open the "never been signed" path — that is the downgrade hole D1 exists for.
  it('a retrustKey cannot wave through an unsigned update of a previously-signed plugin', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');

    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', permissions: ['db:own'] });
    REGISTRY.plugins[0].versions[0].sha256 = createHash('sha256').update(artifact).digest('hex');
    delete (REGISTRY.plugins[0] as { authorPublicKey?: string }).authorPublicKey;
    delete (REGISTRY.plugins[0].versions[0] as { signature?: string }).signature;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: REGISTRY.plugins[0].versions[0].sha256 });
    __clearRegistryCacheForTests();

    await expect(svc.install('flight-tracker', { version: '1.0.0', retrustKey: 'anything' })).rejects.toMatchObject({
      code: 'SIGNATURE_MISSING',
    });
    const row = testDb.prepare("SELECT author_pubkey FROM plugins WHERE id='flight-tracker'").get() as { author_pubkey: string | null };
    expect(row.author_pubkey).toBe(a.pubB64); // still pinned, never NULL
  });
});

describe('PluginRegistryService.resolveVersion (latest compatible)', () => {
  const MULTI = {
    schemaVersion: 1,
    plugins: [{
      id: 'multi', name: 'Multi', author: 'a', description: 'many versions', repo: 'a/b', type: 'integration',
      versions: [
        { version: '2.1.0', gitTag: 'v2.1.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/x', sha256: '', minTrekVersion: '3.4.0' },
        { version: '2.0.0', gitTag: 'v2.0.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/y', sha256: '', minTrekVersion: '3.2.0' },
        { version: '1.5.0', gitTag: 'v1.5.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/z', sha256: '', minTrekVersion: '3.0.0' },
      ],
    }],
  };
  const stub = () => { __clearRegistryCacheForTests(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => MULTI }) as unknown as Response)); };

  it('picks the highest version compatible with the running TREK', async () => {
    process.env.APP_VERSION = '3.3.0'; stub();
    expect((await svc.resolveVersion('multi')).version).toBe('2.0.0'); // 2.1.0 needs 3.4.0 > host
    delete process.env.APP_VERSION;
  });
  it('picks the highest version satisfying a semver range', async () => {
    process.env.APP_VERSION = '3.3.0'; stub();
    expect((await svc.resolveVersion('multi', '>=1.0.0 <2.0.0')).version).toBe('1.5.0');
    delete process.env.APP_VERSION;
  });
  it('throws when nothing satisfies the constraint', async () => {
    process.env.APP_VERSION = '3.3.0'; stub();
    await expect(svc.resolveVersion('multi', '>=9.0.0')).rejects.toThrow(RegistryError);
    delete process.env.APP_VERSION;
  });
  it('throws for a plugin not in the registry', async () => {
    stub();
    await expect(svc.resolveVersion('nope')).rejects.toThrow(/not in registry/);
  });
});

/**
 * The install must be satisfied by the running TREK — on EVERY path.
 *
 * hostCompatible() used to be reachable only from resolveVersion(), i.e. only when the
 * caller passed a semver constraint. The admin UI's Install button passes neither a
 * version nor a constraint, so the one path an admin actually clicks was the one that
 * skipped the check entirely.
 */
describe('TREK-version gating on install', () => {
  const MULTI = {
    schemaVersion: 1,
    plugins: [{
      id: 'multi', name: 'Multi', author: 'a', description: 'many versions', repo: 'a/b', type: 'integration',
      versions: [
        { version: '2.1.0', gitTag: 'v2.1.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/x', sha256: '', minTrekVersion: '3.4.0', trek: '>=3.4.0 <4.0.0' },
        { version: '2.0.0', gitTag: 'v2.0.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/y', sha256: '', minTrekVersion: '3.2.0', trek: '>=3.2.0 <4.0.0' },
      ],
    }],
  };
  const stubMulti = () => { __clearRegistryCacheForTests(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => MULTI }) as unknown as Response)); };

  afterEach(() => { delete process.env.APP_VERSION; });

  /** Stage `version`'s artifact so a successful install has real bytes to fetch. */
  const stageMulti = (version: string, idx: number) => {
    const artifact = makeArtifact({ id: 'multi', name: 'Multi', version, type: 'integration', trek: MULTI.plugins[0].versions[idx].trek });
    const sha = createHash('sha256').update(artifact).digest('hex');
    MULTI.plugins[0].versions[idx].sha256 = sha;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });
  };

  it('install-latest takes the newest version this TREK can RUN, not the newest published', async () => {
    // 2.1.0 is versions[0] and needs >=3.4.0. The old code fetched it without asking; now
    // the same "install latest" the admin's button sends resolves to 2.0.0 instead.
    process.env.APP_VERSION = '3.3.0'; stubMulti();
    stageMulti('2.0.0', 1);
    await expect(svc.install('multi')).resolves.toMatchObject({ id: 'multi', version: '2.0.0' });
    expect(safeDownload).toHaveBeenCalledWith(MULTI.plugins[0].versions[1].downloadUrl, expect.any(Number));
  });

  it('refuses install-latest outright when NO published version fits', async () => {
    process.env.APP_VERSION = '3.0.0'; stubMulti(); // both versions need >=3.2.0
    await expect(svc.install('multi')).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    expect(safeDownload).not.toHaveBeenCalled(); // refused BEFORE a byte is fetched
  });

  it('refuses an explicitly-pinned version this TREK cannot run', async () => {
    process.env.APP_VERSION = '3.3.0'; stubMulti();
    await expect(svc.install('multi', { version: '2.1.0' })).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    expect(safeDownload).not.toHaveBeenCalled();
  });

  it('honours an EXCLUSIVE upper bound, which minTrekVersion alone cannot express', async () => {
    // Both versions declare "<4.0.0" and neither carries a maxTrekVersion — under the old
    // min-only check TREK 4 looked compatible with everything.
    process.env.APP_VERSION = '4.0.0'; stubMulti();
    await expect(svc.install('multi')).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
  });

  /**
   * TREK_PLUGINS_IGNORE_TREK_RANGE: the operator's explicit "install it anyway". Every gate
   * above turns into a warning + a `trekRangeBypassed` marker in the response, so the admin
   * is told the author never vouched for this TREK. The registry's compat VERDICT stays
   * truthful — the UI needs it to say "outside its range" while still offering the button.
   */
  describe('range bypass (TREK_PLUGINS_IGNORE_TREK_RANGE)', () => {
    beforeEach(() => { process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1'; });
    afterEach(() => { delete process.env.TREK_PLUGINS_IGNORE_TREK_RANGE; });

    it('install-latest fetches the newest PUBLISHED version and reports the ignored range', async () => {
      process.env.APP_VERSION = '3.3.0'; stubMulti();
      stageMulti('2.1.0', 0);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(svc.install('multi')).resolves.toEqual({
        id: 'multi', version: '2.1.0', trekRangeBypassed: { trekRange: '>=3.4.0 <4.0.0', hostVersion: '3.3.0' },
      });
      expect(warn.mock.calls.some((c) => /multi.*>=3\.4\.0 <4\.0\.0.*3\.3\.0/.test(String(c[0])))).toBe(true);
      warn.mockRestore();
    });

    it('installs an explicitly-pinned version this TREK cannot run', async () => {
      process.env.APP_VERSION = '3.3.0'; stubMulti();
      stageMulti('2.1.0', 0);
      await expect(svc.install('multi', { version: '2.1.0' })).resolves.toMatchObject({
        version: '2.1.0', trekRangeBypassed: { trekRange: '>=3.4.0 <4.0.0', hostVersion: '3.3.0' },
      });
    });

    it('a version that fits is a normal install — no marker, nothing to warn about', async () => {
      process.env.APP_VERSION = '3.5.0'; stubMulti();
      stageMulti('2.1.0', 0);
      await expect(svc.install('multi')).resolves.toEqual({ id: 'multi', version: '2.1.0', trekRangeBypassed: null });
    });

    it('browse keeps telling the truth about compatibility', async () => {
      process.env.APP_VERSION = '3.3.0'; stubMulti();
      const [item] = await svc.browse(true);
      expect(item).toMatchObject({ compatible: false, latestCompatible: '2.0.0', hostVersion: '3.3.0' });
    });

    it("re-gate on the ARTIFACT's range warns instead of refusing, with the artifact's range", async () => {
      process.env.APP_VERSION = '3.9.0';
      __clearRegistryCacheForTests();
      const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', trek: '>=3.2.0 <3.4.0' });
      const sha = createHash('sha256').update(artifact).digest('hex');
      REGISTRY.plugins[0].versions[0].sha256 = sha;
      safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });
      await expect(svc.install('flight-tracker')).resolves.toMatchObject({
        id: 'flight-tracker', trekRangeBypassed: { trekRange: '>=3.2.0 <3.4.0', hostVersion: '3.9.0' },
      });
      expect(fs.existsSync(path.join(codeRoot, 'flight-tracker'))).toBe(true);
    });

    it('installs an artifact that declares no range at all, saying so', async () => {
      process.env.APP_VERSION = '3.9.0';
      __clearRegistryCacheForTests();
      const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', trek: undefined });
      const sha = createHash('sha256').update(artifact).digest('hex');
      REGISTRY.plugins[0].versions[0].sha256 = sha;
      safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });
      await expect(svc.install('flight-tracker')).resolves.toMatchObject({
        trekRangeBypassed: { trekRange: null, hostVersion: '3.9.0' },
      });
    });

    it('sideload: stages an incompatible or rangeless archive and reports it', () => {
      process.env.APP_VERSION = '3.9.0';
      const old = svc.stageUpload(makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', trek: '>=3.0.0 <3.5.0' }));
      expect(old).toMatchObject({ id: 'my-upload', trekRangeBypassed: { trekRange: '>=3.0.0 <3.5.0', hostVersion: '3.9.0' } });
      fs.rmSync(old.stagingDir, { recursive: true, force: true });
      const rangeless = svc.stageUpload(makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', trek: undefined }));
      expect(rangeless).toMatchObject({ trekRangeBypassed: { trekRange: null, hostVersion: '3.9.0' } });
      fs.rmSync(rangeless.stagingDir, { recursive: true, force: true });
      const fits = svc.stageUpload(makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration' }));
      expect(fits.trekRangeBypassed).toBeNull();
      fs.rmSync(fits.stagingDir, { recursive: true, force: true });
    });

    it('does NOT lift the plugin-API version gate — that one is a real ABI break', () => {
      const bytes = makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', apiVersion: 2 });
      expect(() => svc.stageUpload(bytes)).toThrow('plugin requires plugin-API v2; this TREK supports v1');
    });
  });

  it('reports the newest version this TREK CAN run, so the UI can offer it', async () => {
    process.env.APP_VERSION = '3.3.0'; stubMulti();
    const [item] = await svc.browse(true);
    expect(item).toMatchObject({ id: 'multi', latest: '2.1.0', compatible: false, latestCompatible: '2.0.0', hostVersion: '3.3.0' });
  });

  it('reports plain compatibility when the latest version fits', async () => {
    process.env.APP_VERSION = '3.5.0'; stubMulti();
    const [item] = await svc.browse(true);
    expect(item).toMatchObject({ compatible: true, latestCompatible: '2.1.0' });
  });

  it('tolerates a legacy entry with NO lower bound at all (minTrekVersion: null)', async () => {
    // The schema allows a null floor, so nothing may assume a string here: the legacy check
    // must skip the bound rather than compare against it, and the "requires TREK …" message
    // must not interpolate a missing bound as the word "null".
    process.env.APP_VERSION = '3.3.0';
    __clearRegistryCacheForTests();
    const noFloor = {
      schemaVersion: 1,
      plugins: [{
        id: 'nofloor', name: 'NoFloor', author: 'a', description: 'no lower bound', repo: 'a/b', type: 'integration',
        versions: [{ version: '1.0.0', gitTag: 'v1.0.0', commitSha: 'a'.repeat(40), downloadUrl: 'https://codeload.github.com/a/b/tar.gz/x', sha256: '', minTrekVersion: null, maxTrekVersion: '3.0.0' }],
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => noFloor }) as unknown as Response));

    // Only the ceiling applies, and TREK 3.3 is past it — refused, with a readable reason.
    const err = await svc.install('nofloor').catch((e) => e);
    expect(err).toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    expect(err.message).toContain('<=3.0.0');
    expect(err.message).not.toContain('null');
  });

  it('falls back to the legacy min/max bounds for an entry published without a range', async () => {
    process.env.APP_VERSION = '3.1.0'; // the fixture entry declares minTrekVersion 3.2.0, no trek
    __clearRegistryCacheForTests();
    await expect(svc.install('flight-tracker')).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
  });

  it("re-gates on the ARTIFACT's own range — the index metadata is only a pre-download filter", async () => {
    // The registry index says 3.2.0+, but the manifest inside the tarball says it stops at
    // 3.3.0. The bytes are what will run, so the bytes get the last word.
    process.env.APP_VERSION = '3.9.0';
    __clearRegistryCacheForTests();
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', trek: '>=3.2.0 <3.4.0' });
    const sha = createHash('sha256').update(artifact).digest('hex');
    REGISTRY.plugins[0].versions[0].sha256 = sha;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });
    await expect(svc.install('flight-tracker')).rejects.toMatchObject({ code: 'TREK_VERSION_INCOMPATIBLE' });
    expect(fs.existsSync(path.join(codeRoot, 'flight-tracker'))).toBe(false); // nothing moved into place
  });

  it('refuses an artifact that declares no range at all', async () => {
    __clearRegistryCacheForTests();
    const artifact = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '1.0.0', type: 'widget', trek: undefined });
    const sha = createHash('sha256').update(artifact).digest('hex');
    REGISTRY.plugins[0].versions[0].sha256 = sha;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });
    await expect(svc.install('flight-tracker')).rejects.toThrow(/missing "trek"/);
  });

  describe('sideload', () => {
    it('refuses an uploaded archive this TREK cannot run, and cleans up staging', async () => {
      process.env.APP_VERSION = '3.9.0';
      const bytes = makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', trek: '>=3.0.0 <3.5.0' });
      expect(() => svc.stageUpload(bytes)).toThrow(expect.objectContaining({ code: 'TREK_VERSION_INCOMPATIBLE' }));
      const staging = path.join(dataRoot, '.staging');
      // The rejected upload leaves nothing extracted behind.
      expect(fs.existsSync(staging) ? fs.readdirSync(staging) : []).toEqual([]);
    });

    it('refuses an uploaded archive that declares no range', () => {
      const bytes = makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', trek: undefined });
      expect(() => svc.stageUpload(bytes)).toThrow(/missing "trek"/);
    });

    it('refuses an uploaded archive declaring apiVersion 2 (this TREK only speaks plugin-API v1), and writes nothing to the plugin code dir', () => {
      // trek range is satisfiable on its own — parseManifest's apiVersion check must
      // fire (and stop the upload) before assertHostCompatible is ever reached.
      const bytes = makeArtifact({ id: 'my-upload', name: 'Up', version: '1.0.0', type: 'integration', apiVersion: 2 });
      expect(() => svc.stageUpload(bytes)).toThrow('plugin requires plugin-API v2; this TREK supports v1');
      expect(fs.existsSync(path.join(codeRoot, 'my-upload'))).toBe(false);
    });
  });

  it('installWithDependencies installs the version it RESOLVED, not versions[0]', async () => {
    // It resolved a compatible version and then called install() with the range (or with
    // nothing, for the root), which made install() re-pick — landing on versions[0] and
    // discarding the compatible choice entirely.
    process.env.APP_VERSION = '3.3.0'; stubMulti();
    const artifact = makeArtifact({ id: 'multi', name: 'Multi', version: '2.0.0', type: 'integration', trek: '>=3.2.0 <4.0.0' });
    const sha = createHash('sha256').update(artifact).digest('hex');
    MULTI.plugins[0].versions[1].sha256 = sha;
    safeDownload.mockResolvedValue({ bytes: artifact, sha256: sha });

    const res = await svc.installWithDependencies('multi');
    expect(res.installed).toEqual(['multi']);
    expect(safeDownload).toHaveBeenCalledWith(MULTI.plugins[0].versions[1].downloadUrl, expect.any(Number)); // 2.0.0, not 2.1.0
  });
});

/**
 * Leaving the registry trust model (sideload / dev-link) must take the update-block with it.
 *
 * A block describes a refused REGISTRY update. Once an admin hands TREK the bytes directly,
 * the running code is whatever they uploaded — a warning about an author's signing key says
 * nothing about it, and the row would insist an update was blocked over a key that no longer
 * applies to the code in front of them.
 */
describe('an update block does not outlive the registry relationship', () => {
  it('sideloading clears a recorded block (and the pinned key)', async () => {
    const a = signingKey();
    stageSignedArtifact(a.pubB64, a.sign);
    await svc.install('flight-tracker');

    const b = signingKey();
    stageSignedArtifact(b.pubB64, b.sign);
    await expect(svc.install('flight-tracker')).rejects.toThrow(); // rotated key → blocked
    expect(
      (testDb.prepare("SELECT update_block_code FROM plugins WHERE id='flight-tracker'").get() as { update_block_code: string })
        .update_block_code,
    ).toBe('SIGNATURE_KEY_CHANGED');

    // The admin now uploads the plugin by hand.
    const upload = makeArtifact({ id: 'flight-tracker', name: 'Flight', version: '9.9.9', type: 'widget', permissions: ['db:own'] });
    svc.commitUpload(svc.stageUpload(upload));

    const row = testDb.prepare("SELECT source_repo, author_pubkey, update_block_code, update_block_version FROM plugins WHERE id='flight-tracker'").get() as Record<string, unknown>;
    expect(row.source_repo).toBe('local:upload');
    expect(row.author_pubkey).toBeNull(); // out of the trust model — deliberate, and badged
    expect(row.update_block_code).toBeNull();
    expect(row.update_block_version).toBeNull();
  });
});
