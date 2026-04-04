import express, { Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import {
    getSynologySettings,
    updateSynologySettings,
    getSynologyStatus,
    testSynologyConnection,
    listSynologyAlbums,
    syncSynologyAlbumLink,
    searchSynologyPhotos,
    getSynologyAssetInfo,
    streamSynologyAsset,
} from '../../services/memories/synologyService';
import { canAccessUserPhoto, handleServiceResult, fail } from '../../services/memories/helpersService';

const router = express.Router();

function _parseStringBodyField(value: unknown): string {
    return String(value ?? '').trim();
}

function _parseNumberBodyField(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

router.get('/settings', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await getSynologySettings(authReq.user.id));
});

router.put('/settings', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const synology_url = _parseStringBodyField(body.synology_url);
    const synology_username = _parseStringBodyField(body.synology_username);
    const synology_password = _parseStringBodyField(body.synology_password);

    if (!synology_url || !synology_username) {
        handleServiceResult(res, fail('URL and username are required', 400));
    }
    else {
        handleServiceResult(res, await updateSynologySettings(authReq.user.id, synology_url, synology_username, synology_password));
    }
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await getSynologyStatus(authReq.user.id));
});

router.post('/test', authenticate, async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const synology_url = _parseStringBodyField(body.synology_url);
    const synology_username = _parseStringBodyField(body.synology_username);
    const synology_password = _parseStringBodyField(body.synology_password);

    if (!synology_url || !synology_username || !synology_password) {
        handleServiceResult(res, fail('URL, username, and password are required', 400));
    }
    else{
        handleServiceResult(res, await testSynologyConnection(synology_url, synology_username, synology_password));
    }
});

router.get('/albums', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await listSynologyAlbums(authReq.user.id));
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;
    const sid = req.headers['x-socket-id'] as string;

    handleServiceResult(res, await syncSynologyAlbumLink(authReq.user.id, tripId, sid, linkId));
});

router.post('/search', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const from = _parseStringBodyField(body.from);
    const to = _parseStringBodyField(body.to);
    const offset = _parseNumberBodyField(body.offset, 0);
    const limit = _parseNumberBodyField(body.limit, 100);

    handleServiceResult(res, await searchSynologyPhotos(
        authReq.user.id,
        from || undefined,
        to || undefined,
        offset,
        limit,
    ));
});

router.get('/assets/:tripId/:photoId/:ownerId/info', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, photoId, ownerId } = req.params;

    if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, photoId, 'synologyphotos')) {
        handleServiceResult(res, fail('You don\'t have access to this photo', 403));
    }
    else {
        handleServiceResult(res, await getSynologyAssetInfo(authReq.user.id, photoId, Number(ownerId)));
    }
});

router.get('/assets/:tripId/:photoId/:ownerId/:kind', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, photoId, ownerId, kind } = req.params;
    const { size = "sm" } = req.query;

    if (kind !== 'thumbnail' && kind !== 'original') {
        handleServiceResult(res, fail('Invalid asset kind', 400));
    }

    if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, photoId, 'synologyphotos')) {
        handleServiceResult(res, fail('You don\'t have access to this photo', 403));
    }
    else{
        await streamSynologyAsset(res, authReq.user.id, Number(ownerId), photoId, kind as 'thumbnail' | 'original', String(size));
    }

});

export default router;
