import semver from 'semver';
import { isKnownPermission, PLUGIN_API_VERSION } from '../protocol/envelope';
import { isValidTrekRange, minTrekOf, trekRangeBypassed } from './host-compat';
import {
  MCP_TOOLS_MAX,
  McpToolSchemaError,
  TOOL_NAME_RE,
  buildToolInputSchema,
  normaliseToolSchema,
  sanitiseToolText,
} from '../mcp-tool-schema';
import type { NotifEventType } from '../../notifications/notification-events';

/**
 * Parse + validate a plugin's trek-plugin.json (#plugins, M4). Kept deliberately
 * strict: unknown permissions, missing required fields, or a declared native
 * module all fail here, before a plugin is ever registered. (The published SDK's
 * shared Zod schema will supersede this in M6; the checks stay identical.)
 */

export interface ManifestSettingField {
  key: string;
  label?: string;
  input_type?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  secret?: boolean;
  default?: string | number | boolean;
  scope?: 'instance' | 'user';
  options?: Array<{ value: string; label: string }>;
  oauth?: { initPath?: string; callbackPath?: string };
}

export interface WidgetCapability {
  title?: string;
  defaultSize?: string;
  /** Where the widget mounts: dashboard sidebar (default), hero-bar overlay, or the
   * trip planner's place-detail / day-detail / reservation-detail panel (scoped to
   * the open place/day/reservation). */
  slot?: 'sidebar' | 'hero' | 'place-detail' | 'day-detail' | 'reservation-detail';
}

/** How a trip-page plugin sits in the planner's tab bar. */
export interface TripPageCapability {
  /** Core planner tabs hidden while this plugin is active ('plan' can never be replaced). */
  replaces?: string[];
  /** Preferred 0-based index for the plugin's tab; omitted = appended after the core tabs. */
  position?: number;
}

/** Config for a plugin that implements the `notificationChannel` hook. */
export interface NotificationChannelCapability {
  /** Column name in the notification preferences matrix. Defaults to the plugin's name. */
  title?: string;
  /** Narrow which events this channel carries. Defaults to every non-admin event. */
  events?: string[];
}

/**
 * A button the plugin contributes to its own settings page ("Test connection",
 * "Sync now"). Unlike the notification-channel hook, an action is USER-INITIATED — the
 * acting user is whoever clicked — so `ctx.settings.get()` and trip reads work normally
 * inside it, which is exactly what a "test my credentials" button needs.
 */
export interface ManifestAction {
  key: string;
  label: string;
  hint?: string;
  /** Render as destructive and ask for confirmation before running. */
  danger?: boolean;
  /** Which settings form renders the button. `'user'` (default): the user Settings tab,
   * run as the clicking user. `'instance'`: the admin instance-settings dialog, run as
   * the clicking admin. The default is `'user'` (not `'instance'` like settings fields)
   * so every manifest written before scope existed keeps its user-tab buttons. */
  scope: 'user' | 'instance';
}

/** A routing profile a routeProvider plugin offers — one entry in the planner's
 * route-profile picker (e.g. an EV profile with charging stops). */
export interface RouteProfileCapability {
  id: string;
  label: string;
  icon?: string;
}

/** One MCP tool the plugin advertises on TREK's MCP server. Requires `mcp:tools`.
 *  Declared here, in the signed manifest, and not only reported at load: the child
 *  composes its `loaded` payload AFTER onLoad runs, so a signed, sha256-pinned
 *  artifact could otherwise emit different tool text on every restart with no
 *  version bump and no re-consent. The host advertises the intersection of the two. */
