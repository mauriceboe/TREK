import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';
import { checkSsrf } from '../utils/ssrfGuard';

// ── Google API call counter ───────────────────────────────────────────────────

let googleApiCallCount = 0;

export function getGoogleApiCallCount(): number { return googleApiCallCount; }
export function resetGoogleApiCallCount(): void { googleApiCallCount = 0; }

function googleFetch(endpoint: string, label: string, init?: RequestInit): Promise<Response> {
  googleApiCallCount++;
  console.debug(`[Google API] #${googleApiCallCount} ${label} → ${endpoint}`);
  return fetch(endpoint, init);
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface NominatimResult {
  osm_type: string;
  osm_id: string;
  name?: string;
  display_name?: string;
  lat: string;
  lon: string;
}

interface OverpassElement {
  tags?: Record<string, string>;
}

interface WikiCommonsPage {
  imageinfo?: { url?: string; extmetadata?: { Artist?: { value?: string } } }[];
}

interface GooglePlaceResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  types?: string[];
}

interface GoogleAutocompleteSuggestion {
  placePrediction?: {
    placeId: string;
    structuredFormat?: {
      mainText?: { text: string };
      secondaryText?: { text: string };
    };
  };
}

interface GooglePlaceDetails extends GooglePlaceResult {
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
  googleMapsUri?: string;
  editorialSummary?: { text: string };
  reviews?: { authorAttribution?: { displayName?: string; photoUri?: string }; rating?: number; text?: { text?: string }; relativePublishTimeDescription?: string }[];
  photos?: { name: string; authorAttributions?: { displayName?: string }[] }[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const UA = 'TREK Travel Planner (https://github.com/mauriceboe/TREK)';

// ── Photo cache (disk-backed) ────────────────────────────────────────────────
import * as placePhotoCache from './placePhotoCache';

// ── API key retrieval ────────────────────────────────────────────────────────

export function getMapsKey(userId: number): string | null {
  const user = db.prepare('SELECT maps_api_key FROM users WHERE id = ?').get(userId) as { maps_api_key: string | null } | undefined;
  const user_key = decrypt_api_key(user?.maps_api_key);
  if (user_key) return user_key;
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get() as { maps_api_key: string } | undefined;
  return decrypt_api_key(admin?.maps_api_key) || null;
}

// ── Nominatim search ─────────────────────────────────────────────────────────

export async function searchNominatim(query: string, lang?: string) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: '10',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Nominatim API error: ${response.status} ${response.statusText}${text ? ' - ' + text.substring(0, 200) : ''}`);
  }
  const data = await response.json() as NominatimResult[];
  return data.map(item => ({
    google_place_id: null,
    osm_id: `${item.osm_type}:${item.osm_id}`,
    name: item.name || item.display_name?.split(',')[0] || '',
    address: item.display_name || '',
    lat: parseFloat(item.lat) || null,
    lng: parseFloat(item.lon) || null,
    rating: null,
    website: null,
    phone: null,
    source: 'openstreetmap',
  }));
}

// ── Nominatim lookup (by OSM ID) ────────────────────────────────────────────

export async function lookupNominatim(osmType: string, osmId: string, lang?: string): Promise<{
  name: string; address: string; lat: number | null; lng: number | null;
} | null> {
  const typePrefix = osmType.charAt(0).toUpperCase(); // N, W, R
  const params = new URLSearchParams({
    osm_ids: `${typePrefix}${osmId}`,
    format: 'json',
    'accept-language': lang || 'en',
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/lookup?${params}`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const data = await res.json() as NominatimResult[];
    const item = data[0];
    if (!item) return null;
    return {
      name: item.name || item.display_name?.split(',')[0] || '',
      address: item.display_name || '',
      lat: parseFloat(item.lat) || null,
      lng: parseFloat(item.lon) || null,
    };
  } catch { return null; }
}

// ── Overpass API (OSM details) ───────────────────────────────────────────────

