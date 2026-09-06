import { z } from 'zod';

/**
 * Admin API contract for /api/admin (admin-only).
 *
 * These schemas exist to satisfy the body-contract ratchet without changing
 * behavior, so they are deliberately permissive: wherever AdminService already
 * emits a bespoke 400 of its own ('Invalid role', 'Name is required',
 * 'Username, email and password are required'), the field stays optional and
 * loosely typed so that error survives byte-identically. Every object schema is
 * non-strict — several clients and tests send extra keys and expect success.
 */

export const adminUserCreateRequestSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  // Deliberately z.string(), not z.enum: the service's own 'Invalid role' 400
  // is the pinned contract for a bad role.
  role: z.string().optional(),
});
export type AdminUserCreateRequest = z.infer<typeof adminUserCreateRequestSchema>;

export const adminUserUpdateRequestSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  role: z.string().optional(),
});
export type AdminUserUpdateRequest = z.infer<typeof adminUserUpdateRequestSchema>;

// Values stay z.unknown(): PermissionsService.savePermissions reports unknown
// levels through its `skipped` list (a 200 response field the admin UI shows),
// so narrowing to z.string() would turn that into a 400.
export const adminPermissionsRequestSchema = z.object({
  permissions: z.record(z.string(), z.unknown()),
});
export type AdminPermissionsRequest = z.infer<typeof adminPermissionsRequestSchema>;

export const adminInviteCreateRequestSchema = z.object({
  // string | number: the service parses with parseInt(String(x)), and the
  // admin UI sends numbers while older clients sent strings.
  max_uses: z.union([z.number(), z.string()]).optional(),
  expires_in_days: z.union([z.number(), z.string()]).optional(),
  role: z.enum(['user', 'admin']).optional(),
  // Optional trip binding (#1402): a user who registers via the link is
  // auto-added to this trip. Nullable/absent = a plain registration invite.
  trip_id: z.union([z.number(), z.string()]).nullable().optional(),
});
export type AdminInviteCreateRequest = z.infer<typeof adminInviteCreateRequestSchema>;

export const adminFeatureToggleRequestSchema = z.object({
  enabled: z.boolean(),
});
export type AdminFeatureToggleRequest = z.infer<typeof adminFeatureToggleRequestSchema>;

// Shared by all six packing-template create/update routes. `name` is optional so
// the service's 'Name is required' / 'Category name is required' / 'Item name is
// required' 400s stay the contract, and so the update routes keep treating a
// blank name as a no-op.
export const adminTemplateNameRequestSchema = z.object({
  name: z.string().optional(),
});
export type AdminTemplateNameRequest = z.infer<typeof adminTemplateNameRequestSchema>;

export const adminOidcUpdateRequestSchema = z.object({
  issuer: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  display_name: z.string().optional(),
  discovery_url: z.string().optional(),
});
export type AdminOidcUpdateRequest = z.infer<typeof adminOidcUpdateRequestSchema>;

// `config` must stay free-form: each addon stores its own keys, and the AI addon
// round-trips an apiKey mask sentinel that a narrower shape would strip.
export const adminAddonUpdateRequestSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type AdminAddonUpdateRequest = z.infer<typeof adminAddonUpdateRequestSchema>;

// Fully partial — the client PUTs one computed key at a time.
export const adminCollabFeaturesRequestSchema = z.object({
  chat: z.boolean().optional(),
  notes: z.boolean().optional(),
  polls: z.boolean().optional(),
  whatsnext: z.boolean().optional(),
});
export type AdminCollabFeaturesRequest = z.infer<typeof adminCollabFeaturesRequestSchema>;

// event type -> channel id -> enabled. Anything narrower would silently drop
// plugin-contributed channels, since the client echoes back the whole matrix.
export const adminNotificationPreferencesRequestSchema = z.record(z.string(), z.record(z.string(), z.boolean()));
export type AdminNotificationPreferencesRequest = z.infer<typeof adminNotificationPreferencesRequestSchema>;

// Heterogeneous values, and `null` is meaningful — SettingsService treats it as
// "reset to the built-in default". z.record also rejects arrays and null bodies,
// preserving the route's object-only guard.
export const adminDefaultUserSettingsRequestSchema = z.record(z.string(), z.unknown());
export type AdminDefaultUserSettingsRequest = z.infer<typeof adminDefaultUserSettingsRequestSchema>;

// Dev-only test sender: every field optional (callers POST {}), and `inApp` is a
// boolean OR the in-app action descriptor the dev panel sends.
export const adminTestNotificationRequestSchema = z.object({
  event: z.string().optional(),
  scope: z.string().optional(),
  targetId: z.number().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  inApp: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
});
export type AdminTestNotificationRequest = z.infer<typeof adminTestNotificationRequestSchema>;

// Which backend answers /api/transit (#1699). Transitous stays the default and
// the fallback: it is free and keyless, so an install that never opens this
// switch — or that picks Google without a key — keeps costing nothing.
export const TRANSIT_PROVIDERS = ['transitous', 'google'] as const;
export type TransitProvider = (typeof TRANSIT_PROVIDERS)[number];

export const adminTransitProviderRequestSchema = z.object({
  provider: z.enum(TRANSIT_PROVIDERS),
});
export type AdminTransitProviderRequest = z.infer<typeof adminTransitProviderRequestSchema>;

/**
 * Which of the three credential slots a third-party key resolved out of —
 * operator env, the instance-wide row, or the caller's own. The server's
 * ApiKeySource aliases this rather than restating it: the admin transit
 * response puts the value on the wire, and two copies of the union would be
 * exactly the hand-mirrored contract the project forbids.
 *
 * `null` on the wire means no key resolved at all.
 */
export const API_KEY_SOURCES = ['operator-env', 'instance', 'user-row'] as const;
export type ApiKeySource = (typeof API_KEY_SOURCES)[number];
/** The nullable form the admin transit-provider response carries. */
export type TransitKeySource = ApiKeySource | null;
