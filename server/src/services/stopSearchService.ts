import fetch from 'node-fetch';
import { ipv4Agent, haversineDistance, distanceToPolyline, decodePolyline } from './routingService';
import { getUserSetting } from './fuelService';
import { db } from '../db/database';

// Timeouts
const OVERPASS_TIMEOUT_MS = 45000;
const GOOGLE_PLACES_TIMEOUT_MS = 10000;

// Search constants
const SEARCH_RADII = [15000, 50000, 100000, 200000]; // meters, progressive expansion
const ROUTE_PROXIMITY_THRESHOLD = 2000; // meters, max distance from route polyline
const DEDUP_PROXIMITY = 500; // meters, POI deduplication distance
const CROSS_TYPE_DEDUP_PROXIMITY = 5000; // meters, fuel/rest cross-type dedup
const OVERPASS_QUERY_TIMEOUT = 30; // seconds, in Overpass QL query
const GOOGLE_MAX_RADIUS = 50000; // meters, Google Places API limit
const CORRIDOR_SAMPLE_INTERVAL = 150000; // meters, fuel corridor sampling
const MAX_SEARCH_POINTS = 20; // max points per request

export { CORRIDOR_SAMPLE_INTERVAL, SEARCH_RADII, ROUTE_PROXIMITY_THRESHOLD };

// Rate limiters
let lastOverpassRequest = 0;
let lastGooglePlacesRequest = 0;
const OVERPASS_MIN_INTERVAL_MS = 2000;
const GOOGLE_PLACES_MIN_INTERVAL_MS = 100;

export interface SearchPoint { lat: number; lng: number; distance_along_route_meters: number }
export interface StopResult {
  name: string; lat: number; lng: number; type: 'fuel' | 'rest';
  distance_from_route_meters: number; source: 'osm' | 'google';
  brand: string | null; rating: number | null; opening_hours: string | null;
  osm_id: string | null; place_id: string | null;
}

// Debounce: track last find-stops call per leg to avoid rapid re-calls
const lastFindStopsCall = new Map<string, number>();
const FIND_STOPS_DEBOUNCE_MS = 5000;

export function checkDebounce(debounceKey: string): boolean {
  const lastCall = lastFindStopsCall.get(debounceKey) || 0;
  if (Date.now() - lastCall < FIND_STOPS_DEBOUNCE_MS) return false;
  lastFindStopsCall.set(debounceKey, Date.now());
  return true;
}

export function isValidStopType(type: string): type is 'fuel' | 'rest' | 'both' {
  return type === 'fuel' || type === 'rest' || type === 'both';
}

// Brand tag mappings for Overpass
const BRAND_OVERPASS_TAGS: Record<string, string[]> = {
  'Mobil': ['Mobil', 'Mobil 1'],
  'Ampol': ['Ampol'],
  'BP': ['BP'],
  'Shell': ['Shell', 'Shell Coles Express'],
  '7-Eleven': ['7-Eleven', '7-11'],
};

function buildFuelFilters(around: string, fuelType: string, fuelBrand: string): string[] {
  const filters: string[] = [];

  const brands = fuelBrand === 'any' ? [] : fuelBrand.split(',').map(b => b.trim()).filter(Boolean);
  for (const brand of brands) {
    const tags = BRAND_OVERPASS_TAGS[brand];
    if (!tags) continue;
    for (const tag of tags) {
      filters.push(`node["brand"="${tag}"]["amenity"="fuel"](${around});`);
      filters.push(`node["operator"="${tag}"]["amenity"="fuel"](${around});`);
    }
  }

  if (fuelType === 'diesel') {
    filters.push(`node["fuel:diesel"="yes"](${around});`);
  } else if (fuelType === 'petrol') {
    filters.push(`node["fuel:octane_91"="yes"](${around});`);
    filters.push(`node["fuel:octane_95"="yes"](${around});`);
  } else {
    filters.push(`node["amenity"="fuel"](${around});`);
    filters.push(`node["fuel:diesel"="yes"](${around});`);
  }
  filters.push(`node["shop"="fuel"](${around});`);
  return filters;
}

interface OverpassElement {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

async function enforceOverpassRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastOverpassRequest;
  if (elapsed < OVERPASS_MIN_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, OVERPASS_MIN_INTERVAL_MS - elapsed));
  }
  lastOverpassRequest = Date.now();
}

