# app-config — TREK's environment configuration layer

One validated source of truth for every environment variable the server reads.
Framework-free (no Nest imports), so it is consumable from anywhere: Nest DI
classes, the legacy free-function services, mcp, websocket, scheduler, db and
the pre-init Express middleware.

```
env.schema.ts    Zod catalog of the whole env surface; fail-fast at boot
derive.ts        pure (raw env) → typed namespace functions, exact per-site coercions
env.ts           readEnv() live accessor + validateEnvAtBoot()
app-url.ts       getAppUrl()/getMcpSafeUrl() instance base-URL resolution
boot-validate.ts side-effect import used by index.ts (validates before other modules load)
parsers.ts       shared coercion helpers (boolTrueLoose, numberOr, csvList, …)
```

The Nest binding lives in `src/nest/app-config/` (`AppConfigModule`, registerAs
tokens, `RuntimeEnvService`) and consumes the SAME derive functions.

## Invariants — read before touching anything here

1. **`readEnv()` is live.** It re-derives from the current `process.env` on
   every call, with no caching or memoization, ever. ~60 test files mutate
   `process.env` at runtime and depend on the next read observing the change.
2. **Validation runs once, at boot, from the production entrypoint only.**
   Never wire the schema into `buildApp()`, `ConfigModule.forRoot({ validate })`
   or a request path. Unset/blank variables always pass (defaults apply); only
   present-but-malformed values abort startup. The one addition on top of the
   schema is `managedPreconditions()` in `env.ts`: cross-field rules that only
   apply with `TREK_MANAGED`, for combinations that are individually valid and
   together wrong. It is empty without the switch, so a self-hoster never meets
   it. Put a rule there only if booting anyway would be a security or data
   problem — not to enforce a preference.
3. **Parity is law — with one deliberate exception.** Every derived field pins
   the exact coercion of the call site(s) it replaced (`Number(x) || d`
   treating `"0"` as unset, per-site defaults for the same variable, …). Do not
   "fix" a quirk here; log it as a follow-up instead. The exception: **boolean
   switches are unified** through `parseBool` — every boolean-like variable
   accepts `true/1/on/yes` and `false/0/off/no` (any casing) and derives to a
   real boolean. This intentionally replaces the legacy per-site literals
   (`'true'` here, `'1'` there, `'on'` elsewhere); tests that pinned those
   narrow literals get updated when their call site migrates.
4. **Env vs DB-setting layering stays at the call site.** For
   `process.env.X || getSetting('x')` patterns, this layer supplies only the
   env half; the runtime-mutable admin-setting fallback remains inline where it
   was.
5. **Never convert a frozen read to a live read or vice versa.** Modules that
   captured env in module-top `const`s (mcp, backupService, ssrfGuard, plugin
   rate limits, …) keep freeze-at-import timing, merely sourcing the value from
   `readEnv()` at module top. Request-time reads stay request-time.

## app-url.ts — instance base-URL resolution (moved 2026-07-28)

