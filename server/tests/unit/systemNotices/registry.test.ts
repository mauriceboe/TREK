import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { SYSTEM_NOTICES } from '../../../src/systemNotices/registry.js';
import { isNoticeVersionActive } from '../../../src/systemNotices/service.js';

/** Collect all actionIds registered via registerNoticeAction() in client source files. */
function collectRegisteredActionIds(): Set<string> {
  const clientSrc = path.resolve(__dirname, '../../../../client/src');
  const ids = new Set<string>();
  const queue = [clientSrc];
  while (queue.length) {
    const dir = queue.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { queue.push(full); continue; }
      if (!entry.name.endsWith('noticeActions.ts') && !entry.name.endsWith('noticeActions.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/registerNoticeAction\(\s*['"]([^'"]+)['"]/g)) {
        ids.add(m[1]);
      }
    }
  }
  return ids;
}

describe('registry integrity', () => {
  it('has no duplicate ids', () => {
    const ids = SYSTEM_NOTICES.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all action CTAs reference a registered actionId', () => {
    const registeredActionIds = collectRegisteredActionIds();
    const actionCtaIds = SYSTEM_NOTICES
      .filter(n => n.cta?.kind === 'action')
      .map(n => (n.cta as { actionId: string }).actionId);

    for (const id of actionCtaIds) {
      expect(registeredActionIds, `actionId "${id}" not found in any client noticeActions.ts`).toContain(id);
    }
  });

  it('all publishedAt are valid ISO dates', () => {
    for (const n of SYSTEM_NOTICES) {
      expect(() => new Date(n.publishedAt).toISOString()).not.toThrow();
    }
  });

  it('minVersion and maxVersion are valid semver when set, and minVersion <= maxVersion when both set', () => {
    for (const n of SYSTEM_NOTICES) {
      if (n.minVersion !== undefined) {
        expect(semver.valid(n.minVersion), `notice "${n.id}" has invalid minVersion "${n.minVersion}"`).not.toBeNull();
      }
      if (n.maxVersion !== undefined) {
        expect(semver.valid(n.maxVersion), `notice "${n.id}" has invalid maxVersion "${n.maxVersion}"`).not.toBeNull();
      }
      if (n.minVersion && n.maxVersion) {
        expect(
          semver.lte(n.minVersion, n.maxVersion),
          `notice "${n.id}": minVersion ${n.minVersion} > maxVersion ${n.maxVersion}`
        ).toBe(true);
      }
    }
  });

  it('the 4.0.0 release notice covers the whole 4.x line', () => {
    const release = SYSTEM_NOTICES.find(n => n.id === 'release-4-0-0');
    expect(release).toBeDefined();
    // It must not greet somebody still on 3.x...
    expect(isNoticeVersionActive(release!, '3.4.1')).toBe(false);
    expect(isNoticeVersionActive(release!, '4.0.0')).toBe(true);
    expect(isNoticeVersionActive(release!, '4.0.7')).toBe(true);
    expect(isNoticeVersionActive(release!, '4.0.12')).toBe(true);
    // ...and it stays up across the minors, so no 4.x install is left without a
    // notice the way 4.1.0 was under the old per-release window.
    expect(isNoticeVersionActive(release!, '4.1.0')).toBe(true);
    expect(isNoticeVersionActive(release!, '4.2.0')).toBe(true);
    expect(isNoticeVersionActive(release!, '4.9.9')).toBe(true);
    // The upper bound is exclusive: 5.0.0 gets its own notice.
    expect(isNoticeVersionActive(release!, '5.0.0')).toBe(false);
  });

  it('the 4.0.0 release notice comes back on each upgrade inside that line', () => {
    const release = SYSTEM_NOTICES.find(n => n.id === 'release-4-0-0')!;
    // The version window above is only half of "covers the whole 4.x line". Without
    // this, the default one-time dismissal retired the notice for everyone who
    // closed it on 4.0.0, so none of them saw it again on 4.1, 4.2 or later.
    expect(release.recurring).toBe('per-version');
  });

  it('the thank-you notice hands over to the release modal at 4.0.0', () => {
    const thankYou = SYSTEM_NOTICES.find(n => n.id === 'thank-you-support');
    expect(thankYou).toBeDefined();
    // Both carry the same thank-you and the same two support links, so exactly
    // one of them may be active at any version.
    expect(isNoticeVersionActive(thankYou!, '3.4.1')).toBe(true);
    expect(isNoticeVersionActive(thankYou!, '4.0.0')).toBe(false);

    const release = SYSTEM_NOTICES.find(n => n.id === 'release-4-0-0')!;
    for (const version of ['3.4.1', '4.0.0', '4.0.7', '4.1.0', '5.0.0']) {
      const active = [thankYou!, release].filter(n => isNoticeVersionActive(n, version));
      expect(active.length, `both thank-you notices active at ${version}`).toBeLessThanOrEqual(1);
    }
  });
});
