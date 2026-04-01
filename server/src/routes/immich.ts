import express, { Request, Response, NextFunction } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import { consumeEphemeralToken } from '../services/ephemeralTokens';
import { maybe_encrypt_api_key, decrypt_api_key } from '../services/apiKeyCrypto';
import { checkSsrf } from '../utils/ssrfGuard';
import { writeAudit, getClientIp } from '../services/auditLog';

const router = express.Router();

function getImmichCredentials(userId: number) {
  const user = db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(userId) as any;
  if (!user?.immich_url || !user?.immich_api_key) return null;
  return { immich_url: user.immich_url as string, immich_api_key: decrypt_api_key(user.immich_api_key) as string };
}

/** Validate that an asset ID is a safe UUID-like string (no path traversal). */
function isValidAssetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 100;
}

// ── Immich Connection Settings ──────────────────────────────────────────────

router.get('/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const creds = getImmichCredentials(authReq.user.id);
  res.json({
    immich_url: creds?.immich_url || '',
    connected: !!(creds?.immich_url && creds?.immich_api_key),
  });
});

router.put('/settings', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { immich_url, immich_api_key } = req.body;

  if (immich_url) {
    const ssrf = await checkSsrf(immich_url.trim());
    if (!ssrf.allowed) {
      return res.status(400).json({ error: `Invalid Immich URL: ${ssrf.error}` });
    }
    db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?').run(
      immich_url.trim(),
      maybe_encrypt_api_key(immich_api_key),
      authReq.user.id
    );
    if (ssrf.isPrivate) {
      writeAudit({
        userId: authReq.user.id,
        action: 'immich.private_ip_configured',
        ip: getClientIp(req),
        details: { immich_url: immich_url.trim(), resolved_ip: ssrf.resolvedIp },
      });
      return res.json({
        success: true,
        warning: `Immich URL resolves to a private IP address (${ssrf.resolvedIp}). Make sure this is intentional.`,
      });
    }
  } else {
    db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?').run(
      null,
      maybe_encrypt_api_key(immich_api_key),
      authReq.user.id
    );
  }

  res.json({ success: true });
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) {
    return res.json({ connected: false, error: 'Not configured' });
  }
  try {
    const resp = await fetch(`${creds.immich_url}/api/users/me`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.json({ connected: false, error: `HTTP ${resp.status}` });
    const data = await resp.json() as { name?: string; email?: string };
    res.json({ connected: true, user: { name: data.name, email: data.email } });
  } catch (err: unknown) {
    res.json({ connected: false, error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// Test connection with provided credentials (without saving)
router.post('/test', authenticate, async (req: Request, res: Response) => {
  const { immich_url, immich_api_key } = req.body;
  if (!immich_url || !immich_api_key) return res.json({ connected: false, error: 'URL and API key required' });
  const ssrf = await checkSsrf(immich_url);
  if (!ssrf.allowed) return res.json({ connected: false, error: ssrf.error ?? 'Invalid Immich URL' });
  try {
    const resp = await fetch(`${immich_url}/api/users/me`, {
      headers: { 'x-api-key': immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.json({ connected: false, error: `HTTP ${resp.status}` });
    const data = await resp.json() as { name?: string; email?: string };
    res.json({ connected: true, user: { name: data.name, email: data.email } });
  } catch (err: unknown) {
    res.json({ connected: false, error: err instanceof Error ? err.message : 'Connection failed' });
  }
});

// ── Browse Immich Library (for photo picker) ────────────────────────────────

router.get('/browse', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { page = '1', size = '50' } = req.query;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/timeline/buckets`, {
      method: 'GET',
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch from Immich' });
    const buckets = await resp.json();
    res.json({ buckets });
  } catch (err: unknown) {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

// Search photos by date range (for the date-filter in picker)
router.post('/search', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { from, to } = req.body;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

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
      if (!resp.ok) return res.status(resp.status).json({ error: 'Search failed' });
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
    res.json({ assets });
  } catch {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

// ── Trip Photos (selected by user) ──────────────────────────────────────────

// Get all photos for a trip (own + shared by others)
router.get('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  const photos = db.prepare(`
    SELECT tp.immich_asset_id, tp.user_id, tp.shared, tp.added_at,
           u.username, u.avatar, u.immich_url
    FROM trip_photos tp
    JOIN users u ON tp.user_id = u.id
    WHERE tp.trip_id = ?
    AND (tp.user_id = ? OR tp.shared = 1)
    ORDER BY tp.added_at ASC
  `).all(tripId, authReq.user.id);

  res.json({ photos });
});

// Add photos to a trip
router.post('/trips/:tripId/photos', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  const { asset_ids, shared = true } = req.body;

  if (!Array.isArray(asset_ids) || asset_ids.length === 0) {
    return res.status(400).json({ error: 'asset_ids required' });
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, immich_asset_id, shared) VALUES (?, ?, ?, ?)'
  );
  let added = 0;
  for (const assetId of asset_ids) {
    const result = insert.run(tripId, authReq.user.id, assetId, shared ? 1 : 0);
    if (result.changes > 0) added++;
  }

  res.json({ success: true, added });
  broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);

  // Notify trip members about shared photos
  if (shared && added > 0) {
    import('../services/notifications').then(({ notifyTripMembers }) => {
      const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
      notifyTripMembers(Number(tripId), authReq.user.id, 'photos_shared', { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, count: String(added) }).catch(() => {});
    });
  }
});

// Remove a photo from a trip (own photos only)
router.delete('/trips/:tripId/photos/:assetId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  db.prepare('DELETE FROM trip_photos WHERE trip_id = ? AND user_id = ? AND immich_asset_id = ?')
    .run(req.params.tripId, authReq.user.id, req.params.assetId);
  res.json({ success: true });
  broadcast(req.params.tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

// Toggle sharing for a specific photo
router.put('/trips/:tripId/photos/:assetId/sharing', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  const { shared } = req.body;
  db.prepare('UPDATE trip_photos SET shared = ? WHERE trip_id = ? AND user_id = ? AND immich_asset_id = ?')
    .run(shared ? 1 : 0, req.params.tripId, authReq.user.id, req.params.assetId);
  res.json({ success: true });
  broadcast(req.params.tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
});

// ── Asset Details ───────────────────────────────────────────────────────────

router.get('/assets/:assetId/info', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });

  // Only allow accessing own Immich credentials — prevent leaking other users' API keys
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(404).json({ error: 'Not found' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed' });
    const asset = await resp.json() as any;
    res.json({
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
    });
  } catch {
    res.status(502).json({ error: 'Proxy error' });
  }
});

// ── Proxy Immich Assets ─────────────────────────────────────────────────────

// Asset proxy routes accept ephemeral token via query param (for <img> src usage)
function authFromQuery(req: Request, res: Response, next: NextFunction) {
  const queryToken = req.query.token as string | undefined;
  if (queryToken) {
    const userId = consumeEphemeralToken(queryToken, 'immich');
    if (!userId) return res.status(401).send('Invalid or expired token');
    const user = db.prepare('SELECT id, username, email, role, mfa_enabled FROM users WHERE id = ?').get(userId) as any;
    if (!user) return res.status(401).send('User not found');
    (req as AuthRequest).user = user;
    return next();
  }
  return (authenticate as any)(req, res, next);
}

router.get('/assets/:assetId/thumbnail', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');

  // Only allow accessing own Immich credentials — prevent leaking other users' API keys
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(404).send('Not found');

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}/thumbnail`, {
      headers: { 'x-api-key': creds.immich_api_key },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.status(resp.status).send('Failed');
    res.set('Content-Type', resp.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).send('Proxy error');
  }
});

router.get('/assets/:assetId/original', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');

  // Only allow accessing own Immich credentials — prevent leaking other users' API keys
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(404).send('Not found');

  try {
    const resp = await fetch(`${creds.immich_url}/api/assets/${assetId}/original`, {
      headers: { 'x-api-key': creds.immich_api_key },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return res.status(resp.status).send('Failed');
    res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).send('Proxy error');
  }
});

// ── Album Linking ──────────────────────────────────────────────────────────

// List user's Immich albums
router.get('/albums', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch albums' });
    const albums = (await resp.json() as any[]).map((a: any) => ({
      id: a.id,
      albumName: a.albumName,
      assetCount: a.assetCount || 0,
      startDate: a.startDate,
      endDate: a.endDate,
      albumThumbnailAssetId: a.albumThumbnailAssetId,
    }));
    res.json({ albums });
  } catch {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

// Get album links for a trip
router.get('/trips/:tripId/album-links', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.tripId, (authReq as AuthRequest).user.id)) return res.status(404).json({ error: 'Trip not found' });
  const links = db.prepare(`
    SELECT tal.*, u.username
    FROM trip_album_links tal
    JOIN users u ON tal.user_id = u.id
    WHERE tal.trip_id = ?
    ORDER BY tal.created_at ASC
  `).all(req.params.tripId);
  res.json({ links });
});

// Link an album to a trip
router.post('/trips/:tripId/album-links', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  const { album_id, album_name } = req.body;
  if (!album_id) return res.status(400).json({ error: 'album_id required' });

  try {
    db.prepare(
      'INSERT OR IGNORE INTO trip_album_links (trip_id, user_id, immich_album_id, album_name) VALUES (?, ?, ?, ?)'
    ).run(tripId, authReq.user.id, album_id, album_name || '');
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: 'Album already linked' });
  }
});

// Remove album link
router.delete('/trips/:tripId/album-links/:linkId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  db.prepare('DELETE FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
    .run(req.params.linkId, req.params.tripId, authReq.user.id);
  res.json({ success: true });
});

