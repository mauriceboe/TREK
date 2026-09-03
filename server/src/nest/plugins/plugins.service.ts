import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { pluginsEnabled } from './kill-switch';
import { devLinkEnabled } from './dev-link';
import { maybe_encrypt_api_key, decrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { readAudit } from './host/plugin-audit';
import { keyFingerprint } from './signature-status';
import { pluginBudgetUsage } from './host/plugin-host-state';
import { safeParseConfig as safeParse } from './plugin-config-parse';
import { isFilled, parseDefaultValue, settingDefaults } from './settings-defaults';
import { AddonsService } from '../addons/addons.service';
import { parseDependencies, disabledRequiredAddons, resolveDependencyState, type PluginDepRow, type PluginDependencies, type VersionMismatch } from './dependencies';
import { bypassedRange, hostSatisfies, hostVersion, trekRangeBypassed } from './install/host-compat';
import type { TrekRangeBypass } from './install/host-compat';
import type { PluginDependency } from './install/manifest';
import type { PluginSettingsField } from '@trek/shared';

const SECRET_MASK = '••••••••';

export type PluginDependencyStatus = 'ok' | 'addonDisabled' | 'missingPlugin' | 'hostIncompatible';

/** A save that would leave a `required` settings field empty — mapped to 400 by both controllers. */
export class MissingRequiredSettingError extends Error {
  constructor(public readonly field: string) {
    super(`Missing required setting "${field}"`);
    this.name = 'MissingRequiredSettingError';
  }
}

/**
 * Read side of the plugin system (#plugins), M0 scaffold. Lists installed
 * plugins from the `plugins` registry table and reports whether the runtime is
 * enabled (TREK_PLUGINS_ENABLED). No execution here — the isolated runtime,
 * install pipeline and registry fetch land in later milestones.
 */

interface PluginRawRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  icon: string | null;
  version: string | null;
  status: string;
  enabled: number;
  last_error: string | null;
  reviewed_at: string | null;
  source_repo: string | null;
  permissions: string;
  capabilities: string;
  dependencies: string | null;
  trek_range: string | null;
  author_pubkey: string | null;
  update_block_code: string | null;
  update_block_detail: string | null;
  update_block_version: string | null;
  update_hold: number;
}

export interface PluginListItem {
  id: string;
  name: string;
  description: string | null;
  type: string;
  icon: string | null;
  version: string | null;
  status: string;
  enabled: number;
  last_error: string | null;
  reviewed_at: string | null;
  source_repo: string | null;
  /** Declared permissions (JSON string) — drives the "what this can access" chips. */
  permissions: string;
  /** Declared capabilities (JSON string) — e.g. widget slot. */
  capabilities: string;
  /** The plugin declared it needs OPERATOR-supplied egress hosts (a self-hosted target). */
  operatorEgress: boolean;
  /** How many hosts an admin has actually added — so the card can nudge when it's 0. */
  egressHostCount: number;
  /** How many `scope:'instance'` settings fields the plugin declares — gates the admin
   * settings menu item without a per-plugin fetch. */
  instanceSettingsCount: number;
  /** How many `scope:'instance'` actions the plugin declares — gates the admin settings
   * menu item together with instanceSettingsCount (a plugin can have actions and no fields). */
  instanceActionsCount: number;
  /** Declared dependencies (parsed) — required addons + plugin deps. */
  dependencies: PluginDependencies;
  /** Whether this plugin can currently activate, and why not if it can't. */
  dependencyStatus: PluginDependencyStatus;
  /** The TREK range the plugin declares it supports; null if it declared none. */
  trekRange: string | null;
  /** The running TREK, so the UI can say "needs X, you have Y" without doing semver. */
  hostVersion: string;
  /**
   * Non-null when the plugin is outside its declared range (or declared none) and only
   * TREK_PLUGINS_IGNORE_TREK_RANGE lets it activate. The card shows it as a warning
   * rather than a blocker: the admin chose this, but must keep seeing what they chose.
   */
  trekRangeBypassed: TrekRangeBypass | null;
  /** The concrete blockers, so the UI can render chips + the resolve dialog. */
  dependencyIssues: { disabledAddons: string[]; missing: PluginDependency[]; versionMismatch: VersionMismatch[] };
  /**
   * The author's signature was verified and their key TOFU-pinned at install.
   * False means the bytes matched the registry's sha256 pin and nothing more — one
   * fewer guarantee, not "insecure". Meaningless for a sideloaded/dev-linked plugin,
   * which sits outside the registry trust model entirely; the UI badges those instead.
   */
  signed: boolean;
  /** Short, human-comparable form of the pinned key — for reading out to the author. */
  keyFingerprint: string | null;
  /** Why an update was refused, if one was. `version` is the registry version that was
   * refused, so a caller can treat the block as stale once a newer one is on offer. */
  updateBlock: { code: string; detail: string | null; version: string | null } | null;
  /** A deliberate non-latest install paused updates: excluded from the banner/Update all
   * until the admin resumes, or an install lands back on the newest compatible version. */
  updateHold: boolean;
}