export interface McpToolCapability {
  /** Plugin-local; advertised as `plugin_<pluginId>_<name>`. */
  name: string;
  title?: string;
  description: string;
  /** JSON Schema for the arguments, advertised verbatim after normalisation. */
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface PluginCapabilities {
  widget?: WidgetCapability;
  tripPage?: TripPageCapability;
  notificationChannel?: NotificationChannelCapability;
  /** Routing profiles offered via the routeProvider hook (max 3). */
  routeProfiles?: RouteProfileCapability[];
  /** MCP tools offered via the mcpToolProvider hook (max 8). */
  mcpTools?: McpToolCapability[];
  /** Function names this plugin exposes to its dependents via ctx.plugins.call. */
  provides?: string[];
  /** Event names this plugin publishes to its dependents via ctx.events.emit. */
  emits?: string[];
  /** The plugin ships client/settings.html; the host frames it on the user's settings page. */
  settingsUi?: boolean;
}

/** A declared dependency on another plugin, pinned by a semver range. */
export interface PluginDependency {
  id: string;
  version: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  author?: string;
  description?: string;
  homepage?: string;
  icon?: string;
  type: 'integration' | 'page' | 'widget' | 'trip-page';
  /** The raw semver RANGE of TREK versions this plugin supports (">=3.2.0 <4.0.0"). */
  trek?: string;
  /** Same range, normalized: a valid+satisfiable one, or null. What the host gates on. */
  trekRange: string | null;
  /** The range's lower bound, for display ("Requires TREK 3.2.0+"). Derived, never authored. */
  minTrekVersion?: string;
  nativeModules: boolean;
  permissions: string[];
  egress: string[];
  /**
   * The plugin talks to a service whose hostname only the OPERATOR knows (a self-hosted
   * Gotify, ntfy, Uptime Kuma…). Its manifest `egress` can never cover that, so an admin
   * may add hosts post-install and the runtime unions them into the child's allow-list.
   * Consent stays with the admin — an end user can never widen egress.
   */
  operatorEgress: boolean;
  settings: ManifestSettingField[];
  actions: ManifestAction[];
  capabilities: PluginCapabilities;
  /** Addon ids that must be enabled for this plugin to activate (format-only here). */
  requiredAddons: string[];
  /** Other plugins that must be installed + version-satisfied to activate. */
  pluginDependencies: PluginDependency[];
}

const ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
// Addon ids are lowercase slugs that may contain underscores (e.g. `llm_parsing`).
// Validated format-only: existence is checked at activation, so a plugin declaring
// an unknown addon still installs but can never enable (matches "allow install").
const ADDON_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;
// An outbound host: an exact hostname (single-label like a `redis` sibling
// service, or a dotted FQDN) OR a `*.`-prefixed wildcard that MUST have a real
// multi-label suffix. Rejects `*`, `*.`, whole-TLD `*.com`, schemes, and any
// embedded space — all of which would otherwise widen egress or inject a CSP
// source token when the host is interpolated into connect-src.
const HOST_RE = /^(\*\.[a-z0-9-]+(\.[a-z0-9-]+)+|[a-z0-9-]+(\.[a-z0-9-]+)*)$/i;
// Static path segments under /api/admin/plugins — a plugin id must never shadow them
// (id "registry" would collide with GET registry/:id vs :id/errors routing).
const RESERVED_IDS = new Set(['registry', 'install', 'rescan']);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// 'trip-page' mounts the plugin's sandboxed UI as a tab inside every trip planner
// (tripId-scoped), with no dashboard presence — unlike 'page' (dashboard nav).
const TYPES = new Set(['integration', 'page', 'widget', 'trip-page']);

export class ManifestError extends Error {}

/** JSON.parse that tolerates a UTF-8 BOM (0xFEFF) — manifests written on Windows often carry one. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text.codePointAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * Validate a manifest.
 *
 * `requireTrek` is the INSTALL front doors (registry, sideload, dev-link): a plugin
 * that doesn't say which TREK versions it supports may not be installed at all.
 *
 * It is deliberately OFF for discovery, which is a reconciler, not a gate. Discovery's
 * failure path only logs and skips — it never touches the plugins row — so a plugin it
 * rejects keeps its stale `enabled = 1` and gets spawned by the next boot anyway. Making
 * this strict there would produce a plugin that is invisible to discovery and still
 * running. Activation is where an undeclared range is actually refused.
 */
export function parseManifest(raw: unknown, opts?: { requireTrek?: boolean }): PluginManifest {
  if (!raw || typeof raw !== 'object') throw new ManifestError('manifest is not an object');
  const m = raw as Record<string, unknown>;

  const id = str(m.id, 'id');
  if (!ID_RE.test(id)) throw new ManifestError(`invalid id "${id}" (lowercase slug, 3–40 chars)`);
  if (RESERVED_IDS.has(id)) throw new ManifestError(`reserved id "${id}"`);
  const version = str(m.version, 'version');
  if (!SEMVER_RE.test(version)) throw new ManifestError(`invalid version "${version}"`);
  const type = str(m.type, 'type');
  if (!TYPES.has(type)) throw new ManifestError(`invalid type "${type}"`);

  if (m.nativeModules === true) throw new ManifestError('native modules are not allowed');

  const permissions = arr(m.permissions).map(String);
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length) throw new ManifestError(`unknown permission(s): ${unknown.join(', ')}`);

