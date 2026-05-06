# Troubleshooting

## "Access token required" when changing password on first login

**Cause:** The session cookie has the `Secure` flag set, which means the browser will only send it over HTTPS. When accessing TREK over plain HTTP (e.g. `http://192.168.1.x:3000`), the browser silently drops the cookie and the server sees no session — returning "Access token required".

**Fix:** Choose one of the following options:

**Option 1 — Use HTTPS.** Access TREK via HTTPS with a valid SSL certificate.

**Option 2 — Disable the Secure flag.** Set `COOKIE_SECURE=false` in your Docker environment to allow the session cookie to be sent over plain HTTP:

```yaml
environment:
  - COOKIE_SECURE=false
```

> **Note:** Option 2 is only recommended for internal/home-lab deployments that do not use HTTPS. Do not use it on a publicly accessible instance. See [Environment Variables](Environment-Variables).

---

## WebSocket not connecting / real-time sync broken

**Cause:** Your reverse proxy is not forwarding WebSocket upgrade headers on the `/ws` path.

**Fix:** Add the following to your proxy config for the `/ws` location:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Without these headers, the WebSocket handshake fails and real-time sync will not work. See [Reverse Proxy](Reverse-Proxy) for a complete nginx and Caddy configuration. Caddy handles WebSocket upgrades automatically.

---

## HTTPS redirect loop

**Cause:** `FORCE_HTTPS=true` is set but your reverse proxy is not forwarding the `X-Forwarded-Proto: https` header, so every request looks like plain HTTP and gets redirected indefinitely.

**Fix:** Ensure your proxy passes the `X-Forwarded-Proto` header to TREK. Also set `TRUST_PROXY=1` so that Express uses the forwarded IP for rate limiting and audit logs:

```yaml
environment:
  - FORCE_HTTPS=true
  - TRUST_PROXY=1
```

> **Note:** The `/api/health` endpoint is always exempt from the HTTPS redirect so that Docker health checks continue to work over plain HTTP.

If you are accessing TREK directly on `http://<host>:3000` with no proxy, remove `FORCE_HTTPS` entirely. See [Environment Variables](Environment-Variables).

---

## Encrypted settings lost / API keys not working after migration

**Cause:** The `ENCRYPTION_KEY` was changed or lost. All API keys, SMTP passwords, OIDC client secrets, and MFA TOTP secrets are encrypted at rest using this key. Without the original key, decryption fails.

**Fix:** See [Encryption Key Rotation](Encryption-Key-Rotation) for the migration script that re-encrypts data under a new key. If the original key is gone entirely, the encrypted values are unrecoverable and must be re-entered in the admin panel.

> **Note:** If you upgraded from an older version without setting `ENCRYPTION_KEY`, the server uses the following resolution order on startup: (1) `ENCRYPTION_KEY` env var, (2) `data/.encryption_key` file, (3) one-time fallback to `data/.jwt_secret` for legacy upgrades — the value is immediately written to `data/.encryption_key` so JWT rotation cannot break decryption later, (4) auto-generated fresh key for brand-new installs. Check `data/.encryption_key` for the key currently in use.

---

## Locked out of MFA / lost authenticator

**Fix:** If you still have access to your account, use one of the 10 backup codes generated during MFA setup to complete login. After signing in, go to **Settings > Security** to disable or reconfigure MFA.

If you no longer have access to backup codes and cannot log in, an admin must disable MFA for your account directly in the database, or use the `reset-admin.js` script to regain access to an admin account. There is no per-user MFA reset in the Admin Panel UI — the Admin Panel only controls the global "require MFA for all users" policy. See [Admin: Users and Invites](Admin-Users-and-Invites).

---

## Demo user cannot edit or create

**Cause:** The instance is running with `DEMO_MODE=true`. All write operations are blocked for the demo account by design.

**Fix:** This is intentional behavior for public demo deployments. If you are self-hosting and want full access, remove the `DEMO_MODE` variable (or set it to `false`). See [Demo Mode](Demo-Mode).

---

## Backup restore fails with "file too large"

**Cause:** Your reverse proxy has a default body size limit (commonly 1 MB or 10 MB) that is smaller than the backup ZIP. Backup archives include the full uploads directory and can be large.

**Fix:** Raise the body size limit in your proxy config. TREK's own backup upload cap is 500 MB. For nginx:

```nginx
client_max_body_size 500m;
```

Add this to the `location /` block (or the specific backup route). See [Reverse Proxy](Reverse-Proxy) and [Backups](Backups).

---

## "Cannot find module" on startup

**Likely cause:** A Docker volume mount is missing or the `/app/data` and `/app/uploads` directories are not writable by the container process. TREK automatically creates all required subdirectories on startup (`data/logs`, `data/backups`, `data/tmp`, `uploads/files`, `uploads/covers`, `uploads/avatars`, `uploads/photos`) — if this fails because the volume is read-only or owned by the wrong user, startup will abort.

