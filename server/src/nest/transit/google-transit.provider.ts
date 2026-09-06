import { Injectable } from '@nestjs/common';
import { readEnv } from '../../app-config';
import { DatabaseService } from '../database/database.service';
import { toApiLang } from '../maps/maps.helpers';
import { resolveApiKey, type ApiKeySource } from '../settings/instance-api-keys';
import { readTransitProvider } from './transit-provider';
import {
  decodePolyline,
  deriveTransitStats,
  encodePolyline,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
} from './transit.helpers';

/**
 * Google as the transit backend (#1699), for the regions Transitous has no GTFS
 * for — most of Asia, where a search between two Osaka subway stops returns
 * nothing because the stops are not in the feed at all.
 *
 * Two calls stand behind the two /api/transit routes: Places Text Search for
 * the from/to picker, and the Routes API for the plan. The Routes API, not the
 * legacy Directions API the request named: every other Google call in this repo
 * already speaks the v1/X-Goog-Api-Key family, and Google closed the legacy
 * endpoint to Cloud projects created after March 2025 — a new self-hoster
 * cannot enable it.
 *
 * The key is the one the install already has (`maps_api_key`, operator env →
 * instance → the caller's own row), so nothing new to configure.
 *
 * Cost is the design constraint, because unlike Transitous this one bills:
 *
 * - Both field masks are cut to the cheapest SKU tier that still answers the
 *   question. The picker deliberately does NOT reuse maps.helpers'
 *   SEARCH_TEXT_FIELD_MASK: its rating/website/phone fields bill Text Search at
 *   Enterprise, and a station picker shows none of them.
 * - The cache below is much longer-lived than TransitService's 60s one. A
 *   station's coordinates do not move, and transit search here plans trips days
 *   out rather than catching the next train, so minutes-old departure times are
 *   the right trade for not paying twice.
 * - `computeAlternativeRoutes` is on: alternatives ride along in the one
 *   request that was already billed.
 */

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Text Search at Pro: names, address, coordinates and types, and nothing that
// would push the call into the Enterprise tier.
const STATION_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location,places.types';

// Routes at Pro — steps and transitDetails are what a transit itinerary IS, so
// the tier is unavoidable; everything beyond it (travelAdvisory, viewport,
// localizedValues) is left out.
const ROUTES_FIELD_MASK = [
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.startLocation.latLng',
  'routes.legs.steps.endLocation.latLng',
  'routes.legs.steps.polyline.encodedPolyline',
  'routes.legs.steps.transitDetails.stopDetails',
  'routes.legs.steps.transitDetails.headsign',
  'routes.legs.steps.transitDetails.stopCount',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.color',
  'routes.legs.steps.transitDetails.transitLine.textColor',
  'routes.legs.steps.transitDetails.transitLine.agencies.name',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
].join(',');

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000;

// Google encodes polylines at precision 5; MOTIS uses 6. The client reads the
// precision off the leg, so both render correctly.
const GOOGLE_POLYLINE_PRECISION = 5;

const GEOCODE_TTL = 30 * 60 * 1000;
const PLAN_TTL = 5 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map<string, { at: number; ttl: number; data: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, ttl: number, data: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ttl, data });
}

/** Exposed for tests — the cache is module-scoped for the same reason TransitService's is. */
export function clearGoogleTransitCache(): void {
  cache.clear();
}

/**
 * What a caller may filter by → what `transitPreferences.allowedTravelModes`
 * can express. Google has five buckets; TREK offers thirteen, so ferry, cable
 * and the fine-grained rail splits have no wire equivalent and are dropped from
 * the request and enforced on the response instead (see `matchesRequestedModes`).
 */
const GOOGLE_TRAVEL_MODES: Record<string, string> = {
  BUS: 'BUS',
  COACH: 'BUS',
  SUBWAY: 'SUBWAY',
  TRAM: 'LIGHT_RAIL',
  RAIL: 'TRAIN',
  HIGHSPEED_RAIL: 'TRAIN',
  LONG_DISTANCE: 'TRAIN',
  NIGHT_RAIL: 'TRAIN',
  REGIONAL_RAIL: 'TRAIN',
  SUBURBAN: 'TRAIN',
};

