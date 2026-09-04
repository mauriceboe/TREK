# Environment Variables

Complete reference for all environment variables TREK reads.

## How to Set Variables

- **Docker Compose** — use the `environment:` block or a `.env` file alongside `docker-compose.yml`
- **Docker run** — pass each variable with `-e VARIABLE=value`
- **Helm** — use `env:` for plain values and `secretEnv:` for sensitive values in `values.yaml`. The chart only
  passes through the keys it declares (26 in `templates/configmap.yaml`, 5 in `templates/secret.yaml`), so a variable
  that is not one of them is dropped silently — patch it onto the Deployment or add it to the chart
- **Unraid** — set in the container template editor
- **Proxmox Community Script** — set in `/opt/trek/server/.env`

---

## Startup Validation

TREK checks almost all of this surface once at boot. A variable that is **unset or blank** falls back to its documented
default; a variable that is **present but malformed** aborts startup, with an aggregated report naming every
offending value:

```
Invalid environment configuration:
  - PORT="not-a-port": must be a port number (1-65535)
  - SESSION_DURATION="bogus": must be a duration like "1h", "7d" or "30d"
```

In Docker this crash-loops the container until the value is corrected or removed. Boolean switches accept
`true`/`false`, `1`/`0`, `on`/`off`, `yes`/`no` in any casing — anything else counts as malformed. Variables TREK
does not know are passed through untouched.

`TREK_DB_JOURNAL_MODE` and `TREK_DB_SYNCHRONOUS` are exceptions: they log a warning and fall back instead of
aborting, because `reset-admin.js` — the way back into a locked-out instance — reads the same two variables and has
to keep working. The three plugin caps `TREK_PLUGIN_AI_PER_DAY`, `TREK_PLUGIN_NOTIFY_PER_DAY` and
`TREK_PLUGIN_AUDIT_MAX_ROWS` are read by the plugin host rather than by the boot schema, so a malformed value there
falls back to the default without a warning. `NODE_ENV` and `TZ` are not validated at all, so a non-standard value
like `NODE_ENV=staging` still boots.

---

## Core

