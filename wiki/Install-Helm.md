# Install: Helm

Deploy TREK on Kubernetes using the official Helm chart.

## Add the Chart Repository

```bash
helm repo add trek https://chart.liketrek.com
helm repo update
```

> **Note:** `chart.liketrek.com` is a custom domain (CNAME) for the GitHub Pages site at `https://liketrek.github.io/TREK` — both serve the same chart repository. Using the custom domain keeps your setup working even if the GitHub repository moves again.

> **⚠️ Repository moved:** The chart is no longer served at `https://mauriceboe.github.io/TREK` (the project moved from a personal repo to the `liketrek` organization). If you added the repo from the old URL, switch to the new one:
>
> ```bash
> helm repo remove trek
> helm repo add trek https://chart.liketrek.com
> helm repo update
> ```
>
> Existing releases keep working — only the repo URL changes; future `helm repo update` / `helm upgrade` runs require the new URL. (`https://liketrek.github.io/TREK` also works — it redirects to `chart.liketrek.com`.)

## Basic Install

```bash
helm install trek trek/trek
```

This deploys TREK with default values: a `ClusterIP` service on port 3000, 1 Gi PVCs for data and uploads, and no ingress.

## Encryption Key

`ENCRYPTION_KEY` encrypts stored secrets (API keys, MFA, SMTP, OIDC) at rest. There are three ways to handle it:

**Option 1 — Let the chart generate a random key (recommended for new installs):**

```bash
helm install trek trek/trek --set generateEncryptionKey=true
```

The chart generates a 32-character alphanumeric key at install time and preserves it across upgrades. Note that this differs from the 64-character hex key produced by `openssl rand -hex 32` — both formats are accepted by the server.

**Option 2 — Set an explicit key:**

```bash
helm install trek trek/trek \
  --set secretEnv.ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**Option 3 — Use an existing Kubernetes Secret:**

```bash
kubectl create secret generic trek-secrets \
  --from-literal=ENCRYPTION_KEY=$(openssl rand -hex 32)

helm install trek trek/trek \
  --set existingSecret=trek-secrets
```

If `existingSecret` uses a different key name than `ENCRYPTION_KEY`, specify it with `--set existingSecretKey=MY_KEY_NAME`.

> **Note:** If both `generateEncryptionKey` and `existingSecret` are set, `existingSecret` takes precedence. Only one method should be active at a time.

> **Note:** If `ENCRYPTION_KEY` is left empty, the server resolves it automatically: existing installs fall back to `data/.jwt_secret` (encrypted data stays readable after upgrade); fresh installs auto-generate a key persisted to the data PVC.

> **Note:** `JWT_SECRET` is managed entirely by the server — auto-generated on first start and persisted to the data PVC. It can be rotated via the admin panel (Settings → Danger Zone → Rotate JWT Secret). No Helm configuration is needed or supported for it.

## Admin Account

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are set via `secretEnv`. They are only used on first boot when no users exist yet. **Both must be set together** — if either is missing, the server ignores both values and instead creates the admin account with email `admin@trek.local` and a random password, which is printed to the server log.

```bash
helm install trek trek/trek \
  --set secretEnv.ADMIN_EMAIL=admin@example.com \
  --set secretEnv.ADMIN_PASSWORD=<your-secure-password>
```

> **Note:** When `OIDC_ONLY=true` is configured together with `OIDC_ISSUER` and `OIDC_CLIENT_ID`, no local admin account is created on first boot. Instead, the first user to log in via SSO automatically becomes admin.

## Key `values.yaml` Settings

### Image

```yaml
image:
  repository: mauriceboe/trek
  # tag: latest        # defaults to the chart's appVersion
  pullPolicy: IfNotPresent

# Optional: pull secrets for private registries
imagePullSecrets: []
  # - name: my-registry-secret
```

### Service

```yaml
service:
  type: ClusterIP   # change to LoadBalancer or NodePort to expose externally
  port: 3000
