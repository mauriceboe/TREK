import { db } from '../db/database';
import { maybe_encrypt_api_key, decrypt_api_key } from './apiKeyCrypto';
import { checkSsrf } from '../utils/ssrfGuard';
import { writeAudit } from './auditLog';

// ── Credentials ────────────────────────────────────────────────────────────

export function getImmichCredentials(userId: number) {
  const user = db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(userId) as any;
  if (!user?.immich_url || !user?.immich_api_key) return null;
  return { immich_url: user.immich_url as string, immich_api_key: decrypt_api_key(user.immich_api_key) as string };
}

/** Validate that an asset ID is a safe UUID-like string (no path traversal). */
export function isValidAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 100;
}

// ── Connection Settings ────────────────────────────────────────────────────

export function getConnectionSettings(userId: number) {
  const creds = getImmichCredentials(userId);
  return {
    immich_url: creds?.immich_url || '',
    connected: !!(creds?.immich_url && creds?.immich_api_key),
  };
}

export async function saveImmichSettings(
  userId: number,
  immichUrl: string | undefined,
  immichApiKey: string | undefined,
  clientIp: string | null
): Promise<{ success: boolean; warning?: string; error?: string }> {
  if (immichUrl) {
    const ssrf = await checkSsrf(immichUrl.trim());
    if (!ssrf.allowed) {
      return { success: false, error: `Invalid Immich URL: ${ssrf.error}` };
    }
    db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?').run(
      immichUrl.trim(),
      maybe_encrypt_api_key(immichApiKey),
      userId
    );
    if (ssrf.isPrivate) {
      writeAudit({
        userId,
        action: 'immich.private_ip_configured',
        ip: clientIp,
        details: { immich_url: immichUrl.trim(), resolved_ip: ssrf.resolvedIp },
      });
      return {
        success: true,
        warning: `Immich URL resolves to a private IP address (${ssrf.resolvedIp}). Make sure this is intentional.`,
      };
    }
  } else {
    db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?').run(
      null,
      maybe_encrypt_api_key(immichApiKey),
      userId
    );
  }
  return { success: true };
}

// ── Connection Test / Status ───────────────────────────────────────────────