/** Google's vehicle taxonomy → the mode tokens the client already has icons for. */
const VEHICLE_MODES: Record<string, string> = {
  BUS: 'BUS',
  INTERCITY_BUS: 'COACH',
  TROLLEYBUS: 'BUS',
  SHARE_TAXI: 'BUS',
  TRAM: 'TRAM',
  CABLE_CAR: 'TRAM',
  SUBWAY: 'SUBWAY',
  METRO_RAIL: 'SUBWAY',
  MONORAIL: 'SUBWAY',
  COMMUTER_TRAIN: 'SUBURBAN',
  HEAVY_RAIL: 'RAIL',
  RAIL: 'RAIL',
  HIGH_SPEED_TRAIN: 'HIGHSPEED_RAIL',
  LONG_DISTANCE_TRAIN: 'LONG_DISTANCE',
  FERRY: 'FERRY',
  FUNICULAR: 'FUNICULAR',
  GONDOLA_LIFT: 'AERIAL_LIFT',
};

/** '600s' → 600. Google's Duration JSON encoding; anything else is 0. */
function parseDuration(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const seconds = Number(value.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex) ? `#${hex}` : null;
}

function parseCoord(value: string): { latitude: number; longitude: number } {
  const [lat, lng] = value.split(',').map(Number);
  return { latitude: lat, longitude: lng };
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function shiftIso(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

interface GoogleLatLng { latitude?: number; longitude?: number }
interface GoogleStop { name?: string; location?: { latLng?: GoogleLatLng } }
interface GoogleStep {
  travelMode?: string;
  staticDuration?: string;
  distanceMeters?: number;
  startLocation?: { latLng?: GoogleLatLng };
  endLocation?: { latLng?: GoogleLatLng };
  polyline?: { encodedPolyline?: string };
  transitDetails?: {
    stopDetails?: {
      departureStop?: GoogleStop;
      arrivalStop?: GoogleStop;
      departureTime?: string;
      arrivalTime?: string;
    };
    headsign?: string;
    stopCount?: number;
    transitLine?: {
      name?: string;
      nameShort?: string;
      color?: string;
      textColor?: string;
      agencies?: Array<{ name?: string }>;
      vehicle?: { type?: string };
    };
  };
}

function stopFrom(stop: GoogleStop | undefined, fallback: GoogleLatLng | undefined, name: string): TransitLegStop {
  return {
    name: stop?.name || name,

    lat: stop?.location?.latLng?.latitude ?? fallback?.latitude ?? 0,
    lng: stop?.location?.latLng?.longitude ?? fallback?.longitude ?? 0,
    time: null,
    scheduledTime: null,
    // The Routes API carries no platform/track field — MOTIS's `track` has no
    // Google equivalent, so it stays null rather than being faked from headsign.
    track: null,
  };
}

@Injectable()
export class GoogleTransitProvider {
  constructor(private readonly database: DatabaseService) {}

  private resolveKey(userId: number): { key: string | null; source: ApiKeySource | null } {
    return resolveApiKey(this.database, 'maps_api_key', userId, readEnv().maps.placesApiKey);
  }

  /**
   * True only when the admin picked Google AND a key actually resolves for this
   * caller. "Fall back to Transitous if no Google key is set" is the requested
   * behaviour and the safe one: the alternative is every transit search 403ing
   * on an install that flipped the switch before pasting a key.
   */
  isActive(userId: number): boolean {
    if (readTransitProvider(this.database) !== 'google') return false;
    return !!this.resolveKey(userId).key;
  }

  private async call(endpoint: string, label: string, apiKey: string, body: unknown, fieldMask: string): Promise<unknown> {
    console.debug(`[Google API] ${label} → ${endpoint}`);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const length = Number(res.headers?.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
      const err = new Error('Transit provider error (response too large)') as Error & { status: number };
      err.status = 502;
      throw err;
    }

    const data = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Transit provider error (HTTP ${res.status})`) as Error & {
        status: number;
      };
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }
    return data;
  }

  /** Station/place search for the from/to pickers. `near` biases results. */
  async geocode(text: string, language: string | undefined, near: string | undefined, userId: number): Promise<{ results: TransitPlace[] }> {
    const { key: apiKey, source } = this.resolveKey(userId);
    if (!apiKey) {
      const err = new Error('Transit provider error (no Google API key configured)') as Error & { status: number };
      err.status = 502;
      throw err;
    }

    const key = `g:geo:${text}|${language ?? ''}|${near ?? ''}`;
    const cached = cacheGet(key);
    if (cached) return cached as { results: TransitPlace[] };

    const body: Record<string, unknown> = {
      textQuery: text,
      languageCode: toApiLang(language),
      // Capped at what the picker renders — the response is smaller and the
      // request bills the same either way.
      pageSize: 8,
    };
    if (near) {
      const { latitude, longitude } = parseCoord(near);
      body.locationBias = { circle: { center: { latitude, longitude }, radius: 50000 } };
    }

    let data: { places?: Array<{ displayName?: { text?: string }; formattedAddress?: string; location?: GoogleLatLng; types?: string[] }> };
    try {
      data = (await this.call(PLACES_SEARCH_ENDPOINT, 'transitGeocode', apiKey, body, STATION_FIELD_MASK)) as typeof data;
    } catch (err) {
      console.error(`[Transit] google geocode failed userId=${userId} keySource=${source}`);
      throw err;
    }

    const results: TransitPlace[] = (data.places || []).slice(0, 8).flatMap((place) => {
      const lat = place.location?.latitude;
      const lng = place.location?.longitude;
      const name = place.displayName?.text;
      if (typeof lat !== 'number' || typeof lng !== 'number' || !name) return [];
      // MOTIS answers STOP for a station and PLACE for anything else; the picker
      // renders the two differently, so map Google's type list onto the same pair.
      const isStop = (place.types || []).some((t) => t.includes('station') || t.includes('transit') || t.includes('stop'));
      return [{ name, lat, lng, type: isStop ? 'STOP' : 'PLACE', area: place.formattedAddress || null }];
    });

    const payload = { results };
    cacheSet(key, GEOCODE_TTL, payload);
    return payload;
  }

  /** Route search between two coordinates. Returns the same compact shape MOTIS is mapped to. */
  async plan(q: PlanQuery, language: string | undefined, userId: number): Promise<{ itineraries: TransitItinerary[] }> {
    const { key: apiKey, source } = this.resolveKey(userId);
    if (!apiKey) {
      const err = new Error('Transit provider error (no Google API key configured)') as Error & { status: number };
      err.status = 502;
      throw err;
    }

    const requested = (q.modes || '')
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean)
      .filter((m) => m !== 'TRANSIT');

    const body: Record<string, unknown> = {
      origin: { location: { latLng: parseCoord(q.from) } },
      destination: { location: { latLng: parseCoord(q.to) } },
      travelMode: 'TRANSIT',
      // Free extra options inside a request that is already billed.
      computeAlternativeRoutes: true,
      languageCode: toApiLang(language),
    };

    if (q.time) {
      body[q.arriveBy ? 'arrivalTime' : 'departureTime'] = new Date(q.time).toISOString();
    }

    const transitPreferences: Record<string, unknown> = {};
    const allowed = [...new Set(requested.map((m) => GOOGLE_TRAVEL_MODES[m]).filter(Boolean))];
    if (allowed.length > 0) transitPreferences.allowedTravelModes = allowed;
    // Google has no maxTransfers. Asking it to prefer fewer transfers makes the
    // one billed call likelier to return something the filter below keeps.
    if (typeof q.maxTransfers === 'number' && q.maxTransfers <= 1) {
      transitPreferences.routingPreference = 'FEWER_TRANSFERS';
    }
    if (Object.keys(transitPreferences).length > 0) body.transitPreferences = transitPreferences;

    const key = `g:plan:${JSON.stringify(body)}`;
    const cached = cacheGet(key);
    if (cached) return cached as { itineraries: TransitItinerary[] };

    let data: { routes?: Array<{ legs?: Array<{ steps?: GoogleStep[] }> }> };
    try {
      data = (await this.call(ROUTES_ENDPOINT, 'transitPlan', apiKey, body, ROUTES_FIELD_MASK)) as typeof data;
    } catch (err) {
      console.error(`[Transit] google plan failed userId=${userId} keySource=${source}`);
      throw err;
    }

    const itineraries = (data.routes || [])
      .flatMap((route) => {
        const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
        const built = buildItinerary(steps);
        return built ? [built] : [];
      })
      .filter((it) => matchesRequestedModes(it, requested))
      .filter((it) => q.maxTransfers === undefined || q.maxTransfers === null || it.transfers <= q.maxTransfers)
      .slice(0, 8);

    const payload = { itineraries };
    cacheSet(key, PLAN_TTL, payload);
    return payload;
  }
}

/**
 * Steps → one itinerary, or null when there is nothing scheduled in it.
 *
 * A walk-only route is dropped for the same reason the MOTIS call passes
 * `directModes=WALK`: footpath routing is already OSRM's job, and a walking
 * "itinerary" in the transit picker is noise.
 */
function buildItinerary(steps: GoogleStep[]): TransitItinerary | null {
  if (steps.length === 0) return null;

  const legs: TransitLeg[] = steps.map((step, index) => {
    const details = step.transitDetails;
    const line = details?.transitLine;
    const vehicle = line?.vehicle?.type;
    const isFirst = index === 0;
    const isLast = index === steps.length - 1;

    // MOTIS labels the journey's own endpoints START/END and both the web
    // client and the MCP itinerary builder swap the user's chosen names back
    // in, so match that. Interior walk endpoints are left blank here and
    // filled from the scheduled neighbour they touch.
    const from = stopFrom(details?.stopDetails?.departureStop, step.startLocation?.latLng, isFirst ? 'START' : '');
    const to = stopFrom(details?.stopDetails?.arrivalStop, step.endLocation?.latLng, isLast ? 'END' : '');
    from.time = isoOrNull(details?.stopDetails?.departureTime);
    from.scheduledTime = from.time;
    to.time = isoOrNull(details?.stopDetails?.arrivalTime);
    to.scheduledTime = to.time;

    return {
      mode: details ? (vehicle ? VEHICLE_MODES[vehicle] || 'RAIL' : 'RAIL') : 'WALK',
      from,
      to,
      duration: parseDuration(step.staticDuration),
      distance: typeof step.distanceMeters === 'number' ? Math.round(step.distanceMeters) : null,
      headsign: details?.headsign || null,
      // nameShort is the public line identifier ("M4", "JR-Y"); the long name is
      // the route description and only used when there is no short one.
      line: line?.nameShort || line?.name || null,
      lineColor: safeColor(line?.color),
      lineTextColor: safeColor(line?.textColor),
      agency: line?.agencies?.[0]?.name || null,
      intermediateStops: typeof details?.stopCount === 'number' ? Math.max(0, details.stopCount - 1) : 0,
      geometry: step.polyline?.encodedPolyline || null,
      geometryPrecision: GOOGLE_POLYLINE_PRECISION,
    };
  });

  if (!legs.some((leg) => leg.mode !== 'WALK')) return null;

  const walked = mergeWalkLegs(legs);
  fillWalkGaps(walked);

  const startTime = walked[0].from.time;
  const endTime = walked[walked.length - 1].to.time;
  if (!startTime || !endTime) return null;

  return { startTime, endTime, ...deriveTransitStats(startTime, endTime, walked), legs: walked };
}

/**
 * Collapse each run of consecutive walking steps into one leg.
 *
 * The Routes API returns walking as turn-by-turn navigation steps — "head north
 * on Rue de Rivoli", "turn right" — so a two-minute walk to the platform
 * arrives as half a dozen steps. MOTIS gives one leg per walking segment, and
 * everything downstream is built for that shape: the panel renders a row per
 * leg, and transitItinerarySchema caps an itinerary at 20 legs, so a
 * finely-sliced walk would push a real journey over the limit and get the whole
 * itinerary dropped at the MCP boundary.
 */
function mergeWalkLegs(legs: TransitLeg[]): TransitLeg[] {
  const merged: TransitLeg[] = [];
  for (const leg of legs) {
    const previous = merged[merged.length - 1];
    if (leg.mode !== 'WALK' || previous?.mode !== 'WALK') {
      merged.push(leg);
      continue;
    }
    previous.to = leg.to;
    previous.duration += leg.duration;
    previous.distance =
      previous.distance === null && leg.distance === null ? null : (previous.distance ?? 0) + (leg.distance ?? 0);
    previous.geometry = joinPolylines(previous.geometry, leg.geometry);
  }
  return merged;
}

/**
 * Two step polylines into one. They cannot be concatenated as strings — each is
 * delta-encoded from its own first point — so the pair is decoded, joined and
 * re-encoded. Consecutive steps repeat the point where one ends and the next
 * begins; that seam is dropped rather than drawn twice.
 */
function joinPolylines(head: string | null, tail: string | null): string | null {
  if (!head) return tail;
  if (!tail) return head;
  const first = decodePolyline(head, GOOGLE_POLYLINE_PRECISION);
  const second = decodePolyline(tail, GOOGLE_POLYLINE_PRECISION);
  if (first.length === 0) return tail;
  if (second.length === 0) return head;
  const last = first[first.length - 1];
  const seam = second[0][0] === last[0] && second[0][1] === last[1] ? 1 : 0;
  return encodePolyline([...first, ...second.slice(seam)], GOOGLE_POLYLINE_PRECISION);
}

/**
 * Only transit steps come back with a clock and a stop name. A walking step is
 * anchored to the scheduled neighbour it touches — forwards from the previous
 * arrival, or backwards from the next departure when the walk opens the
 * journey — which is also what makes a walk read "…to Nakanoshima".
 */
function fillWalkGaps(legs: TransitLeg[]): void {
  for (let i = 1; i < legs.length; i++) {
    const previous = legs[i - 1].to;
    const leg = legs[i];
    if (!leg.from.name) leg.from.name = previous.name;
    if (!leg.from.time && previous.time) {
      leg.from.time = previous.time;
      leg.to.time ??= shiftIso(previous.time, leg.duration);
    }
  }

  for (let i = legs.length - 2; i >= 0; i--) {
    const next = legs[i + 1].from;
    const leg = legs[i];
    if (!leg.to.name) leg.to.name = next.name;
    if (!leg.to.time && next.time) {
      leg.to.time = next.time;
      leg.from.time ??= shiftIso(next.time, -leg.duration);
    }
  }

  for (const leg of legs) {
    // transitStopSchema wants a non-empty name; a walk between two unnamed
    // points has nothing better to be called.
    if (!leg.from.name) leg.from.name = 'Transfer';
    if (!leg.to.name) leg.to.name = 'Transfer';
    leg.from.scheduledTime ??= leg.from.time;
    leg.to.scheduledTime ??= leg.to.time;
  }
}

/**
 * The response-side half of the mode filter. Ferry, funicular and the aerial
 * lifts have no `allowedTravelModes` equivalent, and Google's five buckets are
 * coarser than TREK's thirteen — so a user who asked for "subway only" is held
 * to it here rather than being handed a bus.
 */
function matchesRequestedModes(itinerary: TransitItinerary, requested: string[]): boolean {
  if (requested.length === 0) return true;
  const wanted = new Set(requested);
  return itinerary.legs.every((leg) => leg.mode === 'WALK' || wanted.has(leg.mode));
}
