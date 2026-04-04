import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest, Trip, TripLeg, RecommendationPreset, NormalizedPlace } from '../types';
import { getTripLeg } from './legs';

const router = express.Router();

const RECOMMENDATION_PRESETS: Record<string, RecommendationPreset> = {
  top_sights: { nearbyTypes: ['tourist_attraction', 'museum', 'art_gallery'], textQuery: 'top sights' },
  food: { nearbyTypes: ['restaurant'], textQuery: 'best restaurants' },
  coffee: { nearbyTypes: ['cafe'], textQuery: 'best coffee shops' },
  museums: { nearbyTypes: ['museum'], textQuery: 'best museums' },
  nightlife: { nearbyTypes: ['bar', 'night_club'], textQuery: 'best nightlife spots' },
  outdoors: { nearbyTypes: ['park'], textQuery: 'best parks and outdoor spots' },
  shopping: { nearbyTypes: ['shopping_mall'], textQuery: 'best shopping' },
};

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.rating', 'places.userRatingCount', 'places.primaryType', 'places.primaryTypeDisplayName',
  'places.types', 'places.googleMapsUri', 'places.websiteUri', 'places.nationalPhoneNumber',
].join(',');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMapsKey(userId: number): string | null {
  const user = db.prepare('SELECT maps_api_key FROM users WHERE id = ?').get(userId) as { maps_api_key?: string } | undefined;
  if (user?.maps_api_key) return user.maps_api_key;
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get() as { maps_api_key?: string } | undefined;
  return admin?.maps_api_key || null;
}

interface DestinationContext {
  destination_name?: string | null;
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_viewport_south?: number | null;
  destination_viewport_west?: number | null;
  destination_viewport_north?: number | null;
  destination_viewport_east?: number | null;
}

function getDestinationCenter(ctx: DestinationContext): { lat: number; lng: number } | null {
  if (ctx.destination_lat == null || ctx.destination_lng == null) return null;
  return { lat: Number(ctx.destination_lat), lng: Number(ctx.destination_lng) };
}

function getViewportSpan(ctx: DestinationContext): { latDelta: number; lngDelta: number } | null {
  const values = [ctx.destination_viewport_south, ctx.destination_viewport_west, ctx.destination_viewport_north, ctx.destination_viewport_east];
  if (values.some(v => v == null)) return null;
  return {
    latDelta: Math.abs(Number(ctx.destination_viewport_north) - Number(ctx.destination_viewport_south)),
    lngDelta: Math.abs(Number(ctx.destination_viewport_east) - Number(ctx.destination_viewport_west)),
  };
}

function isScopedDestination(ctx: DestinationContext): boolean {
  const span = getViewportSpan(ctx);
  if (!span) return true;
  return span.latDelta <= 4 && span.lngDelta <= 4;
}

function getNearbyRadiusMeters(ctx: DestinationContext): number {
  const span = getViewportSpan(ctx);
  const center = getDestinationCenter(ctx);
  if (!span || !center) return 12000;
  const latMeters = span.latDelta * 111000;
  const lngMeters = span.lngDelta * 111000 * Math.cos((center.lat * Math.PI) / 180);
  const largestSpan = Math.max(latMeters, lngMeters);
  return Math.max(2500, Math.min(30000, Math.round(largestSpan * 0.6)));
}

interface GooglePlaceResult {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
}

function normalizeGooglePlace(place: GooglePlaceResult): NormalizedPlace {
  return {
    google_place_id: place.id || null,
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    rating: place.rating ?? null,
    rating_count: place.userRatingCount ?? null,
    primary_type: place.primaryType || null,
    primary_type_label: place.primaryTypeDisplayName?.text || null,
    types: place.types || [],
    website: place.websiteUri || null,
    phone: place.nationalPhoneNumber || null,
    google_maps_url: place.googleMapsUri || null,
    source: 'google',
  };
}

async function searchNearbyRecommendations({ apiKey, lang, center, radius, preset }: {
  apiKey: string; lang?: string; center: { lat: number; lng: number }; radius: number; preset: RecommendationPreset;
}): Promise<NormalizedPlace[]> {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify({
      includedTypes: preset.nearbyTypes,
      maxResultCount: 8,
      rankPreference: 'POPULARITY',
      languageCode: lang || 'en',
      locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
    }),
  });
  const data = await response.json() as { places?: GooglePlaceResult[]; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || 'Google Places nearby search error');
  return (data.places || []).map(normalizeGooglePlace);
}

async function searchTextRecommendations({ apiKey, lang, destinationName, center, preset }: {
  apiKey: string; lang?: string; destinationName: string; center: { lat: number; lng: number } | null; preset: RecommendationPreset;
}): Promise<NormalizedPlace[]> {
  const body: Record<string, unknown> = {
    textQuery: `${preset.textQuery} in ${destinationName}`,
    pageSize: 8,
    languageCode: lang || 'en',
  };
  if (center) {
    body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 30000 } };
  }
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body),
  });
  const data = await response.json() as { places?: GooglePlaceResult[]; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || 'Google Places text search error');
  return (data.places || []).map(normalizeGooglePlace);
}

// ── Route ────────────────────────────────────────────────────────────────────

// GET /api/trips/:id/recommendations
router.get('/:id/recommendations', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare(`
    SELECT id, destination_name, destination_lat, destination_lng,
      destination_viewport_south, destination_viewport_west,
      destination_viewport_north, destination_viewport_east
    FROM trips WHERE id = ?
  `).get(req.params.id) as Trip | undefined;

  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const legId = req.query.leg_id ? Number(req.query.leg_id) : null;
  const leg = legId ? getTripLeg(req.params.id, legId) : null;
  if (legId && !leg) return res.status(404).json({ error: 'Trip leg not found' });

  const apiKey = getMapsKey(authReq.user.id);
  if (!apiKey) return res.status(400).json({ error: 'Google Maps API key not configured' });

  const category = String(req.query.category || 'top_sights');
  const preset = RECOMMENDATION_PRESETS[category] || RECOMMENDATION_PRESETS.top_sights;
  const destinationContext: DestinationContext = leg || trip;
  const destinationName = destinationContext.destination_name || '';
  const center = getDestinationCenter(destinationContext);

  if (!destinationName && !center) {
    return res.status(400).json({ error: 'Trip destination not configured' });
  }

  try {
    const scoped = center && isScopedDestination(destinationContext);
    let places: NormalizedPlace[] = [];
    let mode = scoped ? 'nearby' : 'text';

    if (scoped && center) {
      places = await searchNearbyRecommendations({
        apiKey, lang: req.query.lang as string | undefined,
        center, radius: getNearbyRadiusMeters(destinationContext), preset,
      });
    }

    if (places.length === 0 && destinationName) {
      mode = 'text';
      places = await searchTextRecommendations({
        apiKey, lang: req.query.lang as string | undefined,
        destinationName, center, preset,
      });
    }

    res.json({ category, leg_id: leg?.id || null, destination_name: destinationName || null, mode, places });
  } catch (err: unknown) {
    console.error('Trip recommendations error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load recommendations' });
  }
});

export default router;
