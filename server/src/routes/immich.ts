import express, { Request, Response, NextFunction } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import { consumeEphemeralToken } from '../services/ephemeralTokens';
import { getClientIp } from '../services/auditLog';
import {
  getConnectionSettings,
  saveImmichSettings,
  testConnection,
  getConnectionStatus,
  browseTimeline,
  searchPhotos,
  proxyThumbnail,
  proxyOriginal,
  isValidAssetId,
  listAlbums,
  createAlbumLink,
  syncAlbumAssets,
  getAssetInfo,
} from '../services/immichService';

const router = express.Router();

// ── Dual auth middleware (JWT or ephemeral token for <img> src) ─────────────
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

// ── Immich Connection Settings ─────────────────────────────────────────────

router.get('/settings', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(getConnectionSettings(authReq.user.id));
});

router.put('/settings', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { immich_url, immich_api_key } = req.body;
  const result = await saveImmichSettings(authReq.user.id, immich_url, immich_api_key, getClientIp(req));
  if (!result.success) return res.status(400).json({ error: result.error });
  if (result.warning) return res.json({ success: true, warning: result.warning });
  res.json({ success: true });
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  res.json(await getConnectionStatus(authReq.user.id));
});

router.post('/test', authenticate, async (req: Request, res: Response) => {
  const { immich_url, immich_api_key } = req.body;
  if (!immich_url || !immich_api_key) return res.json({ connected: false, error: 'URL and API key required' });
  res.json(await testConnection(immich_url, immich_api_key));
});

// ── Browse Immich Library (for photo picker) ───────────────────────────────

router.get('/browse', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await browseTimeline(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ buckets: result.buckets });
});

router.post('/search', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { from, to } = req.body;
  const result = await searchPhotos(authReq.user.id, from, to);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ assets: result.assets });
});

// ── Asset Details ──────────────────────────────────────────────────────────

router.get('/assets/:assetId/info', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });
  const result = await getAssetInfo(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json(result.data);
});

// ── Proxy Immich Assets ────────────────────────────────────────────────────

router.get('/assets/:assetId/thumbnail', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');
  const result = await proxyThumbnail(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).send(result.error);
  res.set('Content-Type', result.contentType!);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
});

router.get('/assets/:assetId/original', authFromQuery, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { assetId } = req.params;
  if (!isValidAssetId(assetId)) return res.status(400).send('Invalid asset ID');
  const result = await proxyOriginal(authReq.user.id, assetId);
  if (result.error) return res.status(result.status!).send(result.error);
  res.set('Content-Type', result.contentType!);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(result.buffer);
});

// ── Album Linking ──────────────────────────────────────────────────────────

router.get('/albums', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await listAlbums(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ albums: result.albums });
});

router.post('/trips/:tripId/album-links', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!canAccessTrip(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });
  const { album_id, album_name } = req.body;
  if (!album_id) return res.status(400).json({ error: 'album_id required' });
  const result = createAlbumLink(tripId, authReq.user.id, album_id, album_name);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, linkId } = req.params;
  const result = await syncAlbumAssets(tripId, linkId, authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true, added: result.added, total: result.total });
  if (result.added! > 0) {
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
  }
});

export default router;