`getAppUrl()` (APP_URL → first ALLOWED_ORIGINS entry → `http://localhost:PORT`,
each candidate URL-validated, ALL trailing slashes stripped) and
`getMcpSafeUrl()` (same, sanitized to HTTPS/localhost/127.0.0.1 for the MCP
SDK's issuer check) moved here **verbatim** from `services/notifications.ts`
(audit findings `auth-2`/`notifications-1`/`admin-3`/`mcp-1`). They follow
invariant 1: `readEnv()` per call, live, never cached. The invalid-URL silent
fallthrough and the strip-ALL-slashes quirk (see `parsers.ts`
`stripTrailingSlashes`) are parity-pinned — do not "fix" them here.

## Classification: boot-stable vs runtime-toggled

**Boot-stable** (frozen at app/module creation; snapshot `registerAs`/`ConfigType`
DI in Nest, module-top `readEnv()` consts elsewhere):
PORT, HOST, TRUST_PROXY, SESSION_DURATION(_REMEMBER), MCP_SESSION_TTL,
MCP_MAX_SESSION_PER_USER, MCP_SSE_KEEPALIVE, TREK_PLUGIN_RPC_*/LOG_*/MAX_RSS_MB,
TREK_PLUGIN_REGISTRY_URL, TREK_WIKI_DIR*, TREK_PLACE_PHOTO_DIR, BACKUP_*,
TRANSIT_API_URL, LOG_LEVEL*, ALLOW_INTERNAL_NETWORK*, DEFAULT_LANGUAGE,
TREK_DB_FILE, TREK_DB_JOURNAL_MODE, TREK_DB_SYNCHRONOUS, ENCRYPTION_KEY**.
(* frozen today because the consuming module captures it at import; tests that
override these set them at file top, before the SUT import.)
(** ENCRYPTION_KEY is boot-stable for the cipher key material itself —
`src/config.ts` resolves and freezes it at process start, per the exemption
below.)

**Runtime-toggled** (read live on every access via `readEnv()` /
`RuntimeEnvService`; tests mutate these mid-lifetime):
TREK_MANAGED, PLACES_API_BASE, PLACES_API_KEY, MAPBOX_ACCESS_TOKEN, CARTO_API_KEY, DEMO_MODE, NODE_ENV, APP_VERSION, APP_URL, TREK_API_DOCS_ENABLED,
TREK_PLUGINS_ENABLED / _DEV_LINK / _IGNORE_TREK_RANGE / _DIR / _DATA_DIR / TREK_PLUGIN_PERMISSIONS,
OIDC_*, SMTP_*, FORCE_HTTPS, COOKIE_SECURE, HSTS_INCLUDE_SUBDOMAINS,
ALLOWED_ORIGINS, UNSPLASH_ACCESS_KEY, WEBAUTHN_*, TZ, ADMIN_EMAIL,
ADMIN_PASSWORD, IDEMPOTENCY_TTL_SECONDS, MCP_RATE_LIMIT (request-path check),
LLM_TIMEOUT_MS.

## Exemptions — raw `process.env` stays

- `src/nest/plugins/runtime/plugin-host-entry.ts` — runs in a scrubbed child
  process; must not import this layer.
- `src/nest/plugins/supervisor/plugin-supervisor.ts` child-env whitelist block —
  the env there is an IPC channel to the sandbox, not app configuration.
- Dynamic-key reads (`process.env[name]`) in `plugins/host/daily-budget.ts` and
  `plugins/host/plugin-audit.ts`.
- `src/config.ts` ENCRYPTION_KEY/JWT_SECRET resolution — key material with file
  persistence and runtime rotation, not env config.
- Standalone scripts (`reset-admin.js`, `scripts/*`) and `tests/**`. Note that
  `reset-admin.js` and `scripts/migrate-encryption.ts` open the database file
  read-write and therefore re-implement `TREK_DB_JOURNAL_MODE` /
  `TREK_DB_SYNCHRONOUS` inline (the journal mode lives in the file header, so
  they must agree with the server). Neither can import this layer — the image
  ships `dist/`, not `src/` — so the defaults in `parsers.resolveDurability()`
  and in those two files move together.

The exemption list is enforced by the `no-restricted-syntax` ban on
`process.env` in `eslint.config.mjs` — keep the two lists in sync.

## Follow-up candidates (quirks pinned during the migration, deliberately NOT fixed)

- `numberOr` (`Number(x) || d`) treats `"0"` and negative-invalid values oddly:
  `PORT=0` silently becomes 3001, `TREK_PLUGIN_RPC_BURST=-5` stays -5.
- APP_URL trailing-slash stripping differs per site (feeds strips one slash,
  notifications strips all).
- `DEMO_ADMIN_EMAIL` defaults differ (demo-seed: admin@trek.app, demo-reset:
  admin@nomad.app).
- NODE_ENV comparisons are case-sensitive at some sites (HSTS activation,
  platform statics, spa-fallback, authService dev_mode, oidcService
  frontendUrl) and case-insensitive at others.