  // Validate the host portion of every per-host outbound permission: this is the
  // string the runtime egress guard AND the iframe CSP connect-src are built from.
  const badOutbound = permissions
    .filter((p) => p.startsWith('http:outbound:'))
    .map((p) => p.slice('http:outbound:'.length))
    .find((h) => !HOST_RE.test(h));
  if (badOutbound !== undefined) throw new ManifestError(`invalid http:outbound host "${badOutbound}"`);

  const capabilities = parseCapabilities(m.capabilities);
  // Declared tools without the grant that runs them would sit in the admin's
  // consent screen looking live and never appear on the MCP server. Same shape
  // as the SDK's notificationChannel and routeProfiles cross-checks.
  if (capabilities.mcpTools?.length && !permissions.includes('mcp:tools')) {
    throw new ManifestError('capabilities.mcpTools requires the "mcp:tools" permission');
  }

  const egress = arr(m.egress).map(String);
  if (m.operatorEgress !== undefined && typeof m.operatorEgress !== 'boolean') {
    throw new ManifestError('operatorEgress must be a boolean');
  }
  if (m.operatorEgress === true && !permissions.some((p) => p === 'http:outbound' || p.startsWith('http:outbound:'))) {
    throw new ManifestError('operatorEgress requires an http:outbound permission');
  }
  // An empty egress[] is only legal for an operatorEgress plugin: its hosts are
  // admin-supplied post-install, so the manifest has nothing to declare. It is NOT
  // an allow-all — the child's guard is built from the (still empty) union, so every
  // outbound call is refused until an admin adds a host.
  if (
    permissions.some((p) => p === 'http:outbound' || p.startsWith('http:outbound:')) &&
    egress.length === 0 &&
    m.operatorEgress !== true
  ) {
    throw new ManifestError('http:outbound declared but egress[] is empty (set operatorEgress: true if the hosts are admin-supplied)');
  }
  if (egress.includes('*')) throw new ManifestError('egress[] must not contain a bare "*"');
  const badEgress = egress.find((h) => !HOST_RE.test(h));
  if (badEgress !== undefined) throw new ManifestError(`invalid egress host "${badEgress}"`);

  const trek = optStr(m.trek);
  const trekRange = isValidTrekRange(trek) ? trek : null;
  // Under TREK_PLUGINS_IGNORE_TREK_RANGE a missing range is the same author oversight as a
  // stale one, so it is reported by the gate (as a null range) instead of refused here.
  if (opts?.requireTrek && !trekRange && !trekRangeBypassed()) {
    throw new ManifestError(
      trek
        ? `invalid "trek" version range "${trek}" (expected a satisfiable semver range, e.g. ">=3.2.0 <4.0.0")`
        : 'missing "trek" version range — declare the TREK versions this plugin supports, e.g. ">=3.2.0 <4.0.0"',
    );
  }

  const rawApi = m.apiVersion;
  if (rawApi !== undefined && (typeof rawApi !== 'number' || !Number.isInteger(rawApi) || rawApi < 1)) {
    throw new ManifestError('apiVersion must be a positive integer');
  }
  const apiVersion = (rawApi as number | undefined) ?? 1;
  if (opts?.requireTrek && apiVersion > PLUGIN_API_VERSION) {
    throw new ManifestError(`plugin requires plugin-API v${apiVersion}; this TREK supports v${PLUGIN_API_VERSION}`);
  }

