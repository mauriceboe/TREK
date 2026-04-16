import express, { Request, Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import {
    getSynologySettings,
    updateSynologySettings,
    getSynologyStatus,
    testSynologyConnection,
    listSynologyAlbums,
    getSynologyAlbumPhotos,
    syncSynologyAlbumLink,
    searchSynologyPhotos,
    getSynologyAssetInfo,
    streamSynologyAsset,
} from '../../services/memories/synologyService';
import { canAccessUserPhoto, handleServiceResult, fail, success } from '../../services/memories/helpersService';

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
    const synology_skip_ssl = body.synology_skip_ssl === true || body.synology_skip_ssl === 'true';

    if (!synology_url || !synology_username) {
        handleServiceResult(res, fail('URL and username are required', 400));
    }
    else {
        handleServiceResult(res, await updateSynologySettings(authReq.user.id, synology_url, synology_username, synology_password, synology_skip_ssl));
    }
});

router.get('/status', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await getSynologyStatus(authReq.user.id));
});

router.post('/test', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const synology_url = _parseStringBodyField(body.synology_url);
    const synology_username = _parseStringBodyField(body.synology_username);
    const synology_password = _parseStringBodyField(body.synology_password);
    const synology_otp = _parseStringBodyField(body.synology_otp);
    const synology_skip_ssl = body.synology_skip_ssl === true || body.synology_skip_ssl === 'true';

    if (!synology_url || !synology_username || !synology_password) {
        const missingFields: string[] = [];
        if (!synology_url) missingFields.push('URL');
        if (!synology_username) missingFields.push('Username');
        if (!synology_password) missingFields.push('Password');
        handleServiceResult(res, success({ connected: false, error: `${missingFields.join(', ')} ${missingFields.length > 1 ? 'are' : 'is'} required` }));
    }
    else{
        handleServiceResult(res, await testSynologyConnection(authReq.user.id, synology_url, synology_username, synology_password, synology_otp, synology_skip_ssl));
    }
});

router.get('/albums', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await listSynologyAlbums(authReq.user.id));
});

router.get('/albums/:albumId/photos', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    handleServiceResult(res, await getSynologyAlbumPhotos(authReq.user.id, req.params.albumId));
});

router.post('/trips/:tripId/album-links/:linkId/sync', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const { tripId, linkId } = req.params;
    const sid = req.headers['x-socket-id'] as string;

    handleServiceResult(res, await syncSynologyAlbumLink(authReq.user.id, tripId, linkId, sid));
});

router.post('/search', authenticate, async (req: Request, res: Response) => {
    const authReq = req as AuthRequest;
    const body = req.body as Record<string, unknown>;
    const from = _parseStringBodyField(body.from);
    const to = _parseStringBodyField(body.to);
    let offset = _parseNumberBodyField(body.offset, 0);
    const page = _parseNumberBodyField(body.page, 1) - 1;
    let limit = _parseNumberBodyField(body.limit, 100);
    const size = _parseNumberBodyField(body.size, 0);
    if(size > 0) limit = size;
    if(page > 0) offset = page*limit;

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
    const VALID_SIZES = ['sm', 'm', 'xl'] as const;
    const rawSize = String(req.query.size ?? 'sm');
    const size = VALID_SIZES.includes(rawSize as any) ? rawSize : 'sm';

    if (kind !== 'thumbnail' && kind !== 'original') {
        return handleServiceResult(res, fail('Invalid asset kind', 400));
    }

    if (!canAccessUserPhoto(authReq.user.id, Number(ownerId), tripId, photoId, 'synologyphotos')) {
        handleServiceResult(res, fail('You don\'t have access to this photo', 403));
    }
    else{
        await streamSynologyAsset(res, authReq.user.id, Number(ownerId), photoId, kind as 'thumbnail' | 'original', String(size));
    }

});

export default router;