export async function fetchOverpassDetails(osmType: string, osmId: string): Promise<OverpassElement | null> {
  const typeMap: Record<string, string> = { node: 'node', way: 'way', relation: 'rel' };
  const oType = typeMap[osmType];
  if (!oType) return null;
  const query = `[out:json][timeout:5];${oType}(${osmId});out tags;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return null;
    const data = await res.json() as { elements?: OverpassElement[] };
    return data.elements?.[0] || null;
  } catch { return null; }
}

// ── Opening hours parsing ────────────────────────────────────────────────────

export function parseOpeningHours(ohString: string): { weekdayDescriptions: string[]; openNow: boolean | null } {
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const result: string[] = LONG.map(d => `${d}: ?`);

  // Parse segments like "Mo-Fr 09:00-18:00; Sa 10:00-14:00"
  for (const segment of ohString.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.+)$/i);
    if (!match) continue;
    const [, daysPart, timePart] = match;
    const dayIndices = new Set<number>();
    for (const range of daysPart.split(',')) {
      const parts = range.trim().split('-').map(d => DAYS.indexOf(d.trim()));
      if (parts.length === 2 && parts[0] >= 0 && parts[1] >= 0) {
        for (let i = parts[0]; i !== (parts[1] + 1) % 7; i = (i + 1) % 7) dayIndices.add(i);
        dayIndices.add(parts[1]);
      } else if (parts[0] >= 0) {
        dayIndices.add(parts[0]);
      }
    }
    for (const idx of dayIndices) {
      result[idx] = `${LONG[idx]}: ${timePart.trim()}`;
    }
  }

  // Compute openNow
  let openNow: boolean | null = null;
  try {
    const now = new Date();
    const jsDay = now.getDay();
    const dayIdx = jsDay === 0 ? 6 : jsDay - 1;
    const todayLine = result[dayIdx];
    const timeRanges = [...todayLine.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (timeRanges.length > 0) {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      openNow = timeRanges.some(m => {
        const start = parseInt(m[1]) * 60 + parseInt(m[2]);
        const end = parseInt(m[3]) * 60 + parseInt(m[4]);
        return end > start ? nowMins >= start && nowMins < end : nowMins >= start || nowMins < end;
      });
    }
  } catch { /* best effort */ }

  return { weekdayDescriptions: result, openNow };
}

// ── Build standardized OSM details ───────────────────────────────────────────

export function buildOsmDetails(tags: Record<string, string>, osmType: string, osmId: string) {
  let opening_hours: string[] | null = null;
  let open_now: boolean | null = null;
  if (tags.opening_hours) {
    const parsed = parseOpeningHours(tags.opening_hours);
    const hasData = parsed.weekdayDescriptions.some(line => !line.endsWith('?'));
    if (hasData) {
      opening_hours = parsed.weekdayDescriptions;
      open_now = parsed.openNow;
    }
  }
  return {
    website: tags['contact:website'] || tags.website || null,
    phone: tags['contact:phone'] || tags.phone || null,
    opening_hours,
    open_now,
    osm_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    summary: tags.description || null,
    source: 'openstreetmap' as const,
  };
}

// ── Wikimedia Commons photo lookup ───────────────────────────────────────────

export async function fetchWikimediaPhoto(lat: number, lng: number, name?: string): Promise<{ photoUrl: string; attribution: string | null } | null> {
  // Strategy 1: Search Wikipedia for the place name -> get the article image
  if (name) {
    try {
      const searchParams = new URLSearchParams({
        action: 'query', format: 'json',
        titles: name,
        prop: 'pageimages',
        piprop: 'thumbnail',
        pithumbsize: '400',
        pilimit: '1',
        redirects: '1',
      });
      const res = await fetch(`https://en.wikipedia.org/w/api.php?${searchParams}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const data = await res.json() as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
        const pages = data.query?.pages;
        if (pages) {
          for (const page of Object.values(pages)) {
            if (page.thumbnail?.source) {
              return { photoUrl: page.thumbnail.source, attribution: 'Wikipedia' };
            }
          }
        }
      }
    } catch { /* fall through to geosearch */ }
  }

  // Strategy 2: Wikimedia Commons geosearch by coordinates
  const params = new URLSearchParams({
    action: 'query', format: 'json',
    generator: 'geosearch',
    ggsprimary: 'all',
    ggsnamespace: '6',
    ggsradius: '300',
    ggscoord: `${lat}|${lng}`,
    ggslimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: '400',
  });
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json() as { query?: { pages?: Record<string, WikiCommonsPage & { imageinfo?: { mime?: string }[] }> } };
    const pages = data.query?.pages;
    if (!pages) return null;
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      // Only use actual photos (JPEG/PNG), skip SVGs and PDFs
      const mime = (info as { mime?: string })?.mime || '';
      if (info?.url && (mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) {
        const attribution = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '').trim() || null;
        return { photoUrl: info.url, attribution };
      }
    }
    return null;
  } catch { return null; }
}