  return {
    id,
    name: str(m.name, 'name'),
    version,
    apiVersion,
    author: optStr(m.author),
    description: optStr(m.description),
    homepage: optStr(m.homepage),
    icon: optStr(m.icon) ?? 'Blocks',
    type: type as PluginManifest['type'],
    trek,
    trekRange,
    // Derived from the range itself, never from the first number that looks like a
    // version in it: a range of "<4.0.0" has a *first* semver of 4.0.0 but a lower
    // bound of 0.0.0, so reading it off the text produced the exact inverse of the truth.
    minTrekVersion: trekRange ? minTrekOf(trekRange) : undefined,
    nativeModules: false,
    permissions,
    egress,
    operatorEgress: m.operatorEgress === true,
    settings: parseSettings(m.settings),
    actions: parseActions(m.actions),
    capabilities,
    requiredAddons: parseRequiredAddons(m.requiredAddons),
    pluginDependencies: parsePluginDependencies(m.pluginDependencies, id),
  };
}

/** Validate `requiredAddons`: a de-duplicated list of well-formed addon-id slugs. */
function parseRequiredAddons(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of arr(raw)) {
    if (typeof v !== 'string' || !ADDON_ID_RE.test(v)) throw new ManifestError(`invalid requiredAddons entry "${String(v)}"`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validate `pluginDependencies`: each `{ id, version }` must reference a valid,
 * non-self, non-reserved plugin id and a parseable semver range. Duplicate ids
 * are rejected so a dependency can't be declared with two conflicting ranges.
 */
function parsePluginDependencies(raw: unknown, selfId: string): PluginDependency[] {
  const out: PluginDependency[] = [];
  for (const v of arr(raw)) {
    if (!v || typeof v !== 'object') throw new ManifestError('each pluginDependencies entry must be an object');
    const d = v as Record<string, unknown>;
    const id = str(d.id, 'pluginDependencies.id');
    if (!ID_RE.test(id)) throw new ManifestError(`invalid pluginDependencies id "${id}"`);
    if (RESERVED_IDS.has(id)) throw new ManifestError(`reserved pluginDependencies id "${id}"`);
    if (id === selfId) throw new ManifestError(`plugin "${selfId}" cannot depend on itself`);
    if (out.some((e) => e.id === id)) throw new ManifestError(`duplicate pluginDependencies id "${id}"`);
    const version = str(d.version, 'pluginDependencies.version');
    if (semver.validRange(version) === null) throw new ManifestError(`invalid pluginDependencies version range "${version}" for "${id}"`);
    out.push({ id, version });
  }
  return out;
}

// Export function / event names exposed to other plugins. Kept to a safe
// identifier shape (dots allowed for event names like `rate.updated`).
const CAPABILITY_NAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

function parseCapabilities(raw: unknown): PluginCapabilities {
  if (!raw || typeof raw !== 'object') return {};
  const c = raw as Record<string, unknown>;
  const out: PluginCapabilities = {};
  if (c.widget && typeof c.widget === 'object') {
    const w = c.widget as Record<string, unknown>;
    const slot = optStr(w.slot);
    if (slot && slot !== 'sidebar' && slot !== 'hero' && slot !== 'place-detail' && slot !== 'day-detail' && slot !== 'reservation-detail') throw new ManifestError(`invalid widget slot "${slot}"`);
    out.widget = {
      title: optStr(w.title),
      defaultSize: optStr(w.defaultSize),
      slot: (slot as WidgetCapability['slot']) ?? 'sidebar',
    };
  }
  if (c.tripPage && typeof c.tripPage === 'object') {
    const tp = c.tripPage as Record<string, unknown>;
    const page: TripPageCapability = {};
    if (tp.replaces !== undefined) {
      if (!Array.isArray(tp.replaces)) throw new ManifestError('capabilities.tripPage.replaces must be an array');
      const replaces: string[] = [];
      for (const v of tp.replaces) {
        if (typeof v !== 'string' || !REPLACEABLE_TABS.includes(v)) {
          throw new ManifestError(`capabilities.tripPage.replaces: "${String(v)}" is not a replaceable tab (${REPLACEABLE_TABS.join(', ')})`);
        }
        if (!replaces.includes(v)) replaces.push(v);
      }
      if (replaces.length) page.replaces = replaces;
    }
    if (tp.position !== undefined) {
      if (typeof tp.position !== 'number' || !Number.isInteger(tp.position) || tp.position < 0 || tp.position > 50) {
        throw new ManifestError('capabilities.tripPage.position must be an integer between 0 and 50');
      }
      page.position = tp.position;
    }
    if (Object.keys(page).length) out.tripPage = page;
  }
  if (c.settingsUi !== undefined) {
    if (typeof c.settingsUi !== 'boolean') throw new ManifestError('capabilities.settingsUi must be a boolean');
    if (c.settingsUi) out.settingsUi = true;
  }
  if (c.notificationChannel && typeof c.notificationChannel === 'object') {
    const nc = c.notificationChannel as Record<string, unknown>;
    const channel: NotificationChannelCapability = {};
    const title = optStr(nc.title);
    if (title) channel.title = title;
    if (nc.events !== undefined) {
      if (!Array.isArray(nc.events)) throw new ManifestError('capabilities.notificationChannel.events must be an array');
      const events: string[] = [];
      for (const v of nc.events) {
        if (typeof v !== 'string' || !(PLUGIN_CHANNEL_EVENTS as readonly string[]).includes(v)) {
          throw new ManifestError(
            `capabilities.notificationChannel.events: "${String(v)}" is not a plugin-deliverable event (${PLUGIN_CHANNEL_EVENTS.join(', ')})`,
          );
        }
        if (!events.includes(v)) events.push(v);
      }
      if (events.length) channel.events = events;
    }
    out.notificationChannel = channel;
  }
  if (c.routeProfiles !== undefined) {
    if (!Array.isArray(c.routeProfiles)) throw new ManifestError('capabilities.routeProfiles must be an array');
    if (c.routeProfiles.length > 3) throw new ManifestError('capabilities.routeProfiles: at most 3 profiles');
    const profiles: RouteProfileCapability[] = [];
    for (const v of c.routeProfiles) {
      if (!v || typeof v !== 'object') throw new ManifestError('capabilities.routeProfiles entries must be objects');
      const p = v as Record<string, unknown>;
      const id = typeof p.id === 'string' ? p.id : '';
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) {
        throw new ManifestError('capabilities.routeProfiles: id must be lowercase [a-z][a-z0-9-], max 24 chars');
      }
      if (profiles.some((x) => x.id === id)) throw new ManifestError(`capabilities.routeProfiles: duplicate id "${id}"`);
      const label = typeof p.label === 'string' ? p.label.trim() : '';
      if (!label || label.length > 40) throw new ManifestError('capabilities.routeProfiles: label is required (max 40 chars)');
      const icon = optStr(p.icon);
      profiles.push({ id, label, ...(icon ? { icon: icon.slice(0, 40) } : {}) });
    }
    if (profiles.length) out.routeProfiles = profiles;
  }
  if (c.mcpTools !== undefined) {
    out.mcpTools = parseMcpToolCapabilities(c.mcpTools);
  }
  const provides = parseCapabilityNames(c.provides, 'provides');
  if (provides.length) out.provides = provides;
  const emits = parseCapabilityNames(c.emits, 'emits');
  if (emits.length) out.emits = emits;
  return out;
}

/**
 * Events a plugin notification channel may carry. Two exclusions, both deliberate:
 * `version_available` is admin-scoped (it goes out over the admin's own global
 * credentials, and a community plugin is never a recipient of one), and
 * `synology_session_cleared` is in-app only.
 *
 * Spelled out rather than derived from the notification service, so the plugin
 * installer carries no runtime dependency on it. The guard below is what keeps the
 * two in step — same trick as `_eventKeyDriftGuard` in services/notifications.ts.
 */
export const PLUGIN_CHANNEL_EVENTS = [
  'trip_invite',
  'booking_change',
  'trip_reminder',
  'todo_due',
  'vacay_invite',
  'collection_invite',
  'photos_shared',
  'collab_message',
  'packing_tagged',
  'plugin_notification',
] as const;

// Compile-time guard: every id above must still be a real notification event.
// If one is renamed or dropped, this stops compiling.
type _ChannelEventsAreReal = (typeof PLUGIN_CHANNEL_EVENTS)[number] extends NotifEventType ? true : never;
const _channelEventDriftGuard: _ChannelEventsAreReal = true;
void _channelEventDriftGuard;

// Core planner tabs a trip-page plugin may replace while it is active. 'plan' is
// deliberately NOT in this list — a trip always keeps its planner view, so a
// plugin can take over bookings/transports/…, never the whole trip.
const REPLACEABLE_TABS = ['transports', 'buchungen', 'listen', 'finanzplan', 'dateien', 'collab'];

/** Validate a `provides`/`emits` array: de-duplicated, well-formed names. */
/**
 * Validate and bound `capabilities.mcpTools`.
 *
 * Rejects rather than drops, unlike most capability parsing: a bad tool schema
 * is an admin-visible install failure here, instead of a tool that silently
 * never appears once the plugin is running. The caps and the text/schema
 * sanitising live in mcp-tool-schema.ts so the install path and the advertise
 * path cannot disagree about them.
 */
export function parseMcpToolCapabilities(raw: unknown): McpToolCapability[] {
  if (!Array.isArray(raw)) throw new ManifestError('capabilities.mcpTools must be an array');
  if (raw.length > MCP_TOOLS_MAX) {
    throw new ManifestError(`capabilities.mcpTools: at most ${MCP_TOOLS_MAX} tools`);
  }
  const tools: McpToolCapability[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new ManifestError('capabilities.mcpTools entries must be objects');
    }
    const t = v as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : '';
    if (!TOOL_NAME_RE.test(name)) {
      throw new ManifestError('capabilities.mcpTools: name must be lowercase [a-z0-9_], max 48 chars');
    }
    if (tools.some((x) => x.name === name)) {
      throw new ManifestError(`capabilities.mcpTools: duplicate name "${name}"`);
    }
    try {
      const text = sanitiseToolText(t.title, t.description);
      const inputSchema = normaliseToolSchema(t.inputSchema);
      // Build the validator here purely so an unenforceable keyword fails the
      // INSTALL, loudly, rather than at advertise time where the per-plugin
      // catch would turn it into a tool that silently never appears.
      buildToolInputSchema(inputSchema);
      tools.push({
        name,
        ...text,
        ...(inputSchema ? { inputSchema } : {}),
        ...(t.annotations !== undefined ? { annotations: t.annotations as Record<string, unknown> } : {}),
      });
    } catch (e) {
      if (e instanceof McpToolSchemaError) {
        throw new ManifestError(`capabilities.mcpTools "${name}": ${e.message}`);
      }
      throw e;
    }
  }
  return tools;
}

