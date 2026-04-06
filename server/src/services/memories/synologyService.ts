
import { Response } from 'express';
import { db } from '../../db/database';
import { decrypt_api_key, encrypt_api_key, maybe_encrypt_api_key } from '../apiKeyCrypto';
import { safeFetch, SsrfBlockedError, checkSsrf } from '../../utils/ssrfGuard';
import { addTripPhotos } from './unifiedService';
import {
    getAlbumIdFromLink,
    updateSyncTimeForAlbumLink,
    Selection,
    ServiceResult,
    fail,
    success,
    handleServiceResult,
    pipeAsset,
    AlbumsList,
    AssetsList,
    StatusResult,
    SyncAlbumResult,
    AssetInfo
} from './helpersService';

const SYNOLOGY_PROVIDER = 'synologyphotos';
const SYNOLOGY_ENDPOINT_PATH = '/webapi/entry.cgi';

const ERROR_MESSAGES: Record<number, string> = {
  101: 'Missing API, method, or version parameter.',
  102: 'Requested API does not exist.',
  103: 'Requested method does not exist.',
  104: 'Requested API version is not supported.',
  105: 'Insufficient privilege.',
  106: 'Connection timeout.',
  107: 'Multiple logins blocked from this IP.',
  117: 'Manager privilege required.',
  119: 'Session is invalid or expired.',
  400: 'Authentication failed.',
  401: 'Session expired or account disabled.',
  402: 'No permission to use this account.',
  403: 'Two-factor authentication is required.',
  404: 'Two-factor authentication failed.',
  406: 'Two-factor authentication is enforced for this account.',
  407: 'Maximum attempts reached.',
  408: 'Password expired.',
  409: 'Remote password expired.',
  410: 'Password must be changed before login.',
  412: 'Guest account cannot log in.',
  413: 'OTP system files are corrupted.',
  414: 'Unable to log in.',
  416: 'Unable to log in.',
  417: 'OTP system is full.',
  498: 'System is upgrading.',
  499: 'System is not ready.',
};

interface SynologyUserRecord {
    synology_url?: string | null;
    synology_username?: string | null;
    synology_password?: string | null;
    synology_sid?: string | null;
};

interface SynologyCredentials {
    synology_url: string;
    synology_username: string;
    synology_password: string;
}

interface SynologySettings {
    synology_url: string;
    synology_username: string;
    connected: boolean;
}

interface ApiCallParams {
    api: string;
    method: string;
    version?: number;
    [key: string]: unknown;
}

interface SynologyApiResponse<T> {
    success: boolean;
    data?: T;
    error?: { code: number };
}


interface SynologyPhotoItem {
    id?: string | number;
    filename?: string;
    filesize?: number;
    time?: number;
    item_count?: number;
    name?: string;
    additional?: {
        thumbnail?: { cache_key?: string };
        address?: { city?: string; country?: string; state?: string };
        resolution?: { width?: number; height?: number };
        exif?: {
            camera?: string;
            lens?: string;
            focal_length?: string | number;
            aperture?: string | number;
            exposure_time?: string | number;
            iso?: string | number;
        };
        gps?: { latitude?: number; longitude?: number };
        orientation?: number;
        description?: string;
    };
}


function _readSynologyUser(userId: number, columns: string[]): ServiceResult<SynologyUserRecord> {
    try {
        const row = db.prepare(`SELECT synology_url, synology_username, synology_password, synology_sid FROM users WHERE id = ?`).get(userId) as SynologyUserRecord | undefined;

        if (!row) {
            return fail('User not found', 404);
        }

        const filtered: SynologyUserRecord = {};
        for (const column of columns) {
            filtered[column] = row[column];
        }

        return success(filtered);
    } catch {
        return fail('Failed to read Synology user data', 500);
    }
}

function _getSynologyCredentials(userId: number): ServiceResult<SynologyCredentials> {
    const user = _readSynologyUser(userId, ['synology_url', 'synology_username', 'synology_password']);
    if (!user.success) return user as ServiceResult<SynologyCredentials>;
    if (!user?.data.synology_url || !user.data.synology_username || !user.data.synology_password) return fail('Synology not configured', 400);
    const password = decrypt_api_key(user.data.synology_password);
    if (!password) return fail('Synology credentials corrupted', 500);
    return success({
        synology_url: user.data.synology_url,
        synology_username: user.data.synology_username,
        synology_password: password,
    });
}


function _buildSynologyEndpoint(url: string, params: string): string {
    const normalized = url.replace(/\/$/, '').match(/^https?:\/\//) ? url.replace(/\/$/, '') : `https://${url.replace(/\/$/, '')}`;
    return `${normalized}${SYNOLOGY_ENDPOINT_PATH}?${params}`;
}

function _buildSynologyFormBody(params: ApiCallParams): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return body;
}

