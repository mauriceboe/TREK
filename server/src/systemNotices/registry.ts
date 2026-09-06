import type { SystemNotice } from './types.js';
import { registerPredicate } from './conditions.js';
import { db } from '../db/database.js';

registerPredicate('whitespace-collision-detected', () => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'whitespace_migration_collision'").get() as { value: string } | undefined;
  return row?.value === 'true';
});

/**
 * SYSTEM NOTICE REGISTRY
 *
 * Rules for authoring:
 * - NEVER reuse a retired `id` — dismissal tracking is keyed by `id`. Retired ids are
 *   listed in RETIRED_NOTICE_IDS so they're never accidentally re-used.
 * - `id` must be globally unique and stable across deployments.
 * - Title: ≤40 chars, sentence case, no trailing punctuation.
 * - Body: markdown (modal) or plain text (banner/toast). ≤400/140/80 chars.
 * - CTA label: ≤20 chars.
 * - Never hardcode version numbers/dates in translated strings — use bodyParams.
 */

/**
 * Retired notices. Kept out of the active list but their ids stay reserved so a future
 * notice never reuses one (dismissals are keyed by id). Do not re-add these ids.
 */
export const RETIRED_NOTICE_IDS = [
  'v3-thankyou',
  'v3-photos',
  'v3-journey',
  'v3-mcp',
  'v3-features',
  'welcome-v1',
] as const;