function parseCapabilityNames(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError(`capabilities.${field} must be an array of names`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !CAPABILITY_NAME_RE.test(v)) throw new ManifestError(`invalid capabilities.${field} entry "${String(v)}"`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * A settings field key. Constrained because the key is used as a JSON object key in
 * the plugin's stored config: an unconstrained one (`__proto__`, `constructor`) resolves
 * off Object.prototype on read, so a *required* field with such a name would look
 * "configured" for every user who had configured nothing — enough, for a notification
 * channel, to be dispatched to everyone without anyone entering credentials.
 * (safeParse in plugins.service.ts now uses a null-prototype object too; this is the
 * front door, that is the backstop.)
 */
const SETTING_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const RESERVED_SETTING_KEYS = new Set(['constructor', 'prototype', '__proto__']);

/**
 * Every attribute a settings-field object may carry — parseSettings reads exactly these and
 * silently drops anything else. The SDK mirrors this list (`SETTING_FIELD_KEYS` in
 * plugin-sdk/src/manifest.ts, parity-tested against this file) so `trek-plugin validate`
 * can warn on a typo'd or unsupported attribute instead of letting it vanish at install.
 */
export const SETTING_FIELD_KEYS = [
  'key', 'label', 'input_type', 'placeholder', 'hint', 'required', 'secret', 'scope', 'options', 'oauth', 'default',
] as const;

function parseSettings(raw: unknown): ManifestSettingField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s): ManifestSettingField => {
      const input_type = optStr(s.input_type) ?? 'text';
      const secret = !!s.secret;
      const options = parseSettingOptions(s.options);
      return {
        key: assertSettingKey(String(s.key ?? '')),
        label: optStr(s.label),
        input_type,
        placeholder: optStr(s.placeholder),
        hint: optStr(s.hint),
        required: !!s.required,
        secret,
        default: parseSettingDefault(s.default, { secret, input_type, options }),
        scope: s.scope === 'user' ? 'user' : 'instance',
        options,
        oauth: s.oauth && typeof s.oauth === 'object' ? (s.oauth as { initPath?: string; callbackPath?: string }) : undefined,
      };
    })
    .filter((s) => s.key);
}