async function _fetchSynologyJson<T>(url: string, body: URLSearchParams): Promise<ServiceResult<T>> {
    const endpoint = _buildSynologyEndpoint(url, `api=${body.get('api')}`);
    try {
        const resp = await safeFetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            body,
            signal: AbortSignal.timeout(30000) as any,
        });
        if (!resp.ok) {
            return fail('Synology API request failed with status ' + resp.status, resp.status);
        }
        const response = await resp.json() as SynologyApiResponse<T>;
        return response.success ? success(response.data) : fail(ERROR_MESSAGES[response.error.code] || 'Synology API request failed', response.error.code);
    } catch (error) {
        if (error instanceof SsrfBlockedError) {
            return fail(error.message, 400);
        }
        return fail('Failed to connect to Synology API', 500);
    }
}

async function _loginToSynology(url: string, username: string, password: string, otp?: string): Promise<ServiceResult<string>> {
    const body = new URLSearchParams({
        api: 'SYNO.API.Auth',
        method: 'login',
        version: '6',
        account: username,
        passwd: password,
        format: 'sid',
        client: 'browser'
    });
    if (otp) {
        body.append('otp_code', otp);
    }

    const result = await _fetchSynologyJson<{ sid?: string }>(url, body);
    if (!result.success) {
        return result as ServiceResult<string>;
    }
    if (!result.data.sid) {
        return fail('Failed to get session ID from Synology', 500);
    }
    return success(result.data.sid);


}

async function _requestSynologyApi<T>(userId: number, params: ApiCallParams): Promise<ServiceResult<T>> {
    const creds = _getSynologyCredentials(userId);
    if (!creds.success) {
        return creds as ServiceResult<T>;
    }

    const session = await _getSynologySession(userId);
    if (!session.success || !session.data) {
        return session as ServiceResult<T>;
    }

    const body = _buildSynologyFormBody({ ...params, _sid: session.data });
    const result = await _fetchSynologyJson<T>(creds.data.synology_url, body);
    // 106 = session timeout, 107 = duplicate login kicked us out, 119 = SID not found/invalid
    if ('error' in result && [106, 107, 119].includes(result.error.status)) {
        _clearSynologySID(userId);
        const retrySession = await _getSynologySession(userId);
        if (!retrySession.success || !retrySession.data) {
            return retrySession as ServiceResult<T>;
        }
        return _fetchSynologyJson<T>(creds.data.synology_url, _buildSynologyFormBody({ ...params, _sid: retrySession.data }));
    }
    return result;
}

function _normalizeSynologyPhotoInfo(item: SynologyPhotoItem): AssetInfo {
    const address = item.additional?.address || {};
    const exif = item.additional?.exif || {};
    const gps = item.additional?.gps || {};

    return {
        id: String(item.additional?.thumbnail?.cache_key || ''),
        takenAt: item.time ? new Date(item.time * 1000).toISOString() : null,
        city: address.city || null,
        country: address.country || null,
        state: address.state || null,
        camera: exif.camera || null,
        lens: exif.lens || null,
        focalLength: exif.focal_length || null,
        aperture: exif.aperture || null,
        shutter: exif.exposure_time || null,
        iso: exif.iso || null,
        lat: gps.latitude || null,
        lng: gps.longitude || null,
        orientation: item.additional?.orientation || null,
        description: item.additional?.description || null,
        width: item.additional?.resolution?.width || null,
        height: item.additional?.resolution?.height || null,
        fileSize: item.filesize || null,
        fileName: item.filename || null,
    };
}


function _clearSynologySID(userId: number): void {
    db.prepare('UPDATE users SET synology_sid = NULL WHERE id = ?').run(userId);
}

function _splitPackedSynologyId(rawId: string): { id: string; cacheKey: string; assetId: string } | null {
    // cache_key format from Synology is "{unit_id}_{timestamp}", e.g. "40808_1633659236".
    // The first segment must be a non-empty integer (the unit ID used for API calls).
    if (!/^\d+_.+$/.test(rawId)) return null;
    const id = rawId.split('_')[0];
    return { id, cacheKey: rawId, assetId: rawId };
}

async function _getSynologySession(userId: number): Promise<ServiceResult<string>> {
    const cachedSid = _readSynologyUser(userId, ['synology_sid']);
    if (cachedSid.success && cachedSid.data?.synology_sid) {
        const decryptedSid = decrypt_api_key(cachedSid.data.synology_sid);
        if (decryptedSid) return success(decryptedSid);
        // Decryption failed (e.g. key rotation) — clear the stale SID and re-login
        _clearSynologySID(userId);
    }

    const creds = _getSynologyCredentials(userId);
    if (!creds.success) {
        return creds as ServiceResult<string>;
    }

    const resp = await _loginToSynology(creds.data.synology_url, creds.data.synology_username, creds.data.synology_password);

    if (!resp.success) {
        return resp as ServiceResult<string>;
    }

    const encrypted = encrypt_api_key(resp.data);
    db.prepare('UPDATE users SET synology_sid = ? WHERE id = ?').run(encrypted, userId);
    return success(resp.data);
}