export const SYSTEM_NOTICES: SystemNotice[] = [
  // ── 4.0.0 release — what shipped, and a note from the maintainer ────────────
  // Carries `release`, so it renders as the two-column release modal rather than
  // the generic notice body. 4.0.0 was big enough that the whole 4.x line should
  // carry it, so `recurring: 'per-version'` brings it back on each upgrade inside
  // the window rather than the default one-time dismissal, which retired it for
  // everyone who closed it once on 4.0.0. A 5.x release gets its own entry.
  {
    id: 'release-4-0-0',
    recurring: 'per-version',
    display: 'modal',
    severity: 'info',
    titleKey: 'system_notice.release_400.headline',
    bodyKey: 'system_notice.release_400.intro',
    release: {
      version: '4.0.0',
      eyebrowKey: 'system_notice.release_400.eyebrow',
      tagKey: 'system_notice.release_400.tag',
      headlineKey: 'system_notice.release_400.headline',
      introKey: 'system_notice.release_400.intro',
      features: [
        {
          iconName: 'Smartphone',
          titleKey: 'system_notice.release_400.feature_mobile_title',
          bodyKey: 'system_notice.release_400.feature_mobile_body',
        },
        {
          iconName: 'BookOpen',
          titleKey: 'system_notice.release_400.feature_studio_title',
          bodyKey: 'system_notice.release_400.feature_studio_body',
          badgeKey: 'system_notice.release_400.feature_studio_badge',
        },
        {
          iconName: 'CalendarDays',
          titleKey: 'system_notice.release_400.feature_vacay_title',
          bodyKey: 'system_notice.release_400.feature_vacay_body',
        },
        {
          iconName: 'Image',
          titleKey: 'system_notice.release_400.feature_places_title',
          bodyKey: 'system_notice.release_400.feature_places_body',
        },
      ],
      // No stat row and no notes button here: the left column reads better short.
      footnoteKey: 'system_notice.release_400.footnote',
      note: {
        eyebrowKey: 'system_notice.release_400.note_eyebrow',
        titleKey: 'system_notice.release_400.note_title',
        bodyKey: 'system_notice.release_400.note_body',
        promiseLabelKey: 'system_notice.release_400.promise_label',
        promiseTextKey: 'system_notice.release_400.promise_text',
        bodyAfterKey: 'system_notice.release_400.note_body_after',
        closingKey: 'system_notice.release_400.note_closing',
        signatureKey: 'system_notice.release_400.note_signature',
      },
      supportTextKey: 'system_notice.release_400.support_text',
    },
    cta: {
      kind: 'link',
      labelKey: 'system_notice.release_400.cta_bmc',
      href: 'https://buymeacoffee.com/mauriceboe',
    },
    secondaryCta: {
      kind: 'link',
      labelKey: 'system_notice.release_400.cta_kofi',
      href: 'https://ko-fi.com/mauriceboe',
    },
    dismissible: true,
    // Desktop-only, like the thank-you modal it replaces: the two-column layout
    // has no phone form, and the mobile release lands with its own onboarding.
    desktopOnly: true,
    // Same reasoning as the thank-you notice below: it asks the reader to fund
    // the project, and on a managed install they already pay whoever runs it.
    conditions: [{ kind: 'managed', is: false }],
    publishedAt: '2026-08-22T00:00:00Z',
    priority: 110,
    // The whole 4.x line. The copy is about what 4.0.0 brought, and that is still
    // what somebody arriving anywhere on 4.x is being introduced to — the minor
    // releases after it add to that picture rather than replace it. Held open to
    // the 5.0.0 boundary (exclusive) so a 4.1/4.2 install is not left with no
    // notice at all, which is what a per-release window did the moment 4.1.0
    // shipped without an entry of its own.
    minVersion: '4.0.0',
    maxVersion: '5.0.0',
  },

  // ── Thank-you + support the project — shown once per install AND once per upgrade ──
  // `recurring: 'per-version'` re-surfaces it whenever the app version moves up.
  {
    id: 'thank-you-support',
    display: 'modal',
    severity: 'info',
    icon: 'Heart',
    titleKey: 'system_notice.thank_you_support.title',
    bodyKey: 'system_notice.thank_you_support.body',
    highlights: [
      { labelKey: 'system_notice.thank_you_support.highlight_opensource', iconName: 'Github' },
      { labelKey: 'system_notice.thank_you_support.highlight_free', iconName: 'Infinity' },
      { labelKey: 'system_notice.thank_you_support.highlight_community', iconName: 'Users' },
    ],
    cta: {
      kind: 'link',
      labelKey: 'system_notice.thank_you_support.cta_bmc',
      href: 'https://buymeacoffee.com/mauriceboe',
    },
    secondaryCta: {
      kind: 'link',
      labelKey: 'system_notice.thank_you_support.cta_kofi',
      href: 'https://ko-fi.com/mauriceboe',
    },
    dismissible: true,
    // Desktop-only: the support modal is suppressed on small/mobile viewports.
    desktopOnly: true,
    // Not on a centrally administered install. The body thanks the reader for
    // installing TREK and asks them to fund it, and there the reader installed
    // nothing and already pays whoever runs it. Gated rather than reworded: the
    // text is right for everyone it was written for.
    conditions: [{ kind: 'managed', is: false }],
    publishedAt: '2026-06-27T00:00:00Z',
    priority: 100,
    recurring: 'per-version',
    // From 4.0.0 on, the release modal carries the same thank-you and the same
    // two support links, so this one would be the second half of a message the
    // reader just read. Retired by version rather than deleted: installs still
    // on 3.x keep it.
    maxVersion: '4.0.0',
  },

  // ── 3.0.14 admin notice — whitespace migration collision ───────────────────
  // Operational alert (not promo): shown only to admins who upgraded across the
  // 3.0.14 boundary AND only when the migration actually renamed colliding accounts.
  {
    id: 'v3014-whitespace-collision',
    display: 'banner',
    severity: 'warn',
    icon: 'AlertTriangle',
    titleKey: 'system_notice.v3014_whitespace_collision.title',
    bodyKey:  'system_notice.v3014_whitespace_collision.body',
    dismissible: true,
    conditions: [
      { kind: 'existingUserBeforeVersion', version: '3.0.14' },
      { kind: 'role', roles: ['admin'] },
      { kind: 'custom', id: 'whitespace-collision-detected' },
      // The body says to check the server logs. On a managed install the reader
      // has none, and the operator sees the same collision in theirs.
      { kind: 'managed', is: false },
    ],
    publishedAt: '2026-05-03T00:00:00Z',
    priority: 85,
    minVersion: '3.0.14',
  },
];
