# Environment Variables

Complete reference for all environment variables TREK reads.

## How to Set Variables

- **Docker Compose** — use the `environment:` block or a `.env` file alongside `docker-compose.yml`
- **Docker run** — pass each variable with `-e VARIABLE=value`
- **Helm** — use `env:` for plain values and `secretEnv:` for sensitive values in `values.yaml`
- **Unraid** — set in the container template editor

---

## Core

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (`production` / `development`) | `production` |
| `ENCRYPTION_KEY` | At-rest encryption key — see resolution order below | auto |
| `TZ` | Timezone for logs, reminders, and cron jobs (e.g. `Europe/Berlin`) | `UTC` |
| `LOG_LEVEL` | `info` = concise user actions; `debug` = verbose details | `info` |
| `DEFAULT_LANGUAGE` | Default language on the login page — see supported codes below | `en` |
| `ALLOWED_ORIGINS` | Comma-separated origins for CORS and email notification links | same-origin |
| `ALLOW_INTERNAL_NETWORK` | Allow outbound requests to private/RFC-1918 IPs. Set `true` if Immich or other integrated services are on your local network. Loopback (`127.x`) and link-local (`169.254.x`) addresses remain blocked regardless. | `false` |
| `APP_URL` | Public base URL (e.g. `https://trek.example.com`). Required when OIDC is enabled — must match the redirect URI registered with your IdP. Also used as the base URL for email notification links. | — |

### `ENCRYPTION_KEY` — Resolution Order

`server/src/config.ts` resolves the encryption key in this order:

1. **`ENCRYPTION_KEY` env var** — explicit value, always takes priority. Persisted to `data/.encryption_key` automatically.
2. **`data/.encryption_key` file** — present on any install that has started at least once.
3. **`data/.jwt_secret` file** — one-time fallback for existing installs upgrading without a pre-set key. The value is immediately persisted to `data/.encryption_key` so JWT rotation cannot break decryption later.
4. **Auto-generated** — fresh install with none of the above; persisted to `data/.encryption_key`.

Setting `ENCRYPTION_KEY` explicitly is recommended so you can back it up independently of the data volume.

### `DEFAULT_LANGUAGE` — Supported Codes

Verified in `server/src/config.ts` (line 107):

`de`, `en`, `es`, `fr`, `hu`, `nl`, `br`, `cs`, `pl`, `ru`, `zh`, `zh-TW`, `it`, `ar`, `ua`

> **Note:** `id` (Indonesian / Bahasa Indonesia) appears in `client/src/i18n/supportedLanguages.ts` but is not in the server's supported-codes list in `config.ts`. Setting `DEFAULT_LANGUAGE=id` will fall back to `en` with a warning in the server log.

---

## HTTPS / Proxy

These three variables work together behind a TLS-terminating reverse proxy. See [Reverse-Proxy](Reverse-Proxy) for the full explanation.

| Variable | Description | Default |
|---|---|---|
| `FORCE_HTTPS` | When `true`: 301-redirects HTTP→HTTPS, sends HSTS (`max-age=31536000`), adds CSP `upgrade-insecure-requests`, forces cookie `secure` flag. Only useful behind a TLS proxy. Requires `TRUST_PROXY`. | `false` |
| `HSTS_INCLUDE_SUBDOMAINS` | When `true`: adds the `includeSubDomains` directive to the HSTS header, extending HTTPS enforcement to all subdomains. Only effective when HSTS is active (`FORCE_HTTPS=true` or `NODE_ENV=production`). Leave `false` if you run other services on sibling subdomains over plain HTTP. | `false` |
| `TRUST_PROXY` | Number of trusted proxy hops. Tells Express to read the real client IP from `X-Forwarded-For` and protocol from `X-Forwarded-Proto`. Defaults to `1` automatically in production. Required for `FORCE_HTTPS` to detect the forwarded protocol. | `1` (production) |
| `COOKIE_SECURE` | Controls the `secure` flag on the `trek_session` cookie. Auto-derived as `true` when `NODE_ENV=production` or `FORCE_HTTPS=true`. Set to `false` only as an escape hatch for LAN testing without TLS — not recommended in production. | auto |