```

### Plain Environment Variables (`env`)

```yaml
env:
  NODE_ENV: production
  PORT: 3000
  # TZ: "Europe/Berlin"          # timezone for logs, reminders, cron jobs
  # LOG_LEVEL: "info"            # "info" = concise, "debug" = verbose
  # TREK_WIKI_DIR: "/app/wiki"   # where /help reads its docs from; leave unset (the image ships them)
  # DEFAULT_LANGUAGE: "en"       # fallback language on login page; supported: de, en, es, fr, hu, nl, br, cs, pl, ru, zh, zh-TW, it, tr, ar, id, ja, ko, uk, gr, sv, vi, ca
  # ALLOWED_ORIGINS: "https://trek.example.com"
  # APP_URL: "https://trek.example.com"
  # FORCE_HTTPS: "false"         # enable HTTPS redirect + HSTS; requires TRUST_PROXY
  # TRUST_PROXY: "1"             # proxy hops for X-Forwarded-For/Proto; defaults to 1 in production
  # COOKIE_SECURE: "true"        # auto-derived; set "false" only for local HTTP testing
  # ALLOW_INTERNAL_NETWORK: "false"  # set "true" if Immich or other services are on a private network
  # DEMO_MODE: "false"           # enable demo mode (hourly data resets)
  # MCP_RATE_LIMIT: "300"        # max MCP requests per user per minute
  # OIDC_ISSUER: "https://auth.example.com"
  # OIDC_CLIENT_ID: "trek"
  # OIDC_DISPLAY_NAME: "SSO"
  # OIDC_ONLY: "false"           # force SSO-only mode; disables password login
  # OIDC_ADMIN_CLAIM: ""         # OIDC claim used to identify admin users
  # OIDC_ADMIN_VALUE: ""         # value of that claim that grants admin role
  # OIDC_SCOPE: "openid email profile groups"
  # OIDC_DISCOVERY_URL: ""       # override for providers with non-standard discovery paths (e.g. Authentik)
```

### Sensitive Variables (`secretEnv`)

These are stored in a Kubernetes Secret and injected as environment variables:

```yaml
secretEnv:
  ENCRYPTION_KEY: ""        # recommended: openssl rand -hex 32
  ADMIN_EMAIL: ""           # initial admin email (first boot only)
  ADMIN_PASSWORD: ""        # initial admin password (first boot only)
  OIDC_CLIENT_SECRET: ""    # set if using OIDC
  UNSPLASH_ACCESS_KEY: ""   # optional; free key from unsplash.com/developers
```

Alternatively, use `generateEncryptionKey: true` to let the chart generate and manage the encryption key, or point `existingSecret` / `existingSecretKey` at an existing Kubernetes Secret.

> **Note:** Without `UNSPLASH_ACCESS_KEY` the server queries Unsplash's unauthenticated endpoint, which many datacenter and VPS IP ranges — including a lot of Kubernetes clusters — are blocked or rate-limited on. Trip-cover and place-image search then fail with **"Unsplash search unavailable"**. A free Access Key switches the server to Unsplash's authenticated API (`api.unsplash.com`), which is not subject to that block. The key can also be set in **Admin → Settings → API Keys**; this value takes priority over that one. See [Environment-Variables](Environment-Variables#image-search-unsplash).

### Persistent Storage

```yaml
persistence:
  enabled: true
  data:
    size: 1Gi     # SQLite database, logs, secrets
  uploads:
    size: 1Gi     # uploaded files — increase if you expect large media uploads
```

### Resource Limits

```yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

### Health Probes

Liveness and readiness probes are configurable under `probes`. The defaults hit `/api/health` on port 3000 and match what the chart shipped before, so an existing install renders the same manifest.

```bash
helm install trek trek/trek   --set probes.liveness.initialDelaySeconds=60   --set probes.readiness.periodSeconds=20
```

Raise `initialDelaySeconds` on slow storage or after a large migration, where the first start can outlast the default and leave the pod restarting in a loop. Overrides are merged over the defaults, so setting one key keeps the rest. To switch a probe to `exec` or `tcpSocket`, clear the shipped handler in the same override (`--set probes.liveness.httpGet=null`), otherwise Kubernetes rejects the pod with "may not specify more than 1 handler type". Set `probes.liveness=null` to drop a probe entirely.

If you change `env.PORT`, update `service.port` and `probes.*.httpGet.port` to match.

### Ingress

```yaml
ingress:
  enabled: true
  className: "nginx"   # your ingress class
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "86400"  # required for WebSockets
    nginx.ingress.kubernetes.io/proxy-body-size: "500m"       # required for backup restore
  hosts:
    - host: trek.example.com
      paths:
        - /
  tls:
    - secretName: trek-tls
      hosts:
        - trek.example.com
```

> **Important:** TREK uses WebSockets on `/ws`. Your ingress controller must support WebSocket upgrades. Set `proxy-read-timeout` to at least `86400` and `proxy-body-size` to at least `500m` for backup restores.

> **Note:** Keep `env.ALLOWED_ORIGINS` in sync with `ingress.hosts` — the chart does not synchronize these automatically.

> **Note:** When using ingress with TLS termination, set `env.FORCE_HTTPS: "true"` and `env.TRUST_PROXY: "1"` to enable HTTPS redirects, HSTS, and secure cookies.

## Upgrade

```bash
helm repo update
helm upgrade trek trek/trek
```

## Full Values Reference

See the [`charts/README.md`](https://github.com/liketrek/TREK/blob/main/charts/README.md) for all available values.

## Next Steps

- [Environment-Variables](Environment-Variables) — full variable reference
- [Reverse-Proxy](Reverse-Proxy) — proxy configuration for non-Kubernetes deployments
