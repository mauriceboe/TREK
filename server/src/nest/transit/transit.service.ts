import { Injectable } from '@nestjs/common';
import { getAppUrl, readEnv } from '../../app-config';
import { buildUserAgent } from '../maps/maps.helpers';
import { GoogleTransitProvider } from './google-transit.provider';
import type { TransitProvider } from '@trek/shared';
import {
  deriveTransitStats,
  SCHEDULED_TRANSIT_MODES,
  type PlanQuery,
  type TransitItinerary,
  type TransitLeg,
  type TransitLegStop,
  type TransitPlace,
} from './transit.helpers';

/**
 * Public transit routing (#1065) backed by Transitous (api.transitous.org), the
 * community-run MOTIS instance over public GTFS feeds — free, no API key, fits
 * TREK's no-paid-providers rule. Self-hosters can point TRANSIT_API_URL at their
 * own MOTIS instance instead.
 *
 * Since #1699 an admin can point the two routes at Google instead, for the
 * regions Transitous has no feed for. This class stays the entry point and the
 * validator either way: the request is checked here, then dispatched, so both
 * backends are held to the same coordinate/mode/transfer contract and answer in
 * the same compact shape. Transitous remains the default and the fallback —
 * see GoogleTransitProvider.isActive.
 *
 * Both responses name the backend that answered. The fallback is silent by
 * design, so without this an empty result is indistinguishable between "this
 * provider has no data here" and "the provider you picked never ran" — which is
 * exactly the guessing game a Paris search ran into when the Île-de-France feed
 * ended before the trip date.
 *
 * This service is a thin, validating proxy: the browser never talks to
 * Transitous directly (their usage policy wants an identifying User-Agent with
 * contact info, which we send once from the server), and responses are mapped
 * to a compact shape so the client isn't coupled to the MOTIS schema.
 *
 * Folded 1:1 from the legacy services/transitService.ts. The base URL, the
 * lazy User-Agent memo and the response cache stay module-scoped on purpose
 * (the permissions/exchange-rates precedent): the DI singleton and any future
 * non-Nest caller share one cache, and the base URL keeps its frozen-at-import
 * legacy timing.
 */

// Frozen at import on purpose (legacy timing).
const TRANSIT_API_BASE = readEnv().integrations.transitApiBase;
let userAgent: string | null = null;

function getUserAgent(): string {
  userAgent ??= buildUserAgent(getAppUrl());
  return userAgent;
}

const ALLOWED_MODES = new Set(['TRANSIT', ...SCHEDULED_TRANSIT_MODES]);

// Short-lived response cache: planning is the expensive call per the Transitous
// usage policy, and a user toggling filters re-requests identical plans.
const CACHE_TTL = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; data: unknown }>();

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (true LRU): geocode and plan share this Map, so without
  // the re-insert a burst of geocoding evicts still-hot plan entries.
  cache.delete(key);
  cache.set(key, hit);
  return hit.data;
}

function cacheSet(key: string, data: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), data });
}

const COORD_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

