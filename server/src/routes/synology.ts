import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import {
    getSynologySettings,
    updateSynologySettings,
    getSynologyStatus,
    testSynologyConnection,
    listSynologyAlbums,
    linkSynologyAlbum,
    syncSynologyAlbumLink,
    searchSynologyPhotos,
    getSynologyAssetInfo,
    pipeSynologyProxy,
    synologyAuthFromQuery,
    getSynologyTargetUserId,
    streamSynologyAsset,
    handleSynologyError,
    SynologyServiceError,
} from '../services/synologyService';

const router = express.Router();

function parseStringBodyField(value: unknown): string {
    return String(value ?? '').trim();
}

function parseNumberBodyField(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

router.get('/settings', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    try {
        res.json(await getSynologySettings(authReq.user.id));
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Failed to load settings');
    }
});

router.put('/settings', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const synology_url = parseStringBodyField(body.synology_url);
    const synology_username = parseStringBodyField(body.synology_username);
    const synology_password = parseStringBodyField(body.synology_password);

    if (!synology_url || !synology_username) {
        return handleSynologyError(res, new SynologyServiceError(400, 'URL and username are required'), 'Missing required fields');
    }

    try {
        await updateSynologySettings(authReq.user.id, synology_url, synology_username, synology_password);
        res.json({ success: true });
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Failed to save settings');
    }
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    res.json(await getSynologyStatus(authReq.user.id));
});

router.post('/test', authenticate, async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const synology_url = parseStringBodyField(body.synology_url);
    const synology_username = parseStringBodyField(body.synology_username);
    const synology_password = parseStringBodyField(body.synology_password);

    if (!synology_url || !synology_username || !synology_password) {
        return handleSynologyError(res, new SynologyServiceError(400, 'URL, username and password are required'), 'Missing required fields');
    }

    res.json(await testSynologyConnection(synology_url, synology_username, synology_password));
});

router.get('/albums', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    try {
        res.json(await listSynologyAlbums(authReq.user.id));
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Could not reach Synology');
    }
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;

    try {
        const result = await syncSynologyAlbumLink(authReq.user.id, tripId, linkId);
        res.json({ success: true, ...result });
        if (result.added > 0) {
            broadcast(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id'] as string);
        }
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Could not reach Synology');
    }
});

router.post('/search', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const from = parseStringBodyField(body.from);
    const to = parseStringBodyField(body.to);
    const offset = parseNumberBodyField(body.offset, 0);
    const limit = parseNumberBodyField(body.limit, 300);

    try {
        const result = await searchSynologyPhotos(
            authReq.user.id,
            from || undefined,
            to || undefined,
            offset,
            limit,
        );
        res.json(result);
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Could not reach Synology');
    }
});

router.get('/assets/:photoId/info', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { photoId } = req.params;

    try {
        res.json(await getSynologyAssetInfo(authReq.user.id, photoId, getSynologyTargetUserId(req)));
    } catch (err: unknown) {
        handleSynologyError(res, err, 'Could not reach Synology');
    }
});

router.get('/assets/:photoId/thumbnail', synologyAuthFromQuery, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { photoId } = req.params;
    const { size = 'sm' } = req.query;

    try {
        const proxy = await streamSynologyAsset(authReq.user.id, getSynologyTargetUserId(req), photoId, 'thumbnail', String(size));
        await pipeSynologyProxy(res, proxy);
    } catch (err: unknown) {
        if (res.headersSent) {
            return;
        }
        handleSynologyError(res, err, 'Proxy error');
    }
});

router.get('/assets/:photoId/original', synologyAuthFromQuery, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { photoId } = req.params;

    try {
        const proxy = await streamSynologyAsset(authReq.user.id, getSynologyTargetUserId(req), photoId, 'original');
        await pipeSynologyProxy(res, proxy);
    } catch (err: unknown) {
        if (res.headersSent) {
            return;
        }
        handleSynologyError(res, err, 'Proxy error');
    }
});

export default router;