export async function getSynologySettings(userId: number): Promise<ServiceResult<SynologySettings>> {
    const creds = _getSynologyCredentials(userId);
    if (!creds.success) return creds as ServiceResult<SynologySettings>;
    const session = await _getSynologySession(userId);
    return success({
        synology_url: creds.data.synology_url || '',
        synology_username: creds.data.synology_username || '',
        connected: session.success,
    });
}

export async function updateSynologySettings(userId: number, synologyUrl: string, synologyUsername: string, synologyPassword?: string, synologyOtp?: string): Promise<ServiceResult<string>> {

    const ssrf = await checkSsrf(synologyUrl);
    if (!ssrf.allowed) {
        return fail(ssrf.error, 400);
    }

    const result = _readSynologyUser(userId, ['synology_password'])
    if (!result.success) return result as ServiceResult<string>;
    const existingEncryptedPassword = result.data?.synology_password || null;

    if (!synologyPassword && !existingEncryptedPassword) {
        return fail('No stored password found. Please provide a password to save settings.', 400);
    }

    try {
        db.prepare('UPDATE users SET synology_url = ?, synology_username = ?, synology_password = ? WHERE id = ?').run(
            synologyUrl,
            synologyUsername,
            synologyPassword ? maybe_encrypt_api_key(synologyPassword) : existingEncryptedPassword,
            userId,
        );
    } catch {
        return fail('Failed to update Synology settings', 500);
    }

    _clearSynologySID(userId);
    console.log(synologyOtp, synologyOtp?.trim(), synologyOtp && synologyOtp.trim()); //debug log to verify OTP presence
    if (synologyOtp && synologyOtp.trim()) {
        const resp = await _loginToSynology(synologyUrl, synologyUsername, synologyPassword || decrypt_api_key(existingEncryptedPassword || '') || '', synologyOtp);
        console.log('Login response after settings update:', resp); //debug log to verify login response
        if ('error' in resp) {
            return fail("Failed to connect to Synology with provided OTP: " + resp.error.message, resp.error.status);
        }
        const encrypted = encrypt_api_key(resp.data);
        db.prepare('UPDATE users SET synology_sid = ? WHERE id = ?').run(encrypted, userId);
        return success(resp.data);
    }
    return success("settings updated");
}

export async function getSynologyStatus(userId: number): Promise<ServiceResult<StatusResult>> {
    const sid = await _getSynologySession(userId);
    if ('error' in sid) return success({ connected: false, error: sid.error.status === 400 ? 'Invalid credentials' : sid.error.message });
    if (!sid.data) return success({ connected: false, error: 'Not connected to Synology' });
    try {
        const user = db.prepare('SELECT synology_username FROM users WHERE id = ?').get(userId) as { synology_username?: string } | undefined;
        return success({ connected: true, user: { name: user?.synology_username || 'unknown user' } });
    } catch (err: unknown) {
        return success({ connected: true, user: { name: 'unknown user' } });
    }
}

export async function testSynologyConnection(synologyUrl: string, synologyUsername: string, synologyPassword: string, synologyOtp?: string): Promise<ServiceResult<StatusResult>> {

    const ssrf = await checkSsrf(synologyUrl);
    if (!ssrf.allowed) {
        return fail(ssrf.error, 400);
    }

    const resp = await _loginToSynology(synologyUrl, synologyUsername, synologyPassword, synologyOtp);
    if ('error' in resp) {
        return success({ connected: false, error: `${resp.error.status}: ${resp.error.message}` },);
    }
    return success({ connected: true, user: { name: synologyUsername } });
}

export async function listSynologyAlbums(userId: number): Promise<ServiceResult<AlbumsList>> {
    const result = await _requestSynologyApi<{ list: SynologyPhotoItem[] }>(userId, {
        api: 'SYNO.Foto.Browse.Album',
        method: 'list',
        version: 4,
        offset: 0,
        limit: 100,
    });
    if (!result.success) return result as ServiceResult<AlbumsList>;

    const albums = (result.data.list || []).map((album: any) => ({
        id: String(album.id),
        albumName: album.name || '',
        assetCount: album.item_count || 0,
    }));

    return success({ albums });
}