**Fix:** Check your Docker volume configuration. Both `./data:/app/data` and `./uploads:/app/uploads` must be mounted and writable. Run `docker inspect <container> --format '{{json .Mounts}}'` to verify the mounts are present and point to valid host paths. If the host directories are owned by root, the container's `chown` step (which runs as root before dropping to `node`) should correct permissions automatically — but if your host filesystem is read-only or permissions are locked down, grant write access manually:

```bash
sudo chown -R 1000:1000 ./data ./uploads
```

---

## Encryption key regenerated on restart — stored secrets stop working

**Cause:** On every startup, TREK resolves its encryption key in this order: (1) `ENCRYPTION_KEY` env var, (2) `data/.encryption_key` file, (3) legacy `data/.jwt_secret` fallback, (4) auto-generate a fresh key. If neither the env var nor the `data/` volume is persisted — for example after recreating a container without a volume mount — a new random key is generated and all stored secrets (SMTP password, OIDC client secret, API keys, MFA TOTP seeds) become unrecoverable.

**Fix:** Ensure `./data:/app/data` is mounted as a persistent volume so `data/.encryption_key` survives restarts. Alternatively, pin the key explicitly:

```yaml
environment:
  - ENCRYPTION_KEY=<your-key>
```

See [Encryption Key Rotation](Encryption-Key-Rotation) for how to retrieve or rotate the key.

---

## OIDC login returns "APP_URL is not configured"

**Cause:** When OIDC is enabled, TREK needs to know its own public URL to build the redirect URI. It resolves this from (1) `APP_URL` env var, (2) the first entry in `ALLOWED_ORIGINS`, (3) `http://localhost:<PORT>` as a last resort. If none of these are set and the request is not coming from localhost, TREK returns a 500 error.

**Fix:** Set `APP_URL` to the public URL of your instance:

```yaml
environment:
  - APP_URL=https://trek.example.com
```

---

## OIDC login fails with issuer mismatch

**Cause:** TREK validates that the `issuer` field in the provider's discovery document exactly matches the configured `OIDC_ISSUER`. A trailing-slash difference (e.g. `https://auth.example.com` vs `https://auth.example.com/`) is enough to fail.

**Fix:** Check the exact issuer value your provider advertises and match it:

```bash
curl -s https://<your-oidc-issuer>/.well-known/openid-configuration | jq .issuer
```

Set `OIDC_ISSUER` to that exact string.

---

## OIDC login fails when provider is on a private/internal network

**Cause:** TREK's SSRF guard blocks outbound requests to private IP ranges by default. If your OIDC provider (e.g. Keycloak, Authentik) is running on an internal address, the discovery document fetch will be blocked with: `Requests to private/internal network addresses are not allowed.`

**Fix:**

```yaml
environment:
  - ALLOW_INTERNAL_NETWORK=true
```

---

## Password reset emails are not delivered / SMTP is silent

**Cause:** SMTP failures are logged but do not surface as errors to the end user — the "reset email sent" message appears regardless. Common causes: wrong `SMTP_HOST` or `SMTP_PORT`, bad credentials, firewall blocking outbound on the SMTP port, or a self-signed certificate on the SMTP server.

**Fix:**

1. Check server logs for `Email send failed`:
   ```bash
   docker logs <container> 2>&1 | grep "Email send failed"
   ```
2. If the error mentions TLS or certificate, set `SMTP_SKIP_TLS_VERIFY=true`.
3. Verify the port: `587` for STARTTLS, `465` for implicit TLS, `25` for plain SMTP.
4. Test connectivity from the container:
   ```bash
   docker exec <container> nc -zv <SMTP_HOST> <SMTP_PORT>
   ```

> **Note:** If no SMTP is configured at all, TREK prints the reset link directly to the server logs (`===== PASSWORD RESET LINK =====`). This is useful for initial setup or self-hosted installs without email.

---

## CORS error — API requests blocked in the browser

**Cause:** If `ALLOWED_ORIGINS` is set, only those origins are permitted. Any request from a different origin is rejected with a CORS error visible in the browser console.

**Fix:** Add your origin to the comma-separated list:

```yaml
environment:
  - ALLOWED_ORIGINS=https://trek.example.com,https://other.example.com
```

If `ALLOWED_ORIGINS` is not set, TREK allows all origins (development default). See [Environment Variables](Environment-Variables).

---

## WebSocket closes immediately after connecting (codes 4001 / 4403)

**Cause:** The `/ws` endpoint requires an ephemeral token generated by the client immediately before connecting. If the token is missing, expired, or the user's session state changed, the server closes the connection with a specific code:

| Code | Reason |
|------|--------|
| `4001` | No token, expired/invalid token, or user not found — re-login required |
| `4403` | MFA is required globally but the user has not enabled it |

**Fix:**

