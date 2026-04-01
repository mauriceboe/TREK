# TREK Security & Code Quality Audit

**Date:** 2026-03-30
**Auditor:** Automated comprehensive audit
**Scope:** Full codebase — server, client, infrastructure, dependencies

---

## Table of Contents

1. [Security](#1-security)
2. [Code Quality](#2-code-quality)
3. [Best Practices](#3-best-practices)
4. [Dependency Hygiene](#4-dependency-hygiene)
5. [Documentation & DX](#5-documentation--dx)
6. [Testing](#6-testing)
7. [Remediation Summary](#7-remediation-summary)

---

## 1. Security

### 1.1 General

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| S-1 | **CRITICAL** | `server/src/middleware/auth.ts` | 17 | JWT `verify()` does not pin algorithm — accepts whatever algorithm is in the token header, potentially including `none`. | Pass `{ algorithms: ['HS256'] }` to all `jwt.verify()` calls. | FIXED |
| S-2 | **HIGH** | `server/src/websocket.ts` | 56 | Same JWT verify without algorithm pinning in WebSocket auth. | Pin algorithm to HS256. | FIXED |
| S-3 | **HIGH** | `server/src/middleware/mfaPolicy.ts` | 54 | Same JWT verify without algorithm pinning. | Pin algorithm to HS256. | FIXED |
| S-4 | **HIGH** | `server/src/routes/oidc.ts` | 84-88 | OIDC `generateToken()` includes excessive claims (username, email, role) in JWT payload. If the JWT is leaked, this exposes PII. | Only include `{ id: user.id }` in token, consistent with auth.ts. | FIXED |
| S-5 | **HIGH** | `client/src/api/websocket.ts` | 27 | Auth token passed in WebSocket URL query string (`?token=`). Tokens in URLs appear in server logs, proxy logs, and browser history. | Document as known limitation; WebSocket protocol doesn't easily support headers from browsers. Add `LOW` priority note to switch to message-based auth in the future. | DOCUMENTED |
| S-6 | **HIGH** | `client/vite.config.js` | 47-56 | Service worker caches ALL `/api/.*` responses with `NetworkFirst`, including auth tokens, user data, budget, reservations. Data persists after logout. | Exclude sensitive API paths from caching: `/api/auth/.*`, `/api/admin/.*`, `/api/backup/.*`. | FIXED |
| S-7 | **HIGH** | `client/vite.config.js` | 57-65 | User-uploaded files (possibly passport scans, booking confirmations) cached with `CacheFirst` for 30 days, persisting after logout. | Reduce cache lifetime; add note about clearing on logout. | FIXED |
| S-8 | **MEDIUM** | `server/src/index.ts` | 60 | CSP allows `'unsafe-inline'` for scripts, weakening XSS protection. | Remove `'unsafe-inline'` from `scriptSrc` if Vite build doesn't require it. If needed for development, only allow in non-production. | FIXED |
| S-9 | **MEDIUM** | `server/src/index.ts` | 64 | CSP `connectSrc` allows `http:` and `https:` broadly, permitting connections to any origin. | Restrict to known API domains (nominatim, overpass, Google APIs) or use `'self'` with specific external origins. | FIXED |
| S-10 | **MEDIUM** | `server/src/index.ts` | 62 | CSP `imgSrc` allows `http:` broadly. | Restrict to `https:` and `'self'` plus known image domains. | FIXED |
| S-11 | **MEDIUM** | `server/src/websocket.ts` | 84-90 | No message size limit on WebSocket messages. A malicious client could send very large messages to exhaust server memory. | Set `maxPayload` on WebSocketServer configuration. | FIXED |
| S-12 | **MEDIUM** | `server/src/websocket.ts` | 84 | No rate limiting on WebSocket messages. A client can flood the server with join/leave messages. | Add per-connection message rate limiting. | FIXED |
| S-13 | **MEDIUM** | `server/src/websocket.ts` | 29 | No origin validation on WebSocket connections. | Add origin checking against allowed origins. | FIXED |
| S-14 | **MEDIUM** | `server/src/routes/auth.ts` | 157-163 | JWT tokens have 24h expiry with no refresh token mechanism. Long-lived tokens increase window of exposure if leaked. | Document as accepted risk for self-hosted app. Consider refresh tokens in future. | DOCUMENTED |
| S-15 | **MEDIUM** | `server/src/routes/auth.ts` | 367-368 | Password change does not invalidate existing JWT tokens. Old tokens remain valid for up to 24h. | Implement token version/generation tracking, or reduce token expiry and add refresh tokens. | REQUIRES MANUAL REVIEW |
| S-16 | **MEDIUM** | `server/src/services/mfaCrypto.ts` | 2, 5 | MFA encryption key is derived from JWT_SECRET. If JWT_SECRET is compromised, all MFA secrets are also compromised. Single point of failure. | Use a separate MFA_ENCRYPTION_KEY env var, or derive using a different salt/purpose. Current implementation with `:mfa:v1` salt is acceptable but tightly coupled. | DOCUMENTED |
| S-17 | **MEDIUM** | `server/src/routes/maps.ts` | 429 | Google API key exposed in URL query string (`&key=${apiKey}`). Could appear in logs. | Use header-based auth (X-Goog-Api-Key) consistently. Already used elsewhere in the file. | FIXED |
| S-18 | **MEDIUM** | `MCP.md` | 232-235 | Contains publicly accessible database download link with hardcoded credentials (`admin@admin.com` / `admin123`). | Remove credentials from documentation. | FIXED |
| S-19 | **LOW** | `server/src/index.ts` | 229 | Error handler logs full error object including stack trace to console. In containerized deployments, this could leak to centralized logging. | Sanitize error logging in production. | FIXED |
| S-20 | **LOW** | `server/src/routes/backup.ts` | 301-304 | Error detail leaked in non-production environments (`detail: process.env.NODE_ENV !== 'production' ? msg : undefined`). | Acceptable for dev, but ensure it's consistently not leaked in production. Already correct. | OK |

### 1.2 Auth (JWT + OIDC + TOTP)

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| A-1 | **CRITICAL** | All jwt.verify calls | Multiple | JWT algorithm not pinned. `jsonwebtoken` library defaults to accepting the algorithm specified in the token header, which could include `none`. | Add `{ algorithms: ['HS256'] }` to every `jwt.verify()` call. | FIXED |
| A-2 | **MEDIUM** | `server/src/routes/auth.ts` | 315-318 | MFA login token uses same JWT_SECRET and same `jwt.sign()`. Purpose field `mfa_login` prevents misuse but should use a shorter expiry. Currently 5m which is acceptable. | OK — 5 minute expiry is reasonable. | OK |
| A-3 | **MEDIUM** | `server/src/routes/oidc.ts` | 113-143 | OIDC redirect URI is dynamically constructed from request headers (`x-forwarded-proto`, `x-forwarded-host`). An attacker who can control these headers could redirect the callback to a malicious domain. | Validate the constructed redirect URI against an allowlist, or use a configured base URL from env vars. | FIXED |
| A-4 | **LOW** | `server/src/routes/auth.ts` | 21 | TOTP `window: 1` allows codes from adjacent time periods (±30s). This is standard and acceptable. | OK | OK |

### 1.3 SQLite (better-sqlite3)

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| D-1 | **HIGH** | `server/src/routes/files.ts` | 90-91 | Dynamic SQL with `IN (${placeholders})` — however, placeholders are correctly generated from array length and values are parameterized. **Not an injection risk.** | OK — pattern is safe. | OK |
| D-2 | **MEDIUM** | `server/src/routes/auth.ts` | 455 | Dynamic SQL `UPDATE users SET ${updates.join(', ')} WHERE id = ?` — column names come from controlled server-side code, not user input. Parameters are properly bound. | OK — column names are from a controlled set. | OK |
| D-3 | **LOW** | `server/src/db/database.ts` | 26-28 | WAL mode and busy_timeout configured. Good. | OK | OK |

### 1.4 WebSocket (ws)

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| W-1 | **MEDIUM** | `server/src/websocket.ts` | 29 | No `maxPayload` set on WebSocketServer. Default is 100MB which is excessive. | Set `maxPayload: 64 * 1024` (64KB). | FIXED |
| W-2 | **MEDIUM** | `server/src/websocket.ts` | 84-110 | Only `join` and `leave` message types are handled; unknown types are silently ignored. This is acceptable but there is no schema validation on the message structure. | Add basic type/schema validation using Zod. | FIXED |
| W-3 | **LOW** | `server/src/websocket.ts` | 88 | `JSON.parse` errors are silently caught with empty catch. | Log malformed messages at debug level. | FIXED |

### 1.5 Express

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| E-1 | **LOW** | `server/src/index.ts` | 82 | Body parser limit set to 100KB. Good. | OK | OK |
| E-2 | **LOW** | `server/src/index.ts` | 14-16 | Trust proxy configured conditionally. Good. | OK | OK |
| E-3 | **LOW** | `server/src/index.ts` | 121-136 | Path traversal protection on uploads endpoint. Uses `path.basename` and `path.resolve` check. Good. | OK | OK |

### 1.6 PWA / Workbox

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| P-1 | **HIGH** | `client/vite.config.js` | 47-56 | API response caching includes sensitive endpoints. | Exclude auth, admin, backup, and settings endpoints from caching. | FIXED |
| P-2 | **MEDIUM** | `client/vite.config.js` | 23, 31, 42, 54, 63 | `cacheableResponse: { statuses: [0, 200] }` — status 0 represents opaque responses which may cache error responses silently. | Remove status 0 from API and upload caches (keep for CDN/map tiles where CORS may return opaque responses). | FIXED |
| P-3 | **MEDIUM** | `client/src/store/authStore.ts` | 126-135 | Logout does not clear service worker caches. Sensitive data persists after logout. | Clear CacheStorage for `api-data` and `user-uploads` caches on logout. | FIXED |

---

## 2. Code Quality

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| Q-1 | **MEDIUM** | `client/src/store/authStore.ts` | 153-161 | `loadUser` silently catches all errors and logs user out. A transient network failure logs the user out. | Only logout on 401 responses, not on network errors. | FIXED |
| Q-2 | **MEDIUM** | `client/src/hooks/useRouteCalculation.ts` | 36 | `useCallback` depends on entire `tripStore` object, defeating memoization. | Select only needed properties from the store. | DOCUMENTED |
| Q-3 | **MEDIUM** | `client/src/hooks/useTripWebSocket.ts` | 14 | `collabFileSync` captures stale `tripStore` reference from initial render. | Use `useTripStore.getState()` instead. | DOCUMENTED |
| Q-4 | **MEDIUM** | `client/src/store/authStore.ts` | 38 vs 105 | `register` function accepts 4 params but TypeScript interface only declares 3. | Update interface to include optional `invite_token`. | FIXED |
| Q-5 | **LOW** | `client/src/store/slices/filesSlice.ts` | — | Empty catch block on file link operation (`catch {}`). | Log error. | DOCUMENTED |
| Q-6 | **LOW** | `client/src/App.tsx` | 101, 108 | Empty catch blocks silently swallow errors. | Add minimal error logging. | DOCUMENTED |
| Q-7 | **LOW** | `client/src/App.tsx` | 155 | `RegisterPage` imported but never used — `/register` route renders `LoginPage`. | Remove unused import. | FIXED |
| Q-8 | **LOW** | `client/tsconfig.json` | 14 | `strict: false` disables TypeScript strict mode. | Enable strict mode and fix resulting type errors. | REQUIRES MANUAL REVIEW |
| Q-9 | **LOW** | `client/src/main.tsx` | 7 | Non-null assertion on `getElementById('root')!`. | Add null check. | DOCUMENTED |
| Q-10 | **LOW** | `server/src/routes/files.ts` | 278 | Empty catch block on file link insert (`catch {}`). | Log duplicate link errors. | FIXED |
| Q-11 | **LOW** | `server/src/db/database.ts` | 20-21 | Silent catch on WAL checkpoint in `initDb`. | Log warning on failure. | DOCUMENTED |

---

## 3. Best Practices

### 3.1 Node / Express

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| B-1 | **LOW** | `server/src/index.ts` | 251-271 | Graceful shutdown implemented with SIGTERM/SIGINT handlers. Good — closes DB, HTTP server, with 10s timeout. | OK | OK |
| B-2 | **LOW** | `server/src/index.ts` | 87-112 | Debug logging redacts sensitive fields. Good. | OK | OK |

### 3.2 React / Vite

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| V-1 | **MEDIUM** | `client/vite.config.js` | — | No explicit `build.sourcemap: false` for production. Source maps may be generated. | Add `build: { sourcemap: false }` to Vite config. | FIXED |
| V-2 | **LOW** | `client/index.html` | 24 | Leaflet CSS loaded from unpkg CDN without Subresource Integrity (SRI) hash. | Add `integrity` and `crossorigin` attributes. | FIXED |

### 3.3 Docker

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| K-1 | **MEDIUM** | `Dockerfile` | 2, 10 | Base images use floating tags (`node:22-alpine`), not pinned to digest. | Pin to specific digest for reproducible builds. | DOCUMENTED |
| K-2 | **MEDIUM** | `Dockerfile` | — | No `HEALTHCHECK` instruction. Only docker-compose has health check. | Add `HEALTHCHECK` to Dockerfile for standalone deployments. | FIXED |
| K-3 | **LOW** | `.dockerignore` | — | Missing exclusions for `chart/`, `docs/`, `.github/`, `docker-compose.yml`, `*.sqlite*`. | Add missing exclusions. | FIXED |

### 3.4 docker-compose.yml

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| C-1 | **HIGH** | `docker-compose.yml` | 25 | `JWT_SECRET` defaults to empty string if not set. App auto-generates one, but it changes on restart, invalidating all sessions. | Log a prominent warning on startup if JWT_SECRET is auto-generated. | FIXED |
| C-2 | **MEDIUM** | `docker-compose.yml` | — | No resource limits defined for the `app` service. | Add `deploy.resources.limits` section. | DOCUMENTED |

### 3.5 Git Hygiene

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| G-1 | **HIGH** | `.gitignore` | 12-14 | Missing `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` patterns. Only `*.db` variants covered. | Add sqlite patterns. | FIXED |
| G-2 | **LOW** | — | — | No `.env` or `.sqlite` files found in git history. | OK | OK |

### 3.6 Helm Chart

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| H-1 | **MEDIUM** | `chart/templates/secret.yaml` | 22 | `randAlphaNum 32` generates a new JWT secret on every `helm upgrade`, invalidating all sessions. | Use `lookup` to preserve existing secret across upgrades. | FIXED |
| H-2 | **MEDIUM** | `chart/values.yaml` | 3 | Default image tag is `latest`. | Use a specific version tag. | DOCUMENTED |
| H-3 | **MEDIUM** | `chart/templates/deployment.yaml` | — | No `securityContext` on pod or container. Runs as root by default. | Add `runAsNonRoot: true`, `runAsUser: 1000`. | FIXED |
| H-4 | **MEDIUM** | `chart/templates/pvc.yaml` | — | PVC always created regardless of `.Values.persistence.enabled`. | Add conditional check. | FIXED |
| H-5 | **LOW** | `chart/values.yaml` | 41 | `resources: {}` — no default resource requests or limits. | Add sensible defaults. | FIXED |

---

## 4. Dependency Hygiene

### 4.1 npm audit

| Package | Severity | Description | Status |
|---------|----------|-------------|--------|
| `serialize-javascript` (via vite-plugin-pwa → workbox-build → @rollup/plugin-terser) | **HIGH** | RCE via RegExp.flags / CPU exhaustion DoS | Fix requires `vite-plugin-pwa` major version upgrade. | DOCUMENTED |
| `picomatch` (via @rollup/pluginutils, tinyglobby) | **MODERATE** | ReDoS via extglob quantifiers | `npm audit fix` available. | FIXED |

**Server:** 0 vulnerabilities.

### 4.2 Outdated Dependencies (Notable)

| Package | Current | Latest | Risk | Status |
|---------|---------|--------|------|--------|
| `express` | ^4.18.3 | 5.2.1 | Major version — breaking changes | DOCUMENTED |
| `uuid` | ^9.0.0 | 13.0.0 | Major version | DOCUMENTED |
| `dotenv` | ^16.4.1 | 17.3.1 | Major version | DOCUMENTED |
| `lucide-react` | ^0.344.0 | 1.7.0 | Major version | DOCUMENTED |
| `react` | ^18.2.0 | 19.2.4 | Major version | DOCUMENTED |
| `zustand` | ^4.5.2 | 5.0.12 | Major version | DOCUMENTED |

> Major version upgrades require manual evaluation and testing. Not applied in this remediation pass.

---

## 5. Documentation & DX

| # | Severity | File | Description | Recommended Fix | Status |
|---|----------|------|-------------|-----------------|--------|
| X-1 | **MEDIUM** | `server/.env.example` | Missing many env vars documented in README: `OIDC_*`, `FORCE_HTTPS`, `TRUST_PROXY`, `DEMO_MODE`, `TZ`, `ALLOWED_ORIGINS`, `DEBUG`. | Add all configurable env vars. | FIXED |
| X-2 | **MEDIUM** | `server/.env.example` | JWT_SECRET placeholder is `your-super-secret-jwt-key-change-in-production` — easily overlooked. | Use `CHANGEME_GENERATE_WITH_openssl_rand_hex_32`. | FIXED |
| X-3 | **LOW** | `server/.env.example` | `PORT=3001` differs from Docker default of `3000`. | Align to `3000`. | FIXED |

---

## 6. Testing

| # | Severity | Description | Status |
|---|----------|-------------|--------|
| T-1 | **HIGH** | No test files found anywhere in the repository. Zero test coverage for auth flows, WebSocket handling, SQLite queries, API routes, or React components. | REQUIRES MANUAL REVIEW |
| T-2 | **HIGH** | No test framework configured (no jest, vitest, or similar in dependencies). | REQUIRES MANUAL REVIEW |
| T-3 | **MEDIUM** | No CI step runs tests before building Docker image. | DOCUMENTED |

---

## 7. Remediation Summary

### Applied Fixes

- **Immich SSRF prevention** — Added URL validation on save (block private IPs, metadata endpoints, non-HTTP protocols)
- **Immich API key isolation** — Removed `userId` query parameter from asset proxy endpoints; all Immich requests now use authenticated user's own credentials only
- **Immich asset ID validation** — Added alphanumeric pattern validation to prevent path traversal in proxied URLs
- **JWT algorithm pinning** — Added `{ algorithms: ['HS256'] }` to all `jwt.verify()` calls (auth middleware, MFA policy, WebSocket, OIDC, auth routes)
- **OIDC token payload** — Reduced to `{ id }` only, matching auth.ts pattern
- **OIDC redirect URI validation** — Validates against `APP_URL` env var when set
- **WebSocket hardening** — Added `maxPayload: 64KB`, message rate limiting (30 msg/10s), origin validation, improved message validation
- **CSP tightening** — Removed `'unsafe-inline'` from scripts in production, restricted `connectSrc` and `imgSrc` to known domains
- **PWA cache security** — Excluded sensitive API paths from caching, removed opaque response caching for API/uploads, clear caches on logout
- **Service worker cache cleanup on logout**
- **Google API key** — Moved from URL query string to header in maps photo endpoint
- **MCP.md credentials** — Removed hardcoded demo credentials
- **.gitignore** — Added `*.sqlite*` patterns
- **.dockerignore** — Added missing exclusions
- **Dockerfile** — Added HEALTHCHECK instruction
- **Helm chart** — Fixed secret rotation, added securityContext, conditional PVC, resource defaults
- **Vite config** — Disabled source maps in production
- **CDN integrity** — Added SRI hash for Leaflet CSS
- **.env.example** — Complete with all env vars
- **Various code quality fixes** — Removed dead imports, fixed empty catch blocks, fixed auth store interface

### Requires Manual Review

- Password change should invalidate existing tokens (S-15)
- TypeScript strict mode should be enabled (Q-8)
- Test suite needs to be created from scratch (T-1, T-2)
- Major dependency upgrades (express 5, React 19, zustand 5, etc.)
- `serialize-javascript` vulnerability fix requires vite-plugin-pwa major upgrade

### 1.7 Immich Integration

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| I-1 | **CRITICAL** | `server/src/routes/immich.ts` | 38-39, 85, 199, 250, 274 | SSRF via user-controlled `immich_url`. Users can set any URL which is then used in `fetch()` calls, allowing requests to internal metadata endpoints (169.254.169.254), localhost services, etc. | Validate URL on save: require HTTP(S) protocol, block private/internal IPs. | FIXED |
| I-2 | **CRITICAL** | `server/src/routes/immich.ts` | 194-196, 244-246, 269-270 | Asset info/thumbnail/original endpoints accept `userId` query param, allowing any authenticated user to proxy requests through another user's Immich API key. This exposes other users' Immich credentials and photo libraries. | Restrict all Immich proxy endpoints to the authenticated user's own credentials only. | FIXED |
| I-3 | **MEDIUM** | `server/src/routes/immich.ts` | 199, 250, 274 | `assetId` URL parameter used directly in `fetch()` URL construction. Path traversal characters could redirect requests to unintended Immich API endpoints. | Validate assetId matches `[a-zA-Z0-9_-]+` pattern. | FIXED |

### 1.8 Admin Routes

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| AD-1 | **MEDIUM** | `server/src/routes/admin.ts` | 302-310 | Self-update endpoint runs `git pull` then `npm run build`. While admin-only and `npm install` uses `--ignore-scripts`, `npm run build` executes whatever is in the pulled package.json. A compromised upstream could execute arbitrary code. | Document as accepted risk for self-hosted self-update feature. Users should pin to specific versions. | DOCUMENTED |

### 1.9 Client-Side XSS

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| X-1 | **CRITICAL** | `client/src/components/Admin/GitHubPanel.tsx` | 66, 106 | `dangerouslySetInnerHTML` with `inlineFormat()` renders GitHub release notes as HTML without escaping. Malicious HTML in release notes could execute scripts. | Escape HTML entities before applying markdown-style formatting. Validate link URLs. | FIXED |
| X-2 | **LOW** | `client/src/components/Map/MapView.tsx` | divIcon | Uses `escAttr()` for HTML sanitization in divIcon strings. Properly mitigated. | OK | OK |

### 1.10 Route Calculator Bug

| # | Severity | File | Line(s) | Description | Recommended Fix | Status |
|---|----------|------|---------|-------------|-----------------|--------|
| RC-1 | **HIGH** | `client/src/components/Map/RouteCalculator.ts` | 16 | OSRM URL hardcodes `'driving'` profile, ignoring the `profile` parameter. Walking/cycling routes always return driving results. | Use the `profile` parameter in URL construction. | FIXED |

### Additional Findings (from exhaustive scan)

- **MEDIUM** — `server/src/index.ts:121-136`: Upload files (`/uploads/:type/:filename`) served without authentication. UUIDs are unguessable but this is security-through-obscurity. **REQUIRES MANUAL REVIEW** — adding auth would break shared trip image URLs.
- **MEDIUM** — `server/src/routes/oidc.ts:194`: OIDC token exchange error was logging full token response (potentially including access tokens). **FIXED** — now logs only HTTP status.
- **MEDIUM** — `server/src/services/notifications.ts:194-196`: Email body is not HTML-escaped. User-generated content (trip names, usernames) interpolated directly into HTML email template. Potential stored XSS in email clients. **DOCUMENTED** — needs HTML entity escaping.
- **LOW** — `server/src/demo/demo-seed.ts:7-9`: Hardcoded demo credentials (`demo12345`, `admin12345`). Intentional for demo mode but dangerous if DEMO_MODE accidentally left on in production. Already has startup warning.
- **LOW** — `server/src/routes/auth.ts:742`: MFA setup returns plaintext TOTP secret to client. This is standard TOTP enrollment flow — users need the secret for manual entry. Must be served over HTTPS.
- **LOW** — `server/src/routes/auth.ts:473`: Admin settings GET returns API keys in full (not masked). Only accessible to admins.
- **LOW** — `server/src/routes/auth.ts:564`: SMTP password stored as plaintext in `app_settings` table. Masked in API response but unencrypted at rest.

### Accepted Risks (Documented)

- WebSocket token in URL query string (browser limitation)
- 24h JWT expiry without refresh tokens (acceptable for self-hosted)
- MFA encryption key derived from JWT_SECRET (noted coupling)
- localStorage for token storage (standard SPA pattern)
- Upload files served without auth (UUID-based obscurity, needed for shared trips)
