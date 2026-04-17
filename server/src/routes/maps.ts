import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  searchPlaces,
  getPlaceDetails,
  getPlaceDetailsExpanded,
  getPlacePhoto,
  reverseGeocode,
  resolveGoogleMapsUrl,
  autocompletePlaces,
} from '../services/mapsService';
import { db } from '../db/database';
import { serveFilePath } from '../services/placePhotoCache';

const router = express.Router();

// POST /search
router.post('/search', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { query } = req.body;

  if (!query) return res.status(400).json({ error: 'Search query is required' });

  try {
    const result = await searchPlaces(authReq.user.id, query, req.query.lang as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Search error';
    console.error('Maps search error:', err);
    res.status(status).json({ error: message });
  }
});

// POST /autocomplete
router.post('/autocomplete', authenticate, async (req: Request, res: Response) => {
  const autocompleteEnabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'places_autocomplete_enabled'").get() as { value: string } | undefined;
  if (autocompleteEnabledRow?.value === 'false') return res.status(200).json({ suggestions: [], source: 'disabled' });

  const authReq = req as AuthRequest;
  const { input, lang, locationBias } = req.body;

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ error: 'Input is required' });
  }

  if (input.length > 200) {
    return res.status(400).json({ error: 'Input too long (max 200 chars)' });
  }

  if (locationBias) {
    const { low, high } = locationBias;
    if (!low || !high
      || !Number.isFinite(low.lat) || !Number.isFinite(low.lng)
      || !Number.isFinite(high.lat) || !Number.isFinite(high.lng)) {
      return res.status(400).json({ error: 'Invalid locationBias: low and high must have finite lat and lng' });
    }
  }

  try {
    const result = await autocompletePlaces(
      authReq.user.id,
      input,
      lang as string,
      locationBias as { low: { lat: number; lng: number }; high: { lat: number; lng: number } } | undefined,
    );
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Autocomplete error';
    console.error('Maps autocomplete error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /details/:placeId
router.get('/details/:placeId', authenticate, async (req: Request, res: Response) => {
  const detailsEnabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'places_details_enabled'").get() as { value: string } | undefined;
  if (detailsEnabledRow?.value === 'false') return res.status(200).json({ place: null, disabled: true });

  const authReq = req as AuthRequest;
  const { placeId } = req.params;
  const expand = req.query.expand as string | undefined;

  try {
    const refresh = req.query.refresh === '1';
    const result = expand
      ? await getPlaceDetailsExpanded(authReq.user.id, placeId, req.query.lang as string, refresh)
      : await getPlaceDetails(authReq.user.id, placeId, req.query.lang as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Error fetching place details';
    console.error('Maps details error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /place-photo/:placeId
router.get('/place-photo/:placeId', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { placeId } = req.params;

  // Kill-switch only applies to Google Places API fetches — Wikimedia (coords: prefix) is always allowed
  if (!placeId.startsWith('coords:')) {
    const photosEnabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'places_photos_enabled'").get() as { value: string } | undefined;
    if (photosEnabledRow?.value === 'false') return res.status(200).json({ photoUrl: null });
  }
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  try {
    const result = await getPlacePhoto(authReq.user.id, placeId, lat, lng, req.query.name as string);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 500;
    const message = err instanceof Error ? err.message : 'Error fetching photo';
    if (status >= 500) console.error('Place photo error:', err);
    res.status(status).json({ error: message });
  }
});

// GET /place-photo/:placeId/bytes — serve cached photo bytes from disk
router.get('/place-photo/:placeId/bytes', authenticate, (req: Request, res: Response) => {
  const { placeId } = req.params;
  const fp = serveFilePath(placeId);
  if (!fp) return res.status(404).json({ error: 'Photo not cached' });
  res.set('Cache-Control', 'public, max-age=2592000, immutable');
  res.sendFile(fp);
});

// GET /reverse
router.get('/reverse', authenticate, async (req: Request, res: Response) => {
  const { lat, lng, lang } = req.query as { lat: string; lng: string; lang?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  try {
    const result = await reverseGeocode(lat, lng, lang);
    res.json(result);
  } catch {
    res.json({ name: null, address: null });
  }
});

// POST /resolve-url
router.post('/resolve-url', authenticate, async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

  try {
    const result = await resolveGoogleMapsUrl(url);
    res.json(result);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status || 400;
    const message = err instanceof Error ? err.message : 'Failed to resolve URL';
    console.error('[Maps] URL resolve error:', message);
    res.status(status).json({ error: message });
  }
});

export default router;
