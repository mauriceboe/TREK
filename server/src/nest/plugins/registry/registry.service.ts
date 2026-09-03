import { readEnv } from '../../../app-config';
import { DatabaseService } from '../../database/database.service';
import { discoverPlugins } from '../install/discovery';
import { bypassedRange, hostSatisfies, hostVersion, normalizedHost, trekRangeBypassed, warnRangeBypass } from '../install/host-compat';
import type { TrekRangeBypass } from '../install/host-compat';
import type { PluginDependency } from '../install/manifest';
import { parseJsonText, parseManifest } from '../install/manifest';
import { scanForNativeBinaries } from '../install/native-scan';
import { extractArchive } from '../install/safe-extract';
import { safeDownload, sha256Matches } from '../install/safe-fetch';
import { verifyAuthorSignature, SignatureError } from '../install/verify-signature';
import { pluginCodeDir, pluginsCodeRoot, pluginsDataRoot } from '../paths';
import { clearUpdateBlock, isSignatureCode, setUpdateBlock, RETRUSTABLE_CODE } from '../signature-status';
import { Injectable } from '@nestjs/common';

import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { MCP_TOOLS_MAX, TOOL_DESCRIPTION_MAX, TOOL_TITLE_MAX } from '../mcp-tool-schema';
import { sanitiseAssistantText } from '../text-sanitize';

/**
 * TREK-side of the plugin registry (#plugins, M5). Fetches the single aggregated
 * dist/index.json (never per-plugin GitHub API calls — the HACS rate-limit
 * lesson), caches it briefly + soft-fails, and installs a pinned version through
 * the M4 pipeline: SSRF-safe download -> sha256 verify -> zip/tar-slip-safe
 * extract -> manifest re-validate -> native re-scan -> atomic move -> discover
 * (registers INACTIVE). Nothing executes on install; activation is separate.
 */

// Frozen at import on purpose (legacy timing) — the registry URL is boot-stable.
const REGISTRY_URL = readEnv().plugins.registryUrl;
const CACHE_TTL = 30 * 60 * 1000;
const MANIFEST_MAX_BYTES = 256 * 1024;
// Sideload upload ceiling — matches the SDK `pack` limit (50 MB) plus zip overhead.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 + 4096;

interface RegistryVersion {
  version: string;
  gitTag: string;
  commitSha: string;
  downloadUrl: string;
  sha256: string;
  /**
   * The version's declared TREK range, mirroring its manifest's `trek`. Authoritative
   * when present. `minTrekVersion`/`maxTrekVersion` are the legacy shape — a lower bound
   * plus an optional INCLUSIVE upper bound, which cannot express the exclusive `<4.0.0`
   * that a manifest actually declares — and stay only so entries published before this
   * field existed still gate.
   */
  trek?: string;
  /** Nullable: an entry may carry no lower bound at all (and a legacy one carries only this). */
  minTrekVersion?: string | null;
  maxTrekVersion?: string | null;
  size?: number;
  apiVersion?: number;
  nativeModules?: boolean;
  publishedAt?: string;
  /** base64 minisign signature (.minisig payload) over the artifact bytes. */
  signature?: string;
  /** Addon ids this version requires enabled (mirrors the manifest; #plugins deps). */
  requiredAddons?: string[];
  /** Other plugins this version depends on (mirrors the manifest). */
  pluginDependencies?: PluginDependency[];
}
export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  homepage?: string;
  tags?: string[];
  type: string;
  /** A lucide icon name for the store tile; absent means the client's default (Blocks). */
  icon?: string;
  reviewedAt?: string | null;
  /** base64 minisign author public key — stable across versions, TOFU-pinned. */
  authorPublicKey?: string;
  /** Release-asset downloads across all versions, aggregated by the registry's stats cron. */
  downloadCount?: number | null;
  /**
   * Store cover image, resolved at build time by the registry's aggregate step:
   * docs/screenshot.png at the latest commit, else the first README image that
   * resolves there. Absent for entries published before this existed — browse
   * and detail then construct the docs/screenshot.png URL themselves.
   */
  screenshotUrl?: string | null;
  versions: RegistryVersion[];
}
interface Registry {
  schemaVersion: number;
  generatedAt?: string;
  plugins: RegistryEntry[];
}

/** A registry entry's standing against the running TREK, resolved server-side. */
export interface HostCompat {
  /** The latest version's declared TREK range, or null for a legacy (min/max-only) entry. */
  trek: string | null;
  hostVersion: string;
  /** Whether the LATEST version can be installed on this TREK. */
  compatible: boolean;
  /** Newest installable version — the latest one, or an older fallback, or null if none fits. */
  latestCompatible: string | null;
}

