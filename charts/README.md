# TREK Helm Chart

This is a minimal Helm chart for deploying the TREK app.

## Features
- Deploys the TREK container
- Exposes port 3000 via Service
- Optional persistent storage for `/app/data` and `/app/uploads`
- Configurable environment variables and secrets
- Optional generic Ingress support
- Configurable health checks (liveness/readiness probes) on `/api/health`

## Helm Repository

A hosted Helm repository is available:

```sh
helm repo add trek https://chart.liketrek.com
helm repo update
helm install trek trek/trek
```

> **Note:** `chart.liketrek.com` is a custom domain (CNAME) for the GitHub Pages site at `https://liketrek.github.io/TREK` — both URLs serve the same repository. The github.io URL keeps working (it redirects to `chart.liketrek.com`), but the custom domain is the canonical one to use.

## Usage

Or install directly from the local chart:

```sh
helm install trek ./chart \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=yourdomain.com
```

See `values.yaml` for more options.

## Files
- `Chart.yaml` — chart metadata
- `values.yaml` — configuration values
- `templates/` — Kubernetes manifests

## Notes
- Ingress is off by default. Enable and configure hosts for your domain.
- PVCs use the cluster's default StorageClass. Set `persistence.data.storageClassName` and/or `persistence.uploads.storageClassName` to bind a specific class.
- To use your own PVCs, set `persistence.data.existingClaim` and/or `persistence.uploads.existingClaim`. The other values for that volume (size, storageClassName, annotations) are then ignored.
- With `persistence.enabled: false`, the data and uploads volumes use an `emptyDir` — storage is ephemeral and lost on pod restart. Intended for testing only.
- `JWT_SECRET` is managed entirely by the server — auto-generated into the data PVC on first start and rotatable via the admin panel (Settings → Danger Zone). No Helm configuration needed.
- `ENCRYPTION_KEY` encrypts stored secrets (API keys, MFA, SMTP, OIDC) at rest. Recommended: set via `secretEnv.ENCRYPTION_KEY` or `existingSecret`. If left empty, the server falls back automatically: existing installs use `data/.jwt_secret` (no action needed on upgrade); fresh installs auto-generate a key persisted to the data PVC.
- If using ingress, you must manually keep `env.ALLOWED_ORIGINS` and `ingress.hosts` in sync to ensure CORS works correctly. The chart does not sync these automatically.
- Set `env.ALLOW_INTERNAL_NETWORK: "true"` if Immich or other integrated services are hosted on a private/RFC-1918 address (e.g. a pod on the same cluster or a NAS on your LAN). Loopback (`127.x`) and link-local/metadata addresses (`169.254.x`) remain blocked regardless.
- `FORCE_HTTPS` is optional. Set `env.FORCE_HTTPS: "true"` only when ingress (or another proxy) terminates TLS. It enables HTTPS redirects, HSTS, CSP `upgrade-insecure-requests`, and forces the session cookie `secure` flag. Requires `TRUST_PROXY` to be set.
- Set `env.TRUST_PROXY: "1"` (or the number of proxy hops) when running behind ingress or a load balancer. Required for `FORCE_HTTPS` to detect the forwarded protocol correctly. In production it defaults to `1` automatically.
- `COOKIE_SECURE` is auto-derived (on when `NODE_ENV=production` or `FORCE_HTTPS=true`). Set `env.COOKIE_SECURE: "false"` only during local testing without TLS. **Not recommended for production.**
- Set `env.OIDC_DISCOVERY_URL` to override the auto-constructed OIDC discovery endpoint. Required for providers (e.g. Authentik) that expose it at a non-standard path.
