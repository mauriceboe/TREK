/**
 * Who owns which setting, pinned.
 *
 * The lists grow and the mode does not: that is how this kind of switch drifts.
 * A key added to ADMIN_SETTINGS_KEYS or DEFAULTABLE_USER_SETTING_KEYS belongs to
 * neither set until somebody decides, and MANAGED-KEYS-001 is what makes that
 * decision unavoidable rather than optional.
 *
 * Deliberately an assignment test, not an equality test. Pinning the locked list
 * alone would pass forever while new keys quietly defaulted to "the admin may
 * set it", which is the failure this is here to prevent.
 */
import { describe, it, expect } from 'vitest';
import { ADMIN_SETTINGS_KEYS } from '../../../src/nest/auth/auth.helpers';
import { DEFAULTABLE_USER_SETTING_KEYS } from '../../../src/nest/settings/settings.service';
import {
  MANAGED_LOCKED_SETTING_KEYS,
  MANAGED_LOCKED_PROFILE_KEYS,
  MANAGED_CUSTOMER_KEYS,
  isManagedLockedKey,
  splitManagedKeys,
} from '../../../src/nest/common/managed';

const SOURCE_KEYS: string[] = [...ADMIN_SETTINGS_KEYS, ...DEFAULTABLE_USER_SETTING_KEYS];
const locked = new Set<string>(MANAGED_LOCKED_SETTING_KEYS);
const customer = new Set<string>(MANAGED_CUSTOMER_KEYS);

describe('managed key assignment', () => {
  it('MANAGED-KEYS-001: every key from both source lists is assigned to exactly one set', () => {
    const unassigned = SOURCE_KEYS.filter((k) => !locked.has(k) && !customer.has(k));
    const both = SOURCE_KEYS.filter((k) => locked.has(k) && customer.has(k));

    // Both in one assertion so the failure message names the offending key.
    expect({ unassigned, both }).toEqual({ unassigned: [], both: [] });
  });

  it('MANAGED-KEYS-002: no customer entry outlives the key it describes', () => {
    expect(MANAGED_CUSTOMER_KEYS.filter((k) => !SOURCE_KEYS.includes(k))).toEqual([]);
  });

  it('MANAGED-KEYS-003: the only locked names outside both source lists are the users columns', () => {
    expect(MANAGED_LOCKED_SETTING_KEYS.filter((k) => !SOURCE_KEYS.includes(k)).slice().sort()).toEqual(
      [...MANAGED_LOCKED_PROFILE_KEYS].sort(),
    );
  });

  it('MANAGED-KEYS-004: neither set repeats itself', () => {
    expect(locked.size).toBe(MANAGED_LOCKED_SETTING_KEYS.length);
    expect(customer.size).toBe(MANAGED_CUSTOMER_KEYS.length);
  });

  it('MANAGED-KEYS-005: the locked list is pinned verbatim', () => {
    expect([...MANAGED_LOCKED_SETTING_KEYS]).toEqual([
      'amap_api_key',
      'carto_api_key',
      'llm_api_key',
      'llm_base_url',
      'llm_model',
      'llm_multimodal',
      'llm_provider',
      'mapbox_access_token',
      'maps_api_key',
      'oidc_login',
      'oidc_registration',
      'openweather_api_key',
      'smtp_from',
      'smtp_host',
      'smtp_pass',
      'smtp_port',
      'smtp_skip_tls_verify',
      'smtp_user',
      'unsplash_api_key',
      'webauthn_origins',
      'webauthn_rp_id',
    ]);
  });

  it("MANAGED-KEYS-006: mapbox_access_token is the operator's, and reaches the browser by design", () => {
    // The one locked key whose value is meant to be public: a managed instance
    // ships the operator's pk.* token, injected when settings are read. Locked so
    // a per-user save cannot land on top of it and break that user's map.
    expect(isManagedLockedKey('mapbox_access_token')).toBe(true);
    expect(customer.has('mapbox_access_token')).toBe(false);
  });
});

describe('splitManagedKeys', () => {
  it('MANAGED-KEYS-007: hands the body back untouched on a self-hosted install', () => {
    const body = { smtp_host: 'mail.example.test', allow_registration: 'true' };

    expect(splitManagedKeys(body, false)).toEqual({ allowed: body, blocked: [] });
  });

  it('MANAGED-KEYS-008: keeps the customer keys and reports the locked ones', () => {
    // The admin settings tab saves SMTP and the registration toggles in one
    // request. Refusing the request would take the toggles down with the SMTP.
    const { allowed, blocked } = splitManagedKeys(
      { smtp_host: 'mail.example.test', smtp_pass: 'hunter2', allow_registration: 'true' },
      true,
    );

    expect(allowed).toEqual({ allow_registration: 'true' });
    expect(blocked).toEqual(['smtp_host', 'smtp_pass']);
  });

  it('MANAGED-KEYS-009: reports blocked names sorted, so a response body is stable', () => {
    const { blocked } = splitManagedKeys(
      { webauthn_rp_id: 'x', llm_api_key: 'y', smtp_from: 'z' },
      true,
    );

    expect(blocked).toEqual(['llm_api_key', 'smtp_from', 'webauthn_rp_id']);
  });

  it('MANAGED-KEYS-010: an unknown key is not the filter’s business', () => {
    // Whatever rejects unknown keys today keeps rejecting them; this only ever
    // removes names it was told to remove.
    const { allowed, blocked } = splitManagedKeys({ not_a_setting: '1' }, true);

    expect(allowed).toEqual({ not_a_setting: '1' });
    expect(blocked).toEqual([]);
  });
});