export async function testConnection(
  immichUrl: string,
  immichApiKey: string
): Promise<{ connected: boolean; error?: string; user?: { name?: string; email?: string } }> {
  const ssrf = await checkSsrf(immichUrl);
  if (!ssrf.allowed) return { connected: false, error: ssrf.error ?? 'Invalid Immich URL' };
  try {
    const resp = await fetch(`${immichUrl}/api/users/me`, {
      headers: { 'x-api-key': immichApiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { connected: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as { name?: string; email?: string };
    return { connected: true, user: { name: data.name, email: data.email } };
  } catch (err: unknown) {
    return { connected: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export async function getConnectionStatus(
  userId: number
): Promise<{ connected: boolean; error?: string; user?: { name?: string; email?: string } }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { connected: false, error: 'Not configured' };
  try {
    const resp = await fetch(`${creds.immich_url}/api/users/me`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { connected: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as { name?: string; email?: string };
    return { connected: true, user: { name: data.name, email: data.email } };
  } catch (err: unknown) {
    return { connected: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// ── Browse Timeline / Search ───────────────────────────────────────────────

export async function browseTimeline(
  userId: number
): Promise<{ buckets?: any; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/timeline/buckets`, {
      method: 'GET',
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: 'Failed to fetch from Immich', status: resp.status };
    const buckets = await resp.json();
    return { buckets };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}

export async function searchPhotos(
  userId: number,
  from?: string,
  to?: string
): Promise<{ assets?: any[]; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    // Paginate through all results (Immich limits per-page to 1000)
    const allAssets: any[] = [];
    let page = 1;
    const pageSize = 1000;
    while (true) {
      const resp = await fetch(`${creds.immich_url}/api/search/metadata`, {
        method: 'POST',
        headers: { 'x-api-key': creds.immich_api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          takenAfter: from ? `${from}T00:00:00.000Z` : undefined,
          takenBefore: to ? `${to}T23:59:59.999Z` : undefined,
          type: 'IMAGE',
          size: pageSize,
          page,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { error: 'Search failed', status: resp.status };
      const data = await resp.json() as { assets?: { items?: any[] } };
      const items = data.assets?.items || [];
      allAssets.push(...items);
      if (items.length < pageSize) break; // Last page
      page++;
      if (page > 20) break; // Safety limit (20k photos max)
    }
    const assets = allAssets.map((a: any) => ({
      id: a.id,
      takenAt: a.fileCreatedAt || a.createdAt,
      city: a.exifInfo?.city || null,
      country: a.exifInfo?.country || null,
    }));
    return { assets };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}


// ── Asset Info / Proxy ─────────────────────────────────────────────────────

export async function getAssetInfo(
  userId: number,
  assetId: string
): Promise<{ data?: any; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Not found', status: 404 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { error: 'Failed', status: resp.status };
    const asset = await resp.json() as any;
    return {
      data: {
        id: asset.id,
        takenAt: asset.fileCreatedAt || asset.createdAt,
        width: asset.exifInfo?.exifImageWidth || null,
        height: asset.exifInfo?.exifImageHeight || null,
        camera: asset.exifInfo?.make && asset.exifInfo?.model ? `${asset.exifInfo.make} ${asset.exifInfo.model}` : null,
        lens: asset.exifInfo?.lensModel || null,
        focalLength: asset.exifInfo?.focalLength ? `${asset.exifInfo.focalLength}mm` : null,
        aperture: asset.exifInfo?.fNumber ? `f/${asset.exifInfo.fNumber}` : null,
        shutter: asset.exifInfo?.exposureTime || null,
        iso: asset.exifInfo?.iso || null,
        city: asset.exifInfo?.city || null,
        state: asset.exifInfo?.state || null,
        country: asset.exifInfo?.country || null,
        lat: asset.exifInfo?.latitude || null,
        lng: asset.exifInfo?.longitude || null,
        fileSize: asset.exifInfo?.fileSizeInByte || null,
        fileName: asset.originalFileName || null,
      },
    };
  } catch {
    return { error: 'Proxy error', status: 502 };
  }
}

export async function proxyThumbnail(
  userId: number,
  assetId: string
): Promise<{ buffer?: Buffer; contentType?: string; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Not found', status: 404 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}/thumbnail`, {
      headers: { 'x-api-key': creds.immich_api_key },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { error: 'Failed', status: resp.status };
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') || 'image/webp';
    return { buffer, contentType };
  } catch {
    return { error: 'Proxy error', status: 502 };
  }
}

export async function proxyOriginal(
  userId: number,
  assetId: string
): Promise<{ buffer?: Buffer; contentType?: string; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Not found', status: 404 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}/original`, {
      headers: { 'x-api-key': creds.immich_api_key },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return { error: 'Failed', status: resp.status };
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    return { buffer, contentType };
  } catch {
    return { error: 'Proxy error', status: 502 };
  }
}

// ── Albums ──────────────────────────────────────────────────────────────────

export async function listAlbums(
  userId: number
): Promise<{ albums?: any[]; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { error: 'Failed to fetch albums', status: resp.status };
    const albums = (await resp.json() as any[]).map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount || 0,
      startDate: a.startDate,
      endDate: a.endDate,
      albumThumbnailAssetId: a.albumThumbnailAssetId,
    }));
    return { albums };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}


export function createAlbumLink(
  tripId: string,
  userId: number,
  albumId: string,
  albumName: string
): { success: boolean; error?: string } {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, provider, album_id, album_name) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, userId, 'immich', albumId, albumName || '');
    return { success: true };
  } catch {
    return { success: false, error: 'Album already linked' };
  }
}

export async function syncAlbumAssets(
  tripId: string,
  linkId: string,
  userId: number
): Promise<{ success?: boolean; added?: number; total?: number; error?: string; status?: number }> {
  const link = db.prepare('SELECT * FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ? AND provider = ?')
    .get(linkId, tripId, userId, 'immich') as any;
  if (!link) return { error: 'Album link not found', status: 404 };

  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums/${link.album_id}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: 'Failed to fetch album', status: resp.status };
    const albumData = await resp.json() as { assets?: any[] };
    const assets = (albumData.assets || []).filter((a: any) => a.type === 'IMAGE');

    const insert = db.prepare("INSERT OR IGNORE INTO trip_photos (trip_id, user_id, asset_id, provider, shared) VALUES (?, ?, ?, 'immich', 1)");
    let added = 0;
    for (const asset of assets) {
      const r = insert.run(tripId, userId, asset.id);
      if (r.changes > 0) added++;
    }

    db.prepare('UPDATE trip_album_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);

    return { success: true, added, total: assets.length };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}