> **Warning:** `FORCE_HTTPS=true` without `TRUST_PROXY` set causes a redirect loop.

---

## OIDC / SSO

For setup instructions, see [OIDC-SSO](OIDC-SSO).

| Variable | Description | Default |
|---|---|---|
| `OIDC_ISSUER` | OpenID Connect provider URL (e.g. `https://auth.example.com`) | — |
| `OIDC_CLIENT_ID` | OIDC client ID | — |
| `OIDC_CLIENT_SECRET` | OIDC client secret | — |
| `OIDC_DISPLAY_NAME` | Label shown on the SSO login button | `SSO` |
| `OIDC_ONLY` | Force SSO-only mode: disables password login and registration, overrides Admin > Settings toggles, cannot be changed at runtime. First SSO login becomes admin on a fresh instance. | `false` |
| `OIDC_ADMIN_CLAIM` | OIDC claim used to identify admin users (e.g. `groups`) | — |
| `OIDC_ADMIN_VALUE` | Value of the OIDC claim that grants admin role (e.g. `app-trek-admins`) | — |
| `OIDC_SCOPE` | Space-separated OIDC scopes to request. **Fully replaces** the default — always include `openid email profile` plus any extra scopes (e.g. add `groups` when using `OIDC_ADMIN_CLAIM`) | `openid email profile` |
| `OIDC_DISCOVERY_URL` | Override the auto-constructed OIDC discovery endpoint. Required for providers with a non-standard path (e.g. Authentik) | — |

---

## Email / SMTP

SMTP settings can be configured via the Admin panel or overridden with environment variables. Env vars take priority over the database values.

| Variable | Description | Default |
|---|---|---|
| `SMTP_HOST` | SMTP server hostname (e.g. `smtp.example.com`) | — |
| `SMTP_PORT` | SMTP server port. Port `465` enables implicit TLS (`secure: true`); all other ports use STARTTLS or plain. | — |
| `SMTP_USER` | SMTP authentication username | — |
| `SMTP_PASS` | SMTP authentication password | — |
| `SMTP_FROM` | Sender address for outbound emails (e.g. `TREK <noreply@example.com>`) | — |
| `SMTP_SKIP_TLS_VERIFY` | Set `true` to disable TLS certificate validation. Useful for self-signed certs on internal SMTP relays — not recommended in production. | `false` |

`SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` are all required for email delivery to work. `SMTP_USER` and `SMTP_PASS` are optional (for unauthenticated relays).

---

## Initial Setup

These variables only take effect on first boot, before any user exists.

| Variable | Description | Default |
|---|---|---|
| `ADMIN_EMAIL` | Email for the first admin account | `admin@trek.local` |
| `ADMIN_PASSWORD` | Password for the first admin account | random |

Both variables must be set together. If either is omitted, the account is created with email `admin@trek.local` and a randomly generated password that is printed to the server log. Once any user exists, these variables have no effect.

---

## MCP

For setup instructions, see [MCP-Overview](MCP-Overview).

| Variable | Description | Default |
|---|---|---|
| `MCP_RATE_LIMIT` | Max MCP API requests per user per minute | `300` |
| `MCP_MAX_SESSION_PER_USER` | Max concurrent MCP sessions per user | `20` |

---

## Other

| Variable | Description | Default |
|---|---|---|
| `DEMO_MODE` | Enable demo mode (hourly data resets). Not intended for regular use. | `false` |

---

## Related Pages

- [Reverse-Proxy](Reverse-Proxy) — HTTPS proxy setup and the `FORCE_HTTPS` / `TRUST_PROXY` / `COOKIE_SECURE` trio
- [OIDC-SSO](OIDC-SSO) — complete OIDC configuration guide
- [MCP-Overview](MCP-Overview) — MCP server setup and rate limiting
- [Encryption-Key-Rotation](Encryption-Key-Rotation) — rotating the `ENCRYPTION_KEY` without losing data
