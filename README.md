<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="client/public/logo-light.svg" />
    <source media="(prefers-color-scheme: light)" srcset="client/public/logo-dark.svg" />
    <img src="client/public/logo-light.svg" alt="TREK" height="60" />
  </picture>
  <br />
  <em>Your Trips. Your Plan.</em>
</p>

<p align="center">
  <a href="https://discord.gg/J27gr9GH"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <a href="https://hub.docker.com/r/mauriceboe/trek"><img src="https://img.shields.io/docker/pulls/mauriceboe/trek" alt="Docker Pulls" /></a>
  <a href="https://github.com/mauriceboe/TREK"><img src="https://img.shields.io/github/stars/mauriceboe/TREK" alt="GitHub Stars" /></a>
  <a href="https://github.com/mauriceboe/TREK/commits"><img src="https://img.shields.io/github/last-commit/mauriceboe/TREK" alt="Last Commit" /></a>
</p>

<p align="center">
  A self-hosted, real-time collaborative travel planner with interactive maps, budgets, packing lists, and more.
  <br />
  <strong><a href="https://demo-nomad.pakulat.org">Live Demo</a></strong> — Try TREK without installing. Resets hourly.
</p>

![TREK Screenshot](docs/screenshot.png)
![TREK Screenshot 2](docs/screenshot-2.png)

<details>
<summary>More Screenshots</summary>

| | |
|---|---|
| ![Plan Detail](docs/screenshot-plan-detail.png) | ![Bookings](docs/screenshot-bookings.png) |
| ![Budget](docs/screenshot-budget.png) | ![Packing List](docs/screenshot-packing.png) |
| ![Files](docs/screenshot-files.png) | |

</details>

## Features

### Trip Planning
- **Drag & Drop Planner** — Organize places into day plans with reordering and cross-day moves
- **Interactive Map** — Leaflet map with photo markers, clustering, route visualization, and customizable tile sources
- **Place Search** — Search via Google Places (with photos, ratings, opening hours) or OpenStreetMap (free, no API key needed)
- **Day Notes** — Add timestamped, icon-tagged notes to individual days with drag & drop reordering
- **Route Optimization** — Auto-optimize place order and export to Google Maps
- **Weather Forecasts** — 16-day forecasts via Open-Meteo (no API key needed) with historical climate averages as fallback
- **Map Category Filter** — Filter places by category and see only matching pins on the map

### Travel Management
- **Reservations & Bookings** — Track flights, accommodations, restaurants with status, confirmation numbers, and file attachments
- **Budget Tracking** — Category-based expenses with pie chart, per-person/per-day splitting, and multi-currency support
- **Packing Lists** — Category-based checklists with user assignment, packing templates, and progress tracking
- **Packing Templates** — Create reusable packing templates in the admin panel with categories and items, apply to any trip
- **Bag Tracking** — Optional weight tracking and bag assignment for packing items with iOS-style weight distribution (admin-toggleable)
- **Document Manager** — Attach documents, tickets, and PDFs to trips, places, or reservations (up to 50 MB per file)
- **PDF Export** — Export complete trip plans as PDF with cover page, images, notes, and TREK branding

### Mobile & PWA
- **Progressive Web App** — Install on iOS and Android directly from the browser, no App Store needed
- **Offline Support** — Service Worker caches map tiles, API data, uploads, and static assets via Workbox
- **Native App Feel** — Fullscreen standalone mode, custom app icon, themed status bar, and splash screen
- **Touch Optimized** — Responsive design with mobile-specific layouts, touch-friendly controls, and safe area handling

### Collaboration
- **Real-Time Sync** — Plan together via WebSocket — changes appear instantly across all connected users
- **Multi-User** — Invite members to collaborate on shared trips with role-based access
- **Invite Links** — Create one-time registration links with configurable max uses and expiry for easy onboarding
- **Single Sign-On (OIDC)** — Login with Google, Apple, Authentik, Keycloak, or any OIDC provider
- **Two-Factor Authentication (MFA)** — TOTP-based 2FA with QR code setup, works with Google Authenticator, Authy, etc.
- **Collab** — Chat with your group, share notes, create polls, and track who's signed up for each day's activities

### Addons (modular, admin-toggleable)
- **Vacay** — Personal vacation day planner with calendar view, public holidays (100+ countries), company holidays, user fusion with live sync, and carry-over tracking
- **Atlas** — Interactive world map with visited countries, bucket list with planned travel dates, travel stats, continent breakdown, streak tracking, and liquid glass UI effects
- **Collab** — Chat with your group, share notes, create polls, and track who's signed up for each day's activities
- **Dashboard Widgets** — Currency converter and timezone clock, toggleable per user

### Customization & Admin
- **Dashboard Views** — Toggle between card grid and compact list view on the My Trips page
- **Dark Mode** — Full light and dark theme with dynamic status bar color matching
- **Multilingual** — English, German, Spanish, French, Russian, Chinese (Simplified), Dutch, Arabic (with RTL support)
- **Admin Panel** — User management, invite links, packing templates, global categories, addon management, API keys, backups, and GitHub release history
- **Auto-Backups** — Scheduled backups with configurable interval and retention
- **Customizable** — Temperature units, time format (12h/24h), map tile sources, default coordinates

