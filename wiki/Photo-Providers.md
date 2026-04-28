# Photo Providers

TREK can browse your personal photo library on Immich or Synology Photos and attach selected photos to trips. TREK never copies the original files — it stores only a reference (provider name + asset ID) and proxies all image streams through its own server, so your provider credentials are never sent to the browser.

> **Admin:** Enable at least one photo provider (Immich or Synology Photos) in **Admin → Addons** — photo provider toggles appear as sub-items under the **Journey** addon. Once a provider is on, a Photo Providers section appears in each user's **Settings → Integrations**. If your provider runs on a local or private network, the server must be configured to allow internal network access. See [Admin-Addons](Admin-Addons) and [Internal-Network-Access](Internal-Network-Access).

---

## Supported providers

| Provider | Internal ID |
|----------|-------------|
| Immich | `immich` |
| Synology Photos | `synologyphotos` |

Both providers can be active at the same time.

---

## Configuring a provider

Go to **Settings → Integrations → Photo Providers**. Each enabled provider shows its own settings section.

<!-- TODO: screenshot: Photo Providers section in Settings > Integrations -->

### Immich

| Field | Required | Notes |
|-------|----------|-------|
| Server URL | Yes | Full URL of your Immich instance, e.g. `https://immich.example.com` |
| API Key | Yes | Stored encrypted; never returned to the browser after saving |
| Mirror journey photos to Immich on upload | No | Checkbox; when enabled, photos you upload in TREK are also pushed to your Immich library |

Enter the full URL of your Immich instance and an Immich API key. The API key is stored encrypted on the TREK server and is never returned to the browser after it is saved.

#### Required API key permissions

When generating the API key in Immich (**Account Settings → API Keys**), grant only the scopes TREK actually uses:

| Permission | Why TREK needs it |
|------------|-------------------|
| `user.read` | Verify the API key and identify the connected account |
| `timeline.read` | Browse photos by date |
| `asset.read` | Read photo metadata and search results |
| `asset.view` | Load thumbnails and preview images |
| `album.read` | List owned + shared albums and their contents |
| `asset.upload` | *Only if you enable "Mirror journey photos to Immich on upload"* — push TREK uploads back to your library |

TREK never modifies or deletes anything in Immich, so no `update`, `delete`, or admin scopes are needed.

### Synology Photos

| Field | Required | Notes |
|-------|----------|-------|
| Server URL | Yes | Full URL including the Photos app path, e.g. `https://your-nas:5001/photo` |
| Username | Yes | Synology account username |
| Password | Yes | Stored encrypted; leave blank to keep the existing password |
| OTP code | No | One-time password for 2FA; only needed on first connection or when re-authenticating |
| Skip SSL verification | No | Checkbox; disable TLS certificate validation for self-signed certificates |

#### Required DSM account permissions

Synology Photos doesn't use API keys — TREK signs in with a regular DSM user account. To minimize blast radius, create a **dedicated low-privilege DSM user** for TREK rather than reusing your admin account:

- A standard (non-admin) DSM user account is sufficient.
- The account must have access to the **Synology Photos** package (DSM → **Control Panel → User & Group → [user] → Applications**, allow Synology Photos).
- The account must be able to log in to DSM (not disabled, not IP-blocked).
- Network access to DSM (typically port `5000` HTTP / `5001` HTTPS, or your reverse-proxy host).
- 2FA is supported — enter the OTP at first connection; TREK stores the resulting device token so you won't be re-prompted on subsequent saves.
- Read-only access is enough — TREK only lists albums, lists items, runs searches, and fetches thumbnails. It never writes, uploads, or deletes.

---

## Testing the connection

Each provider section has a **Test Connection** button. Clicking it sends your current field values to the server and attempts to authenticate with the provider. A green "Connected" badge confirms success; any error message from the provider is shown if it fails.

For Synology, a successful test stores a session token so the OTP code is not required again on subsequent saves (as long as the URL and username remain the same).

---

## Multiple providers

You can configure both Immich and Synology simultaneously. TREK queries photos from all enabled providers when loading trip photos.

---

## After setup

Once a provider is connected, you can browse and attach photos to your trips. See [Documents-and-Files](Documents-and-Files) for how to manage files after setup.

---

## See also

- [Admin-Addons](Admin-Addons)
- [Internal-Network-Access](Internal-Network-Access)