// ── Search places (Google or Nominatim fallback) ─────────────────────────────

export async function searchPlaces(userId: number, query: string, lang?: string): Promise<{ places: Record<string, unknown>[]; source: string }> {
  const apiKey = getMapsKey(userId);

  if (!apiKey) {
    const places = await searchNominatim(query, lang);
    return { places, source: 'openstreetmap' };
  }

  const response = await googleFetch('https://places.googleapis.com/v1/places:searchText', 'searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.websiteUri,places.nationalPhoneNumber,places.types',
    },
    body: JSON.stringify({ textQuery: query, languageCode: lang || 'en' }),
  });

  const data = await response.json() as { places?: GooglePlaceResult[]; error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const places = (data.places || []).map((p: GooglePlaceResult) => ({
    google_place_id: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    lat: p.location?.latitude || null,
    lng: p.location?.longitude || null,
    rating: p.rating || null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    source: 'google',
  }));

  return { places, source: 'google' };
}

// ── Autocomplete (Google or Nominatim fallback) ─────────────────────────────

export async function autocompletePlaces(
  userId: number,
  input: string,
  lang?: string,
  locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
): Promise<{ suggestions: { placeId: string; mainText: string; secondaryText: string }[]; source: string }> {
  const apiKey = getMapsKey(userId);

  if (!apiKey) {
    return autocompleteNominatim(input, lang);
  }

  const body: Record<string, unknown> = {
    input,
    languageCode: lang || 'en',
  };
  if (locationBias) {
    body.locationBias = {
      rectangle: {
        low: { latitude: locationBias.low.lat, longitude: locationBias.low.lng },
        high: { latitude: locationBias.high.lat, longitude: locationBias.high.lng },
      },
    };
  }

  const response = await googleFetch('https://places.googleapis.com/v1/places:autocomplete', 'autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as { suggestions?: GoogleAutocompleteSuggestion[]; error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places Autocomplete error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const suggestions = (data.suggestions || [])
    .filter((s) => s.placePrediction)
    .slice(0, 5)
    .map((s) => ({
      placeId: s.placePrediction!.placeId,
      mainText: s.placePrediction!.structuredFormat?.mainText?.text || '',
      secondaryText: s.placePrediction!.structuredFormat?.secondaryText?.text || '',
    }));

  return { suggestions, source: 'google' };
}

async function autocompleteNominatim(
  input: string,
  lang?: string,
): Promise<{ suggestions: { placeId: string; mainText: string; secondaryText: string }[]; source: string }> {
  try {
    const places = await searchNominatim(input, lang);
    const suggestions = places
      .filter((p) => p.osm_id && p.osm_id.includes(':') && p.osm_id.split(':')[1] !== '')
      .slice(0, 5)
      .map((p) => {
        const parts = (p.address || '').split(',').map((s) => s.trim());
        return {
          placeId: p.osm_id,
          mainText: p.name || parts[0] || '',
          secondaryText: parts.slice(1).join(', '),
        };
      });
    return { suggestions, source: 'nominatim' };
  } catch (err) {
    console.error('Nominatim autocomplete failed:', err);
    return { suggestions: [], source: 'nominatim' };
  }
}

// ── Place details (Google or OSM) ────────────────────────────────────────────

export async function getPlaceDetails(userId: number, placeId: string, lang?: string): Promise<{ place: Record<string, unknown> }> {
  // OSM details: placeId is "node:123456" or "way:123456" etc.
  if (placeId.includes(':')) {
    const [osmType, osmId] = placeId.split(':');
    const element = await fetchOverpassDetails(osmType, osmId);
    const details = buildOsmDetails(element?.tags || {}, osmType, osmId);

    // Fetch Nominatim only when Overpass lacks coordinates or address
    const d = details as Record<string, unknown>;
    const needsNominatim = !d.lat || !d.lng || !d.address;
    const nominatim = needsNominatim ? await lookupNominatim(osmType, osmId, lang) : null;

    return {
      place: {
        ...details,
        name: (d.name as string) || nominatim?.name || element?.tags?.name || '',
        address: (d.address as string) || nominatim?.address || '',
        lat: d.lat ?? nominatim?.lat ?? null,
        lng: d.lng ?? nominatim?.lng ?? null,
        osm_id: placeId,
      },
    };
  }

  // Google details
  const langKey = lang || 'de';
  const apiKey = getMapsKey(userId);
  if (!apiKey) {
    throw Object.assign(new Error('Google Maps API key not configured'), { status: 400 });
  }

  // Check DB cache first (lean mask, expanded=0) — 7-day TTL
  const DETAILS_TTL = 7 * 24 * 60 * 60 * 1000;
  const cached = db.prepare(
    'SELECT payload_json, fetched_at FROM place_details_cache WHERE place_id = ? AND lang = ? AND expanded = 0'
  ).get(placeId, langKey) as { payload_json: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < DETAILS_TTL) return { place: JSON.parse(cached.payload_json) };

  const response = await googleFetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=${langKey}`, `getPlaceDetails(${placeId})`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri',
    },
  });

  const data = await response.json() as GooglePlaceDetails & { error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const place = {
    google_place_id: data.id,
    name: data.displayName?.text || '',
    address: data.formattedAddress || '',
    lat: data.location?.latitude || null,
    lng: data.location?.longitude || null,
    rating: data.rating || null,
    rating_count: data.userRatingCount || null,
    website: data.websiteUri || null,
    phone: data.nationalPhoneNumber || null,
    opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
    open_now: data.regularOpeningHours?.openNow ?? null,
    google_maps_url: data.googleMapsUri || null,
    summary: null,
    reviews: [],
    source: 'google' as const,
    cached_at: Date.now(),
  };

  try {
    db.prepare(
      'INSERT OR REPLACE INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at) VALUES (?, ?, 0, ?, ?)'
    ).run(placeId, langKey, JSON.stringify(place), Date.now());
  } catch (dbErr) {
    console.error('Failed to cache place details:', dbErr);
  }

  return { place };
}

export async function getPlaceDetailsExpanded(userId: number, placeId: string, lang?: string, refresh = false): Promise<{ place: Record<string, unknown> }> {
  const langKey = lang || 'de';
  const apiKey = getMapsKey(userId);
  if (!apiKey) throw Object.assign(new Error('Google Maps API key not configured'), { status: 400 });

  // Check DB cache for expanded result
  if (!refresh) {
    const cached = db.prepare(
      'SELECT payload_json FROM place_details_cache WHERE place_id = ? AND lang = ? AND expanded = 1'
    ).get(placeId, langKey) as { payload_json: string } | undefined;
    if (cached) return { place: JSON.parse(cached.payload_json) };
  }

  const response = await googleFetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=${langKey}`, `getPlaceDetailsExpanded(${placeId})`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri,reviews,editorialSummary',
    },
  });

  const data = await response.json() as GooglePlaceDetails & { error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const place = {
    google_place_id: data.id,
    name: data.displayName?.text || '',
    address: data.formattedAddress || '',
    lat: data.location?.latitude || null,
    lng: data.location?.longitude || null,
    rating: data.rating || null,
    rating_count: data.userRatingCount || null,
    website: data.websiteUri || null,
    phone: data.nationalPhoneNumber || null,
    opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
    open_now: data.regularOpeningHours?.openNow ?? null,
    google_maps_url: data.googleMapsUri || null,
    summary: data.editorialSummary?.text || null,
    reviews: (data.reviews || []).slice(0, 5).map((r: NonNullable<GooglePlaceDetails['reviews']>[number]) => ({
      author: r.authorAttribution?.displayName || null,
      rating: r.rating || null,
      text: r.text?.text || null,
      time: r.relativePublishTimeDescription || null,
      photo: r.authorAttribution?.photoUri || null,
    })),
    source: 'google' as const,
    cached_at: Date.now(),
  };

  try {
    db.prepare(
      'INSERT OR REPLACE INTO place_details_cache (place_id, lang, expanded, payload_json, fetched_at) VALUES (?, ?, 1, ?, ?)'
    ).run(placeId, langKey, JSON.stringify(place), Date.now());
  } catch (dbErr) {
    console.error('Failed to cache expanded place details:', dbErr);
  }

  return { place };
}