## Tech Stack

- **Backend**: Node.js 22 + Express + SQLite (`better-sqlite3`)
- **Frontend**: React 18 + Vite + Tailwind CSS
- **PWA**: vite-plugin-pwa + Workbox
- **Real-Time**: WebSocket (`ws`)
- **State**: Zustand
- **Auth**: JWT + OIDC + TOTP (MFA)
- **Maps**: Leaflet + react-leaflet-cluster + Google Places API (optional)
- **Weather**: Open-Meteo API (free, no key required)
- **Icons**: lucide-react

## Quick Start

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32) docker run -d -p 3000:3000 \
  -e ENCRYPTION_KEY=$ENCRYPTION_KEY \
  -v ./data:/app/data -v ./uploads:/app/uploads mauriceboe/trek
```

The app runs on port `3000`. The first user to register becomes the admin.

### Install as App (PWA)

TREK works as a Progressive Web App — no App Store needed:

1. Open your TREK instance in the browser (HTTPS required)
2. **iOS**: Share button → "Add to Home Screen"
3. **Android**: Menu → "Install app" or "Add to Home Screen"
4. TREK launches fullscreen with its own icon, just like a native app

<details>
<summary>Docker Compose (recommended for production)</summary>

```yaml
services:
  app:
    image: mauriceboe/trek:latest
    container_name: trek
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - ENCRYPTION_KEY=${ENCRYPTION_KEY:-} # Recommended. Generate with: openssl rand -hex 32. If unset, falls back to data/.jwt_secret (existing installs) or auto-generates a key (fresh installs).
      - TZ=${TZ:-UTC} # Timezone for logs, reminders and scheduled tasks (e.g. Europe/Berlin)
      - LOG_LEVEL=${LOG_LEVEL:-info} # info = concise user actions; debug = verbose admin-level details
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-} # Comma-separated origins for CORS and email notification links
      - FORCE_HTTPS=true # Redirect HTTP to HTTPS when behind a TLS-terminating proxy
      # - COOKIE_SECURE=false # Uncomment if accessing over plain HTTP (no HTTPS). Not recommended for production.
      - TRUST_PROXY=1 # Number of trusted proxies for X-Forwarded-For
      # - ALLOW_INTERNAL_NETWORK=true # Uncomment if Immich or other services are on your local network (RFC-1918 IPs)
      - APP_URL=${APP_URL:-} # Base URL of this instance — required when OIDC is enabled; must match the redirect URI registered with your IdP; Also used as the base URL for email notifications and other external links
      # - OIDC_ISSUER=https://auth.example.com # OpenID Connect provider URL
      # - OIDC_CLIENT_ID=trek # OpenID Connect client ID
      # - OIDC_CLIENT_SECRET=supersecret # OpenID Connect client secret
      # - OIDC_DISPLAY_NAME=SSO # Label shown on the SSO login button
      # - OIDC_ONLY=false # Set to true to disable local password auth entirely (SSO only)
      # - OIDC_ADMIN_CLAIM=groups # OIDC claim used to identify admin users
      # - OIDC_ADMIN_VALUE=app-trek-admins # Value of the OIDC claim that grants admin role
      # - OIDC_SCOPE=openid email profile # Fully overrides the default. Add extra scopes as needed (e.g. add groups if using OIDC_ADMIN_CLAIM)
      # - OIDC_DISCOVERY_URL= # Override the OIDC discovery endpoint for providers with non-standard paths (e.g. Authentik)
      # - DEMO_MODE=false # Enable demo mode (resets data hourly)
      # - ADMIN_EMAIL=admin@trek.local # Initial admin e-mail — only used on first boot when no users exist
      # - ADMIN_PASSWORD=changeme      # Initial admin password — only used on first boot when no users exist
      # - MCP_RATE_LIMIT=60 # Max MCP API requests per user per minute (default: 60)
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
```

```bash
docker compose up -d
```

</details>

### Updating

**Docker Compose** (recommended):

```bash
docker compose pull && docker compose up -d
```

**Docker Run** — use the same volume paths from your original `docker run` command:

```bash
docker pull mauriceboe/trek
docker rm -f trek
docker run -d --name trek -p 3000:3000 -v ./data:/app/data -v ./uploads:/app/uploads --restart unless-stopped mauriceboe/trek
```

> **Tip:** Not sure which paths you used? Run `docker inspect trek --format '{{json .Mounts}}'` before removing the container.

Your data is persisted in the mounted `data` and `uploads` volumes — updates never touch your existing data.

### Rotating the Encryption Key

If you need to rotate `ENCRYPTION_KEY` (e.g. you are upgrading from a version that derived encryption from `JWT_SECRET`), use the migration script to re-encrypt all stored secrets under the new key without starting the app:

```bash
docker exec -it trek node --import tsx scripts/migrate-encryption.ts
```

The script will prompt for your old and new keys interactively (input is not echoed). It creates a timestamped database backup before making any changes and exits with a non-zero code if anything fails.

**Upgrading from a previous version?** Your old JWT secret is in `./data/.jwt_secret`. Use its contents as the "old key" and your new `ENCRYPTION_KEY` value as the "new key".

### Reverse Proxy (recommended)

For production, put TREK behind a reverse proxy with HTTPS (e.g. Nginx, Caddy, Traefik).

> **Important:** TREK uses WebSockets for real-time sync. Your reverse proxy must support WebSocket upgrades on the `/ws` path.

<details>
<summary>Nginx</summary>

```nginx
server {
    listen 80;
    server_name trek.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name trek.yourdomain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

</details>

<details>
<summary>Caddy</summary>

Caddy handles WebSocket upgrades automatically:

```
trek.yourdomain.com {
    reverse_proxy localhost:3000
}
```

</details>

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| **Core** | | |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (`production` / `development`) | `production` |
| `ENCRYPTION_KEY` | At-rest encryption key for stored secrets (API keys, MFA, SMTP, OIDC). Recommended: generate with `openssl rand -hex 32`. If unset, falls back to `data/.jwt_secret` (existing installs) or auto-generates a key (fresh installs). | Auto |
| `TZ` | Timezone for logs, reminders and cron jobs (e.g. `Europe/Berlin`) | `UTC` |
| `LOG_LEVEL` | `info` = concise user actions, `debug` = verbose details | `info` |
| `ALLOWED_ORIGINS` | Comma-separated origins for CORS and email links | same-origin |
| `FORCE_HTTPS` | Redirect HTTP to HTTPS behind a TLS-terminating proxy | `false` |
| `COOKIE_SECURE` | Set to `false` to allow session cookies over plain HTTP (e.g. accessing via IP without HTTPS). Defaults to `true` in production. **Not recommended to disable in production.** | `true` |
| `TRUST_PROXY` | Number of trusted reverse proxies for `X-Forwarded-For` | `1` |
| `ALLOW_INTERNAL_NETWORK` | Allow outbound requests to private/RFC-1918 IP addresses. Set to `true` if Immich or other integrated services are hosted on your local network. Loopback (`127.x`) and link-local/metadata addresses (`169.254.x`) are always blocked regardless of this setting. | `false` |
| `APP_URL` | Public base URL of this instance (e.g. `https://trek.example.com`). Required when OIDC is enabled — must match the redirect URI registered with your IdP. Also used as the base URL for external links in email notifications. | — |
| **OIDC / SSO** | | |
| `OIDC_ISSUER` | OpenID Connect provider URL | — |
| `OIDC_CLIENT_ID` | OIDC client ID | — |
| `OIDC_CLIENT_SECRET` | OIDC client secret | — |
| `OIDC_DISPLAY_NAME` | Label shown on the SSO login button | `SSO` |
| `OIDC_ONLY` | Disable local password auth entirely (first SSO login becomes admin) | `false` |
| `OIDC_ADMIN_CLAIM` | OIDC claim used to identify admin users | — |
| `OIDC_ADMIN_VALUE` | Value of the OIDC claim that grants admin role | — |
| `OIDC_SCOPE` | Space-separated OIDC scopes to request. **Fully replaces** the default — always include `openid email profile` plus any extra scopes you need (e.g. add `groups` when using `OIDC_ADMIN_CLAIM`) | `openid email profile` |
| `OIDC_DISCOVERY_URL` | Override the auto-constructed OIDC discovery endpoint. Useful for providers that expose it at a non-standard path (e.g. Authentik: `https://auth.example.com/application/o/trek/.well-known/openid-configuration`) | — |
| **Initial Setup** | | |
| `ADMIN_EMAIL` | Email for the first admin account created on initial boot. Must be set together with `ADMIN_PASSWORD`. If either is omitted a random password is generated and printed to the server log. Has no effect once any user exists. | `admin@trek.local` |
| `ADMIN_PASSWORD` | Password for the first admin account created on initial boot. Must be set together with `ADMIN_EMAIL`. | random |
| **Other** | | |
| `DEMO_MODE` | Enable demo mode (hourly data resets) | `false` |
| `MCP_RATE_LIMIT` | Max MCP API requests per user per minute | `60` |

## Optional API Keys

API keys are configured in the **Admin Panel** after login. Keys set by the admin are automatically shared with all users — no per-user configuration needed.

### Google Maps (Place Search & Photos)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Places API (New)**
3. Create an API key under Credentials
4. In TREK: Admin Panel → Settings → Google Maps

## Building from Source

```bash
git clone https://github.com/mauriceboe/TREK.git
cd TREK
docker build -t trek .
```

## Data & Backups

- **Database**: SQLite, stored in `./data/travel.db`
- **Uploads**: Stored in `./uploads/`
- **Logs**: `./data/logs/trek.log` (auto-rotated)
- **Backups**: Create and restore via Admin Panel
- **Auto-Backups**: Configurable schedule and retention in Admin Panel

## License

[AGPL-3.0](LICENSE)