/** Anzeige-only preview of a plugin's live manifest (fetched at the reviewed commit). */
export interface ManifestPreview {
  permissions: string[];
  egress: string[];
  /**
   * The plugin talks to a service only the OPERATOR can name (a self-hosted Gotify/ntfy),
   * so its `egress` can't be the whole story — an admin adds the real hosts after install.
   * Surfaced pre-install so the reviewer knows the network reach is not fully described by
   * the hosts listed above.
   */
  operatorEgress: boolean;
  settings: Array<{ key: string; label: string; inputType: string; scope: string; required: boolean }>;
  license: string | null;
  icon: string | null;
  requiredAddons: string[];
  pluginDependencies: PluginDependency[];
  /**
   * The UI-facing slice of `capabilities`. A plugin that replaces planner tabs hides core
   * UI, so the reviewer has to see it BEFORE installing, not only on the installed row.
   */
  capabilities: {
    widget?: { slot?: string };
    tripPage?: { replaces?: string[] };
    /**
     * The tools this plugin will publish into every user's assistant context if
     * `mcp:tools` is granted. Carried in the PREVIEW, not just on the installed
     * row, because the whole point is that an admin reads the text before
     * approving the grant rather than meeting it later inside a chat.
     */
    mcpTools?: Array<{ name: string; title?: string; description: string }>;
  };
}

let _cache: { data: Registry; expiresAt: number } | null = null;
const _detailCache = new Map<string, { data: unknown; expiresAt: number }>();

/** Test hook: drop the in-memory registry cache. */
export function __clearRegistryCacheForTests(): void {
  _cache = null;
  _detailCache.clear();
}

/**
 * A registry/install failure. `code` is machine-readable and MUST survive out to
 * the client: the admin UI decides whether to offer a re-trust override from the
 * code, never by string-matching the message. A client that matches on prose will
 * eventually offer the override on the wrong condition — which is the single worst
 * outcome this surface could produce.
 */
export class RegistryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

@Injectable()
export class PluginRegistryService {
  constructor(private readonly dbs: DatabaseService) {}

  private get db() {
    return this.dbs.connection;
  }

