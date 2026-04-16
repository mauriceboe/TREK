import express, { Request, Response } from 'express';
import { canAccessTrip } from '../../db/database';
import { authenticate } from '../../middleware/auth';
import { broadcast } from '../../websocket';
import { AuthRequest } from '../../types';
import { getClientIp } from '../../services/auditLog';
import {
  getConnectionSettings,
  saveImmichSettings,
  testConnection,
  getConnectionStatus,
  browseTimeline,
  searchPhotos,
  streamImmichAsset,
  listAlbums,
  getAlbumPhotos,
  syncAlbumAssets,
  getAssetInfo,
  isValidAssetId,
} from '../../services/memories/immichService';
import { canAccessUserPhoto } from '../../services/memories/helpersService';

const router = express.Router();

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
  const { from, to, size, page } = req.body;
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(Number(size) || 50, 200);
  const result = await searchPhotos(authReq.user.id, from, to, pageNum, pageSize);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ assets: result.assets || [], hasMore: !!result.hasMore });
});

// ── Asset Details ──────────────────────────────────────────────────────────

router.get('/assets/:tripId/:assetId/:ownerId/info', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, assetId, ownerId } = req.params;

  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });
  if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, assetId, 'immich')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const result = await getAssetInfo(authReq.user.id, assetId, Number(ownerId));
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json(result.data);
});

// ── Proxy Immich Assets ────────────────────────────────────────────────────

router.get('/assets/:tripId/:assetId/:ownerId/thumbnail', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, assetId, ownerId } = req.params;

  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });
  if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, assetId, 'immich')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await streamImmichAsset(res, authReq.user.id, assetId, 'thumbnail', Number(ownerId));
});

router.get('/assets/:tripId/:assetId/:ownerId/original', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, assetId, ownerId } = req.params;

  if (!isValidAssetId(assetId)) return res.status(400).json({ error: 'Invalid asset ID' });
  if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, assetId, 'immich')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await streamImmichAsset(res, authReq.user.id, assetId, 'original', Number(ownerId));
});

// ── Album Linking ──────────────────────────────────────────────────────────

router.get('/albums', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await listAlbums(authReq.user.id);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ albums: result.albums });
});

router.get('/albums/:albumId/photos', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const result = await getAlbumPhotos(authReq.user.id, req.params.albumId);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ assets: result.assets });
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, linkId } = req.params;
  const sid = req.headers['x-socket-id'] as string;
  const result = await syncAlbumAssets(tripId, linkId, authReq.user.id, sid);
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ success: true, added: result.added, total: result.total });
  if (result.added! > 0) {
    broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
  }
});

export default router;