function isCoord(v: string): boolean {
  if (!COORD_RE.test(v)) return false;
  const [lat, lng] = v.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// A plan response with eight geometry-carrying itineraries stays well under a
// megabyte; anything bigger is a misbehaving provider, not data we want to map.
const MAX_RESPONSE_BYTES = 5_000_000;

async function upstream(path: string, params: URLSearchParams): Promise<unknown> {
  const url = `${TRANSIT_API_BASE}${path}?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': getUserAgent(), Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = new Error(`Transit provider error (HTTP ${res.status})`) as Error & { status: number };
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  const length = Number(res.headers?.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) {
    const err = new Error('Transit provider error (response too large)') as Error & { status: number };
    err.status = 502;
    throw err;
  }
  return res.json();
}

// GTFS colors come as bare hex ("FF0000"), with hash, or empty — normalise to
// a #-prefixed value or null so the client can use them in CSS directly.
function safeColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex) ? `#${hex}` : null;
}

interface MotisPlaceRaw {
  name?: string;
  lat?: number;
  lon?: number;
  departure?: string;
  arrival?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  track?: string;
  scheduledTrack?: string;
}

function mapStop(p: MotisPlaceRaw | undefined, kind: 'departure' | 'arrival'): TransitLegStop {
  return {
    name: p?.name || '',
    // A missing coordinate becomes 0 (null island) rather than null on
    // purpose: TransitLegStop.lat/lng are non-nullable across the wire
    // contract (transitStopSchema, the client picker) — making them nullable
    // would ripple through transit-itinerary.helpers' validation and drop
    // otherwise-usable itineraries. MOTIS places carry coordinates in
    // practice; endpoint stops are re-checked by transitCoordinatesMatch.
    lat: typeof p?.lat === 'number' ? p.lat : 0,
    lng: typeof p?.lon === 'number' ? p.lon : 0,
    time: (kind === 'departure' ? p?.departure : p?.arrival) || null,
    scheduledTime: (kind === 'departure' ? p?.scheduledDeparture : p?.scheduledArrival) || null,
    track: p?.track || p?.scheduledTrack || null,
  };
}

@Injectable()
export class TransitService {
  constructor(private readonly google: GoogleTransitProvider) {}

  /**
   * Station/place search for the from/to pickers. `near` biases results.
   *
   * `userId` resolves the Google key (operator env → instance → own row) and is
   * only read when Google is the active backend; the Transitous path is keyless
   * and identical for every caller.
   */
  async geocode(
    query: string,
    language?: string,
    near?: string,
    userId = 0,
  ): Promise<{ results: TransitPlace[]; provider: TransitProvider }> {
    const text = (query || '').trim();
    // Answered before either backend is consulted, so it reports the one that
    // WOULD have been asked rather than claiming nobody was.
    const provider: TransitProvider = this.google.isActive(userId) ? 'google' : 'transitous';
    if (text.length < 2) return { results: [], provider };
    if (text.length > 200) {
      const e = new Error('Query too long') as Error & { status: number };
      e.status = 400;
      throw e;
    }

    if (provider === 'google') {
      return { ...(await this.google.geocode(text, language, near && isCoord(near) ? near : undefined, userId)), provider };
    }

    const params = new URLSearchParams({ text });
    if (language) params.set('language', language.slice(0, 5));
    if (near && isCoord(near)) params.set('place', near);

    const key = `geo:${params.toString()}`;
    const cached = cacheGet(key);
    if (cached) return { ...(cached as { results: TransitPlace[] }), provider };

    const raw = (await upstream('/api/v1/geocode', params)) as Array<{
      name?: string;
      lat?: number;
      lon?: number;
      type?: string;
      areas?: Array<{ name?: string; matched?: boolean; default?: boolean }>;
    }>;

    const results: TransitPlace[] = (Array.isArray(raw) ? raw : []).slice(0, 8).flatMap((m) => {
      if (typeof m.lat !== 'number' || typeof m.lon !== 'number' || !m.name) return [];
      const area = m.areas?.find((a) => a.default)?.name || m.areas?.[0]?.name || null;
      return [{ name: m.name, lat: m.lat, lng: m.lon, type: m.type || 'PLACE', area }];
    });

    const data = { results };
    cacheSet(key, data);
    return { ...data, provider };
  }

  /** Route search between two coordinates. Returns compact itineraries for the picker. */
  async plan(
    q: PlanQuery,
    language?: string,
    userId = 0,
  ): Promise<{ itineraries: TransitItinerary[]; provider: TransitProvider }> {
    const bad = (msg: string) => {
      const e = new Error(msg) as Error & { status: number };
      e.status = 400;
      throw e;
    };
    if (!q.from || !isCoord(q.from)) bad('from must be "lat,lng"');
    if (!q.to || !isCoord(q.to)) bad('to must be "lat,lng"');

    const params = new URLSearchParams({ fromPlace: q.from, toPlace: q.to, numItineraries: '8' });

    if (q.time) {
      const parsed = new Date(q.time);
      if (Number.isNaN(parsed.getTime())) bad('time must be an ISO date-time');
      params.set('time', parsed.toISOString());
    }
    if (q.arriveBy) params.set('arriveBy', 'true');

    if (q.modes) {
      const modes = q.modes
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      if (modes.some((m) => !ALLOWED_MODES.has(m))) bad('unsupported transit mode');
      if (modes.length > 0) params.set('transitModes', modes.join(','));
    }
    if (q.maxTransfers !== undefined && q.maxTransfers !== null) {
      const n = Number(q.maxTransfers);
      if (!Number.isInteger(n) || n < 0 || n > 10) bad('maxTransfers must be 0-10');
      params.set('maxTransfers', String(n));
    }
    // We only want scheduled transit journeys in the results — a pure-walk
    // "direct" connection is what the existing OSRM footpath routing is for.
    params.set('directModes', 'WALK');

    // After validation on purpose: whichever backend answers, the caller is held
    // to the same coordinate/mode/transfer contract and gets the same 400s.
    if (this.google.isActive(userId)) {
      return { ...(await this.google.plan(q, language, userId)), provider: 'google' };
    }

    const key = `plan:${params.toString()}`;
    const cached = cacheGet(key);
    if (cached) return { ...(cached as { itineraries: TransitItinerary[] }), provider: 'transitous' };

    const raw = (await upstream('/api/v6/plan', params)) as {
      itineraries?: Array<{
        duration?: number;
        startTime?: string;
        endTime?: string;
        transfers?: number;
        legs?: Array<{
          mode?: string;
          duration?: number;
          distance?: number;
          headsign?: string;
          routeShortName?: string;
          displayName?: string;
          routeColor?: string;
          routeTextColor?: string;
          agencyName?: string;
          from?: MotisPlaceRaw;
          to?: MotisPlaceRaw;
          intermediateStops?: unknown[];
          legGeometry?: { points?: string; precision?: number };
        }>;
      }>;
    };

    const itineraries: TransitItinerary[] = (raw.itineraries || []).flatMap((it) => {
      if (!it.startTime || !it.endTime || !Array.isArray(it.legs)) return [];
      const legs: TransitLeg[] = it.legs.map((leg) => ({
        mode: (leg.mode || 'WALK').toUpperCase(),
        from: mapStop(leg.from, 'departure'),
        to: mapStop(leg.to, 'arrival'),
        duration: typeof leg.duration === 'number' ? leg.duration : 0,
        distance: typeof leg.distance === 'number' ? Math.round(leg.distance) : null,
        headsign: leg.headsign || null,
        // displayName is the public identifier MOTIS resolved for the run, taking
        // the trip number into account where the feed has one. Plenty of operators
        // (German long distance among them) keep routeShortName as an internal line
        // number, so preferring it showed "20" instead of "ICE 72" (#1715).
        line: leg.displayName || leg.routeShortName || null,
        lineColor: safeColor(leg.routeColor),
        lineTextColor: safeColor(leg.routeTextColor),
        agency: leg.agencyName || null,
        intermediateStops: Array.isArray(leg.intermediateStops) ? leg.intermediateStops.length : 0,
        geometry: leg.legGeometry?.points || null,
        geometryPrecision: leg.legGeometry?.precision ?? 6,
      }));
      const stats = deriveTransitStats(it.startTime, it.endTime, legs, it.transfers);
      return [
        {
          startTime: it.startTime,
          endTime: it.endTime,
          // Wall-clock duration (start→end) so waits/transfers count — summing leg
          // run-times would understate the journey and mis-slot it in the timeline.
          ...stats,
          legs,
        },
      ];
    });

    const data = { itineraries };
    cacheSet(key, data);
    return { ...data, provider: 'transitous' };
  }
}