  /**
   * Fetch the aggregated registry (cached, soft-fail, stale-serve). Pass
   * force=true (the admin "rescan" button) to bypass the 30-min cache and also
   * bust GitHub's raw CDN edge cache (max-age=300), so a just-merged registry
   * entry shows up right away instead of up to ~35 min later.
   */
  async fetchRegistry(force = false): Promise<Registry> {
    if (!force && _cache && Date.now() < _cache.expiresAt) return _cache.data;
    if (force) _detailCache.clear();
    try {
      const url = force ? `${REGISTRY_URL}${REGISTRY_URL.includes('?') ? '&' : '?'}_=${Date.now()}` : REGISTRY_URL;
      const headers: Record<string, string> = { 'User-Agent': 'TREK-Server' };
      if (force) {
        headers['Cache-Control'] = 'no-cache';
        headers.Pragma = 'no-cache';
      }
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`registry ${resp.status}`);
      const data = (await resp.json()) as Registry;
      if (!data || !Array.isArray(data.plugins)) throw new Error('malformed registry');
      _cache = { data, expiresAt: Date.now() + CACHE_TTL };
      return data;
    } catch {
      return _cache?.data ?? { schemaVersion: 1, plugins: [] };
    }
  }

  /**
   * The browse list the admin UI renders (metadata only, no code).
   *
   * `signed` describes the LATEST version (browse already treats versions[0] as
   * latest), so on a version-constrained install the badge can describe a version
   * other than the artifact actually fetched. Accepted for a Discover card.
   * `authorPublicKey` is exposed in full — it is a public key, and the re-trust
   * round-trip compares it exactly (a truncated fingerprint would be a weak check).
   */
  async browse(force = false): Promise<
    Array<
      Omit<RegistryEntry, 'versions'> & {
        latest: string | null;
        minTrekVersion: string | null;
        requiredAddons: string[];
        pluginDependencies: PluginDependency[];
        screenshotUrl: string | null;
        signed: boolean;
        authorPublicKey: string | null;
      } & HostCompat
    >
  > {
    const reg = await this.fetchRegistry(force);
    return reg.plugins.map((p) => {
      const latest = p.versions[0] ?? null;
      return {
        id: p.id,
        name: p.name,
        author: p.author,
        description: p.description,
        repo: p.repo,
        homepage: p.homepage,
        tags: p.tags,
        type: p.type,
        icon: p.icon,
        reviewedAt: p.reviewedAt ?? null,
        downloadCount: p.downloadCount ?? null,
        latest: latest?.version ?? null,
        minTrekVersion: latest?.minTrekVersion ?? null,
        requiredAddons: latest?.requiredAddons ?? [],
        pluginDependencies: latest?.pluginDependencies ?? [],
        screenshotUrl: p.screenshotUrl ?? (latest ? rawFileUrl(p.repo, latest.commitSha, 'docs/screenshot.png') : null),
        signed: !!p.authorPublicKey && !!latest?.signature,
        authorPublicKey: p.authorPublicKey ?? null,
        ...this.hostCompat(p),
      };
    });
  }

  /**
   * How this entry stands against the running TREK, computed SERVER-side. The client has
   * no semver dependency and must never grow a second implementation of range logic — a
   * UI that disagreed with the install gate would show an enabled button that 400s.
   *
   * `latestCompatible` is the useful half: when the newest version has outrun this TREK,
   * an older one often still fits, so the UI can offer it instead of a dead grey button.
   */
  private hostCompat(entry: RegistryEntry): HostCompat {
    const latest = entry.versions[0] ?? null;
    const compatible = latest ? hostCompatible(latest, normalizedHost()) : false;
    // The verdict is the TRUTH, so it asks the strict predicate even when the picker is
    // bypassed: "latest compatible" must keep naming a version the author vouched for.
    const fallback = compatible ? null : this.latestCompatible(entry, undefined, hostCompatible);
    return {
      trek: latest?.trek ?? null,
      hostVersion: hostVersion(),
      compatible,
      latestCompatible: compatible ? (latest?.version ?? null) : (fallback?.version ?? null),
    };
  }

  /**
   * Everything the browse detail view shows for one plugin: the registry entry
   * plus a preview of its live manifest (permissions, egress, settings) fetched
   * from the author repo at the pinned/reviewed commit. Display-only — the
   * install pipeline re-validates the manifest inside the downloaded artifact.
   * Cached per plugin (30 min) and only fetched when a detail view opens, never
   * for the whole grid (the HACS rate-limit lesson).
   */
  async detail(id: string): Promise<Record<string, unknown>> {
    const hit = _detailCache.get(id);
    if (hit && Date.now() < hit.expiresAt) return hit.data as Record<string, unknown>;

    const reg = await this.fetchRegistry();
    const entry = reg.plugins.find((p) => p.id === id);
    if (!entry) throw new RegistryError(`plugin ${id} not in registry`);
    const latest = entry.versions[0] ?? null;

    let manifest: ManifestPreview | null = null;
    if (latest) {
      try {
        const { bytes } = await safeDownload(
          rawFileUrl(entry.repo, latest.commitSha, 'trek-plugin.json'),
          MANIFEST_MAX_BYTES,
        );
        manifest = previewManifest(parseJsonText(bytes.toString('utf8')));
      } catch {
        // Soft-fail: the detail view still renders from registry metadata alone.
      }
    }

    const data = {
      id: entry.id,
      name: entry.name,
      author: entry.author,
      description: entry.description,
      repo: entry.repo,
      homepage: entry.homepage ?? null,
      tags: entry.tags ?? [],
      type: entry.type,
      reviewedAt: entry.reviewedAt ?? null,
      downloadCount: entry.downloadCount ?? null,
      latest: latest?.version ?? null,
      minTrekVersion: latest?.minTrekVersion ?? null,
      size: latest?.size ?? null,
      publishedAt: latest?.publishedAt ?? null,
      requiredAddons: latest?.requiredAddons ?? [],
      pluginDependencies: latest?.pluginDependencies ?? [],
      screenshotUrl: entry.screenshotUrl ?? (latest ? rawFileUrl(entry.repo, latest.commitSha, 'docs/screenshot.png') : null),
      signed: !!entry.authorPublicKey && !!latest?.signature,
      authorPublicKey: entry.authorPublicKey ?? null,
      // The version picker's data: every published version with its OWN server-computed
      // compat verdict. The client has no semver and must never re-derive range logic —
      // a picker that disagreed with the install gate would offer a version that 400s.
      versions: entry.versions.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt ?? null,
        size: v.size ?? null,
        signed: !!entry.authorPublicKey && !!v.signature,
        trek: trekRequirementOrNull(v),
        compatible: hostCompatible(v, normalizedHost()),
      })),
      ...this.hostCompat(entry),
      manifest,
    };
    // Don't negative-cache a transiently failed manifest fetch — the next
    // detail open should retry instead of hiding the preview for 30 minutes.
    if (manifest || !latest) _detailCache.set(id, { data, expiresAt: Date.now() + CACHE_TTL });
    return data;
  }

  /**
   * Resolve which registry version of `id` to install: the highest that satisfies
   * `constraint` (any version if omitted) AND is compatible with the running TREK
   * version (`minTrekVersion`/`maxTrekVersion`). Throws if the plugin isn't in the
   * registry or nothing qualifies. Backs "download the latest compatible version".
   */
  async resolveVersion(id: string, constraint?: string): Promise<RegistryVersion> {
    const reg = await this.fetchRegistry();
    const entry = reg.plugins.find((p) => p.id === id);
    if (!entry) throw new RegistryError(`plugin ${id} not in registry`);
    const v = this.latestCompatible(entry, constraint);
    if (!v) {
      throw new RegistryError(
        constraint
          ? `no version of ${id} satisfies "${constraint}" and TREK ${hostVersion()}`
          : `no version of ${id} is compatible with TREK ${hostVersion()}`,
        'TREK_VERSION_INCOMPATIBLE',
      );
    }
    return v;
  }

  /**
   * The newest version of `entry` that satisfies `constraint` AND admits the running TREK.
   * `admits` defaults to the picker's rule (which honours TREK_PLUGINS_IGNORE_TREK_RANGE);
   * the UI verdict passes the strict {@link hostCompatible} instead.
   */
  private latestCompatible(
    entry: RegistryEntry,
    constraint?: string,
    admits: (v: RegistryVersion, host: string | null) => boolean = installable,
  ): RegistryVersion | null {
    const host = normalizedHost();
    const candidates = entry.versions.filter((v) => {
      if (constraint && !semver.satisfies(v.version, constraint, { includePrerelease: true })) return false;
      return admits(v, host);
    });
    if (!candidates.length) return null;
    return [...candidates].sort((a, b) => semver.rcompare(a.version, b.version))[0];
  }

  /**
   * Pick the version `install()` will fetch, and refuse an incompatible one — on EVERY
   * path, which is the whole point. An explicit `version` and the bare "install latest"
   * both used to bypass the compat check entirely (only the `constraint` path went
   * through resolveVersion), so the admin UI's own Install button — which sends neither —
   * happily installed a plugin that declared it doesn't support this TREK.
   */
  private selectVersion(entry: RegistryEntry, opts?: { version?: string; constraint?: string }): RegistryVersion {
    if (opts?.version) {
      const ver = entry.versions.find((v) => v.version === opts.version);
      if (!ver) throw new RegistryError(`version ${opts.version} not found for ${entry.id}`);
      if (!installable(ver, normalizedHost())) {
        throw new RegistryError(
          `${entry.id} ${ver.version} requires TREK ${trekRequirement(ver)} — this is TREK ${hostVersion()}`,
          'TREK_VERSION_INCOMPATIBLE',
        );
      }
      return ver;
    }
    const ver = this.latestCompatible(entry, opts?.constraint);
    if (ver) return ver;
    // Nothing compatible. Say WHY against the newest version the admin was actually
    // shown, rather than a bare "not found" — the fix is a TREK upgrade, not a retry.
    const latest = entry.versions[0];
    if (latest && !opts?.constraint) {
      throw new RegistryError(
        `${entry.id} ${latest.version} requires TREK ${trekRequirement(latest)} — this is TREK ${hostVersion()}`,
        'TREK_VERSION_INCOMPATIBLE',
      );
    }
    throw new RegistryError(
      opts?.constraint
        ? `no version of ${entry.id} satisfies "${opts.constraint}" and TREK ${hostVersion()}`
        : `no version of ${entry.id} is compatible with TREK ${hostVersion()}`,
      'TREK_VERSION_INCOMPATIBLE',
    );
  }

  /**
   * Install a version from the registry. Returns the installed plugin id + version.
   *
   * `retrustKey` is the admin's explicit "I have confirmed this new signing key with
   * the author out-of-band" override, and it only lifts the TOFU key-change stop —
   * the artifact must STILL verify under that key (see verifySignatureAndTofu), so a
   * blessed key that doesn't actually sign the code is refused like any other bad
   * signature. It is never a way to install something unverified.
   */
  async install(
    id: string,
    opts?: { version?: string; constraint?: string; retrustKey?: string },
  ): Promise<{ id: string; version: string; trekRangeBypassed: TrekRangeBypass | null }> {
    const reg = await this.fetchRegistry();
    const entry = reg.plugins.find((p) => p.id === id);
    if (!entry) throw new RegistryError(`plugin ${id} not in registry`);
    const ver = this.selectVersion(entry, opts); // throws TREK_VERSION_INCOMPATIBLE before we fetch a byte

    // 1. SSRF-safe download + 2. sha256 verify
    const { bytes, sha256 } = await safeDownload(ver.downloadUrl, (ver.size ?? 50 * 1024 * 1024) + 4096);
    if (!sha256Matches(sha256, ver.sha256)) throw new RegistryError('integrity check failed (sha256 mismatch)');

    // 2b. author signature (opt-in) + TOFU key pin. Unsigned plugins skip this
    // and install on sha256 alone (unchanged behaviour); a signed plugin must
    // verify, and its author key must match the one pinned on first install.
    // A refusal is REMEMBERED (the plugin keeps running on its old code, so the
    // reason must outlive the toast) and re-thrown untouched.
    try {
      this.verifySignatureAndTofu(id, bytes, entry, ver, opts?.retrustKey);
    } catch (e) {
      if (e instanceof RegistryError && isSignatureCode(e.code)) setUpdateBlock(this.dbs.connection, id, e.code, e.message, ver.version);
      throw e;
    }

    // 3. zip/tar-slip-safe extract to staging
    const staging = path.join(pluginsDataRoot(), '.staging', `${id}-${ver.version}-${Date.now()}`);
    try {
      extractArchive(bytes, staging);
      const pluginRoot = locateManifestDir(staging);
      if (!pluginRoot) throw new RegistryError('archive contains no trek-plugin.json');

      // 4. re-validate the bundled manifest + 5. native re-scan
      const manifest = parseManifest(
        parseJsonText(fs.readFileSync(path.join(pluginRoot, 'trek-plugin.json'), 'utf8')),
        { requireTrek: true },
      );
      if (manifest.id !== id) throw new RegistryError(`manifest id "${manifest.id}" != "${id}"`);
      // The artifact's OWN range is the authoritative compat check. The index metadata
      // gated above is only what the registry says about this version, and it is weaker:
      // published entries usually carry a lower bound and no upper one at all, so a
      // plugin that declares "<4.0.0" passes the pre-download filter on TREK 4 and is
      // caught only here.
      const trekRangeBypassed = assertHostCompatible(manifest.trekRange, id);
      if (scanForNativeBinaries(pluginRoot).length) throw new RegistryError('artifact contains native binaries');

      // 6. atomic move into place
      const dest = pluginCodeDir(id);
      fs.mkdirSync(pluginsCodeRoot(), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(pluginRoot, dest);

      // 7. register INACTIVE (record provenance)
      discoverPlugins(this.db);
      this.db.prepare('UPDATE plugins SET source_repo = ?, source_commit = ?, sha256 = ?, reviewed_at = ? WHERE id = ?').run(
        entry.repo,
        ver.commitSha,
        ver.sha256,
        entry.reviewedAt ?? null,
        id,
      );
      // Pin the author key on first successful install of a signed plugin (TOFU) —
      // and, after a re-trust, re-pin to the new key the admin blessed. Only ever set
      // to a key the artifact just verified under; NEVER cleared to NULL, because a
      // NULL pin re-opens the "was never signed" path that accepts an unsigned update.
      if (entry.authorPublicKey) {
        this.db.prepare('UPDATE plugins SET author_pubkey = ? WHERE id = ?').run(entry.authorPublicKey, id);
      }
      // The plugin is now on new code that passed every check — whatever refusal was
      // recorded before no longer describes reality.
      clearUpdateBlock(this.dbs.connection, id);
      return { id, version: ver.version, trekRangeBypassed };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Install `id` (latest-compatible, or the newest matching `constraint`) together
   * with any of its declared plugin dependencies that aren't installed yet — each
   * resolved to the newest version satisfying its declared range. Required addons
   * can't be installed; they're collected and returned so the caller can prompt the
   * admin to enable them. Cycle-safe. Already-installed plugins are left untouched.
   */
  async installWithDependencies(
    id: string,
    constraint?: string,
  ): Promise<{ installed: string[]; requiredAddons: string[]; trekRangeBypassed: TrekRangeBypass | null }> {
    let trekRangeBypassed: TrekRangeBypass | null = null;
    const installedNow = new Set(
      (this.db.prepare('SELECT id FROM plugins').all() as Array<{ id: string }>).map((r) => r.id),
    );
    const done = new Set<string>();
    const installed: string[] = [];
    const requiredAddons = new Set<string>();

    const visit = async (pid: string, range: string | undefined, stack: string[]): Promise<void> => {
      if (done.has(pid)) return;
      if (stack.includes(pid)) throw new RegistryError(`plugin dependency cycle: ${[...stack, pid].join(' -> ')}`);
      const ver = await this.resolveVersion(pid, range); // throws if not in registry / unsatisfiable
      if (!installedNow.has(pid)) {
        // Install the version we just RESOLVED. Passing the range back (or nothing, for
        // the root) made install() re-pick on its own and land on entry.versions[0] —
        // so the compatible version resolveVersion had chosen was computed and discarded.
        const res = await this.install(pid, { version: ver.version });
        // The admin asked for the root; that is the bypass they are warned about (a
        // dependency's own bypass still lands in the log).
        if (pid === id) trekRangeBypassed = res.trekRangeBypassed;
        installed.push(pid);
        installedNow.add(pid);
      }
      done.add(pid);
      for (const a of ver.requiredAddons ?? []) requiredAddons.add(a);
      for (const dep of ver.pluginDependencies ?? []) await visit(dep.id, dep.version, [...stack, pid]);
    };
    await visit(id, constraint, []);
    return { installed, requiredAddons: [...requiredAddons], trekRangeBypassed };
  }

  /**
   * Recompute the per-plugin update hold after a successful install/update.
   *
   * The hold exists so a DELIBERATE rollback isn't immediately nagged away by the
   * update banner. It is set only when `explicit` (the admin picked this exact
   * version) AND a newer TREK-compatible version exists; every other outcome writes
   * 0, so landing back on the newest compatible version — by any path — releases a
   * stale hold. An unresolvable registry never sets a hold: refusing to pin on
   * missing information beats silently muting future updates.
   */
  async recomputeUpdateHold(id: string, installedVersion: string, explicit: boolean): Promise<boolean> {
    let hold = false;
    if (explicit) {
      try {
        const newest = await this.resolveVersion(id);
        hold = semver.lt(installedVersion, newest.version);
      } catch {
        hold = false;
      }
    }
    this.db.prepare('UPDATE plugins SET update_hold = ? WHERE id = ?').run(hold ? 1 : 0, id);
    return hold;
  }

  /**
   * Sideload step 1: extract + validate an uploaded archive into a staging dir,
   * WITHOUT touching the live plugin. Returns the manifest id/version + the staged
   * path so the caller can stop a running child before the swap. Same hard guards
   * as a registry install (slip/bomb-safe extract, strict manifest, no native
   * binaries) — only the registry sha256/signature checks are absent, because a
   * sideload has no registry entry. Throws (and self-cleans staging) on failure.
   */
  stageUpload(bytes: Buffer): { id: string; version: string; root: string; stagingDir: string; trekRangeBypassed: TrekRangeBypass | null } {
    if (bytes.length > MAX_UPLOAD_BYTES) throw new RegistryError('archive exceeds the 50MB limit');
    const stagingDir = path.join(pluginsDataRoot(), '.staging', `upload-${Date.now()}`);
    try {
      extractArchive(bytes, stagingDir);
      const root = locateManifestDir(stagingDir);
      if (!root) throw new RegistryError('archive contains no trek-plugin.json');
      const manifest = parseManifest(parseJsonText(fs.readFileSync(path.join(root, 'trek-plugin.json'), 'utf8')), {
        requireTrek: true,
      });
      const trekRangeBypassed = assertHostCompatible(manifest.trekRange, manifest.id);
      if (scanForNativeBinaries(root).length) throw new RegistryError('artifact contains native binaries');
      return { id: manifest.id, version: manifest.version, root, stagingDir, trekRangeBypassed };
    } catch (e) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Sideload step 2: move a staged upload into place and register it INACTIVE as a
   * sideloaded plugin — source "local:upload", unsigned, not registry-reviewed, so
   * the UI flags it and offers no auto-update. The caller MUST have stopped any
   * running child of this id first (the code dir is replaced).
   */
  commitUpload(staged: { id: string; root: string; stagingDir: string }): void {
    try {
      const dest = pluginCodeDir(staged.id);
      fs.mkdirSync(pluginsCodeRoot(), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(staged.root, dest);
      discoverPlugins(this.db);
      // Provenance for a sideload, plus a hard INACTIVE floor: discoverPlugins keeps
      // an existing row's status, so replacing a plugin that was active must not
      // leave the new code marked active — the admin re-activates (and re-consents
      // to permissions) explicitly.
      //
      // The update-block goes too. It described a REGISTRY update being refused, and this
      // plugin has just left the registry trust model entirely — the code is now whatever
      // the admin uploaded. Leaving the block would have the row insist an update was
      // blocked over a signing key that no longer applies to the code that is running.
      this.db.prepare(
        `UPDATE plugins SET source_repo = ?, source_commit = ?, sha256 = ?, reviewed_at = ?, author_pubkey = NULL,
                            update_block_code = NULL, update_block_detail = NULL, update_block_version = NULL,
                            status = 'inactive', enabled = 0
         WHERE id = ?`,
      ).run('local:upload', null, null, null, staged.id);
    } finally {
      fs.rmSync(staged.stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * Verify the author signature (if the entry declares a key + the version a
   * signature) and enforce Trust-On-First-Use on the author key.
   *
   * - Neither key nor signature → unsigned plugin, skip (opt-in).
   * - Key present but no signature (or vice versa) → hard stop; a half-signed
   *   entry is a misconfiguration we refuse rather than silently downgrade.
   * - Signature invalid (or malformed) → hard stop.
   * - Registry key differs from the key pinned on a prior install → hard stop
   *   (author change / rotation / attack; needs an explicit admin re-trust).
   *
   * Each stop carries a machine-readable code, because only ONE of them
   * (SIGNATURE_KEY_CHANGED) may ever be overridden and the UI must be able to tell
   * them apart without reading prose.
   *
   * `retrustKey` lifts the key-change stop for exactly the key the admin confirmed.
   * Note what it does NOT do: the signature check below still runs, against the NEW
   * key, over the artifact bytes. A key an admin blesses must still sign the code it
   * ships — a re-trust moves the pin from one VERIFIED key to another verified key.
   */
  private verifySignatureAndTofu(
    id: string,
    bytes: Buffer,
    entry: RegistryEntry,
    ver: RegistryVersion,
    retrustKey?: string,
  ): void {
    const pinned =
      (this.db.prepare('SELECT author_pubkey FROM plugins WHERE id = ?').get(id) as { author_pubkey?: string } | undefined)
        ?.author_pubkey ?? null;

    if (!entry.authorPublicKey && !ver.signature) {
      if (pinned) {
        throw new RegistryError(
          'this plugin was signed before but the update is unsigned — refusing',
          'SIGNATURE_MISSING',
        );
      }
      return; // unsigned throughout: sha256 is the only pin
    }
    if (!entry.authorPublicKey || !ver.signature) {
      throw new RegistryError(
        'incomplete signature: an author key and a version signature must both be present',
        'SIGNATURE_INCOMPLETE',
      );
    }
    if (pinned && pinned !== entry.authorPublicKey && retrustKey !== entry.authorPublicKey) {
      throw new RegistryError(
        "the plugin's author signing key changed since it was installed — re-trust it explicitly to continue",
        RETRUSTABLE_CODE,
      );
    }
    // verifyAuthorSignature returns false on a well-formed non-matching signature but
    // THROWS SignatureError on a malformed key/signature. Both mean the same thing to
    // an admin — the bytes aren't what the author signed — and both are non-overridable.
    let ok: boolean;
    try {
      ok = verifyAuthorSignature(bytes, ver.signature, entry.authorPublicKey);
    } catch (e) {
      if (e instanceof SignatureError) {
        throw new RegistryError(`author signature verification failed: ${e.message}`, 'SIGNATURE_INVALID');
      }
      throw e;
    }
    if (!ok) throw new RegistryError('author signature verification failed', 'SIGNATURE_INVALID');
  }

  /**
   * Re-derive, SERVER-SIDE, that `id` is genuinely in the one overridable condition
   * (its pinned key no longer matches the registry's) and that `publicKey` is the key
   * the registry offers RIGHT NOW.
   *
   * Both halves matter. The first is the real enforcement of "re-trust is offered only
   * for a changed key" — the UI hiding the button is a convenience, not the control, so
   * an admin cannot re-trust their way past an invalid signature by calling the endpoint
   * directly. The second closes the TOCTOU window: the client sends back the key it
   * SHOWED the admin, and if the entry has been re-keyed again since the dialog
   * rendered, the admin would be blessing a key they never saw.
   */
  async assertRetrustable(id: string, publicKey: string): Promise<RegistryEntry> {
    const row = this.db.prepare('SELECT source_repo, author_pubkey FROM plugins WHERE id = ?').get(id) as
      | { source_repo?: string | null; author_pubkey?: string | null }
      | undefined;
    if (!row) throw new RegistryError(`plugin ${id} not found`, 'NOT_FOUND');
    if (!row.source_repo || row.source_repo === 'local:upload' || row.source_repo === 'local:link') {
      throw new RegistryError('only a registry-installed plugin can be re-trusted', 'RETRUST_NOT_APPLICABLE');
    }

    const reg = await this.fetchRegistry();
    const entry = reg.plugins.find((p) => p.id === id);
    if (!entry) throw new RegistryError(`plugin ${id} not in registry`, 'NOT_FOUND');

    const pinned = row.author_pubkey ?? null;
    if (!pinned || !entry.authorPublicKey || pinned === entry.authorPublicKey) {
      throw new RegistryError(
        "this plugin's signing key has not changed — there is nothing to re-trust",
        'RETRUST_NOT_APPLICABLE',
      );
    }
    if (entry.authorPublicKey !== publicKey) {
      throw new RegistryError(
        'the signing key changed again since you were shown it — review the new key before re-trusting',
        'RETRUST_KEY_MISMATCH',
      );
    }
    return entry;
  }
}

function rawFileUrl(repo: string, commitSha: string, file: string): string {
  return `https://raw.githubusercontent.com/${repo}/${commitSha}/${file}`;
}

/**
 * Whether a registry version admits the running TREK.
 *
 * The version's `trek` range is authoritative when the entry carries one. Entries
 * published before that field existed only carry min/max bounds, so those remain the
 * fallback — but they are a strictly weaker check (maxTrekVersion is inclusive and is
 * usually absent entirely, because the SDK never emitted it), which is why install
 * re-gates on the artifact's own manifest after extraction. This is only the cheap
 * pre-download filter.
 */
function hostCompatible(v: RegistryVersion, host: string | null): boolean {
  if (host === null) return true; // unversioned build — don't block on compat
  if (v.trek) return hostSatisfies(v.trek, host);
  if (v.minTrekVersion && semver.valid(v.minTrekVersion) && semver.lt(host, v.minTrekVersion)) return false;
  if (v.maxTrekVersion && semver.valid(v.maxTrekVersion) && semver.gt(host, v.maxTrekVersion)) return false;
  return true;
}

/**
 * Whether the registry picker may offer `v`: it fits the host, or the operator set
 * TREK_PLUGINS_IGNORE_TREK_RANGE and asked for the newest published version regardless.
 * Only the PICKER uses this — the compat verdict the UI shows (hostCompat/detail) stays
 * on {@link hostCompatible}, so a bypassed install is still labelled as outside its range.
 */
function installable(v: RegistryVersion, host: string | null): boolean {
  return trekRangeBypassed() || hostCompatible(v, host);
}

/**
 * Refuse an artifact whose declared TREK range doesn't admit the running host. Shared by
 * every install front door (registry, sideload, dev-link) so they all fail the same way,
 * with a code the admin UI can act on rather than prose it would have to string-match.
 *
 * Under TREK_PLUGINS_IGNORE_TREK_RANGE the refusal becomes a log warning, and the
 * returned marker is what the front door hands back so the admin is told too. Null
 * means the range fits and nothing was bypassed.
 */
export function assertHostCompatible(range: string | null, id: string): TrekRangeBypass | null {
  if (hostSatisfies(range)) return null;
  const bypass = bypassedRange(range);
  if (bypass) {
    warnRangeBypass(id, bypass);
    return bypass;
  }
  throw new RegistryError(`${id} requires TREK ${range} — this is TREK ${hostVersion()}`, 'TREK_VERSION_INCOMPATIBLE');
}

/**
 * A version's declared TREK requirement as a range string, or null when the entry
 * carries no bounds at all. Each bound is optional — an entry may declare only a
 * ceiling, or (once `trek` is absent too) nothing — so this composes whatever
 * bounds exist rather than interpolating a missing one as "null".
 */
function trekRequirementOrNull(v: RegistryVersion): string | null {
  if (v.trek) return v.trek;
  const bounds = [
    v.minTrekVersion ? `>=${v.minTrekVersion}` : null,
    v.maxTrekVersion ? `<=${v.maxTrekVersion}` : null,
  ].filter(Boolean);
  return bounds.length ? bounds.join(' ') : null;
}

/** How a version's TREK requirement reads in an error/UI string. */
function trekRequirement(v: RegistryVersion): string {
  return trekRequirementOrNull(v) ?? 'any version';
}

/**
 * Tolerant projection of a live manifest for display. Unknown shapes degrade to
 * empty lists instead of throwing — a future manifest field must never break
 * browsing (strict validation happens against the downloaded artifact instead).
 */
/**
 * The reviewer-facing slice of a registry manifest.
 *
 * Exported for its unit test: this function is the reason the admin dialog can
 * show anything at all before install, and a field it forgets to carry makes
 * the corresponding UI section silently dead.
 */
export function previewManifest(raw: unknown): ManifestPreview {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const operatorEgress = m.operatorEgress === true;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const settings = Array.isArray(m.settings)
    ? m.settings
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({
          key: typeof s.key === 'string' ? s.key : '',
          label: typeof s.label === 'string' ? s.label : typeof s.key === 'string' ? s.key : '',
          inputType: typeof s.input_type === 'string' ? s.input_type : 'text',
          scope: s.scope === 'user' ? 'user' : 'instance',
          required: s.required === true,
        }))
        .filter((s) => s.key)
    : [];
  const pluginDependencies = Array.isArray(m.pluginDependencies)
    ? m.pluginDependencies
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => ({
          id: typeof d.id === 'string' ? d.id : '',
          version: typeof d.version === 'string' ? d.version : '',
        }))
        .filter((d) => d.id && d.version)
    : [];
  const rawCaps = (m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {}) as Record<
    string,
    unknown
  >;
  const widget = (rawCaps.widget && typeof rawCaps.widget === 'object' ? rawCaps.widget : null) as {
    slot?: unknown;
  } | null;
  const tripPage = (rawCaps.tripPage && typeof rawCaps.tripPage === 'object' ? rawCaps.tripPage : null) as {
    replaces?: unknown;
  } | null;
  const capabilities: ManifestPreview['capabilities'] = {};
  if (widget) capabilities.widget = typeof widget.slot === 'string' ? { slot: widget.slot } : {};
  if (tripPage) capabilities.tripPage = { replaces: strings(tripPage.replaces) };
  // Sanitised here too. This text comes from a registry entry the host has not
  // installed or verified yet, and it is about to be rendered in the admin's
  // own chrome, so it gets the same treatment as the advertised copy rather
  // than being trusted because it came from the registry.
  if (Array.isArray(rawCaps.mcpTools)) {
    const tools = rawCaps.mcpTools
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t))
      .slice(0, MCP_TOOLS_MAX)
      .map((t) => ({
        name: sanitiseAssistantText(t.name, 96),
        title: sanitiseAssistantText(t.title, TOOL_TITLE_MAX),
        description: sanitiseAssistantText(t.description, TOOL_DESCRIPTION_MAX),
      }))
      .filter((t) => t.name)
      .map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description }));
    if (tools.length) capabilities.mcpTools = tools;
  }

  return {
    permissions: strings(m.permissions),
    egress: strings(m.egress),
    operatorEgress,
    settings,
    license: typeof m.license === 'string' ? m.license : null,
    icon: typeof m.icon === 'string' ? m.icon : null,
    requiredAddons: strings(m.requiredAddons),
    pluginDependencies,
    capabilities,
  };
}

/** The extracted plugin root: staging itself, or its single wrapper subdir (codeload archives wrap in {repo}-{sha}/). */
function locateManifestDir(staging: string): string | null {
  if (fs.existsSync(path.join(staging, 'trek-plugin.json'))) return staging;
  const subs = fs.existsSync(staging)
    ? fs.readdirSync(staging, { withFileTypes: true }).filter((d) => d.isDirectory())
    : [];
  for (const s of subs) {
    const p = path.join(staging, s.name);
    if (fs.existsSync(path.join(p, 'trek-plugin.json'))) return p;
  }
  return null;
}
