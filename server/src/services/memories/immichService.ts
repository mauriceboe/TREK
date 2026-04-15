import { Response } from 'express';
import { db } from '../../db/database';
import { maybe_encrypt_api_key, decrypt_api_key } from '../apiKeyCrypto';
import { checkSsrf, safeFetch } from '../../utils/ssrfGuard';
import { writeAudit } from '../auditLog';
import { addTripPhotos} from './unifiedService';
import { getAlbumIdFromLink, updateSyncTimeForAlbumLink, Selection, pipeAsset } from './helpersService';

// ── Credentials ────────────────────────────────────────────────────────────

export function getImmichCredentials(userId: number) {
  const user = db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(userId) as any;
  if (!user?.immich_url || !user?.immich_api_key) return null;
  const apiKey = decrypt_api_key(user.immich_api_key);
  if (!apiKey) return null;
  return { immich_url: user.immich_url as string, immich_api_key: apiKey };
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
): Promise<{ connected: boolean; error?: string; user?: { name?: string; email?: string }; canonicalUrl?: string }> {
  const ssrf = await checkSsrf(immichUrl);
  if (!ssrf.allowed) return { connected: false, error: ssrf.error ?? 'Invalid Immich URL' };
  try {
    const resp = await safeFetch(`${immichUrl}/api/users/me`, {
      headers: { 'x-api-key': immichApiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000) as any,
    });
    if (!resp.ok) return { connected: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as { name?: string; email?: string };

    // Detect http → https upgrade only: same host/port, protocol changed to https
    let canonicalUrl: string | undefined;
    if (resp.url) {
      const finalUrl = new URL(resp.url);
      const inputUrl = new URL(immichUrl);
      if (
        inputUrl.protocol === 'http:' &&
        finalUrl.protocol === 'https:' &&
        finalUrl.hostname === inputUrl.hostname &&
        finalUrl.port === inputUrl.port
      ) {
        canonicalUrl = finalUrl.origin;
      }
    }

    return { connected: true, user: { name: data.name, email: data.email }, canonicalUrl };
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
    const resp = await safeFetch(`${creds.immich_url}/api/users/me`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000) as any,
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
    const resp = await safeFetch(`${creds.immich_url}/api/timeline/buckets`, {
      method: 'GET',
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000) as any,
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
  to?: string,
  page: number = 1,
  size: number = 50,
): Promise<{ assets?: any[]; hasMore?: boolean; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await safeFetch(`${creds.immich_url}/api/search/metadata`, {
      method: 'POST',
      headers: { 'x-api-key': creds.immich_api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        takenAfter: from ? `${from}T00:00:00.000Z` : undefined,
        takenBefore: to ? `${to}T23:59:59.999Z` : undefined,
        type: 'IMAGE',
        size,
        page,
      }),
      signal: AbortSignal.timeout(15000) as any,
    });
    if (!resp.ok) return { error: 'Search failed', status: resp.status };
    const data = await resp.json() as { assets?: { items?: any[] } };
    const items = data.assets?.items || [];
    const assets = items.map((a: any) => ({
      id: a.id,
      takenAt: a.fileCreatedAt || a.createdAt,
      city: a.exifInfo?.city || null,
      country: a.exifInfo?.country || null,
    }));
    return { assets, hasMore: items.length >= size };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}


// ── Asset Info / Proxy ─────────────────────────────────────────────────────


export async function getAssetInfo(
  userId: number,
  assetId: string,
  ownerUserId?: number
): Promise<{ data?: any; error?: string; status?: number }> {
  const effectiveUserId = ownerUserId ?? userId;
  const creds = getImmichCredentials(effectiveUserId);
  if (!creds) return { error: 'Not found', status: 404 };

  try {
    const resp = await safeFetch(`${creds.immich_url}/api/assets/${assetId}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000) as any,
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

export async function streamImmichAsset(
  response: Response,
  userId: number,
  assetId: string,
  kind: 'thumbnail' | 'original',
  ownerUserId?: number
): Promise<{ error?: string; status?: number } | void> {
  const effectiveUserId = ownerUserId ?? userId;
  const creds = getImmichCredentials(effectiveUserId);
  if (!creds) return { error: 'Not found', status: 404 };

  const timeout = kind === 'thumbnail' ? 10000 : 30000;
  const url = kind === 'thumbnail'
    ? `${creds.immich_url}/api/assets/${assetId}/thumbnail?size=thumbnail`
    : `${creds.immich_url}/api/assets/${assetId}/thumbnail?size=fullsize`;

  response.set('Cache-Control', 'public, max-age=86400');
  await pipeAsset(url, response, { 'x-api-key': creds.immich_api_key }, AbortSignal.timeout(timeout));
}

// ── Albums ──────────────────────────────────────────────────────────────────

export async function listAlbums(
  userId: number
): Promise<{ albums?: any[]; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    // Fetch both owned and shared albums
    const [ownResp, sharedResp] = await Promise.all([
      safeFetch(`${creds.immich_url}/api/albums`, {
        headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000) as any,
      }),
      safeFetch(`${creds.immich_url}/api/albums?shared=true`, {
        headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000) as any,
      }),
    ]);
    if (!ownResp.ok) return { error: 'Failed to fetch albums', status: ownResp.status };
    const ownAlbums = await ownResp.json() as any[];
    const sharedAlbums = sharedResp.ok ? await sharedResp.json() as any[] : [];
    const seenIds = new Set<string>();
    const allAlbums = [...ownAlbums, ...sharedAlbums].filter((a: any) => {
      if (seenIds.has(a.id)) return false;
      seenIds.add(a.id);
      return true;
    });
    const albums = allAlbums.map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount || 0,
      startDate: a.startDate,
      endDate: a.endDate,
      albumThumbnailAssetId: a.albumThumbnailAssetId,
      shared: a.shared || a.sharedUsers?.length > 0,
    }));
    return { albums };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}

export async function getAlbumPhotos(
  userId: number,
  albumId: string,
): Promise<{ assets?: any[]; error?: string; status?: number }> {
  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await safeFetch(`${creds.immich_url}/api/albums/${albumId}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000) as any,
    });
    if (!resp.ok) return { error: 'Failed to fetch album', status: resp.status };
    const albumData = await resp.json() as { assets?: any[] };
    const assets = (albumData.assets || []).filter((a: any) => a.type === 'IMAGE').map((a: any) => ({
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

export function listAlbumLinks(tripId: string) {
  return db.prepare(`
    SELECT tal.*, u.username
    FROM trip_album_links tal
    JOIN users u ON tal.user_id = u.id
    WHERE tal.trip_id = ?
    ORDER BY tal.created_at ASC
  `).all(tripId);
}

export function createAlbumLink(
  tripId: string,
  userId: number,
  albumId: string,
  albumName: string
): { success: boolean; error?: string } {
  try {
    db.prepare(
      "INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, album_id, album_name, provider) VALUES (?, ?, ?, ?, 'immich')"
    ).run(tripId, userId, albumId, albumName || '');
    return { success: true };
  } catch {
    return { success: false, error: 'Album already linked' };
  }
}

export function deleteAlbumLink(linkId: string, tripId: string, userId: number) {
  db.transaction(() => {
    const link = db.prepare('SELECT id FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?').get(linkId, tripId, userId);
    if (link) {
      db.prepare('DELETE FROM trip_photos WHERE trip_id = ? AND album_link_id = ?').run(tripId, linkId);
      db.prepare('DELETE FROM trip_album_links WHERE id = ?').run(linkId);
    }
  })();
}

export async function syncAlbumAssets(
  tripId: string,
  linkId: string,
  userId: number,
  sid: string,
): Promise<{ success?: boolean; added?: number; total?: number; error?: string; status?: number }> {
  const response = getAlbumIdFromLink(tripId, linkId, userId);
  if (!response.success) return { error: 'Album link not found', status: 404 };

  const creds = getImmichCredentials(userId);
  if (!creds) return { error: 'Immich not configured', status: 400 };

  try {
    const resp = await safeFetch(`${creds.immich_url}/api/albums/${response.data}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000) as any,
    });
    if (!resp.ok) return { error: 'Failed to fetch album', status: resp.status };
    const albumData = await resp.json() as { assets?: any[] };
    const assets = (albumData.assets || []).filter((a: any) => a.type === 'IMAGE');

    const selection: Selection = {
      provider: 'immich',
      asset_ids: assets.map((a: any) => a.id),
    };

    const result = await addTripPhotos(tripId, userId, true, [selection], sid, linkId);
    if ('error' in result) return { error: result.error.message, status: result.error.status };

    updateSyncTimeForAlbumLink(linkId);

    return { success: true, added: result.data.added, total: assets.length };
  } catch {
    return { error: 'Could not reach Immich', status: 502 };
  }
}

// ── Upload to Immich ──────────────────────────────────────────────────────

export async function uploadToImmich(userId: number, filePath: string, fileName: string): Promise<string | null> {
  const creds = getImmichCredentials(userId);
  if (!creds) return null;

  const fs = await import('node:fs');
  const path = await import('node:path');

  const fullPath = path.join(__dirname, '../../../uploads', filePath);
  if (!fs.existsSync(fullPath)) return null;

  try {
    const fileBuffer = fs.readFileSync(fullPath);
    const boundary = '----ImmichUpload' + Date.now();
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const now = new Date().toISOString();

    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    addField('deviceAssetId', `trek-${Date.now()}`);
    addField('deviceId', 'TREK');
    addField('fileCreatedAt', now);
    addField('fileModifiedAt', now);

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await safeFetch(`${creds.immich_url}/api/assets`, {
      method: 'POST',
      headers: {
        'x-api-key': creds.immich_api_key,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    if (res.ok) {
      const data = await res.json() as { id?: string };
      return data.id || null;
    }
    return null;
  } catch {
    return null;
  }
}
