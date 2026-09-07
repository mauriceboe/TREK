import { z } from 'zod';

/**
 * Auth API contract for /api/auth.
 *
 * The auth service does the heavy credential/MFA validation internally (and
 * returns its own {error,status}); these schemas pin the well-defined request
 * bodies the public + account endpoints accept. Login/reset can branch to an
 * MFA step, so password fields stay permissive where the service owns the rules.
 */
export const registerRequestSchema = z.object({
  email: z.string(),
  password: z.string(),
  username: z.string().optional(),
  invite_token: z.string().optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string(),
  password: z.string(),
  // "Remember me" — when true the server issues a longer-lived
  // (SESSION_DURATION_REMEMBER) JWT + persistent cookie; when false/absent the
  // session lasts SESSION_DURATION and the cookie is a browser-session cookie.
  remember_me: z.boolean().optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  email: z.string(),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string(),
  // The client sends `new_password` and the service reads `body.new_password`;
  // the field was misnamed `password` here, which broke the client's typing.
  new_password: z.string(),
  mfa_code: z.string().optional(),
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const changePasswordRequestSchema = z.object({
  current_password: z.string(),
  new_password: z.string(),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const mfaVerifyLoginRequestSchema = z.object({
  mfa_token: z.string(),
  code: z.string(),
  // Carries the login-form "Remember me" choice through the second (MFA) leg,
  // since the session token is only minted once the MFA code is verified.
  remember_me: z.boolean().optional(),
});
export type MfaVerifyLoginRequest = z.infer<typeof mfaVerifyLoginRequestSchema>;

export const mfaEnableRequestSchema = z.object({
  code: z.string(),
});
export type MfaEnableRequest = z.infer<typeof mfaEnableRequestSchema>;

export const mcpTokenCreateRequestSchema = z.object({
  name: z.string().optional(),
});
export type McpTokenCreateRequest = z.infer<typeof mcpTokenCreateRequestSchema>;

// The client sends an explicit `null` to clear the stored key; optional keeps
// the legacy accept-anything omission path (omitting also clears — service rule).
export const mapsKeyUpdateRequestSchema = z.object({
  maps_api_key: z.string().nullable().optional(),
});
export type MapsKeyUpdateRequest = z.infer<typeof mapsKeyUpdateRequestSchema>;

// Per-key partial update: an absent key keeps the stored value, `null` clears it.
export const apiKeysUpdateRequestSchema = z.object({
  maps_api_key: z.string().nullable().optional(),
  openweather_api_key: z.string().nullable().optional(),
  unsplash_api_key: z.string().nullable().optional(),
  /** Amap (高德) web-service key — the places provider an install in China uses. */
  amap_api_key: z.string().nullable().optional(),
});
export type ApiKeysUpdateRequest = z.infer<typeof apiKeysUpdateRequestSchema>;

export const settingsUpdateRequestSchema = z.object({
  maps_api_key: z.string().nullable().optional(),
  openweather_api_key: z.string().nullable().optional(),
  unsplash_api_key: z.string().nullable().optional(),
  amap_api_key: z.string().nullable().optional(),
  username: z.string().optional(),
  email: z.string().optional(),
});
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;

// Deliberately an open map: the accepted keys are the server's ADMIN_SETTINGS_KEYS
// allow-list (unknown keys are ignored there), and values arrive as strings or
// booleans (`require_mfa` toggles) — the service owns the per-key coercion and
// the lockout/self-MFA guards with their bespoke 400 strings.
export const appSettingsUpdateRequestSchema = z.record(z.string(), z.unknown());
export type AppSettingsUpdateRequest = z.infer<typeof appSettingsUpdateRequestSchema>;

export const mfaDisableRequestSchema = z.object({
  password: z.string(),
  code: z.string(),
});
export type MfaDisableRequest = z.infer<typeof mfaDisableRequestSchema>;

// `purpose` must be the literal 'download' today, but the 400 'Invalid purpose'
// answer is a service rule (kept bespoke), so the wire type stays a plain string.
export const resourceTokenRequestSchema = z.object({
  purpose: z.string().optional(),
});
export type ResourceTokenRequest = z.infer<typeof resourceTokenRequestSchema>;

// ── Passkeys (/api/auth/passkey) ─────────────────────────────────────────────
// The WebAuthn ceremony payloads are raw @simplewebauthn/browser outputs whose
// real validation is the server-side ceremony verifier, and the bespoke 4xx
// strings ('Incorrect password' 401, 'Invalid registration response',
// 'Name is required', the uniform 'Authentication failed' 401) are service
// rules — so every field stays permissive and the service owns the semantics.

// Password re-auth: a missing password must reach the service (401), not 400.
export const passkeyRegisterOptionsRequestSchema = z.object({
  password: z.string().optional(),
});
export type PasskeyRegisterOptionsRequest = z.infer<typeof passkeyRegisterOptionsRequestSchema>;

// `name` is omitted entirely when the user leaves it blank; the service
// sanitizes non-strings itself.
export const passkeyRegisterVerifyRequestSchema = z.object({
  attestationResponse: z.unknown().optional(),
  name: z.unknown().optional(),
});
export type PasskeyRegisterVerifyRequest = z.infer<typeof passkeyRegisterVerifyRequestSchema>;

export const passkeyLoginVerifyRequestSchema = z.object({
  assertionResponse: z.unknown().optional(),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof passkeyLoginVerifyRequestSchema>;

export const passkeyRenameRequestSchema = z.object({
  name: z.unknown().optional(),
});
export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequestSchema>;

// DELETE /credentials/:id — outside the POST/PUT/PATCH boot gate, but typed
// anyway: a non-string password used to reach bcrypt.compareSync and 500.
// Optional keeps the missing-password 401 a service rule.
export const passkeyDeleteRequestSchema = z.object({
  password: z.string().optional(),
});
export type PasskeyDeleteRequest = z.infer<typeof passkeyDeleteRequestSchema>;