async function enforceGooglePlacesRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastGooglePlacesRequest;
  if (elapsed < GOOGLE_PLACES_MIN_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, GOOGLE_PLACES_MIN_INTERVAL_MS - elapsed));
  }
  lastGooglePlacesRequest = Date.now();
}

async function runOverpassQuery(points: SearchPoint[], stopType: string, radiusMeters: number, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<OverpassElement[]> {
  await enforceOverpassRateLimit();

  const filters: string[] = [];
  for (const sp of points) {
    const around = `around:${radiusMeters},${sp.lat},${sp.lng}`;
    if (stopType === 'fuel' || stopType === 'both') {
      filters.push(...buildFuelFilters(around, fuelType, fuelBrand));
    }
    if (stopType === 'rest' || stopType === 'both') filters.push(`node["highway"="rest_area"](${around});`);
  }
  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];(${filters.join('')});out body;`;
  console.log(`[find-stops] Overpass query: ${points.length} points, radius:${radiusMeters}m, type:${stopType}, query length:${query.length}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TREK-TravelPlanner/1.0' },
      body: `data=${encodeURIComponent(query)}`,
      agent: ipv4Agent,
      signal: controller.signal as never,
    });
    clearTimeout(timeout);
    const body = await res.text();
    console.log(`[find-stops] Overpass response status: ${res.status}, body length: ${body.length}`);
    if (!res.ok) {
      console.error(`[find-stops] Overpass error response: ${body.substring(0, 500)}`);
      return [];
    }
    const data = JSON.parse(body) as OverpassResponse;
    console.log(`[find-stops] Overpass POIs returned: ${(data.elements || []).length}`);
    return data.elements || [];
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[find-stops] Overpass request timed out after ${OVERPASS_TIMEOUT_MS}ms`);
    } else {
      console.error('[find-stops] Overpass fetch error:', err);
    }
    return [];
  }
}

function deduplicateElements(elements: OverpassElement[]): OverpassElement[] {
  const seen = new Set<number>();
  return elements.filter(el => {
    if (seen.has(el.id)) return false;
    seen.add(el.id);
    return true;
  });
}

function isFuelElement(el: OverpassElement): boolean {
  return el.tags?.amenity === 'fuel' || el.tags?.shop === 'fuel' || el.tags?.['fuel:diesel'] === 'yes';
}

function elementsToStopResults(elements: OverpassElement[]): StopResult[] {
  return elements.map(el => ({
    name: el.tags?.name || el.tags?.brand || 'Unknown',
    lat: el.lat, lng: el.lon,
    type: (isFuelElement(el) ? 'fuel' : 'rest') as 'fuel' | 'rest',
    distance_from_route_meters: 0,
    source: 'osm' as const,
    brand: el.tags?.brand || null,
    rating: null,
    opening_hours: el.tags?.opening_hours || null,
    osm_id: `node/${el.id}`,
    place_id: null,
  }));
}

function assignBestPoi(sp: SearchPoint, allPois: StopResult[], radiusMeters: number): StopResult[] {
  const scored = allPois.map(poi => ({
    ...poi,
    distance_from_route_meters: Math.round(haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng)),
  }));
  scored.sort((a, b) => a.distance_from_route_meters - b.distance_from_route_meters);
  const best = scored.filter(p => p.distance_from_route_meters <= radiusMeters).slice(0, 1);
  if (best.length > 0) {
    console.log(`[find-stops] Found ${best[0].name} at ${best[0].distance_from_route_meters}m from route (search radius: ${radiusMeters}m)`);
  }
  return best;
}

export async function searchOverpassBatched(searchPoints: SearchPoint[], stopType: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<Map<number, StopResult[]>> {
  const resultsByPoint = new Map<number, StopResult[]>();
  let pendingIndices = searchPoints.map((_, i) => i);
  let allElements: OverpassElement[] = [];

  for (const radius of SEARCH_RADII) {
    if (pendingIndices.length === 0) break;

    const pendingPoints = pendingIndices.map(i => searchPoints[i]);
    const elements = await runOverpassQuery(pendingPoints, stopType, radius, fuelType, fuelBrand);
    allElements = deduplicateElements([...allElements, ...elements]);
    const allPois = elementsToStopResults(allElements);

    const stillPending: number[] = [];
    for (const idx of pendingIndices) {
      const best = assignBestPoi(searchPoints[idx], allPois, radius);
      if (best.length > 0) {
        resultsByPoint.set(idx, best);
      } else {
        stillPending.push(idx);
      }
    }

    if (stillPending.length > 0 && radius < SEARCH_RADII[SEARCH_RADII.length - 1]) {
      const nextRadius = SEARCH_RADII[SEARCH_RADII.indexOf(radius) + 1];
      console.log(`[find-stops] Overpass: ${stillPending.length} points had no results at ${radius}m, retrying at ${nextRadius}m`);
    }
    pendingIndices = stillPending;
  }

  for (const idx of pendingIndices) {
    resultsByPoint.set(idx, []);
  }

  return resultsByPoint;
}

export async function searchCorridorOverpass(searchPoints: SearchPoint[], stopType: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<StopResult[]> {
  let allElements: OverpassElement[] = [];

  for (const radius of SEARCH_RADII) {
    const elements = await runOverpassQuery(searchPoints, stopType, radius, fuelType, fuelBrand);
    allElements = deduplicateElements([...allElements, ...elements]);
    const allPois = elementsToStopResults(allElements);
    const uncoveredCount = searchPoints.filter(sp =>
      !allPois.some(poi => haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng) <= radius)
    ).length;
    if (uncoveredCount === 0) {
      console.log(`[find-stops] Corridor Overpass: full coverage at ${radius}m radius, ${allElements.length} total POIs`);
      break;
    }
    if (radius < SEARCH_RADII[SEARCH_RADII.length - 1]) {
      console.log(`[find-stops] Corridor Overpass: ${uncoveredCount} uncovered points at ${radius}m, expanding`);
    }
  }

  console.log(`[find-stops] Corridor Overpass: ${allElements.length} unique POIs found`);
  const results = elementsToStopResults(allElements);
  return results.map(poi => {
    let minDist = Infinity;
    for (const sp of searchPoints) {
      const d = haversineDistance(sp.lat, sp.lng, poi.lat, poi.lng);
      if (d < minDist) minDist = d;
    }
    return { ...poi, distance_from_route_meters: Math.round(minDist) };
  });
}

interface GooglePlaceResult {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  regularOpeningHours?: { openNow?: boolean };
}

interface GooglePlacesResponse {
  places?: GooglePlaceResult[];
}

export function getGlobalMapsKey(): string | null {
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get() as { maps_api_key: string } | undefined;
  if (!admin?.maps_api_key) {
    console.warn('Google Places requested but no Maps API key configured by admin');
    return null;
  }
  return admin.maps_api_key;
}

async function searchGooglePlacesAtRadius(lat: number, lng: number, searchType: string, apiKey: string, radiusMeters: number): Promise<StopResult[]> {
  await enforceGooglePlacesRateLimit();

  const results: StopResult[] = [];
  const includedTypes = searchType === 'fuel' ? ['gas_station'] : ['rest_stop'];
  console.log(`[find-stops] Google Places search types:${includedTypes.join(',')} near ${lat},${lng} radius:${radiusMeters}m`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_PLACES_TIMEOUT_MS);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.regularOpeningHours',
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount: 5,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(radiusMeters, GOOGLE_MAX_RADIUS) },
        },
      }),
      agent: ipv4Agent,
      signal: controller.signal as never,
    });
    clearTimeout(timeout);
    const body = await res.text();
    console.log(`[find-stops] Google Places response status: ${res.status}, body length: ${body.length}`);
    if (!res.ok) {
      console.error(`[find-stops] Google Places error: ${body.substring(0, 500)}`);
      return [];
    }
    const data = JSON.parse(body) as GooglePlacesResponse;
    for (const r of data.places || []) {
      const dist = Math.round(haversineDistance(lat, lng, r.location?.latitude || 0, r.location?.longitude || 0));
      const name = r.displayName?.text || 'Unknown';
      console.log(`[find-stops] Found ${name} at ${dist}m from route (search radius: ${radiusMeters}m)`);
      results.push({
        name,
        lat: r.location?.latitude || 0, lng: r.location?.longitude || 0,
        type: searchType as 'fuel' | 'rest',
        distance_from_route_meters: dist,
        source: 'google',
        brand: null,
        rating: r.rating || null,
        opening_hours: r.regularOpeningHours?.openNow != null ? (r.regularOpeningHours.openNow ? 'Open now' : 'Closed') : null,
        osm_id: null,
        place_id: r.id || null,
      });
    }
  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[find-stops] Google Places request timed out after ${GOOGLE_PLACES_TIMEOUT_MS}ms`);
    } else {
      console.error('[find-stops] Google Places fetch error:', err);
    }
  }
  return results;
}