// Sync album — fetch all assets from Immich album and add missing ones to trip
router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, linkId } = req.params;

  const link = db.prepare('SELECT * FROM trip_album_links WHERE id = ? AND trip_id = ? AND user_id = ?')
    .get(linkId, tripId, authReq.user.id) as any;
  if (!link) return res.status(404).json({ error: 'Album link not found' });

  const creds = getImmichCredentials(authReq.user.id);
  if (!creds) return res.status(400).json({ error: 'Immich not configured' });

  try {
    const resp = await fetch(`${creds.immich_url}/api/albums/${link.immich_album_id}`, {
      headers: { 'x-api-key': creds.immich_api_key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch album' });
    const albumData = await resp.json() as { assets?: any[] };
    const assets = (albumData.assets || []).filter((a: any) => a.type === 'IMAGE');

    const insert = db.prepare(
      'INSERT OR IGNORE INTO trip_photos (trip_id, user_id, immich_asset_id, shared) VALUES (?, ?, ?, 1)'
    );
    let added = 0;
    for (const asset of assets) {
      const r = insert.run(tripId, authReq.user.id, asset.id);
      if (r.changes > 0) added++;
    }

    db.prepare('UPDATE trip_album_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);

    res.json({ success: true, added, total: assets.length });
    if (added > 0) {
      broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
    }
  } catch {
    res.status(502).json({ error: 'Could not reach Immich' });
  }
});

export default router;
