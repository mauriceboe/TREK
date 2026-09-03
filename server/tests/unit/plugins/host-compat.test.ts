import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  hostVersion,
  normalizedHost,
  isValidTrekRange,
  minTrekOf,
  hostSatisfies,
  trekRangeBypassed,
  bypassedRange,
  __resetHostWarningForTests,
} from '../../../src/nest/plugins/install/host-compat';

/**
 * The TREK-version gate (#plugins). Every install front door and the activation gate
 * answer "can this plugin run here?" through these functions, so their edges are the
 * edges of the whole feature.
 */

const APP_VERSION = process.env.APP_VERSION;
afterEach(() => {
  if (APP_VERSION === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = APP_VERSION;
  delete process.env.TREK_PLUGINS_IGNORE_TREK_RANGE;
  __resetHostWarningForTests();
});

describe('isValidTrekRange', () => {
  it('accepts the ranges a plugin actually declares', () => {
    for (const r of ['>=3.2.0 <4.0.0', '^3.2.0', '~3.2', '>=3', '<4.0.0', '3.x', '*']) {
      expect(isValidTrekRange(r), r).toBe(true);
    }
  });

  it('rejects a range no version can ever satisfy — validRange() alone would accept it', () => {
    // Syntactically fine, semantically empty. A plugin declaring this would be
    // uninstallable everywhere with nothing to tell its author why.
    expect(isValidTrekRange('>=4.0.0 <3.0.0')).toBe(false);
  });

  it('rejects junk without letting semver.minVersion throw out of it', () => {
    for (const r of ['latest', 'v3-ish', '3.2+', '', '   ', undefined, null, 42, {}]) {
      expect(isValidTrekRange(r), String(r)).toBe(false);
    }
  });
});

describe('minTrekOf', () => {
  it('reads the lower bound off the RANGE, not off the first version-shaped substring', () => {
    // The regression this replaces: the old regex took the first X.Y.Z in the string, so
    // "<4.0.0" reported a *minimum* of 4.0.0 — the exact inverse of what the plugin says.
    expect(minTrekOf('<4.0.0')).toBeUndefined(); // lower bound is 0.0.0 → nothing to show
    expect(minTrekOf('>=3.2.0 <4.0.0')).toBe('3.2.0');
    expect(minTrekOf('^3.2.0')).toBe('3.2.0');
    expect(minTrekOf('~3.2')).toBe('3.2.0');
    expect(minTrekOf('>=3')).toBe('3.0.0');
    expect(minTrekOf('>=3.2.0-beta.1')).toBe('3.2.0-beta.1');
  });

  it('has no lower bound to show for an unbounded range', () => {
    expect(minTrekOf('*')).toBeUndefined();
  });
});

describe('hostSatisfies', () => {
  it('admits a host inside the range and refuses one outside it', () => {
    expect(hostSatisfies('>=3.2.0 <4.0.0', '3.3.0')).toBe(true);
    expect(hostSatisfies('>=3.2.0 <4.0.0', '3.2.0')).toBe(true);
    expect(hostSatisfies('>=3.2.0 <4.0.0', '3.1.9')).toBe(false);
    expect(hostSatisfies('>=3.2.0 <4.0.0', '4.0.0')).toBe(false); // the exclusive upper bound
  });

  it('treats a prerelease host as its target release — both edges matter', () => {
    // Plain semver would fail 3.4.0-rc.1 against a range that names no prerelease, which
    // would make EVERY plugin incompatible the moment TREK shipped an rc.
    expect(hostSatisfies('>=3.2.0 <4.0.0', '3.4.0-rc.1')).toBe(true);
    // And includePrerelease would order 4.0.0-rc.1 BEFORE 4.0.0, so it would satisfy
    // "<4.0.0" — loading a plugin that disclaims TREK 4 onto a build that already carries
    // TREK 4's breaking changes. An rc of 4.0 IS 4.0 for compatibility purposes.
    expect(hostSatisfies('>=3.2.0 <4.0.0', '4.0.0-rc.1')).toBe(false);
    expect(hostSatisfies('>=4.0.0', '4.0.0-rc.1')).toBe(true);
  });

  it('never blocks when the host version is not semver at all (APP_VERSION=dev)', () => {
    // The Docker build ARG defaults to the literal "dev". An unversioned build must stay
    // fully usable rather than refusing every plugin it has.
    process.env.APP_VERSION = 'dev';
    expect(normalizedHost()).toBeNull();
    expect(hostSatisfies('>=3.2.0 <4.0.0')).toBe(true);
    expect(hostSatisfies(null)).toBe(true);
  });

  it('warns once — and only once — about an unparseable host, so a misconfig is visible', () => {
    process.env.APP_VERSION = 'nonsense';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizedHost();
    normalizedHost();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/not a semver version/);
    warn.mockRestore();
  });

  it('refuses an undeclared or unsatisfiable range rather than waving it through', () => {
    // The caller decides what an absent range MEANS (reject at install, "unknown" at
    // activation) — it must not pass by accident here.
    expect(hostSatisfies(null, '3.3.0')).toBe(false);
    expect(hostSatisfies('', '3.3.0')).toBe(false);
    expect(hostSatisfies('>=4.0.0 <3.0.0', '3.3.0')).toBe(false);
  });

  it('reads the running version from APP_VERSION, falling back to the package version', () => {
    process.env.APP_VERSION = '3.9.1';
    expect(hostVersion()).toBe('3.9.1');
    expect(hostSatisfies('>=3.2.0 <4.0.0')).toBe(true);
    expect(hostSatisfies('>=4.0.0')).toBe(false);

    delete process.env.APP_VERSION;
    expect(hostVersion()).toMatch(/^\d+\.\d+\.\d+/); // package.json
  });
});

/**
 * TREK_PLUGINS_IGNORE_TREK_RANGE: an operator's explicit "install it anyway" for a plugin
 * whose author has not updated its `trek` range. The gates warn instead of refusing, but
 * the truth (hostSatisfies) never changes — the UI still has to say the plugin is
 * outside its range.
 */
describe('range bypass (TREK_PLUGINS_IGNORE_TREK_RANGE)', () => {
  it('is off by default and only an explicit truthy value turns it on', () => {
    expect(trekRangeBypassed()).toBe(false);
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '0';
    expect(trekRangeBypassed()).toBe(false);
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
    expect(trekRangeBypassed()).toBe(true);
  });

  it('reports a bypassed mismatch only when the bypass is on AND the range does not admit the host', () => {
    process.env.APP_VERSION = '3.3.0';
    expect(bypassedRange('>=4.0.0')).toBeNull(); // off → the gate refuses, nothing to report
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = 'true';
    expect(bypassedRange('>=4.0.0')).toEqual({ trekRange: '>=4.0.0', hostVersion: '3.3.0' });
    expect(bypassedRange('>=3.2.0 <4.0.0')).toBeNull(); // fits → not a bypass, a normal install
  });

  it('covers a plugin that declared no range at all — the same author oversight', () => {
    process.env.APP_VERSION = '3.3.0';
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
    expect(bypassedRange(null)).toEqual({ trekRange: null, hostVersion: '3.3.0' });
    expect(bypassedRange(undefined)).toEqual({ trekRange: null, hostVersion: '3.3.0' });
  });

  it('leaves hostSatisfies telling the truth while bypassed', () => {
    process.env.APP_VERSION = '3.3.0';
    process.env.TREK_PLUGINS_IGNORE_TREK_RANGE = '1';
    expect(hostSatisfies('>=4.0.0')).toBe(false);
  });
});