export async function syncSynologyAlbumLink(userId: number, tripId: string, linkId: string, sid: string): Promise<ServiceResult<SyncAlbumResult>> {
    const response = getAlbumIdFromLink(tripId, linkId, userId);
    if (!response.success) return response as ServiceResult<SyncAlbumResult>;

    const allItems: SynologyPhotoItem[] = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
        const result = await _requestSynologyApi<{ list: SynologyPhotoItem[] }>(userId, {
            api: 'SYNO.Foto.Browse.Item',
            method: 'list',
            version: 1,
            album_id: Number(response.data),
            offset,
            limit: pageSize,
            additional: ['thumbnail'],
        });

        if (!result.success) return result as ServiceResult<SyncAlbumResult>;

        const items = result.data.list || [];
        allItems.push(...items);
        if (items.length < pageSize) break;
        offset += pageSize;
    }

    const selection: Selection = {
        provider: SYNOLOGY_PROVIDER,
        asset_ids: allItems.map(item => String(item.additional?.thumbnail?.cache_key || '')).filter(id => id),
    };


    const result = await addTripPhotos(tripId, userId, true, [selection], sid, linkId);
    if (!result.success) return result as ServiceResult<SyncAlbumResult>;

    updateSyncTimeForAlbumLink(linkId);

    return success({ added: result.data.added, total: allItems.length });
}

export async function searchSynologyPhotos(userId: number, from?: string, to?: string, offset = 0, limit = 300): Promise<ServiceResult<AssetsList>> {
    const params: ApiCallParams = {
        api: 'SYNO.Foto.Search.Search',
        method: 'list_item',
        version: 1,
        offset,
        limit,
        keyword: '.',
        additional: ['thumbnail', 'address'],
    };

    if (from || to) {
        if (from) {
            params.start_time = Math.floor(new Date(from).getTime() / 1000);
        }
        if (to) {
            params.end_time = Math.floor(new Date(to).getTime() / 1000) + 86400; //adding it as the next day 86400 seconds in day
        }
    }

    // SYNO.Foto.Search.Search list_item does not return a total count — only data.list.
    // hasMore is inferred: if we got a full page, there may be more.
    const result = await _requestSynologyApi<{ list: SynologyPhotoItem[] }>(userId, params);
    if (!result.success) return result as ServiceResult<AssetsList>;

    const allItems = result.data.list || [];
    const assets = allItems.map(item => _normalizeSynologyPhotoInfo(item));

    return success({
        assets,
        total: allItems.length,
        hasMore: allItems.length === limit,
    });
}

export async function getSynologyAssetInfo(userId: number, photoId: string, targetUserId?: number): Promise<ServiceResult<AssetInfo>> {
    const parsedId = _splitPackedSynologyId(photoId);
    if (!parsedId) return fail('Invalid photo ID format', 400);
    const result = await _requestSynologyApi<{ list: SynologyPhotoItem[] }>(targetUserId, {
        api: 'SYNO.Foto.Browse.Item',
        method: 'get',
        version: 5,
        id: `[${Number(parsedId.id) + 1}]`, //for some reason synology wants id moved by one to get image info
        additional: ['resolution', 'exif', 'gps', 'address', 'orientation', 'description'],
    });

    if (!result.success) return result as ServiceResult<AssetInfo>;

    const metadata = result.data.list?.[0];
    if (!metadata) return fail('Photo not found', 404);

    const normalized = _normalizeSynologyPhotoInfo(metadata);
    normalized.id = photoId;
    return success(normalized);
}

export async function streamSynologyAsset(
    response: Response,
    userId: number,
    targetUserId: number,
    photoId: string,
    kind: 'thumbnail' | 'original',
    size?: string,
): Promise<void> {
    const parsedId = _splitPackedSynologyId(photoId);
    if (!parsedId) {
        handleServiceResult(response, fail('Invalid photo ID format', 400));
        return;
    }

    const synology_credentials = _getSynologyCredentials(targetUserId);
    if (!synology_credentials.success) {
        handleServiceResult(response, synology_credentials);
        return;
    }

    const sid = await _getSynologySession(targetUserId);
    if (!sid.success) {
        handleServiceResult(response, sid);
        return;
    }
    if (!sid.data) {
        handleServiceResult(response, fail('Failed to retrieve session ID', 500));
        return;
    }

    const params = kind === 'thumbnail'
        ? new URLSearchParams({
            api: 'SYNO.Foto.Thumbnail',
            method: 'get',
            version: '2',
            mode: 'download',
            id: parsedId.id,
            type: 'unit',
            size: size,
            cache_key: parsedId.cacheKey,
            _sid: sid.data,
        })
        : new URLSearchParams({
            api: 'SYNO.Foto.Download',
            method: 'download',
            version: '2',
            cache_key: parsedId.cacheKey,
            unit_id: `[${parsedId.id}]`,
            _sid: sid.data,
        });

    const url = _buildSynologyEndpoint(synology_credentials.data.synology_url, params.toString());
    await pipeAsset(url, response)
}