@Injectable()
export class PluginsService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly addons: AddonsService,
  ) {}

  private get db() {
    return this.dbs.connection;
  }

  /** Hosts an admin has added for a plugin (0 unless it declared operatorEgress). */
  private egressHostCount(id: string): number {
    try {
      return (this.db.prepare('SELECT COUNT(*) AS n FROM plugin_egress_hosts WHERE plugin_id = ?').get(id) as { n: number }).n;
    } catch {
      return 0; // table absent (a slimmed test app)
    }
  }

  private instanceSettingsCount(id: string): number {
    try {
      return (
        this.db.prepare("SELECT COUNT(*) AS n FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'instance'").get(id) as { n: number }
      ).n;
    } catch {
      return 0; // table absent (a slimmed test app)
    }
  }

  private instanceActionsCount(id: string): number {
    try {
      return (
        this.db.prepare("SELECT COUNT(*) AS n FROM plugin_actions WHERE plugin_id = ? AND scope = 'instance'").get(id) as { n: number }
      ).n;
    } catch {
      return 0; // table absent (a slimmed test app)
    }
  }

  list(): { enabled: boolean; devLink: boolean; ignoreTrekRange: boolean; plugins: PluginListItem[] } {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, type, icon, version, status, enabled, last_error, reviewed_at, source_repo,
                permissions, capabilities, dependencies, operator_egress, trek_range,
                author_pubkey, update_block_code, update_block_detail, update_block_version, update_hold
         FROM plugins
         ORDER BY sort_order, name`,
      )
      .all() as PluginRawRow[];
    const installed = new Map<string, PluginDepRow>(
      rows.map((r) => [r.id, { id: r.id, version: r.version, enabled: r.enabled, dependencies: r.dependencies }]),
    );
    const plugins: PluginListItem[] = rows.map((r) => {
      const deps = parseDependencies(r.dependencies);
      const disabledAddons = disabledRequiredAddons(deps, (id) => this.addons.isAddonEnabled(id));
      const state = resolveDependencyState(deps, installed);
      // Mirrors the order of assertActivatable's gate, so the card explains the same
      // blocker the activate call would hit rather than a second, lesser one.
      const trekBypass = bypassedRange(r.trek_range);
      const dependencyStatus: PluginDependencyStatus = !hostSatisfies(r.trek_range) && !trekBypass
        ? 'hostIncompatible'
        : disabledAddons.length
          ? 'addonDisabled'
          : state.missing.length || state.versionMismatch.length
            ? 'missingPlugin'
            : 'ok';
      const {
        dependencies: _raw,
        operator_egress: _oe,
        trek_range,
        author_pubkey,
        update_block_code,
        update_block_detail,
        update_block_version,
        update_hold,
        ...rest
      } = r as PluginRawRow & { operator_egress?: number };
      return {
        ...rest,
        operatorEgress: _oe === 1,
        egressHostCount: this.egressHostCount(r.id),
        instanceSettingsCount: this.instanceSettingsCount(r.id),
        instanceActionsCount: this.instanceActionsCount(r.id),
        dependencies: deps,
        dependencyStatus,
        trekRange: trek_range,
        hostVersion: hostVersion(),
        trekRangeBypassed: trekBypass,
        dependencyIssues: { disabledAddons, missing: state.missing, versionMismatch: state.versionMismatch },
        signed: !!author_pubkey,
        keyFingerprint: keyFingerprint(author_pubkey),
        updateBlock: update_block_code
          ? { code: update_block_code, detail: update_block_detail, version: update_block_version }
          : null,
        updateHold: update_hold === 1,
      };
    });
    return { enabled: pluginsEnabled(), devLink: devLinkEnabled(), ignoreTrekRange: trekRangeBypassed(), plugins };
  }

  /**
   * Release a per-plugin update hold (set by a deliberate non-latest install).
   * Returns whether the plugin row existed — the controller answers 404 otherwise.
   */
  resumeUpdates(id: string): boolean {
    return this.db.prepare('UPDATE plugins SET update_hold = 0 WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Merge instance-scope settings into the plugin's config, encrypting fields
   * declared secret (unless the value is the unchanged mask sentinel). Only keys
   * declared as `scope:'instance'` fields are accepted, same as updateUserConfig.
   * Returns the config with secrets masked for the client.
   */
  updateInstanceConfig(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM plugins WHERE id = ?').get(id) as { config: string } | undefined;
    if (!row) throw new Error(`plugin ${id} not found`);

    const secretKeys = new Set(
      (
        this.db
          .prepare("SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'instance' AND secret = 1")
          .all(id) as Array<{ field_key: string }>
      ).map((r) => r.field_key),
    );

    const allowed = new Set(
      (
        this.db
          .prepare("SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'instance'")
          .all(id) as Array<{ field_key: string }>
      ).map((r) => r.field_key),
    );

    const config = safeParse(row.config);
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue; // never store an undeclared key
      if (secretKeys.has(k)) {
        if (v === SECRET_MASK) continue; // unchanged secret — keep stored ciphertext
        config[k] = maybe_encrypt_api_key(v);
      } else {
        config[k] = v;
      }
    }
    this.assertRequiredFilled(id, 'instance', config);
    this.db.prepare('UPDATE plugins SET config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(config), id);
    return maskSecrets(config, secretKeys);
  }

  /** The plugin's `scope:'user'` settings fields, in declared order (for the user form). */
  userSettingsFields(id: string): PluginSettingsField[] {
    return this.settingsFields(id, 'user');
  }

  /** The plugin's `scope:'instance'` settings fields, in declared order (for the ADMIN form). */
  instanceSettingsFields(id: string): PluginSettingsField[] {
    return this.settingsFields(id, 'instance');
  }

  private settingsFields(id: string, scope: 'user' | 'instance'): PluginSettingsField[] {
    return this.db
      .prepare(
        `SELECT field_key AS key, label, input_type, placeholder, hint, required, secret, options, default_value
         FROM plugin_settings_fields WHERE plugin_id = ? AND scope = ? ORDER BY sort_order, id`,
      )
      .all(id, scope)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          key: String(row.key),
          label: (row.label ?? null) as string | null,
          input_type: (row.input_type ?? 'text') as string,
          placeholder: (row.placeholder ?? null) as string | null,
          hint: (row.hint ?? null) as string | null,
          required: row.required === 1,
          secret: row.secret === 1,
          default: parseDefaultValue(row.default_value),
          // Stored as manifest-validated JSON ({value,label} pairs) — parse, don't re-check.
          options:
            typeof row.options === 'string' && row.options
              ? (safeArray(row.options as string) as PluginSettingsField['options'])
              : undefined,
        };
      });
  }

  private userSecretKeys(id: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare("SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'user' AND secret = 1")
          .all(id) as Array<{ field_key: string }>
      ).map((r) => r.field_key),
    );
  }

  /** A user's own config for a plugin, secrets masked (safe to send to the client). */
  getUserConfig(id: string, userId: number): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM plugin_user_config WHERE plugin_id = ? AND user_id = ?').get(id, userId) as
      | { config: string }
      | undefined;
    return maskSecrets(safeParse(row?.config ?? '{}'), this.userSecretKeys(id));
  }

  /** Merge a user's own settings, encrypting secret fields (SECRET_MASK = keep stored
   * ciphertext). Only keys declared as `scope:'user'` fields are accepted. Returns masked. */
  updateUserConfig(id: string, userId: number, patch: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set(
      (this.db.prepare("SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'user'").all(id) as Array<{ field_key: string }>).map(
        (r) => r.field_key,
      ),
    );
    const secretKeys = this.userSecretKeys(id);
    const existing = this.db.prepare('SELECT config FROM plugin_user_config WHERE plugin_id = ? AND user_id = ?').get(id, userId) as
      | { config: string }
      | undefined;
    const config = safeParse(existing?.config ?? '{}');
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.has(k)) continue; // never store an undeclared key
      if (secretKeys.has(k)) {
        if (v === SECRET_MASK) continue; // unchanged secret — keep stored ciphertext
        config[k] = maybe_encrypt_api_key(v);
      } else {
        config[k] = v;
      }
    }
    this.assertRequiredFilled(id, 'user', config);
    this.db.prepare(
      `INSERT INTO plugin_user_config (plugin_id, user_id, config, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(plugin_id, user_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).run(id, userId, JSON.stringify(config));
    return maskSecrets(config, secretKeys);
  }

  /** A user's own config with secrets DECRYPTED — host-only, for runtime `ctx.settings`.
   * Never sent to a client; the acting user is resolved host-side. */
  getUserConfigDecrypted(id: string, userId: number): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM plugin_user_config WHERE plugin_id = ? AND user_id = ?').get(id, userId) as
      | { config: string }
      | undefined;
    const config = safeParse(row?.config ?? '{}');
    const secretKeys = this.userSecretKeys(id);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) out[k] = secretKeys.has(k) && v ? decrypt_api_key(v) : v;
    return out;
  }

  /** A plugin's error log, newest first. */
  errors(id: string): Array<{ ts: string; level: string; message: string }> {
    return this.db
      .prepare('SELECT ts, level, message FROM plugin_error_log WHERE plugin_id = ? ORDER BY ts DESC, id DESC LIMIT 200')
      .all(id) as Array<{ ts: string; level: string; message: string }>;
  }

  clearErrors(id: string): void {
    this.db.prepare('DELETE FROM plugin_error_log WHERE plugin_id = ?').run(id);
  }

  /** A plugin's hash-chained capability audit log, newest first. */
  auditLog(id: string): unknown[] {
    return readAudit(this.db, id);
  }

  /** A plugin's broker budget usage for today (AI + notification counts vs caps). */
  budget(id: string): ReturnType<typeof pluginBudgetUsage> {
    return pluginBudgetUsage(id, this.db);
  }

  /** Read the instance config with secret fields masked. */
  getInstanceConfig(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT config FROM plugins WHERE id = ?').get(id) as { config: string } | undefined;
    if (!row) throw new Error(`plugin ${id} not found`);
    const secretKeys = new Set(
      (
        this.db
          .prepare("SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = 'instance' AND secret = 1")
          .all(id) as Array<{ field_key: string }>
      ).map((r) => r.field_key),
    );
    return maskSecrets(safeParse(row.config), secretKeys);
  }

  /**
   * `required` used to be a decorative asterisk (PR-87 feedback): the form rendered it, but
   * nothing refused a save. Enforced on the MERGED result so partial patches stay legal and a
   * stored secret (non-empty ciphertext) counts as filled. A `checkbox` is exempt — required
   * would demand `true`, which is a consent flow, not a settings field.
   */
  private assertRequiredFilled(id: string, scope: 'instance' | 'user', config: Record<string, unknown>): void {
    const required = this.db
      .prepare(
        "SELECT field_key FROM plugin_settings_fields WHERE plugin_id = ? AND scope = ? AND required = 1 AND input_type != 'checkbox'",
      )
      .all(id, scope) as Array<{ field_key: string }>;
    const defaults = settingDefaults(this.db, id, scope);
    for (const f of required) {
      // The runtime resolves the default too, so it counts as filled here as well.
      if (!isFilled(config[f.field_key] ?? defaults[f.field_key])) throw new MissingRequiredSettingError(f.field_key);
    }
  }
}

function safeArray(json: string): unknown[] | undefined {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function maskSecrets(config: Record<string, unknown>, secretKeys: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = secretKeys.has(k) && v ? SECRET_MASK : v;
  }
  return out;
}