/**
 * A field's `default` — the field's effective value wherever nothing is stored (the form
 * pre-fills it and the runtime resolves it; see settings-defaults.ts). Tolerant on purpose:
 * an unusable default degrades to "no default" and never blocks an install (the SDK's
 * `validate` is where an author hears about it). Dropped when:
 *   - the field is a SECRET — the manifest is public, so it would be a plaintext secret;
 *   - a `checkbox` default is not a boolean — the form would coerce it to unchecked anyway;
 *   - a field with `options` defaults to a value not among them — the select would render
 *     blank and Save would persist an undeclared value.
 */
function parseSettingDefault(
  raw: unknown,
  field: { secret: boolean; input_type: string; options?: Array<{ value: string }> },
): string | number | boolean | undefined {
  if (raw === undefined || raw === null || field.secret) return undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return undefined;
  if (field.input_type === 'checkbox' && typeof raw !== 'boolean') return undefined;
  if (field.options && field.options.length > 0 && !field.options.some((o) => o.value === String(raw))) return undefined;
  return raw;
}

/**
 * A `select` field's options. The client renders `{value, label}`, so a bare string list —
 * the obvious thing to write, and what a manifest was silently allowed to carry — rendered
 * every option BLANK (value/label both undefined). Coerce the string form instead of
 * failing on it, and reject anything that is neither.
 */
