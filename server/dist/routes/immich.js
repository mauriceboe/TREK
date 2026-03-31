"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const websocket_1 = require("../websocket");
const router = express_1.default.Router();
// ── Immich Connection Settings ──────────────────────────────────────────────
router.get('/settings', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(authReq.user.id);
    res.json({
        immich_url: user?.immich_url || '',
        connected: !!(user?.immich_url && user?.immich_api_key),
    });
});
router.put('/settings', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { immich_url, immich_api_key } = req.body;
    database_1.db.prepare('UPDATE users SET immich_url = ?, immich_api_key = ? WHERE id = ?').run(immich_url?.trim() || null, immich_api_key?.trim() || null, authReq.user.id);
    res.json({ success: true });
});
router.get('/status', auth_1.authenticate, async (req, res) => {
    const authReq = req;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (!user?.immich_url || !user?.immich_api_key) {
        return res.json({ connected: false, error: 'Not configured' });
    }
    try {
        const resp = await fetch(`${user.immich_url}/api/users/me`, {
            headers: { 'x-api-key': user.immich_api_key, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok)
            return res.json({ connected: false, error: `HTTP ${resp.status}` });
        const data = await resp.json();
        res.json({ connected: true, user: { name: data.name, email: data.email } });
    }
    catch (err) {
        res.json({ connected: false, error: err instanceof Error ? err.message : 'Connection failed' });
    }
});
// ── Browse Immich Library (for photo picker) ────────────────────────────────
router.get('/browse', auth_1.authenticate, async (req, res) => {
    const authReq = req;
    const { page = '1', size = '50' } = req.query;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (!user?.immich_url || !user?.immich_api_key)
        return res.status(400).json({ error: 'Immich not configured' });
    try {
        const resp = await fetch(`${user.immich_url}/api/timeline/buckets`, {
            method: 'GET',
            headers: { 'x-api-key': user.immich_api_key, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok)
            return res.status(resp.status).json({ error: 'Failed to fetch from Immich' });
        const buckets = await resp.json();
        res.json({ buckets });
    }
    catch (err) {
        res.status(502).json({ error: 'Could not reach Immich' });
    }
});
// Search photos by date range (for the date-filter in picker)
router.post('/search', auth_1.authenticate, async (req, res) => {
    const authReq = req;
    const { from, to } = req.body;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(authReq.user.id);
    if (!user?.immich_url || !user?.immich_api_key)
        return res.status(400).json({ error: 'Immich not configured' });
    try {
        const resp = await fetch(`${user.immich_url}/api/search/metadata`, {
            method: 'POST',
            headers: { 'x-api-key': user.immich_api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                takenAfter: from ? `${from}T00:00:00.000Z` : undefined,
                takenBefore: to ? `${to}T23:59:59.999Z` : undefined,
                type: 'IMAGE',
                size: 200,
            }),
            signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok)
            return res.status(resp.status).json({ error: 'Search failed' });
        const data = await resp.json();
        const assets = (data.assets?.items || []).map((a) => ({
            id: a.id,
            takenAt: a.fileCreatedAt || a.createdAt,
            city: a.exifInfo?.city || null,
            country: a.exifInfo?.country || null,
        }));
        res.json({ assets });
    }
    catch {
        res.status(502).json({ error: 'Could not reach Immich' });
    }
});
// ── Trip Photos (selected by user) ──────────────────────────────────────────
// Get all photos for a trip (own + shared by others)
router.get('/trips/:tripId/photos', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const photos = database_1.db.prepare(`
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
router.post('/trips/:tripId/photos', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { tripId } = req.params;
    const { asset_ids, shared = true } = req.body;
    if (!Array.isArray(asset_ids) || asset_ids.length === 0) {
        return res.status(400).json({ error: 'asset_ids required' });
    }
    const insert = database_1.db.prepare('INSERT OR IGNORE INTO trip_photos (trip_id, user_id, immich_asset_id, shared) VALUES (?, ?, ?, ?)');
    let added = 0;
    for (const assetId of asset_ids) {
        const result = insert.run(tripId, authReq.user.id, assetId, shared ? 1 : 0);
        if (result.changes > 0)
            added++;
    }
    res.json({ success: true, added });
    (0, websocket_1.broadcast)(tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id']);
});
// Remove a photo from a trip (own photos only)
router.delete('/trips/:tripId/photos/:assetId', auth_1.authenticate, (req, res) => {
    const authReq = req;
    database_1.db.prepare('DELETE FROM trip_photos WHERE trip_id = ? AND user_id = ? AND immich_asset_id = ?')
        .run(req.params.tripId, authReq.user.id, req.params.assetId);
    res.json({ success: true });
    (0, websocket_1.broadcast)(req.params.tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id']);
});
// Toggle sharing for a specific photo
router.put('/trips/:tripId/photos/:assetId/sharing', auth_1.authenticate, (req, res) => {
    const authReq = req;
    const { shared } = req.body;
    database_1.db.prepare('UPDATE trip_photos SET shared = ? WHERE trip_id = ? AND user_id = ? AND immich_asset_id = ?')
        .run(shared ? 1 : 0, req.params.tripId, authReq.user.id, req.params.assetId);
    res.json({ success: true });
    (0, websocket_1.broadcast)(req.params.tripId, 'memories:updated', { userId: authReq.user.id }, req.headers['x-socket-id']);
});
// ── Asset Details ───────────────────────────────────────────────────────────
router.get('/assets/:assetId/info', auth_1.authenticate, async (req, res) => {
    const authReq = req;
    const { assetId } = req.params;
    const { userId } = req.query;
    const targetUserId = userId ? Number(userId) : authReq.user.id;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(targetUserId);
    if (!user?.immich_url || !user?.immich_api_key)
        return res.status(404).json({ error: 'Not found' });
    try {
        const resp = await fetch(`${user.immich_url}/api/assets/${assetId}`, {
            headers: { 'x-api-key': user.immich_api_key, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok)
            return res.status(resp.status).json({ error: 'Failed' });
        const asset = await resp.json();
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
    }
    catch {
        res.status(502).json({ error: 'Proxy error' });
    }
});
// ── Proxy Immich Assets ─────────────────────────────────────────────────────
// Asset proxy routes accept token via query param (for <img> src usage)
function authFromQuery(req, res, next) {
    const token = req.query.token;
    if (token && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${token}`;
    }
    return auth_1.authenticate(req, res, next);
}
router.get('/assets/:assetId/thumbnail', authFromQuery, async (req, res) => {
    const authReq = req;
    const { assetId } = req.params;
    const { userId } = req.query;
    const targetUserId = userId ? Number(userId) : authReq.user.id;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(targetUserId);
    if (!user?.immich_url || !user?.immich_api_key)
        return res.status(404).send('Not found');
    try {
        const resp = await fetch(`${user.immich_url}/api/assets/${assetId}/thumbnail`, {
            headers: { 'x-api-key': user.immich_api_key },
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok)
            return res.status(resp.status).send('Failed');
        res.set('Content-Type', resp.headers.get('content-type') || 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(await resp.arrayBuffer());
        res.send(buffer);
    }
    catch {
        res.status(502).send('Proxy error');
    }
});
router.get('/assets/:assetId/original', authFromQuery, async (req, res) => {
    const authReq = req;
    const { assetId } = req.params;
    const { userId } = req.query;
    const targetUserId = userId ? Number(userId) : authReq.user.id;
    const user = database_1.db.prepare('SELECT immich_url, immich_api_key FROM users WHERE id = ?').get(targetUserId);
    if (!user?.immich_url || !user?.immich_api_key)
        return res.status(404).send('Not found');
    try {
        const resp = await fetch(`${user.immich_url}/api/assets/${assetId}/original`, {
            headers: { 'x-api-key': user.immich_api_key },
            signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok)
            return res.status(resp.status).send('Failed');
        res.set('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(await resp.arrayBuffer());
        res.send(buffer);
    }
    catch {
        res.status(502).send('Proxy error');
    }
});
exports.default = router;
//# sourceMappingURL=immich.js.map