// ── Place photo (Google or Wikimedia, disk-cached) ────────────────────────────

export async function getPlacePhoto(
  userId: number,
  placeId: string,
  lat: number,
  lng: number,
  name?: string,
): Promise<{ photoUrl: string; attribution: string | null }> {
  // Disk cache hit — serve immediately, no Google call
  const diskHit = placePhotoCache.get(placeId);
  if (diskHit) return { photoUrl: diskHit.photoUrl, attribution: diskHit.attribution };

  // Recent error — don't hammer the API
  if (placePhotoCache.getErrored(placeId)) {
    throw Object.assign(new Error('(Cache) No photo available'), { status: 404 });
  }

  // Deduplicate concurrent requests for the same placeId
  const existing = placePhotoCache.getInFlight(placeId);
  if (existing) {
    const result = await existing;
    if (!result) throw Object.assign(new Error('(Cache) No photo available'), { status: 404 });
    return { photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`, attribution: result.attribution };
  }

  const fetchPromise = (async (): Promise<{ filePath: string; attribution: string | null } | null> => {
    const apiKey = getMapsKey(userId);
    const isCoordLookup = placeId.startsWith('coords:');

    // No Google key or coordinate-only lookup → try Wikimedia (URL-based, not byte-cached)
    if (!apiKey || isCoordLookup) {
      if (!isNaN(lat) && !isNaN(lng)) {
        try {
          const wiki = await fetchWikimediaPhoto(lat, lng, name);
          if (wiki) {
            // Wikimedia photos: fetch bytes and cache to disk
            const ssrf = await checkSsrf(wiki.photoUrl, true);
            if (!ssrf.allowed) throw Object.assign(new Error('Photo URL blocked'), { status: 403 });
            const imgRes = await fetch(wiki.photoUrl);
            if (imgRes.ok) {
              const bytes = Buffer.from(await imgRes.arrayBuffer());
              const cached = await placePhotoCache.put(placeId, bytes, wiki.attribution);
              return { filePath: cached.filePath, attribution: cached.attribution };
            }
          }
        } catch { /* fall through */ }
      }
      placePhotoCache.markError(placeId);
      return null;
    }

    // Google Photos — fetch details to get photo name
    const detailsRes = await googleFetch(`https://places.googleapis.com/v1/places/${placeId}`, `getPlacePhoto/details(${placeId})`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'photos',
      },
    });
    const details = await detailsRes.json() as GooglePlaceDetails & { error?: { message?: string } };

    if (!detailsRes.ok) {
      console.error('Google Places photo details error:', details.error?.message || detailsRes.status);
      placePhotoCache.markError(placeId);
      return null;
    }

    if (!details.photos?.length) {
      placePhotoCache.markError(placeId);
      return null;
    }

    const photo = details.photos[0];
    const photoName = photo.name;
    const attribution = photo.authorAttributions?.[0]?.displayName || null;

    // Fetch actual image bytes
    const mediaRes = await googleFetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=400`,
      `getPlacePhoto/media(${placeId})`,
      { headers: { 'X-Goog-Api-Key': apiKey } }
    );

    if (!mediaRes.ok) {
      placePhotoCache.markError(placeId);
      return null;
    }

    const bytes = Buffer.from(await mediaRes.arrayBuffer());
    if (!bytes.length) {
      placePhotoCache.markError(placeId);
      return null;
    }

    const cached = await placePhotoCache.put(placeId, bytes, attribution);

    // Persist stable proxy URL to database
    try {
      db.prepare(
        'UPDATE places SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE google_place_id = ? AND (image_url IS NULL OR image_url = \'\')'
      ).run(cached.photoUrl, placeId);
    } catch (dbErr) {
      console.error('Failed to persist photo URL to database:', dbErr);
    }

    return { filePath: cached.filePath, attribution };
  })();

  placePhotoCache.setInFlight(placeId, fetchPromise);

  const result = await fetchPromise;
  if (!result) throw Object.assign(new Error('No photo available'), { status: 404 });
  return { photoUrl: `/api/maps/place-photo/${encodeURIComponent(placeId)}/bytes`, attribution: result.attribution };
}

// ── Reverse geocoding ────────────────────────────────────────────────────────

export async function reverseGeocode(lat: string, lng: string, lang?: string): Promise<{ name: string | null; address: string | null }> {
  const params = new URLSearchParams({
    lat, lon: lng, format: 'json', addressdetails: '1', zoom: '18',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) return { name: null, address: null };
  const data = await response.json() as { name?: string; display_name?: string; address?: Record<string, string> };
  const addr = data.address || {};
  const name = data.name || addr.tourism || addr.amenity || addr.shop || addr.building || addr.road || null;
  return { name, address: data.display_name || null };
}

// ── Resolve Google Maps URL ──────────────────────────────────────────────────

export async function resolveGoogleMapsUrl(url: string): Promise<{ lat: number; lng: number; name: string | null; address: string | null }> {
  let resolvedUrl = url;

  // Follow redirects for short URLs (goo.gl, maps.app.goo.gl) with SSRF protection
  const parsed = new URL(url);
  if (['goo.gl', 'maps.app.goo.gl'].includes(parsed.hostname)) {
    const ssrf = await checkSsrf(url, true);
    if (!ssrf.allowed) throw Object.assign(new Error('URL blocked by SSRF check'), { status: 403 });
    const redirectRes = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    resolvedUrl = redirectRes.url;
  }

  // Extract coordinates from Google Maps URL patterns:
  // /@48.8566,2.3522,15z  or  /place/.../@48.8566,2.3522
  // ?q=48.8566,2.3522  or  ?ll=48.8566,2.3522
  let lat: number | null = null;
  let lng: number | null = null;
  let placeName: string | null = null;

  // Pattern: /@lat,lng
  const atMatch = resolvedUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) { lat = parseFloat(atMatch[1]); lng = parseFloat(atMatch[2]); }

  // Pattern: !3dlat!4dlng (Google Maps data params)
  if (!lat) {
    const dataMatch = resolvedUrl.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
    if (dataMatch) { lat = parseFloat(dataMatch[1]); lng = parseFloat(dataMatch[2]); }
  }

  // Pattern: ?q=lat,lng or &q=lat,lng
  if (!lat) {
    const qMatch = resolvedUrl.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (qMatch) { lat = parseFloat(qMatch[1]); lng = parseFloat(qMatch[2]); }
  }

  // Extract place name from URL path: /place/Place+Name/@...
  const placeMatch = resolvedUrl.match(/\/place\/([^/@]+)/);
  if (placeMatch) {
    placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
  }

  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    throw Object.assign(new Error('Could not extract coordinates from URL'), { status: 400 });
  }

  // Reverse geocode to get address
  const nominatimRes = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
    { headers: { 'User-Agent': 'TREK-Travel-Planner/1.0' }, signal: AbortSignal.timeout(8000) }
  );
  const nominatim = await nominatimRes.json() as { display_name?: string; name?: string; address?: Record<string, string> };

  const name = placeName || nominatim.name || nominatim.address?.tourism || nominatim.address?.building || null;
  const address = nominatim.display_name || null;

  return { lat, lng, name, address };
}
