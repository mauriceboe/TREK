# TREK Helm Chart

This is a minimal Helm chart for deploying the TREK app.

## Features
- Deploys the TREK container
- Exposes port 3000 via Service
- Optional persistent storage for `/app/data` and `/app/uploads`
- Configurable environment variables and secrets
- Optional generic Ingress support
- Health checks on `/api/health`

## Usage

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
- PVCs require a default StorageClass or specify one as needed.
- `JWT_SECRET` is managed entirely by the server — auto-generated into the data PVC on first start and rotatable via the admin panel (Settings → Danger Zone). No Helm configuration needed.
- `ENCRYPTION_KEY` encrypts stored secrets (API keys, MFA, SMTP, OIDC) at rest. Recommended: set via `secretEnv.ENCRYPTION_KEY` or `existingSecret`. If left empty, the server falls back automatically: existing installs use `data/.jwt_secret` (no action needed on upgrade); fresh installs auto-generate a key persisted to the data PVC.
- If using ingress, you must manually keep `env.ALLOWED_ORIGINS` and `ingress.hosts` in sync to ensure CORS works correctly. The chart does not sync these automatically.
- Set `env.ALLOW_INTERNAL_NETWORK: "true"` if Immich or other integrated services are hosted on a private/RFC-1918 address (e.g. a pod on the same cluster or a NAS on your LAN). Loopback (`127.x`) and link-local/metadata addresses (`169.254.x`) remain blocked regardless.
- Set `env.COOKIE_SECURE: "false"` only if your deployment has no TLS (e.g. during local testing without ingress). Session cookies require HTTPS in all other cases.
- Set `env.OIDC_DISCOVERY_URL` to override the auto-constructed OIDC discovery endpoint. Required for providers (e.g. Authentik) that expose it at a non-standard path.