function parseSettingOptions(raw: unknown): Array<{ value: string; label: string }> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ManifestError('settings option list must be an array');
  return raw.map((o) => {
    if (typeof o === 'string' || typeof o === 'number') return { value: String(o), label: String(o) };
    if (o && typeof o === 'object') {
      const { value, label } = o as { value?: unknown; label?: unknown };
      if (value === undefined || value === null || String(value) === '') {
        throw new ManifestError('settings option must have a non-empty "value"');
      }
      return { value: String(value), label: String(label ?? value) };
    }
    throw new ManifestError(`invalid settings option ${JSON.stringify(o)} (expected a string or { value, label })`);
  });
}

/** Settings-page action buttons. Bounded: the host renders the label itself. */
function parseActions(raw: unknown): ManifestAction[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError('actions must be an array');
  if (raw.length > 8) throw new ManifestError('at most 8 actions');
  const out: ManifestAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') throw new ManifestError('each action must be an object');
    const { key, label, hint, danger, scope } = a as Record<string, unknown>;
    const k = assertSettingKey(String(key ?? ''));
    if (!k) throw new ManifestError('action must have a "key"');
    if (out.some((x) => x.key === k)) throw new ManifestError(`duplicate action "${k}"`);
    if (scope !== undefined && scope !== 'user' && scope !== 'instance') {
      throw new ManifestError(`action "${k}".scope must be "user" or "instance"`);
    }
    // `label ?? k` only defaults on null/undefined — an explicit `label: ''` would pass
    // straight through and reach the client as an empty button/confirm label (which
    // MConfirmSheet then refuses to render a confirm button for). Fall back to the key
    // whenever the label is empty after trimming.
    const rawLabel = label == null ? '' : String(label);
    out.push({
      key: k,
      label: (rawLabel.trim() === '' ? k : rawLabel).slice(0, 60),
      hint: hint === undefined ? undefined : String(hint).slice(0, 200),
      danger: danger === true,
      scope: scope === 'instance' ? 'instance' : 'user',
    });
  }
  return out;
}

function assertSettingKey(key: string): string {
  // An empty key is dropped by the .filter below (a manifest may legitimately omit a
  // field), but a PRESENT key that is malformed is a hard reject — silently ignoring it
  // would leave the plugin expecting a setting the host will never store.
  if (!key) return key;
  if (!SETTING_KEY_RE.test(key) || RESERVED_SETTING_KEYS.has(key)) {
    throw new ManifestError(`invalid settings key "${key}" (letters, digits, . _ - ; must start with a letter; 1–64 chars)`);
  }
  return key;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new ManifestError(`missing/invalid "${name}"`);
  return v;
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
