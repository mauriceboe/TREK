import semver from 'semver';
import { readEnv } from '../../../app-config';

/**
 * Host-version compatibility for plugins (#plugins). A manifest declares the TREK
 * versions it supports as a semver RANGE (`"trek": ">=3.2.0 <4.0.0"`); this module
 * is the single place that answers "what TREK is running" and "does that range admit
 * it". Every install front door (registry, sideload, dev-link) and the activation
 * gate go through here, so a plugin can never run against a host it says it doesn't
 * support — and, just as importantly, they all answer the question the same way.
 */

/** The running TREK version (same source as the rest of the app). */
export function hostVersion(): string {
  return readEnv().app.appVersion || (require('../../../../package.json') as { version: string }).version;
}

let warnedUnparseable = false;

/**
 * The running version as a plain release triple, or null when it can't be parsed at all.
 *
 * Prereleases are deliberately COERCED to their target release: 3.4.0-rc.1 compares as
 * 3.4.0, and 4.0.0-rc.1 as 4.0.0. Both halves of that matter, and semver's own ordering
 * gets both wrong for this purpose:
 *
 *  - Plain `satisfies()` excludes a prerelease from any range that doesn't name one, so
 *    3.4.0-rc.1 would fail ">=3.2.0 <4.0.0" and EVERY plugin on the instance would go
 *    incompatible the moment TREK shipped a release candidate.
 *  - `includePrerelease` fixes that but orders 4.0.0-rc.1 BEFORE 4.0.0, so it satisfies
 *    "<4.0.0" — letting a plugin that disclaims TREK 4 load on a build that already
 *    carries TREK 4's breaking changes. That is the precise failure this gate exists to
 *    prevent.
 *
 * Coercing to the release says the useful thing instead: for compatibility purposes, an
 * rc of 4.0 IS 4.0.
 *
 * A null host NEVER blocks anything (see {@link hostSatisfies}). This is deliberate:
 * APP_VERSION is a Docker build ARG that defaults to the literal string `dev`, and an
 * unversioned build must stay fully usable. The warning exists so that a MISCONFIGURED
 * APP_VERSION in production — which silently switches this whole gate off — is visible
 * in the logs instead of being discovered when an incompatible plugin misbehaves.
 */
export function normalizedHost(): string | null {
  const raw = hostVersion();
  const coerced = semver.coerce(raw)?.version ?? null;
  if (!coerced && !warnedUnparseable) {
    warnedUnparseable = true;
    console.warn(`[plugins] APP_VERSION "${raw}" is not a semver version — plugin TREK-compatibility checks are disabled`);
  }
  return coerced;
}

/** Test hook: re-arm the one-time unparseable-host warning. */
export function __resetHostWarningForTests(): void {
  warnedUnparseable = false;
}

/**
 * Whether `r` is a semver range a plugin may declare.
 *
 * `semver.validRange` alone is not enough: ">=4.0.0 <3.0.0" is a VALID range that no
 * version can ever satisfy, and a plugin that declares it would be uninstallable with
 * no way to tell the author why. minVersion() returns null for exactly that case (and
 * throws outright on garbage like "latest"), so it is the real satisfiability test.
 */
export function isValidTrekRange(r: unknown): r is string {
  if (typeof r !== 'string' || !r.trim()) return false;
  if (semver.validRange(r) === null) return false;
  try {
    return semver.minVersion(r) !== null;
  } catch {
    return false;
  }
}

/**
 * The lowest TREK version a range admits — what the UI shows as "Requires TREK x+".
 * Undefined for a range with no real lower bound (`*`, `<4.0.0`), because "requires
 * TREK 0.0.0+" is noise rather than information.
 */
export function minTrekOf(range: string): string | undefined {
  if (!isValidTrekRange(range)) return undefined;
  const min = semver.minVersion(range);
  if (!min || min.version === '0.0.0') return undefined;
  return min.version;
}

/**
 * Whether the running TREK satisfies `range`. The host arrives here already coerced to a
 * release triple (see {@link normalizedHost}), which is what makes a plain satisfies()
 * correct on both prerelease edges.
 *
 * A null/empty range is not a decision this function can make — the caller knows whether
 * an undeclared range means "reject" (an install) or "unknown" (an already-installed
 * plugin), and they surface different codes. It returns false so neither can pass by
 * accident.
 */
export function hostSatisfies(range: string | null | undefined, host: string | null = normalizedHost()): boolean {
  // Coerce again rather than trusting the argument: callers that pass a host explicitly
  // (the registry, tests) would otherwise skip the prerelease normalisation and get a
  // different answer than the default path for the same TREK.
  const release = host === null ? null : (semver.coerce(host)?.version ?? null);
  if (release === null) return true; // unversioned build — never block
  if (!isValidTrekRange(range)) return false;
  return semver.satisfies(release, range);
}

/**
 * Whether TREK_PLUGINS_IGNORE_TREK_RANGE is set: the operator's explicit "install it
 * anyway" for a plugin whose author has not updated its `trek` range. While it is on,
 * every TREK-version gate (registry picker, post-extraction re-check, sideload, dev-link,
 * activation) WARNS instead of refusing. Nothing else changes — {@link hostSatisfies}
 * keeps telling the truth, so the admin UI can still say the plugin is running outside
 * the range its author vouched for. Read live, like the other plugin switches.
 */
export function trekRangeBypassed(): boolean {
  return readEnv().plugins.ignoreTrekRange;
}

/** What a bypassed gate reports back to the admin: the range that was ignored and the host it was ignored on. */
export interface TrekRangeBypass {
  /** The plugin's declared range, or null when it declared none at all. */
  trekRange: string | null;
  hostVersion: string;
}

/**
 * Non-null exactly when `range` would have been refused and only the bypass lets it
 * through: the marker that makes an install/activate response say "this worked, but
 * only because you told TREK to ignore the version check". Null for a normal install
 * (the range fits) and null when the bypass is off (the gate refuses instead).
 */
export function bypassedRange(range: string | null | undefined): TrekRangeBypass | null {
  if (hostSatisfies(range)) return null;
  if (!trekRangeBypassed()) return null;
  return { trekRange: range ?? null, hostVersion: hostVersion() };
}

/**
 * The one log line every bypassed gate writes. It names the plugin, the range that was
 * ignored and the host it was ignored on, so an operator reading the log after a plugin
 * misbehaves can connect the two without the UI.
 */
export function warnRangeBypass(id: string, b: TrekRangeBypass): void {
  const declared = b.trekRange ? `declares TREK ${b.trekRange}` : 'declares no TREK version range';
  console.warn(
    `[plugins] ${id} ${declared} — this is TREK ${b.hostVersion}; continuing because TREK_PLUGINS_IGNORE_TREK_RANGE is set. The author has not verified it on this version: it may not work, and it could corrupt TREK data.`,
  );
}