| Variable                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Default                         |
|-----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------|
| `PORT`                      | Server port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Sources: `3001`, Docker: `3000` |
| `HOST`                      | Bind address for the HTTP server (e.g. `127.0.0.1`, `10.0.0.72`). **Source / Proxmox installs only** — do not set this in Docker or any containerized deployment. See note below.                                                                                                                                                                                                                                                                                                                                                 | all interfaces                  |
| `NODE_ENV`                  | Environment (`production` / `development`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `production`                    |
| `ENCRYPTION_KEY`            | At-rest encryption key — see resolution order below                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | auto                            |
| `TZ`                        | Timezone for logs, reminders, and cron jobs (e.g. `Europe/Berlin`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `UTC`                           |
| `LOG_LEVEL`                 | `info` = concise user actions; `debug` = verbose details                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `info`                          |
| `DEFAULT_LANGUAGE`          | Default language on the login page — see supported codes below                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `en`                            |
| `SESSION_DURATION`          | How long a login session stays valid before re-login is required. Used when **"Remember me" is unchecked** on the login form (the default): applies to the `trek_session` JWT `exp` claim, and the cookie is issued as a **browser-session cookie** (no `maxAge`, cleared when the browser closes). Accepts `ms`-style strings: `1h`, `12h`, `7d`, `30d`, `90d`. Invalid values abort startup — see Startup Validation above. Does not affect the short-lived MFA challenge token or MCP OAuth tokens (those keep their own TTL). | `24h`                           |
| `SESSION_DURATION_REMEMBER` | Session length used when the user **ticks "Remember me"** on login: a longer-lived JWT `exp` claim plus a **persistent** `trek_session` cookie whose `maxAge` matches, so the session survives browser restarts. Same `ms`-style format and the same startup validation as `SESSION_DURATION`.                                                                                                                                                                                                                                     | `30d`                           |
| `ALLOWED_ORIGINS`           | Comma-separated origins for CORS and email notification links                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | same-origin                     |
| `ALLOW_INTERNAL_NETWORK`    | Allow outbound requests to private/RFC-1918 IPs. Set `true` if Immich or other integrated services are on your local network. Loopback (`127.x`) and link-local (`169.254.x`) addresses remain blocked regardless.                                                                                                                                                                                                                                                                                                                | `false`                         |
| `APP_URL`                   | Public base URL (e.g. `https://trek.example.com`). Required when OIDC is enabled — must match the redirect URI registered with your IdP. Also used as the base URL for email notification links and subscribable calendar feed URLs (the `webcal://`/`https://` links the Subscribe dialog hands to Google/Apple/Outlook).                                                                                                                                                                                                          | —                               |
| `TREK_WIKI_DIR`             | Where the in-app Help pages (`/help`) read their content from. TREK ships this wiki and serves it from disk, so the docs always match the version you are running. You should not need to set this — it is an escape hatch for unusual layouts. If the directory cannot be found, Help falls back to fetching the repository's `wiki/` folder from the `main` branch on GitHub (which can be ahead of the release you are running, and needs outbound network access).                                                               | the bundled `wiki/` directory   |

### `HOST` — Source and Proxmox installs only

By default TREK binds to all network interfaces (`0.0.0.0`), which is the correct behaviour inside a container because
Docker handles port exposure at the host level. Setting `HOST` overrides the bind address at the Node.js level.

**When to use it:** only when running TREK directly on a host (git sources or
the [Proxmox community script](Install-Proxmox)) and you need to restrict which interface the server listens on — for
example, to expose TREK only on a LAN interface while keeping it off the public-facing one.

**Never set `HOST` in Docker, Docker Compose, Helm, or Unraid deployments.** Use Docker's
`-p <host-ip>:<host-port>:<container-port>` syntax or your orchestrator's port binding instead.

```
# .env — source / Proxmox installs only
HOST=10.0.0.72   # bind only on this LAN interface
PORT=3001
```

When `HOST` is set, the startup banner includes a `Host:` line confirming the bound address.

### `ENCRYPTION_KEY` — Resolution Order

`server/src/config.ts` resolves the encryption key in this order:

1. **`ENCRYPTION_KEY` env var** — explicit value, always takes priority. Persisted to `data/.encryption_key`
   automatically.
2. **`data/.encryption_key` file** — present on any install that has started at least once.
3. **`data/.jwt_secret` file** — one-time fallback for existing installs upgrading without a pre-set key. The value is
   immediately persisted to `data/.encryption_key` so JWT rotation cannot break decryption later.
4. **Auto-generated** — fresh install with none of the above; persisted to `data/.encryption_key`.

Setting `ENCRYPTION_KEY` explicitly is recommended so you can back it up independently of the data volume.

### `DEFAULT_LANGUAGE` — Supported Codes

You can set `DEFAULT_LANGUAGE` to any of the 23 languages TREK ships. The currently supported codes are:

| Code    | Language           |
|---------|--------------------|
| `en`    | English            |
| `de`    | Deutsch            |
| `es`    | Español            |
| `fr`    | Français           |
| `hu`    | Magyar             |
| `nl`    | Nederlands         |
| `br`    | Português (Brasil) |
| `cs`    | Česky              |
| `pl`    | Polski             |
| `ru`    | Русский            |
| `zh`    | 简体中文               |
| `zh-TW` | 繁體中文               |
| `it`    | Italiano           |
| `tr`    | Türkçe             |
| `ar`    | العربية            |
| `id`    | Bahasa Indonesia   |
| `ja`    | 日本語                |
| `ko`    | 한국어                |
| `uk`    | Українська         |
| `gr`    | Ελληνικά           |
| `sv`    | Svenska            |
| `vi`    | Tiếng Việt         |
| `ca`    | Català             |

If you set a code that isn't on this list, TREK refuses to start and prints
`DEFAULT_LANGUAGE="…": must be one of: …`. Leave the variable unset to use English (`en`). This list grows as new
translations are added to TREK.

---

## Outbound HTTP(S) Proxy

TREK can route supported outbound HTTP(S) requests through a proxy by setting the standard variables below. Outbound
proxying is disabled by default.

| Variable      | Description                                                   | Default |
|---------------|---------------------------------------------------------------|---------|
| `HTTP_PROXY`  | Proxy URL for outbound HTTP requests                          | —       |
| `HTTPS_PROXY` | Proxy URL for outbound HTTPS requests                         | —       |
| `NO_PROXY`    | Comma-separated hosts or domains that should bypass the proxy | —       |

> **Note:** Proxy environment variables apply to requests made through Node.js's default HTTP dispatcher. Requests
> handled by TREK's SSRF protection use a dedicated dispatcher and do not use the environment proxy.

> **Container only.** Node ignores these variables unless it is started with `NODE_USE_ENV_PROXY=1`, and the official
> image sets that for you. On a source or Proxmox install, and on Helm where the chart's ConfigMap only passes through
> the keys it knows, set `NODE_USE_ENV_PROXY=1` alongside them or nothing will change.

> **Set `NO_PROXY`.** Without it every request goes to the proxy, including the ones TREK makes to itself, such as the
> container health check. `localhost,127.0.0.1` is a sensible minimum; add your own hosts as needed.

---

## HTTPS / Reverse Proxy

These three variables work together behind a TLS-terminating reverse proxy. See [Reverse-Proxy](Reverse-Proxy) for the
full explanation.

| Variable                  | Description                                                                                                                                                                                                                                                                             | Default          |
|---------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| `FORCE_HTTPS`             | When `true`: 301-redirects HTTP→HTTPS, sends HSTS (`max-age=31536000`), adds CSP `upgrade-insecure-requests`, forces cookie `secure` flag. Only useful behind a TLS proxy. Your proxy must send `X-Forwarded-Proto: https`.                                                             | `false`          |
| `HSTS_INCLUDE_SUBDOMAINS` | When `true`: adds the `includeSubDomains` directive to the HSTS header, extending HTTPS enforcement to all subdomains. Only effective when HSTS is active (`FORCE_HTTPS=true` or `NODE_ENV=production`). Leave `false` if you run other services on sibling subdomains over plain HTTP. | `false`          |
| `TRUST_PROXY`             | Number of trusted proxy hops. Tells Express how far into `X-Forwarded-For` to look for the real client IP, and where to read `X-Forwarded-Proto`. Count your hops: with two proxies in front of TREK and `TRUST_PROXY=1`, the IP on every audit row is the inner proxy's. `0` trusts nothing and always uses the socket address. Not required for the `FORCE_HTTPS` redirect, which reads the `X-Forwarded-Proto` header directly — set it for correct client IPs in the audit log, and for the `COOKIE_SECURE` auto-derivation, which goes through `req.secure`. | `1` (production) |
| `COOKIE_SECURE`           | Controls the `secure` flag on the `trek_session` cookie. Auto-derived as `true` when `NODE_ENV=production`, when `FORCE_HTTPS=true`, or when the request itself arrived over TLS on the outermost hop (`X-Forwarded-Proto: https` with `TRUST_PROXY` set). Set to `false` only as an escape hatch for LAN testing without TLS — not recommended in production.                                                   | auto             |

> **Warning:** `FORCE_HTTPS=true` behind a proxy that does not forward `X-Forwarded-Proto: https` causes a
> redirect loop — every request looks like plain HTTP to TREK and gets 301'd again. Fix the proxy to send the
> header. Setting `TRUST_PROXY` does not help: the redirect accepts the raw `X-Forwarded-Proto: https` header on
> its own, whatever `trust proxy` is set to. (`TRUST_PROXY` only feeds the second half of the check, `req.secure`,
> which additionally covers a proxy chain that sends a comma-joined `X-Forwarded-Proto` — and production already
> trusts one hop by default.)

---

## OIDC / SSO

For setup instructions, see [OIDC-SSO](OIDC-SSO).

| Variable             | Description                                                                                                                                                                            | Default                |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------|
| `OIDC_ISSUER`        | OpenID Connect provider URL (e.g. `https://auth.example.com`)                                                                                                                          | —                      |
| `OIDC_CLIENT_ID`     | OIDC client ID                                                                                                                                                                         | —                      |
| `OIDC_CLIENT_SECRET` | OIDC client secret                                                                                                                                                                     | —                      |
| `OIDC_DISPLAY_NAME`  | Label shown on the SSO login button                                                                                                                                                    | `SSO`                  |
| `OIDC_ONLY`          | Force SSO-only mode: disables password login and registration, overrides Admin > Settings toggles, cannot be changed at runtime. First SSO login becomes admin on a fresh instance.    | `false`                |
| `OIDC_ADMIN_CLAIM`   | OIDC claim inspected for the admin role. Only takes effect once `OIDC_ADMIN_VALUE` is set.                                                                                             | `groups`               |
| `OIDC_ADMIN_VALUE`   | Value of the OIDC claim that grants admin role (e.g. `app-trek-admins`)                                                                                                                | —                      |
| `OIDC_SCOPE`         | Space-separated OIDC scopes to request. **Fully replaces** the default — always include `openid email profile` plus any extra scopes (e.g. add `groups` when using `OIDC_ADMIN_CLAIM`) | `openid email profile` |
| `OIDC_DISCOVERY_URL` | Override the auto-constructed OIDC discovery endpoint. Required for providers with a non-standard path (e.g. Authentik)                                                                | —                      |

---

## WebAuthn / Passkeys

Passkey (WebAuthn) login is configured from the Admin panel, but the two cryptographically
sensitive values can be pinned via environment variables. Env vars take priority over the
corresponding database settings. These values are **only** ever derived from server-side config —
never from request `Host` / `X-Forwarded-Host` headers (mirroring OIDC redirect-URI handling).

| Variable           | Description                                                                                                                                                                                                                                                                                                                                                                   | Default                |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------|
| `WEBAUTHN_RP_ID`   | Relying-Party ID — the registrable domain passkeys are bound to (e.g. `trek.example.com`). Overrides the `webauthn_rp_id` DB setting. When unset, it is derived from the hostname of `APP_URL`. Bare IP literals (IPv4/IPv6) are rejected. If it cannot be resolved, passkeys are disabled.                                                                                   | derived from `APP_URL` |
| `WEBAUTHN_ORIGINS` | Comma-separated list of allowed origins for passkey ceremonies (e.g. `https://trek.example.com`). Overrides the `webauthn_origins` DB setting; trailing slashes are stripped. When unset and the RP ID is not `localhost`, a single origin is derived from `APP_URL`. In dev (RP ID `localhost`) `http://localhost:5173` and `http://localhost:3001` are added automatically. | derived from `APP_URL` |

---

## Email / SMTP

SMTP settings can be configured via the Admin panel or overridden with environment variables. Env vars take priority
over the database values.

| Variable               | Description                                                                                                                             | Default |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|---------|
| `SMTP_HOST`            | SMTP server hostname (e.g. `smtp.example.com`)                                                                                          | —       |
| `SMTP_PORT`            | SMTP server port. Port `465` enables implicit TLS (`secure: true`); all other ports use STARTTLS or plain.                              | —       |
| `SMTP_USER`            | SMTP authentication username                                                                                                            | —       |
| `SMTP_PASS`            | SMTP authentication password                                                                                                            | —       |
| `SMTP_FROM`            | Sender address for outbound emails (e.g. `TREK <noreply@example.com>`)                                                                  | —       |
| `SMTP_SKIP_TLS_VERIFY` | Set `true` to disable TLS certificate validation. Useful for self-signed certs on internal SMTP relays — not recommended in production. | `false` |

`SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` are all required for email delivery to work. `SMTP_USER` and `SMTP_PASS` are
optional (for unauthenticated relays).

---

## Initial Setup

These variables only take effect on first boot, before any user exists.

| Variable         | Description                          | Default            |
|------------------|--------------------------------------|--------------------|
| `ADMIN_EMAIL`    | Email for the first admin account    | `admin@trek.local` |
| `ADMIN_PASSWORD` | Password for the first admin account | random             |

Both variables must be set together. If either is omitted, the account is created with email `admin@trek.local` and a
randomly generated password that is printed to the server log. Once any user exists, these variables have no effect.

---

## MCP

For setup instructions, see [MCP-Overview](MCP-Overview).

| Variable                   | Description                                                                                             | Default |
|----------------------------|---------------------------------------------------------------------------------------------------------|---------|
| `MCP_RATE_LIMIT`           | Max MCP API requests per minute, counted **per user and per OAuth client** — a user connected from two MCP clients gets this budget twice. Requests made with a static `trek_` token or a session JWT carry no client and share one further bucket per user. | `300`   |
| `MCP_MAX_SESSION_PER_USER` | Max concurrent MCP sessions per user. At the cap the user's least-recently-active session is closed to make room — requests are not rejected. | `20`    |
| `MCP_SESSION_TTL`          | Session idle timeout in seconds (max 86400)                                                              | `3600`  |
| `MCP_SSE_KEEPALIVE`        | SSE keep-alive ping interval in seconds — keeps the stream alive through reverse proxies. `0` disables the pings; an open stream still refreshes the session's idle timeout. | `25`    |

---

## API Docs

| Variable                | Description                                                                                                                                             | Default |
|-------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|---------|
| `TREK_API_DOCS_ENABLED` | Serve interactive OpenAPI/Swagger docs at `/api/docs` (raw spec at `/api/docs-json`). The spec enumerates every route including the admin surface, so it is off by default. | `false` |

With the flag on, `/api/docs` lists every REST endpoint with try-it-out; authorize with a session JWT
via the Bearer button (the API accepts `Authorization: Bearer <jwt>` everywhere as the cookie fallback).
Request bodies validated with Zod are documented automatically from the same schemas.

---

## Booking Import (KDE Itinerary)

| Variable                    | Description                                                                                                                                                                                             | Default       |
|-----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| `KITINERARY_EXTRACTOR_PATH` | Full path to the `kitinerary-extractor` binary. When unset, TREK searches `/usr/lib/*/libexec/kf6/kitinerary-extractor` and then `PATH`. Set this if you install the binary to a non-standard location. | auto-detected |

The official TREK Docker image bundles the binary automatically: on both amd64 and arm64 it installs
`libkitinerary-bin` via apt (Debian trixie) and symlinks it to `/usr/local/bin/kitinerary-extractor`, which the image
also pins via `KITINERARY_EXTRACTOR_PATH`. When running TREK from source, install `libkitinerary-bin` (Debian trixie /
Ubuntu 25.04+) or download the static binary directly and place it anywhere on `PATH`. The
`GET /api/health/features` endpoint returns `{ "bookingImport": true }` when the binary is found. The Import button in
the Reservations panel is hidden only when **neither** extractor is available — an instance running the AI Parsing
addon still offers it with `bookingImport: false`.

Booking import can also fall back to an AI model for documents KDE Itinerary can't read. That feature (the **AI Parsing** addon) is configured entirely in the UI and needs no environment variables — see [AI-Booking-Import](AI-Booking-Import).

---

## Public Transit (Transitous)

Public-transit routing in the planner is powered by [Transitous](https://transitous.org/), a free community MOTIS service — no API key is required. See [Transport: Flights, Trains, Cars](Transport-Flights-Trains-Cars) for the feature itself.

| Variable          | Description                                                                                                                                                                                                                             | Default                     |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------|
| `TRANSIT_API_URL` | Base URL of the transit routing API. TREK's server proxies requests to it. Point this at your own self-hosted [MOTIS](https://github.com/motis-project/motis) instance if you want zero third-party egress. A trailing slash is stripped. | `https://api.transitous.org` |

When left at the default, using the transit feature makes the TREK **server** send outbound HTTPS requests to `api.transitous.org` (with an identifying User-Agent, as the Transitous usage policy asks). No transit request is made until a user actually searches for a journey.

---

## Image Search (Unsplash)

TREK can search [Unsplash](https://unsplash.com/) for **trip cover images** and **place images**. By default the server queries Unsplash's public web endpoint **without an API key**, so no configuration is needed on most installs.

Some hosting environments — commonly VPS and datacenter IP ranges (and many Kubernetes clusters) — are **blocked or rate-limited** by that unauthenticated endpoint, which surfaces in the UI as **"Unsplash search unavailable"**. Configuring a free Unsplash Access Key switches the server to Unsplash's official, authenticated API (`api.unsplash.com`), which is not subject to that block. See [issue #1449](https://github.com/liketrek/TREK/issues/1449).

| Variable              | Description                                                                                                                                                                                                                                                                                                                                                                    | Default                       |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------|
| `UNSPLASH_ACCESS_KEY` | Unsplash **Access Key** used to authenticate cover/place image search against `https://api.unsplash.com`. When set, it takes priority over any key configured per-admin in **Admin → Settings**. When unset, the server falls back to the unauthenticated endpoint (which some datacenter/VPS IPs are blocked from). Get a free key at [unsplash.com/developers](https://unsplash.com/developers). | unauthenticated endpoint |

**Two ways to configure it** — pick one; the env var wins if both are present:

1. **Environment variable** (this page) — instance-wide, ideal for Docker/Helm/Unraid where you already manage config as env.
2. **Admin → Settings → API Keys** — paste the key into the **Unsplash API Key** field. Stored encrypted at rest and used as a fallback for every user when no env var is set. This is the better option if you'd rather not restart the container to change it.

To get a key: create a free account at [unsplash.com/developers](https://unsplash.com/developers), register a new application, and copy its **Access Key** (not the Secret Key). The Unsplash free tier (demo) allows 50 requests/hour, which is ample for cover search.

---

## Storage & Paths

Storage backends and category assignment are configured in
[[Admin: Storage|Admin-Storage]] (or a seed-once `storage-config.json`), not
through environment variables. `TREK_PLACE_PHOTO_DIR` below is unaffected.

| Variable                     | Description                                                                                                                                                                                                                                            | Default                 |
|------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|
| `TREK_PLACE_PHOTO_DIR`       | Directory where cached Google place photos are stored. Created recursively on boot. Set this to point photo storage at a dedicated mounted volume.                                                                                                     | `uploads/photos/google` |
| `BACKUP_UPLOAD_LIMIT_MB`     | Maximum **compressed** size (in MB) of a restore-backup archive that may be uploaded. Raise it if your backups (which include the `uploads/` directory) exceed the default. Non-positive or invalid values abort startup. | `500`                   |
| `BACKUP_MAX_DECOMPRESSED_MB` | Maximum **decompressed** size (in MB) of a restore-backup archive — the zip-bomb guard. Independent of `BACKUP_UPLOAD_LIMIT_MB` and enforced on both restore paths, so a restore that fits the upload cap can still be refused with `Backup exceeds the maximum decompressed size.` Raise both when restoring a very large instance. | `5120` (5 GB)          |
| `TREK_DB_JOURNAL_MODE`       | SQLite [journal mode](https://sqlite.org/pragma.html#pragma_journal_mode): `DELETE`, `TRUNCATE`, `PERSIST`, `MEMORY`, `WAL` or `OFF`. Set `DELETE` when the data directory lives on network storage — see below. Values SQLite doesn't know log a warning and fall back. | `WAL`                   |
| `TREK_DB_SYNCHRONOUS`        | SQLite [synchronous](https://sqlite.org/pragma.html#pragma_synchronous) level: `OFF`, `NORMAL`, `FULL` or `EXTRA`. The default follows the journal mode — `NORMAL` under WAL (what SQLite itself uses there), `FULL` otherwise, because a rollback journal at `NORMAL` can lose committed transactions on a power cut. | `NORMAL` / `FULL`       |

### Running the database on network storage

WAL is the right mode on a local disk and stays the default. It coordinates readers and writers through a shared-memory
file (`travel.db-shm`) and memory mapping, and [SQLite's own documentation](https://sqlite.org/wal.html#noshm) says that
combination is not safe on filesystems that don't implement those primitives properly. In practice that means Azure App
Service (Linux), and SMB/NFS volumes mounted from a NAS or a PaaS host. If your `data/` directory is one of those, set:

```
TREK_DB_JOURNAL_MODE=DELETE
```

The journal mode is written into the database file header, not held per connection, so it survives restarts and applies
from the next boot onward. The startup log prints what is actually in effect:

```
[DB] journal_mode=DELETE, synchronous=FULL
```

The maintenance tools that open the same file — `reset-admin.js` and `scripts/migrate-encryption.ts` — read the same two
variables, so run them with the same environment (`docker exec` into the container does this for you). Otherwise the
next key rotation or admin reset would quietly switch the file back to WAL.

---

## Advanced / Tuning

| Variable                  | Description                                                                                                                                                                                                                                                                                                                | Default             |
|---------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------|
| `IDEMPOTENCY_TTL_SECONDS` | How long (in seconds) stored idempotency keys are kept before garbage collection. The offline client replays queued mutations with their `X-Idempotency-Key` on reconnect, so this must exceed the longest expected offline window or a replay could create a duplicate. Invalid values abort startup. | `2592000` (30 days) |
| `OVERPASS_URL`            | Custom [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) endpoint(s) used by the map's POI "explore" search, comma-separated. When set it **replaces** the bundled public mirrors — point it at an internal or self-hosted Overpass instance when the public mirrors are unreachable from your network (e.g. firewalled/locked-down egress in a Kubernetes cluster). Entries that aren't valid `http(s)` URLs are ignored. If you don't run your own Overpass but the public mirrors throttle TREK, first make sure `APP_URL` (or `ALLOWED_ORIGINS`) is set: that alone gives outbound Overpass/Nominatim requests a unique User-Agent, which the public mirrors rate-limit far less. | bundled public mirrors |
| `OVERPASS_TIMEOUT_MS`     | Per-endpoint timeout (in milliseconds) for Overpass POI requests. Endpoints race in parallel and one that hasn't answered within this window is abandoned so a faster mirror can win. Raise it if you run a slow self-hosted Overpass instance. Invalid values abort startup. | `12000` |
| `LLM_TIMEOUT_MS`          | How long (in milliseconds) one AI-parsing call may take before it is abandoned. One ceiling for every provider, applied to the abort signal and to the underlying HTTP client alike. The default is generous so heavier parsing work fits without a code change; lower it if you use a cloud provider and would rather fail fast. Invalid values abort startup. | `900000` (15 min) |

---

## Demo Mode

Demo mode runs TREK as a public, self-resetting sandbox. Not intended for regular deployments.

| Variable           | Description                                                                                                                                                                                                                                                                 | Default          |
|--------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|
| `DEMO_MODE`        | Enable demo mode: seeds example data, resets the database hourly, exposes the demo-login endpoint, and blocks destructive mutations (password change, account deletion, uploads) for demo users. Logs a security warning at startup if combined with `NODE_ENV=production`. | `false`          |
| `DEMO_ADMIN_USER`  | Username of the seeded demo admin account.                                                                                                                                                                                                                                  | `admin`          |
| `DEMO_ADMIN_EMAIL` | Email of the seeded demo admin account.                                                                                                                                                                                                                                     | `admin@trek.app` |
| `DEMO_ADMIN_PASS`  | Initial password for the seeded demo admin (bcrypt-hashed at seed time).                                                                                                                                                                                                    | `admin12345`     |

The `DEMO_ADMIN_*` variables only take effect when `DEMO_MODE=true`, and only at the moment the demo data is first
seeded.

---

## Plugins

The plugin system is **on by default**. The runtime and the Admin → Plugins panel are available out of the box, but installed plugins still have to be activated one by one — so no third-party code runs until an admin turns a specific plugin on. Set `TREK_PLUGINS_ENABLED=false` to switch the whole system off. See [Plugins](Plugins) for the full system and [Plugin-Permissions](Plugin-Permissions) for the isolation model.

| Variable                          | Description                                                                                                                                                                                                           | Default                                                                             |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| `TREK_PLUGINS_ENABLED`            | Master switch for the plugin system. Enabled unless set to `false` (also accepts `0`, `off`, `no`, case-insensitive). Turning it off is a kill switch — installed plugins stay on disk but nothing runs.               | enabled                                                                             |
| `TREK_PLUGINS_DIR`                | Directory where installed plugin **code** is stored. Persist it as a volume if you use plugins.                                                                                                                       | `<data>/plugins`                                                                    |
| `TREK_PLUGINS_DATA_DIR`           | Directory for each plugin's own **data** (its private SQLite file). Kept separate from the code tree; persist it as a volume too.                                                                                     | `<data>/plugins-data`                                                               |
| `TREK_PLUGIN_REGISTRY_URL`        | Override the plugin registry index the *Discover* tab browses. Point it at your own fork or mirror of the registry.                                                                                                  | `https://raw.githubusercontent.com/liketrek/TREK-Plugins/main/dist/index.json` |
| `TREK_PLUGIN_MAX_RSS_MB`          | Per-plugin memory ceiling in MB. A plugin process that exceeds it is stopped.                                                                                                                                         | `300`                                                                               |
| `TREK_PLUGIN_PERMISSIONS`         | Set to any falsy value (`off`, `false`, `0`, `no` — any casing) to opt **out** of the Node.js OS-level permission sandbox for plugin child processes (not recommended). A truthy value, or leaving it unset, keeps the sandbox on; anything outside that set is rejected at boot.                                                            | `on`                                                                                |
| `TREK_PLUGIN_ALLOW_PRIVATE_EGRESS`| Set to `on` to let a plugin's declared outbound hosts resolve to private/internal addresses (e.g. a service on your LAN). By default connections to private, loopback, link-local and metadata addresses are refused. | off (private egress blocked)                                                        |
| `TREK_PLUGINS_DEV_LINK`           | **Development only.** Set to any truthy value (`1`, `true`, `on`, `yes` — any casing) to enable *dev-link*: registering a plugin from a local build directory and hot-reloading it against a live instance's data. Dev-linked code bypasses the install-time signature/integrity checks and (under `npm run dev`) runs with the OS permission jail off, so it must never be reachable in production — absent, blank or an explicitly falsy value (`0`, `false`, `off`, `no`) keeps it off. Data access is still fully gated by the capability host. | off (disabled)                                                                      |
| `TREK_PLUGINS_IGNORE_TREK_RANGE` | Set to any truthy value (`1`, `true`, `on`, `yes` — any casing) to turn the plugin **TREK-version gate** into a warning. A plugin whose `trek` range does not admit the running TREK — or that declares no range at all — can then be installed (registry, sideload, dev-link), updated and activated, and "install latest" takes the newest published version rather than the newest compatible one. Every bypass is logged, the install response carries a `trekRangeBypassed` marker, and the admin panel shows a *Version checks off* pill, a warning dialog before/after each such install, and a persistent chip on the row. Use it only when a plugin author has not yet updated their range for your TREK: nothing guarantees the plugin works, and in rare cases a mismatched plugin can corrupt TREK data. The plugin-API version gate is **not** lifted. Absent, blank or falsy keeps the gate hard. | off (gate enforced) |
| `TREK_PLUGIN_AI_PER_DAY`          | Per-plugin **daily** cap on shared-LLM broker calls (`ai.complete` / `ai.extract`). Bounds how much a single plugin can spend on the admin's LLM quota per UTC day, independent of its granted permissions. Counts persist across restarts within the same day; set to `0` to disable the AI broker entirely. Generous by design — only bites a runaway plugin. | `200`                                                                               |
| `TREK_PLUGIN_NOTIFY_PER_DAY`      | Per-plugin **daily** cap on user-notification broker calls (`notify.send`), so one plugin can't spam a user. Same UTC-day window and restart-safe counting as `TREK_PLUGIN_AI_PER_DAY`; set to `0` to disable the notify broker. | `100`                                                                               |
| `TREK_PLUGIN_RPC_PER_SEC`         | Sustained rate limit (calls **per second**) for a plugin's host RPC calls (`ctx.*`) once its burst allowance is spent. Prevents a tight-loop plugin from starving the single-threaded host. | `20`                                                                                |
| `TREK_PLUGIN_RPC_BURST`           | Burst allowance — how many host RPC calls a plugin may fire back-to-back before the per-second limit applies. | `60`                                                                                |
| `TREK_PLUGIN_RPC_INFLIGHT`        | Max concurrent host→plugin RPC dispatches allowed for a single plugin at once (concurrency cap). | `16`                                                                                |
| `TREK_PLUGIN_LOG_PER_SEC`         | Sustained rate limit (log lines **per second**) for a plugin's log output — `ctx.log.*`, the child process's stdout/stderr, and unknown plugin event topics — once its burst allowance is spent. This path is **not** covered by the RPC limiter above, and `warn`/`error` lines land in a synchronous `plugin_error_log` INSERT + prune on the host thread, so this is what stops a `while (true) ctx.log.error(...)` loop from pinning the instance. Excess lines are dropped; when logging resumes, one `warn` line reports how many were dropped, so the throttling is visible to an operator. | `10`                                                                                |
| `TREK_PLUGIN_LOG_BURST`           | Burst allowance — how many log lines a plugin may emit back-to-back before the per-second limit applies. | `50`                                                                                |
| `TREK_PLUGIN_AUDIT_MAX_ROWS`      | Per-plugin retention cap for the capability audit log (kept in the shared `data/travel.db`). The newest N rows per plugin are retained and older ones pruned; the retained window stays tamper-evident. Set to `0` to disable pruning. | `20000`                                                                             |

All of these are optional — the defaults are safe. Set `TREK_PLUGINS_ENABLED=false` if you want to switch the plugin system off entirely.

---

## Related Pages

- [Reverse-Proxy](Reverse-Proxy) — HTTPS proxy setup and the `FORCE_HTTPS` / `TRUST_PROXY` / `COOKIE_SECURE` trio
- [OIDC-SSO](OIDC-SSO) — complete OIDC configuration guide
- [MCP-Overview](MCP-Overview) — MCP server setup and rate limiting
- [Encryption-Key-Rotation](Encryption-Key-Rotation) — rotating the `ENCRYPTION_KEY` without losing data