async function searchGooglePlaces(lat: number, lng: number, stopType: string, apiKey: string): Promise<StopResult[]> {
  const searchTypes: string[] = [];
  if (stopType === 'fuel' || stopType === 'both') searchTypes.push('fuel');
  if (stopType === 'rest' || stopType === 'both') searchTypes.push('rest');

  const allResults: StopResult[] = [];
  const GOOGLE_RADII = [15000, GOOGLE_MAX_RADIUS];

  for (const sType of searchTypes) {
    let found = false;
    for (const radius of GOOGLE_RADII) {
      const results = await searchGooglePlacesAtRadius(lat, lng, sType, apiKey, radius);
      if (results.length > 0) {
        allResults.push(...results);
        found = true;
        break;
      }
      if (radius < GOOGLE_RADII[GOOGLE_RADII.length - 1]) {
        const nextRadius = GOOGLE_RADII[GOOGLE_RADII.indexOf(radius) + 1];
        console.log(`[find-stops] Google Places: no results at ${radius}m, expanding to ${nextRadius}m for point ${lat},${lng}`);
      }
    }
    if (!found) {
      console.log(`[find-stops] Google Places: no ${sType} results at any radius for point ${lat},${lng}`);
    }
  }
  return allResults;
}

export async function searchCorridorGoogle(searchPoints: SearchPoint[], stopType: string, apiKey: string, fuelType: string = 'any', fuelBrand: string = 'any'): Promise<StopResult[]> {
  const allResults: StopResult[] = [];
  const seenIds = new Set<string>();

  for (const sp of searchPoints) {
    const results = await searchGooglePlaces(sp.lat, sp.lng, stopType, apiKey);
    for (const r of results) {
      const key = r.place_id || `${r.lat},${r.lng}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        allResults.push(r);
      }
    }
  }

  const uncoveredPoints = searchPoints.filter(sp =>
    !allResults.some(r => haversineDistance(sp.lat, sp.lng, r.lat, r.lng) <= GOOGLE_MAX_RADIUS)
  );
  if (uncoveredPoints.length > 0) {
    console.log(`[find-stops] Corridor Google: ${uncoveredPoints.length} points had no nearby results, falling back to Overpass`);
    const overpassResults = await searchCorridorOverpass(uncoveredPoints, stopType, fuelType, fuelBrand);
    const overpassDeduped = overpassResults.filter(r => {
      const key = r.osm_id || `${r.lat},${r.lng}`;
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });
    allResults.push(...overpassDeduped);
  }

  return allResults;
}

export interface FindStopsOptions {
  tripId: string;
  legId: number;
  userId: number;
  stopType: string;
  searchPoints: SearchPoint[];
  corridor?: boolean;
}

export async function findStopsForLeg(opts: FindStopsOptions): Promise<(StopResult & { distance_along_route_meters: number })[]> {
  const { userId, stopType, searchPoints, corridor } = opts;

  const source = getUserSetting(userId, 'roadtrip_stop_source') || 'osm';
  const apiKey = source === 'google' ? getGlobalMapsKey() : null;
  const fuelType = getUserSetting(userId, 'roadtrip_fuel_type') || 'any';
  const fuelBrand = getUserSetting(userId, 'roadtrip_fuel_brand') || 'any';

  const useGoogle = source === 'google' && apiKey;
  console.log(`[find-stops] source: ${source}, useGoogle: ${!!useGoogle}, fuelType: ${fuelType}, fuelBrand: ${fuelBrand}`);
  const validType = isValidStopType(stopType) ? stopType : 'both';
  const cappedPoints = searchPoints.slice(0, MAX_SEARCH_POINTS);

  let allFoundStops: (StopResult & { distance_along_route_meters: number })[] = [];

  if (corridor) {
    console.log(`[find-stops] Corridor mode: searching entire route corridor`);
    let corridorResults: StopResult[];
    if (useGoogle) {
      corridorResults = await searchCorridorGoogle(cappedPoints, validType, apiKey!, fuelType, fuelBrand);
    } else {
      corridorResults = await searchCorridorOverpass(cappedPoints, validType, fuelType, fuelBrand);
    }
    allFoundStops = corridorResults.map(r => {
      let closestDist = Infinity;
      let closestPointDist = 0;
      for (const sp of cappedPoints) {
        const d = haversineDistance(r.lat, r.lng, sp.lat, sp.lng);
        if (d < closestDist) {
          closestDist = d;
          closestPointDist = sp.distance_along_route_meters;
        }
      }
      return { ...r, distance_along_route_meters: closestPointDist };
    });
    allFoundStops.sort((a, b) => a.distance_along_route_meters - b.distance_along_route_meters);
    console.log(`[find-stops] Corridor: ${allFoundStops.length} total stops found along corridor`);
  } else {
    const stops: { search_point: SearchPoint; results: StopResult[] }[] = [];

    if (useGoogle) {
      for (const sp of cappedPoints) {
        const results = await searchGooglePlaces(sp.lat, sp.lng, validType, apiKey!);
        results.sort((a, b) => a.distance_from_route_meters - b.distance_from_route_meters);
        stops.push({ search_point: sp, results: results.slice(0, 1) });
      }
      const emptyIndices = stops.map((s, i) => s.results.length === 0 ? i : -1).filter(i => i >= 0);
      if (emptyIndices.length > 0) {
        console.log(`[find-stops] Google Places: ${emptyIndices.length} points had no results, falling back to Overpass`);
        const fallbackPoints = emptyIndices.map(i => cappedPoints[i]);
        const overpassResults = await searchOverpassBatched(fallbackPoints, validType, fuelType, fuelBrand);
        for (let j = 0; j < emptyIndices.length; j++) {
          const results = overpassResults.get(j) || [];
          if (results.length > 0) {
            stops[emptyIndices[j]] = { search_point: cappedPoints[emptyIndices[j]], results };
          }
        }
      }
    } else {
      const resultsByPoint = await searchOverpassBatched(cappedPoints, validType, fuelType, fuelBrand);
      for (let i = 0; i < cappedPoints.length; i++) {
        stops.push({ search_point: cappedPoints[i], results: resultsByPoint.get(i) || [] });
      }
    }

    allFoundStops = stops.flatMap(s =>
      s.results.map(r => ({
        ...r,
        distance_along_route_meters: s.search_point.distance_along_route_meters,
      }))
    );
  }

  return allFoundStops;
}

export function deduplicateAndFilterStops(
  allFoundStops: (StopResult & { distance_along_route_meters: number })[],
  routeGeometry: string | null,
  fuelBrand: string | null,
): (StopResult & { distance_along_route_meters: number })[] {
  // Cross-type dedup: if a rest stop is within 5km of a fuel stop, drop the rest stop
  const fuelStops = allFoundStops.filter(s => s.type === 'fuel');
  if (fuelStops.length > 0) {
    allFoundStops = allFoundStops.filter(s => {
      if (s.type !== 'rest') return true;
      return !fuelStops.some(f => haversineDistance(s.lat, s.lng, f.lat, f.lng) < CROSS_TYPE_DEDUP_PROXIMITY);
    });
  }

  // Dedup by location (within DEDUP_PROXIMITY = same station)
  const dedupedStops: typeof allFoundStops = [];
  for (const stop of allFoundStops) {
    const isDupe = dedupedStops.some(s =>
      s.type === stop.type && haversineDistance(s.lat, s.lng, stop.lat, stop.lng) < DEDUP_PROXIMITY
    );
    if (!isDupe) dedupedStops.push(stop);
  }
  allFoundStops = dedupedStops;

  // Filter by true distance from route polyline
  if (routeGeometry) {
    const routePolyline = decodePolyline(routeGeometry);
    if (routePolyline.length >= 2) {
      const beforeCount = allFoundStops.length;
      allFoundStops = allFoundStops.filter(stop => {
        const dist = distanceToPolyline(stop.lat, stop.lng, routePolyline);
        stop.distance_from_route_meters = Math.round(dist);
        return dist <= ROUTE_PROXIMITY_THRESHOLD;
      });
      console.log(`[find-stops] Filtered ${beforeCount} POIs to ${allFoundStops.length} within ${ROUTE_PROXIMITY_THRESHOLD}m of route`);
    }
  }

  // Sort: preferred brands first if set
  if (fuelBrand && fuelBrand !== 'any') {
    const brands = fuelBrand.split(',').map(b => b.trim().toLowerCase()).filter(Boolean);
    const matchesBrand = (stop: StopResult) =>
      brands.some(b => stop.brand?.toLowerCase().includes(b) || stop.name?.toLowerCase().includes(b));
    allFoundStops.sort((a, b) => {
      const aMatch = matchesBrand(a) ? 0 : 1;
      const bMatch = matchesBrand(b) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return a.distance_along_route_meters - b.distance_along_route_meters;
    });
  }

  return allFoundStops;
}