- Code `4001`: Log out and log back in. If it persists, check that your reverse proxy is not stripping the `token` query parameter from the WebSocket upgrade request.
- Code `4403`: The user must enable MFA in **Settings > Security**, or an admin can disable the global MFA requirement in **Admin > Settings**.

---

## Clipboard features not working (copy link, share, etc.)

**Cause:** The browser Clipboard API (`navigator.clipboard`) is only available in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). When accessing TREK over plain HTTP on a non-localhost address, the API is unavailable and clipboard operations silently fail or show an error.

**Fix:** The only supported options are:

- Access TREK over HTTPS with a valid SSL certificate.
- Access TREK directly from `http://localhost:<port>` — browsers treat `localhost` as a secure context for the Clipboard API (unlike the session cookie, which always requires HTTPS regardless of hostname).

---

## MCP OAuth flow does not initiate / "Connect" redirects but authentication never starts

**Cause:** TREK builds the OAuth 2.1 redirect URI from `APP_URL`. If `APP_URL` is not set, the authorization URL is constructed from a localhost fallback that external clients (Claude.ai, Claude Desktop) cannot reach, so the OAuth handshake never completes.

**Fix:** Set `APP_URL` to the public URL of your instance:

```yaml
environment:
  - APP_URL=https://trek.example.com
```

Restart the container after adding the variable. Once set, clicking **Connect** in the MCP client should redirect to your TREK instance and complete the OAuth flow normally.

> **Note:** `APP_URL` is required for any MCP OAuth integration. Without it, the authorization endpoint resolves to `http://localhost:<PORT>`, which is unreachable from external MCP clients.

---

## MCP integration: "Too many requests" or "Session limit reached"

**Cause:** Each user is limited to 300 MCP requests per minute and 20 concurrent sessions by default. Exceeding either limit returns a `429` response.

**Fix:** Increase the limits via environment variables:

```yaml
environment:
  - MCP_RATE_LIMIT=600          # requests per minute per user (default: 300)
  - MCP_MAX_SESSION_PER_USER=50 # concurrent sessions per user (default: 20)
```

---

## MCP requests blocked by Cloudflare WAF (Bot Fight Mode)

**Cause:** When TREK is proxied through Cloudflare, **Bot Fight Mode** and **Super Bot Fight Mode** classify requests from ChatGPT as bots and block them at the WAF level — before the request ever reaches TREK. This is specific to ChatGPT; Claude.ai is not affected. ChatGPT's exit node IPs have low reputation scores in Cloudflare's threat intelligence and the User-Agent matches Cloudflare's automated-traffic heuristics. TREK itself never receives the request, so there is nothing in TREK's logs; the block is silent from TREK's perspective.

Symptoms:
- ChatGPT shows a connection error or times out immediately after OAuth completes.
- Cloudflare's Security → Events log shows blocked requests to `/mcp` with action `block` and source `bfm` (Bot Fight Mode) or `managed_rule`.

**Fix — Option 1: Disable Bot Fight Mode (free plan and paid plan)**

In the Cloudflare dashboard for your zone: **Security → Bots → Bot Fight Mode → Off** (or Super Bot Fight Mode → Off).

This is the only option available on the **free plan**. It disables bot blocking for the entire zone — all probe bots, scrapers, and crawlers that Cloudflare would otherwise block will reach your server. Only use this if you have no alternative.

**Fix — Option 2: WAF skip rule for MCP paths (paid plan only)**

> WAF custom rules require a **paid Cloudflare plan** (Pro or above). This option is not available on the free plan.

Create a WAF skip rule that bypasses bot management only for the MCP and OAuth paths, leaving protection in place for the rest of the site:

1. Go to **Security → WAF → Custom rules** and click **Create rule**.
2. Enter the following expression (replace `trek.example.com` with your domain):

   ```
   (http.host eq "trek.example.com") and (
     http.request.uri.path eq "/mcp" or
     http.request.uri.path starts_with "/oauth/" or
     http.request.uri.path starts_with "/.well-known/"
   )
   ```

   This covers all paths that ChatGPT's servers hit during discovery, OAuth, and MCP calls:

   | Path | Purpose |
   |---|---|
   | `/mcp` | MCP endpoint (GET, POST, DELETE) |
   | `/oauth/authorize` | OAuth authorization handler |
   | `/oauth/register` | Dynamic client registration |
   | `/oauth/token` | Token issuance |
   | `/oauth/userinfo` | User info (for domain claiming) |
   | `/oauth/revoke` | Token revocation |
   | `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
   | `/.well-known/oauth-protected-resource` | RFC 9728 flat resource metadata |
   | `/.well-known/openid-configuration` | OIDC discovery |

3. Set the action to **Skip** and check **Bot Fight Mode** (and/or **Super Bot Fight Mode**) under the skip options.
4. Save and deploy.

This allows MCP and OAuth traffic through while keeping Cloudflare bot protection active for all other paths.
